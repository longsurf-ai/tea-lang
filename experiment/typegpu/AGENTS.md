# TypeGPU backtest experiment

Standalone Node experiment for evaluating TypeGPU as a physical compute target
for parameter-swept backtests. It is intentionally isolated from the Tea
compiler until the GPU execution model is proven.

## Invariants

- The package is independently installable with npm and never imports from the
  OpenChart monorepo or mutates a parent workspace manifest or lockfile.
- TypeGPU is the only shader authoring and WebGPU abstraction used in this
  experiment. Stop and ask before bypassing it with raw WebGPU operations other
  than device creation, command submission, and buffer readback interoperability
  exposed by TypeGPU.
- One compute dispatch assigns exactly one complete backtest to each invocation;
  batching is not introduced silently if the full dispatch exceeds a device
  limit or watchdog budget.
- Node 22 is the supported native runtime. TypeGPU readbacks are sequential, and
  the Dawn owner remains strongly reachable through process teardown.
- GPU journal overflow and CPU/GPU disagreement fail the run. No artifact
  manifest may describe truncated or unreconciled results as complete.
- Event capacity defaults to the derived worst case (2 events per
  signal-capable bar per valid job — see `worstCaseEventCapacity`), so default
  runs cannot overflow; an explicit `--event-capacity` is a lower bet that
  still hard-fails on overflow. If the kernel's event emission changes, the
  bound changes in the same commit.
- Journal readback deserializes only the cursor-written prefix; capacity
  headroom may cost GPU memory but never readback time. Device storage limits
  are raised automatically up to the adapter maximum to fit the journal, and a
  worst case beyond the adapter maximum fails before any dispatch.
- Full-history artifacts replay the GPU journal as the strategy decision record;
  CPU replay validates lifecycle/accounting and produces rich entities/equity.
  The independent CPU strategy remains the small-fixture conformance oracle.
- Downloaded market data and generated results stay untracked. Tests use only
  checked-in deterministic fixtures and never access the network.
