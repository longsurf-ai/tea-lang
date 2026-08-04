# The Tea runtime ABI (`rt`)

How a compiled Program executes. This document is the source of truth for
the runtime ABI, the two external seams, and the execution protocol;
`src/runtime/` implements the kernel and `src/codegen/` targets the ABI. The
Program contract stays owned by [ir.md](ir.md); the root `runtime.ts` sketch
is superseded by this document.

## Architecture

```
generated JS module ──rt──▶ Tea runtime kernel ──data──▶ DataProvider (injected)
                            (owns the main loop) ──sink──▶ OutputSink  (injected)
```

One runtime. The kernel owns everything between the two seams: frames,
rings, the main loop, provisional/commit, and (later) request-child
scheduling. Hosts differ only in what they inject: the `tea` CLI injects a
csv provider and a printing sink; OpenChart injects a TSGraph-backed
provider and the chart/alert sink. A second kernel implementation is not a
goal; the ABI merely permits one.

## Pipeline order

```
Compilation ─▶ Lowering ─▶ Binding ─▶ Execution
   Program      module      instance    rows
```

Lowering is **bind-independent**: one JS module per Program, reusable across
bindings (a settings change rebinds without re-lowering). This revises the
earlier Binding → Lowering sketch, because bind-time expressions (bound
depths, output bindArgs) are themselves lowered code: binding RUNS the
module's `init` section. Baking bound constants into specialized modules is
a permitted later optimization, not the model.

## The generated module

Lowering emits one self-describing module — code plus the manifest the
kernel needs to allocate and bind. The module, not the Program, is the
runtime artifact (`tea build` output, cacheable, serializable):

```js
export default {
  abi: 1,
  manifest: {
    series:  ['close', ...],              // sid -> host id (ambient + input.source params)
    params:  [{name, type, default, constraints, seriesSid?}, ...],
    outputs: [{effect, staticArgs, channels: [{name, type}]}, ...],
    frames:  [                            // fid 0 = the program frame
      {locals: [{storage, depth}, ...],   // slot-indexed; depth: none|const n|bound|capped n
       subs:   [{fid}, ...]},             // call-site-slot-indexed
    ],
  },
  init(rt) {...},                // bind time: rt.bindDepth / rt.bindOutput calls
  inits: {(fid, slot): (rt, fr) => v},   // var/varip first-execution thunks
  funcs: {fid: (rt, fr, ...args) => v},
  main(rt, fr) {...},            // the per-row body (fr = program frame)
};
```

Dense ids (`sid`, `pid`, `oid`, `fid`, local slots) are assigned by the
lowering walk; the manifest is their single source of truth — the kernel
never re-derives ids from the Program.

## The rt surface

Only Time-Machine-relevant operations cross the ABI. Everything else —
arithmetic, comparisons, `math.*`, `na()`/`nz()`/`fixnan` — expands inline
in generated code via the backend's emitter rules table (a codegen-internal
seam: JS renders these natively; another backend supplies another table).

```ts
// reads and writes (offset 0 = current row)
rt.series(sid, offset)        // ambient series and input.source params
rt.param(pid)                 // bind-time scalar
rt.read(fr, slot, offset)     // a name's history
rt.write(fr, slot, v)
rt.request(rid, offset)       // reserved: request slice
// frames
rt.frame(fr, slot)            // open the sub-frame at this call site
// emissions
rt.emit(oid, channel, v)
// bind-time (init section only)
rt.bindDepth(fid, slot, bars)   // a name's bound history depth
rt.bindSeriesDepth(sid, bars)   // a series/input.source bound depth
rt.bindOutput(oid, argName, v)  // an output's bind-time argument
// heap (reserved: collections/UDT slice)
rt.newUdt / rt.field / rt.mutField / rt.array*
```

`rt.frame(fr, slot)` is the seam where per-call-site state materializes:
fetch the sub-frame at compartment `slot` of `fr`, creating it on first use
from the callee's manifest layout and running its var-init thunks once. A
call site lowers to:

```js
const v = f_3(rt, rt.frame(fr, 0), rt.series(0, 0), 9);
```

## Values

