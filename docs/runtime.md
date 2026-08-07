# The Tea runtime ABI (`rt`)

How a compiled Program executes. This document is the source of truth for
the runtime ABI, the two external seams, and the execution protocol;
`src/runtime/` implements it (`JSRuntime`) and `src/codegen/` targets the ABI. The
Program contract stays owned by [ir.md](ir.md); the root `runtime.ts` sketch
is superseded by this document.

## Architecture

```
generated JS module ──rt──▶ Tea runtime (JSRuntime) ──data──▶ DataProvider (injected)
                            (owns the main loop) ──sink──▶ OutputSink  (injected)
```

One runtime. The runtime owns everything between the two seams: frames,
rings, the main loop, provisional/commit, and (later) request-child
scheduling. Hosts differ only in what they inject: the `tea` CLI injects a
csv provider and a printing sink; OpenChart injects a TSGraph-backed
provider and the chart/alert sink. A second runtime implementation is not a
goal; the ABI merely permits one.

## Pipeline order

```
Compilation ─▶ Lowering ─▶ Binding ─▶ Execution
   Program      module      instance    rows
```

Lowering is **bind-independent**: one JS module per Program, reusable across
bindings (a settings change rebinds without re-lowering). This revises the
earlier Binding → Lowering sketch, because bind-time expressions (bound
depths, input metadata, and output bindArgs) are themselves lowered code:
binding runs frame-free `init`, creates a scratch-only provisional program
frame, runs frame-aware `bind`, then allocates the final frame tree from its
depth reports. Baking bound constants into specialized modules is a permitted
later optimization, not the model.

## The generated module

Lowering emits one self-describing module — code plus the manifest the
runtime needs to allocate and bind. The module, not the Program, is the
runtime artifact (`tea build` output, cacheable, serializable):

```js
export default {
  abi: 2,
  manifest: {
    series:  ['close', ...],              // sid -> host id (ambient + input.source params)
    params:  [{name, type, control, defaultValue, constraints, // control = UI flavor
               enumType, group, inline, tooltip, confirm,
               display, seriesSid?}, ...],
    outputs: [{effect, staticArgs, channels: [{name, type}]}, ...],
    frames:  [                            // fid 0 = the program frame
      {locals: [{storage, depth, valueClass}, ...], // slot-indexed; typed empty values
       subs:   [{fid}, ...]},             // call-site-slot-indexed
    ],
    requests: [{merge, depth, resultSlot, valueClass}, ...], // rid-indexed metadata
  },
  requests: [M1, ...],           // rid-indexed child modules (same shape,
                                 // sibling consts — code cannot live in the
                                 // JSON manifest)
  init(rt) {...},                // reserved frame-free preparation
  bind(rt, fr) {...},            // input aliases/UDFs, depth reports, active,
                                 // output args, and static request pairs
  inits: {(fid, slot): (rt, fr) => v},   // var/varip first-execution thunks
  funcs: {fid: (rt, fr, ...args) => v},
  main(rt, fr) {...},            // the per-row body (fr = program frame)
};
```

Dense ids (`sid`, `pid`, `oid`, `fid`, local slots) are assigned by the
lowering walk; the manifest is their single source of truth — the runtime
never re-derives ids from the Program.

**Portability contract.** The emitted source is a strict-mode ECMAScript
**2015 (ES6)** FunctionBody: no module syntax (import/export/require), no
host I/O, no nondeterminism, and only whitelisted standard globals —
`Math.{abs, sign, floor, ceil, round, trunc, sqrt, pow, log, log10, exp,
max, min}`, `Number.{isFinite,isNaN}`, `String`, `NaN` — everything else
crosses the `rt` parameter. Any ES2015 engine loads it with
`new Function(src)()` (Node, Bun, browsers, V8 isolates alike); an ES2015
parse gate plus a deny-list test enforce the ceiling so it cannot drift.

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
rt.request(rid, offset)       // the edge's merged result: static view or
                              // dynamic result ring (docs/requests.md)
rt.requestFor(rid, sym, tf)   // dynamic offset-0 read; unresolved pairs
                              // throw ContextSuspension (host awaits
                              // resolvePending, re-executes the row)
// frames
rt.frame(fr, slot)            // open the sub-frame at this call site
rt.root()                     // the program frame (globals read from funcs)
// emissions
rt.emit(oid, channel, v)
// frame-aware bind section (against a provisional scratch-only frame)
rt.historyDepth(offset)         // invalid history offsets normalize to zero
rt.bindDepth(fid, slot, bars)   // a name's bound history depth
rt.bindSeriesDepth(sid, bars)   // a series/input.source bound depth
rt.bindParamActive(pid, active) // resolved input enablement
rt.bindOutput(oid, argName, v)  // an output's bind-time argument
rt.bindRequest(rid, sym, tf)    // a static request edge's context pair
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

