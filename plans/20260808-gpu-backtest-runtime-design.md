# GPU backtest runtime: domain model, feasibility, dual lowering

## 1. System map

```text
            packages/tea-lang/docs/backtest.md   (semantic source of truth)
            time model | order lifecycle | matching | accounting | precision
                     |                                   |
        CPU: oracle + live path              GPU: parameter sweep
                     |                                   |
  Tea Program --JS codegen--> JSRuntime    Tea Program --WGSL codegen--> strategy module
       |   rt host-service seam                 |   strategy_init/on_bar ABI
       v                                        v
  BacktestHost (TS)                        runtime.wgsl (hand-written)
   +- exchange: match/fill                  +- outer bar loop
   +- accounting: position/pnl              +- exchange: same rules
   +- recorder                              +- accounting + atomic journal
       |                                        |  per-job state in job-strided
       v                                        v  storage buffers, multi-dispatch
  trades/equity  <------ differential ------> summaries/journal
```

- Source of truth is the semantics doc; both runtimes are projections of it and
  a differential conformance suite (L3) enforces agreement.
- The strategy contract is identical on both targets and matches the Tea IR
  `host-service` effect class ([ir.md](../packages/tea-lang/docs/ir.md)):
  intents emitted at bar `t` close, matched during bar `t+1`, fill/position
  feedback readable at bar `t+1`. This is the seam that makes bar-synchronous
  GPU execution and future live execution the same model.
- A module = one function interface + one state struct. Upgrading fidelity
  (L1 bar-synthesized book -> L2 depth) replaces one module's text and state
  without touching the loop, strategy ABI, or accounting.
- Precision is layered: exchange math uses integer ticks/lots (bit-portable
  across CPU/Metal/Vulkan, kills the f32 SMA-crossing parity bug class);
  strategy signal math stays f32 with a documented tolerance.
- Open decision (resolved by probe step 2): GPU cash/PnL representation —
  f32 with measured drift vs. emulated 64-bit integer (2x u32 add-with-carry).

## 2. Problem

The TypeGPU experiment proved one-dispatch parameter sweeps work (64
full-history jobs, 132k journal events, ~190 ms) but with a hardcoded SMA
strategy whose entire state is ~20 scalars in registers
([typegpu-kernel.ts](../packages/tea-lang/experiment/typegpu/src/typegpu-kernel.ts)).
We have since decided to drop TypeGPU and lower Tea IR directly to WGSL against
a hand-written runtime. What is missing is (a) a backtest/live domain model
that is tape-driven — a host-premerged, timestamp-sorted record tape consumed
in lockstep, with Bar as the first record kind; Nautilus's dynamic event
routing, not event ordering, is what is GPU-incompatible — yet keeps its
proven matching/accounting semantics, (b) an
answer to whether arbitrary strategy/orderbook state survives GPU limits —
registers, 16 KiB workgroup memory, storage binding sizes, watchdogs — and how
dispatches must be scheduled, and (c) a CPU lowering of the same semantics to
serve as correctness oracle, sweep-necessity baseline, and live-execution
engine.

Scope boundary: this plan delivers the semantics doc, feasibility numbers, and
the two reference runtimes driven by hand-written fixture strategies. Wiring
`strategy.*` natives into the Tea checker/noder and the Tea->WGSL compiler
backend are follow-up plans.

## 3. Implementation

