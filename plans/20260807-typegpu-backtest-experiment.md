# TypeGPU parameter-sweep backtest experiment

> Historical note: this experiment was extracted to the sibling directory
> `tea-lang-typegpu-experiment`. Paths below describe the design at the time of
> extraction and are relative to that standalone package. The extracted local
> directory is not initialized or published as a Git repository by this change.

## 1. System map

```text
Binance market-data API
          |
          v
  validated local snapshots ----+-----------------------------+
  (BTCUSDT 1d + 1h)             |                             |
          |                     v                             v
          |              CPU reference/replay          TypeGPU buffers
          |                     |                             |
          |                     |                  one compute dispatch
          |                     |                  job = series x params
          |                     |                             |
          |                     +<---- summaries + events ---+
          |                         journal replay/parity gate
          v                                  |
  snapshot manifest                          v
                              streamed result artifacts
                              summaries / orders / fills /
                              round trips / equity curves
```

- The sibling `tea-lang-typegpu-experiment` package is the standalone owner;
  it has no
  workspace imports, dependencies, or root lockfile changes.
- The normalized snapshot and explicit SMA/exchange contract are input sources
  of truth. The GPU journal owns real-run strategy decisions; CPU artifact
  replay validates exchange accounting and reconstructs full equity.
- One TypeGPU dispatch covers every valid `(series, fast, slow)` job. Event
  capacity exhaustion fails the run rather than truncating its journal.
- TypeGPU is a hard boundary. If its public API cannot express any required
  capability, implementation pauses before introducing raw WebGPU.

## 2. Problem

We need to test whether TypeGPU can express a useful compiler-style compute
workload rather than a small element-wise demo. Each GPU invocation must scan a
complete price series sequentially, run rolling SMA crossover logic plus a
minimal cash exchange, and parallelize across parameter pairs and later across
instruments. The first real inputs are Binance spot BTCUSDT daily and hourly
history from the venue's first available candle.

The experiment must run from Node through Dawn, use a single compute dispatch,
return every parameter result for analysis, preserve the kernel's sparse
orders/fills, and produce inspectable full equity curves without retaining the
entire result matrix in memory. It remains isolated from the Tea compiler and
the OpenChart monorepo.

## 3. Implementation

1. **Create the standalone experiment boundary** — `package.json`,
   `tsconfig.json`, `AGENTS.md`, `README.md` in
   `tea-lang-typegpu-experiment`
   - Pin concrete npm dependencies for TypeGPU, its Rollup plugin, Dawn,
     boundary parsing, and package-local tooling.
   - Provide separate download, sweep, artifact, test, typecheck, and benchmark
     commands without modifying Tea or root workspace configuration.

2. **Own normalized market snapshots** — `src/market-data.ts`, `src/contracts.ts`
   - Page Binance's market-data-only API into cached BTCUSDT `1d` and `1h`
     snapshots, excluding the current incomplete candle.
   - Parse remote payloads from `unknown`, enforce finite positive OHLC values
     and strict chronology, and store venue/symbol/interval metadata plus a
     content digest. Tests use checked-in tiny fixtures and never the network.

3. **Define one deterministic backtest contract** — `src/backtest-contract.ts`,
   `src/cpu-backtest.ts`
   - Implement close-based rolling SMAs, strict crossover after warmup,
     next-open all-in/all-out market fills, 1 bp adverse slippage and fee,
     final-close marking, and online maximum drawdown using explicit `f32`
     operation order.
   - CPU replay owns inspectable orders, fills, round trips, and equity points;
     focused cases lock warmup, timing, accounting, and final-bar expiry.

4. **Implement the TypeGPU sweep** — `src/typegpu-kernel.ts`,
   `src/typegpu-engine.ts`, `src/node-gpu.ts`
   - Inject a Dawn-created `GPUDevice` into TypeGPU and pack concatenated series,
     descriptors, parameters, summaries, and a bounded atomic event journal.
   - Dispatch one invocation per job in one compute pass and one compute queue
     submission, then perform three sequential copy-only readbacks.
   - Reject invalid jobs and device-limit violations before submission; stop
     the implementation if TypeGPU lacks a required public capability.

5. **Persist only reconciled output** — `src/artifacts.ts`, `src/cli.ts`
   - Sort GPU events by job and sequence, validate lifecycle/accounting during
     CPU journal replay, and fail before completion if identities, counts, or
     metrics exceed the documented 8-ULP aggregate tolerance.
   - Stream summaries and journals plus row-major `f32` equity data with an
     offset index. Write a complete manifest only after every artifact closes;
     benchmark mode does not implicitly generate multi-gigabyte equity output.

6. **Document feasibility and extension seams** — `README.md`, `AGENTS.md`
   - Record the exact Node/Dawn command flow, single-dispatch limitations,
     artifact sizes, journal overflow behavior, and how another instrument is
     added as another packed series descriptor.

## 4. Verification

- [x] `npm ci && npm run typecheck` succeeds from the nested package alone.
- [x] `npm test` proves SMA warmup/crossover, next-open fills, fees/slippage,
      final marking, invalid data rejection, event ordering, and overflow.
- [x] A tiny Dawn GPU run exactly matches the CPU reference within stated `f32`
      tolerances and records the expected order/fill journal.
- [x] `npm run download -- --symbol BTCUSDT --intervals 1d,1h` produces valid,
      completed, chronological snapshots and a reproducible manifest.
- [x] A bounded `npm run sweep` executes both full snapshots in one TypeGPU
      dispatch and returns every summary plus phase timings. The dense default
      hard-fails because its 40,994,756 events exceed the 128 MiB binding limit.
- [x] A bounded artifact smoke run streams orders, fills, round trips, and full
      equity curves; no all-curves in-memory allocation occurs.
- [x] `npm run benchmark` reports repeated runs without silently batching jobs.
- [x] Targeted Prettier and `git diff --check` pass; the existing dirty `bun.lock`
      remains untouched.