- In-flight (what generated code holds): numerics are finite JS numbers or
  **na = NaN**. Every arithmetic and numeric-native result crosses the
  finite-or-na normalizer, so overflow and other non-finite results become
  NaN on both folded and dynamic paths; `Infinity` is never a Tea value.
  Every comparison with typed numeric or reference na returns false,
  including `!=`. References (string, color, UDT, collections) use
  **null** as na; string concatenation propagates null. bool is never na and
  its empty value is false — a checker guarantee the runtime may rely on.
  A direct bare `na` operand in a comparison is instead a compile error; use
  `na(x)` to test whether a value is missing.
- Host-bound numeric input values must be finite (NaN and both infinities are
  bind errors), and int inputs must be safe integers so their value is exact in
  the JS runtime. Provider series may return finite numbers or NaN; an infinity
  is a provider-contract invariant violation and fails loudly at the read.
- int semantics are codegen's job (truncating division, `math.*` int
  overloads); the runtime never re-checks types.
- Storage is runtime-owned and invisible to generated code: rings may use
  compact typed arrays plus validity, plain JS arrays, or anything else.

## Series access: one interface

```ts
interface SeriesView {
  at(offset: number): Value; // offset 0 = current row; out of range = typed empty
}
```

An offset names history only when it is a non-negative safe integer. Negative,
fractional, non-finite, and na offsets are out of range and return that place's
typed empty value (NaN, null, or false); they never turn into future-row indices
or array properties. The same rule normalizes a bind-reported depth to zero,
and fixed-context ring retention never exceeds the context's row extent.

Every time-addressed read goes through this interface — externally provided
columnar structures (TSGraph's low-copy pages), the runtime's own rings, and
later request results. Neither the runtime's read path nor generated code
ever assumes a native array; providers try to be efficient, the contract
doesn't require it.

The alignment contract: **all series a provider serves for one binding
share one row space** — one context is one axis, so the runtime keeps a
single cursor and every read is `cursor - offset` arithmetic. There is no
per-input index mapping inside a Program; cross-axis mapping exists only at
request edges, where the MergePolicy names it explicitly. The runtime
rejects misaligned series at bind.

Two asymmetries between the runtime's rings and provider series:

- Providers hand over **absolute-indexed committed rows** (`SeriesData`);
  the runtime wraps them, owning the cursor anchoring (offset → absolute)
  and, under live ticks, the provisional head — so external series and
  rings behave identically under the provisional protocol.
- Depth means **allocation** for rings (the runtime sizes them) but
  **contract** for providers: the demanded depth is the promise `at()` must
  honor that far back (a paged provider keeps pages accordingly; a csv
  provider ignores it).

## Frames and rings

A frame is a call site's persistent box: one Ring per local slot, one
sub-frame box per call-site slot, materialized lazily by `rt.frame` (frame
trees can also appear at runtime — dynamic requests instantiate whole trees
per context). One Ring class serves all value classes; ring capacity comes
from the manifest depth (`none` = current cell only, `const
n` / `capped n` = n + 1 cells, `bound` = the value `bind` reported via
`rt.bindDepth`). Each local and request manifest entry carries an explicit
`valueClass` (`numeric | reference | boolean`), and the Ring derives its empty
value (NaN, null, or false) from that class. A Ring implements SeriesView.

## Main loop and the provisional protocol

```
bind(module, params, provider, sink):        # async — awaits live here only
  await provider.resolveContext('', '')      # the primary context
  validate params; run module.init           # frame-free preparation
  resolve manifest.series from the context   # a missing id is a bind error
  build scratch-only provisional frame
  run module.bind                            # aliases/UDFs, depths, active,
                                             # output args, request pairs
  discard it; allocate final rings/frame tree from reported depths
  per request edge: await resolveContext(pair); bind + run the child
  (recursively, same machinery, null sink); build the merged view
  sink.declare(outputs + bound args)

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
interface DataProvider {
  series(id: string): SeriesData | null;
}
interface SeriesData {
  readonly length: number;
  at(index: number): number;
}
interface OutputSink {
  declare(outputs): void; // before the first row
  emit(row, oid, channels, provisional): void;
}
```

Historical csv execution uses exactly this. The request slice
(`docs/requests.md`) supersedes `series()` with async
`resolveContext(symbol, timeframe, range)` — one resolution path for the
primary and every request context — without changing the rt surface.

## Determinism

A module is a pure function of its Program; execution is a pure function of
(module, params, provider data). Generated code contains no `Date`, no
`Math.random`, no host I/O — enforced by an emitter-level guard and a test
grep. Replay of the same rows and ticks is byte-identical, which is what
makes golden traces and the tick/rollback property tests
(provisional-then-rollback ≡ never-executed; varip persistence) valid.

## Staged beyond this slice

Collections and UDT heap ops (COW at the `rt.mut*` seam), drawing/handle
natives, further network drivers (the quantmod roster —
alphavantage/tiingo with the same key treatment — as needed), live push
feeds, and V8-isolate embedding. None of them change the surface above;
they fill reserved entries.

A dynamic-request suspension is part of the execution protocol:
`executeRow` may throw `ContextSuspension`; the host awaits
`resolvePending()` and re-executes the SAME row, whose aborted attempt
vanishes entirely (all scratch, varip included, re-seeds from committed
state). `runAll` runs this loop itself.