1. **Semantics doc** — `packages/tea-lang/docs/backtest.md`
   - Distill Nautilus into a tape-driven model: the outer loop consumes a
     host-premerged sorted record tape (today only Bar records). Two clocks:
     the exchange advances per tape record; the strategy is invoked at its own
     cadence (bar close), so fill-fidelity upgrades (quote/trade records) never
     touch the strategy ABI. Keep/drop table:

   | Nautilus | Keep (simplified) | Drop |
   |---|---|---|
   | Strategy/DataActor | `on_init` + `on_bar` | ~40 callbacks, actor lifecycle, msgbus, cache |
   | OrderMatchingEngine | `OrderMatchingCore` predicates (`is_limit_matched`, `is_stop_matched`) + bar->OHLC tick synthesis | latency queue, emulator, risk engine, venue IDs |
   | Order model | Market/Limit/StopMarket/StopLimit; Accepted -> Filled/Canceled/Expired; GTC/IOC | 9 types/16 states, trailing, OTO/OCO, Pending* |
   | FillModel | deterministic predicate + fill-price fn (BestPrice + fixed slippage baseline) | probabilistic RNG models (later: per-job seeded) |
   | Accounting | flat per-job position driven only by `apply(fill)`; single currency | margin, multi-currency, Money/Currency, Portfolio |
   | Fixed point | integer price ticks (i32) / quantity lots (u32), per-instrument scale | i64 raw x 10^9 universal scalar |

   - Specify the intra-bar order of operations, the next-bar feedback contract,
     the fixed-capacity pools (open orders per job, journal) with hard-fail
     overflow, and every module seam (orderbook, fill, fee, data granularity,
     multi-instrument descriptors) as interface + state struct.
   - Dynamic-event rule: the only dynamic sequence is the shared uniform tape;
     per-job future events (strategy timers, order latency) are timestamp
     fields (`next_timer_ts`, `effective_at`) polled against the tape clock,
     never per-job event queues.
2. **GPU feasibility probes** — extend `packages/tea-lang/experiment/typegpu`
   - State-residency: move sweep state to job-strided storage buffers; measure
     throughput vs. register baseline at 256 B / 1 KiB / 4 KiB / 16 KiB per job.
   - Multi-dispatch bar-slicing: state persists in storage across N dispatches;
     results must be bit-identical to one dispatch. This is the watchdog and
     journal-capacity answer: the full 47k-job grid runs as scheduled batches
     with `requiredLimits` raised toward the adapter max (4 GiB on M2 Max).
   - Workgroup-size sweep (32/64/128/256) and atomic-journal contention at
     millions of events. Output: a budget formula (`jobs x stateBytes` vs.
     binding limits) and a host-side dispatch-planning policy, written into the
     semantics doc as the scheduling section.
3. **CPU BacktestHost** — new standalone package
   `packages/tea-lang/experiment/backtest-runtime` (same isolation invariants
   as the typegpu experiment; no monorepo imports)
   - TypeScript exchange/accounting/recorder implementing the doc exactly,
     integer tick math, driven per-bar through the same
     `strategy_init/strategy_on_bar` ABI shape with hand-written fixture
     strategies (SMA cross; a stateful limit+stop strategy).
   - Include a worker-parallel CPU sweep runner reporting `totalBarSteps/s` —
     the sweep-necessity baseline.
4. **runtime.wgsl** — same package
   - Hand-written WGSL runtime ported from the experiment's generated shader
     (`/tmp/typegpu-backtest.wgsl` is the reference); raw WebGPU host layer
     (device, layout module for std430 offsets, dispatch planner from step 2).
   - The template's only holes: symbol references resolved by concatenating the
     strategy module, plus compiler-emitted `const` declarations. Fixture
     strategies are hand-written WGSL modules against the ABI.
5. **Differential conformance harness** — same package
   - Runs CPU host and GPU runtime on identical jobs: exchange events must be
     exactly equal (integer math); signal-path divergence must sit inside the
     doc's tolerance. This gate is what later certifies the Tea->WGSL backend.

## 4. Verification

- [ ] Doc review: the L1->L2 orderbook swap is describable as one module
      replacement; every seam names its interface and state struct.
- [ ] `state-residency` probe: throughput curve recorded for 256 B–16 KiB/job;
      storage-resident baseline within measured, documented cost of registers.
- [ ] `bar-slicing` probe: N-dispatch run bit-identical to single dispatch
      (same summaries and journal bytes).
- [ ] Full 47k-job grid completes via batching with every event retained or a
      hard overflow failure — never truncation.
- [ ] Conformance: CPU vs GPU exchange events byte-equal on both fixture
      strategies over full BTC 1d+1h history; f32 signal drift within tolerance.
- [ ] CPU baseline documented: `totalBarSteps/s` CPU (1 core / N workers) vs
      GPU for the same grid.
- [ ] `npm ci && npm test` green in both experiment packages on Node 22;
      `bun test` in `packages/tea-lang` untouched.