- In-flight (what generated code holds): numerics are JS numbers with
  **na = NaN** — IEEE propagation implements Pine's na-propagation for
  arithmetic; comparisons with na yield false (ledger: verify against v6).
  References (string, color, UDT, collections) use **null** as na. bool is
  never na — a checker guarantee the runtime may rely on.
- int semantics are codegen's job (truncating division, `math.*` int
  overloads); the kernel never re-checks types.
- Storage is kernel-owned and invisible to generated code: rings may use
  compact typed arrays plus validity, plain JS arrays, or anything else.

## Series access: one interface

```ts
interface SeriesView {
  at(offset: number): number;   // offset 0 = current row; out of range = na
}
```

Every time-addressed read goes through this interface — externally provided
columnar structures (TSGraph's low-copy pages), the kernel's own rings, and
later request results. Neither the kernel's read path nor generated code
ever assumes a native array; providers try to be efficient, the contract
doesn't require it.

Two asymmetries between the kernel's rings and provider series:

- Providers hand over **absolute-indexed committed rows** (`SeriesData`);
  the kernel wraps them, owning the cursor anchoring (offset → absolute)
  and, under live ticks, the provisional head — so external series and
  rings behave identically under the provisional protocol.
- Depth means **allocation** for rings (the kernel sizes them) but
  **contract** for providers: the demanded depth is the promise `at()` must
  honor that far back (a paged provider keeps pages accordingly; a csv
  provider ignores it).

## Frames and rings

A frame is a call site's persistent box: one Ring per local slot, one
sub-frame box per call-site slot, materialized lazily by `rt.frame` (frame
trees can also appear at runtime — dynamic requests instantiate whole trees
per context). One Ring class serves value and reference slots alike; ring
capacity comes from the manifest depth (`none` = current cell only, `const
n` / `capped n` = n + 1 cells, `bound` = the value `init` reported via
`rt.bindDepth`). A Ring implements SeriesView.

## Main loop and the provisional protocol

```
bind(module, params, provider, sink):
  validate params against constraints; resolve manifest.series via provider
  (a demanded id the provider lacks is a bind error); run module.init;
  size rings; build the program frame; sink.declare(outputs + bound args)

per row r (historical):        execute(r); commit(r)
per live tick on row r:        execute(r) — provisional
on row close:                  execute(r); commit(r)
```

`execute(r)` always runs the full body **from committed state** — there are
no incremental update paths, by construction:

- Every ring has committed cells plus a **scratch head** for the row being
  executed. Reads at offset 0 see this execution's writes (or the storage
  class's start value); offsets ≥ 1 see committed history.
- At execution start the scratch head resets: `var` starts from its last
  committed value, perBar starts unwritten (na until written). **varip**
  scratch survives across provisional executions of the same row — the one
  storage class whose writes ticks accumulate.
- `commit(r)` pushes scratch heads into committed history (for slots whose
  depth keeps any), seals emissions for the row, and advances the cursor.
  Rollback is therefore free: discarding a provisional execution discards
  scratch, committed state was never touched.

Emissions carry a `provisional` flag to the sink; alert-class outputs fire
on commit only.

```ts
interface DataProvider { series(id: string): SeriesData | null }
interface SeriesData   { readonly length: number; at(index: number): number }
interface OutputSink {
  declare(outputs): void;                            // before the first row
  emit(row, oid, channels, provisional): void;
}
```

Historical csv execution uses exactly this; live push feeds extend
DataProvider in the request/live slice without changing the rt surface.

## Determinism

A module is a pure function of its Program; execution is a pure function of
(module, params, provider data). Generated code contains no `Date`, no
`Math.random`, no host I/O — enforced by an emitter-level guard and a test
grep. Replay of the same rows and ticks is byte-identical, which is what
makes golden traces and the tick/rollback property tests
(provisional-then-rollback ≡ never-executed; varip persistence) valid.

## Staged beyond this slice

Request execution (child instances, merge, dynamic contexts), collections
and UDT heap ops (COW at the `rt.mut*` seam), drawing/handle natives,
network providers (Stooq), live push feeds, and V8-isolate embedding. None
of them change the surface above; they fill reserved entries.
