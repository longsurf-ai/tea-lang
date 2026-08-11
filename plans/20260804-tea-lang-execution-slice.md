# tea-lang: execution slice — rt ABI, kernel, JS codegen, tea run

## 1. System map

```text
Program --lower--> generated JS module          src/codegen
                   { init(rt), inits{}, funcs{}, main(rt, fr) }
                        |
                        | rt ABI (Time-Machine ops only:
                        |   read/write/series/param/request,
                        |   frame(fr, slot), emit, heap COW)
                        v
                   Tea runtime kernel      src/runtime
                   frames + rings + provisional overlay
                   main loop: bind -> init -> per bar:
                     [tick* provisional re-exec] commit
                        |                     |
              DataProvider seam          OutputSink seam
              (SeriesView per id)        (declare, emit, alert)
                        |                     |
                   csv provider          tea run printer/JSON
                   src/providers         src/main.ts
```

- `docs/runtime.md` (written first) is the source of truth for both seams and the
  rt ABI; `docs/ir.md` keeps owning the Program contract. "The compiler
  describes; the runtime implements" stays the governing invariant: generated
  code never touches ring indices, COW, or overlay mechanics.
- All series access goes through the `SeriesView` interface (external
  columnar structures, our rings, later request results) — codegen and kernel
  never assume native arrays. Enforced by the ABI types plus a kernel that
  stores rings behind the same interface.
- In-flight values: na = NaN for numerics (na-propagation via IEEE), null
  for references; bool is never na (checker-guaranteed). Storage layout is
  kernel-owned and compact (typed arrays + validity where it pays).
- Provisional protocol: every tick re-executes the current bar from
  committed state; varip writes live in an overlay that survives ticks;
  commit advances rings. No incremental-update paths exist by construction.
- Scope: historical CSV execution end-to-end plus a tick/commit test
  harness. Requests execution, collections/UDT COW ops, drawing natives, and
  the Stooq network provider are follow-up plans.

## 2. Problem

The pipeline stops at the Program: `codegen/generate` is `unimplemented`,
there is no runtime, and `tea run` exits with code 2. All runtime-facing
semantics the compiler describes (depths, storage classes, frames, slots,
emissions) are unexecuted and therefore numerically unverified — including
the ~40 ta.\* functions, which only ever type-check today.

This slice makes `tea run script.tea --input testdata/dataset.csv` execute
real bars: lower the Program to a JS module against a small runtime ABI
(`rt`), implement the kernel that owns frames, rings, and the main loop, and
bind it to a csv DataProvider and a printing OutputSink. Numeric golden
traces become the execution-level regression surface.

## 3. Implementation

1. **runtime.md — the ABI contract** — `docs/runtime.md`
   - Write the runtime authority doc: module shape, rt surface, SeriesView,
     DataProvider/OutputSink seams, value representation, frame/ring/
     provisional semantics, emitter-rules-table note for non-JS backends.
   - `runtime.ts` root notes get a pointer and stop being the sketch of
     record.
2. **ABI types + kernel** — `src/runtime/` (new: `abi.ts`, `kernel.ts`, `ring.ts`)
   - `abi.ts`: `Rt`, `SeriesView {at(offset): number}`, `DataProvider`,
     `OutputSink`, `BoundProgram`, frame/slot handle types. Layering: `rt`
     imports only `base/` and `ir/` types.
   - `ring.ts`: one Ring class for values and references (user decision:
     rings act over reference types too), sized from `HistoryDepth`,
     implementing SeriesView.
   - `kernel.ts`: bind (param validation against constraints, series
     binding, depth resolution values from generated init, frame tree
     construction with lazy sub-frame creation running var-init thunks
     once), main loop (init -> bars -> tick re-exec -> commit), emission
     buffering with provisional flag.
3. **JS codegen** — `src/codegen/` (`emit.ts` rules table, `codegen.ts`)
   - Lower Program -> module source: `init(rt)` for bindArgs/bound depths,
     `inits` thunks for var/varip, one function per IrFunc, `main(rt, fr)`
     for the body; dense ids for names/series/params/outputs/funcs assigned
     by a lowering walk (visit projections).
   - Emitter rules table keyed by (op, operand types): JS renders arithmetic
     natively (int division truncates, NaN carries na); math.\*/na()/nz()
     expand inline. Time-Machine ops call `rt`. Backend-specific choices
     live only in the rules table.
   - `generate()` stops being `unimplemented`; compile() emits a runnable
     module string.
4. **csv provider + run wiring** — `src/providers/csv.ts`, `src/main.ts`
   - Header names map to ambient series ids; a demanded-but-missing series
     is a bind error. `tea run <file> --input <csv>` binds, executes, and
     prints per-bar channel values (stable text form reused by goldens).
5. **Execution goldens + provisional harness** — `src/runtime/run.test.ts`,
   `testdata/run/`
   - Numeric golden traces: macd.tea and a ta-coverage script over
     `dataset.csv` (extend the CSV with high/low/volume columns as needed),
     `UPDATE_GOLDENS=1` convention.
   - Tick harness property tests: provisional ticks then rollback ==
     never-executed; commit sequence deterministic on replay; varip survives
     ticks while var rolls back.
6. **Docs + AGENTS** — `src/runtime/AGENTS.md`, `src/codegen/AGENTS.md`,
   package `AGENTS.md`, `docs/ir.md` pointer to runtime.md; memory update.

## 4. Verification

- [x] `bun run typecheck` and `bun test` green; new rt/codegen suites
      included.
- [x] `bun src/main.ts run testdata/macd.tea --input testdata/dataset.csv`
      prints per-bar MACD/signal/histogram values; exit 0.
- [x] Execution goldens locked under `testdata/run/`; rerun is
      byte-identical (determinism).
- [x] Hand-checked vectors: ta.sma/ema over a tiny known series match
      hand-computed values in unit tests (first numeric ground truth).
- [x] Provisional property tests pass: tick/rollback equivalence and varip
      persistence.
- [x] Layering greps: `src/runtime` imports only base/ir; generated-module string
      contains no `Date.`/`Math.random` (determinism guard).
