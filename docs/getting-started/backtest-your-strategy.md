---
title: Backtest your strategy
hide_title: true
---

# Backtest your strategy

This walkthrough uses Tea's explicit broker, portfolio, and strategy values.
All execution and accounting policy is Tea source compiled into the same
`Program` as the user's signals.

## 1. Read the strategy

The runnable source is `examples/strategy-cpu-gpu.tea`:

```tea
//@version=1
strategy("CPU/GPU next-open strategy", shorttitle="CPU/GPU", overlay=false)

import broker
import portfolio
import strategy

slippage = input.float(0.1, "Slippage", minval=0.0)
fee = input.float(0.1, "Fee", minval=0.0)
initial_cash = input.float(121.0, "Initial cash", minval=1.0)

var strat = strategy.configure(
    broker = broker.basic(slippage, fee),
    portfolio = portfolio.basic(initial_cash)
)

strat.begin(open, bar_index)

if bar_index == 0
    strat.entry("Long", strategy.Direction.long)
if bar_index == 1
    strat.close("Long")
if bar_index == 2
    strat.entry("Long", strategy.Direction.long)

expired = strat.end(close, barstate.islast)

plot(strat.cash(), "cash")
plot(strat.position_quantity(), "position quantity")
plot(strat.equity(), "equity")
plot(strat.realized_pnl(), "realized pnl")
plot(strat.total_fees(), "total fees")
plot(strat.fill_count(), "fill count")
plot(strat.round_trip_count(), "round-trip count")
plot(strat.max_drawdown(), "maximum drawdown")
plot(na(expired) ? 0 : expired.id, "expired order id")
```

`strategy()` is contextual first-statement metadata. `import strategy` binds
the ordinary package used by later selectors. All three packages are explicit
because their policy is part of the program, not a platform setting.

## 2. Read the bars

`examples/strategy-bars.csv` contains:

```csv
open,close
10,10
10,11
20,18
```

The entry submitted after row 0's `begin` fills at row 1's open. The close
submitted after row 1 fills at row 2's open. The final entry has no later open,
so the last `end` expires order id `3`.

## 3. Run it

```sh
tea run examples/strategy-cpu-gpu.tea \
  --input examples/strategy-bars.csv
```

`run` uses the JavaScript CPU target by default. It prints system statistics,
effective parameters, the complete dense table, and typed sparse effects.
Source parameters become CLI options after compilation:

```sh
tea run examples/strategy-cpu-gpu.tea \
  --input examples/strategy-bars.csv \
  --slippage 0 --fee 0 --initial_cash 100
```

With 10% adverse slippage and a 10% taker fee, the fixture ends with two fills,
one completed round trip, cash/equity `162`, realized PnL `41`, total fees `29`,
and maximum drawdown `11 / 121`. Those values come from the Tea-authored
packages, not from the host runner.

## 4. Make an execution reproducible

The canonical durable command is:

```text
tea execute <config> [--view|--trace]
```

For example, the repository includes a real Binance Spot BTCUSDT daily sweep:

```sh
tea execute examples/ema-cross-sweep.yaml
tea execute examples/ema-cross-sweep.yaml --view
```

The configuration is ordinary YAML (JSON is also accepted):

```yaml
schema: tea.execution/v1

program:
  source: ./ema-cross-strategy.tea

runtime:
  kind: webgpu

execution:
  kind: sweep
  provider:
    kind: csv
    path: ./binance-btcusdt-1d.csv
    sha256: fea088e4b139c8e99fe115e5ccdc5c85f2f1b25d6af38a7e71a29dfef1d0545d
  parameters:
    fast_length:
      range: {start: 2, stop: 20, step: 2}
    slow_length:
      range: {start: 24, stop: 60, step: 4}
    initial_cash: 100000
    slippage: 0.0005
    fee: 0.001
  maxExecutions: 100
  timeNow: 1786579200000
```

This boundary deliberately remains three parts:

1. **Tea Core** compiles `program.source` once through the ordinary frontend to
   the one target-independent `Program`.
2. **The runtime** executes that Program on JavaScript or WebGPU; selecting a
   runtime never creates another compiler path.
3. **The execution context** resolves the provider, parameter selections,
   inputs, bindings, fixed time, and run kind into ordered `BindInputs[]` for
   that runtime.

The config is a durable execution-context specification, not a serialized
Program or GPU plan. That same boundary can later describe scans and live
execution without moving provider or deployment policy into Tea Core.

### Configuration v1

The schema is closed: unknown or duplicate fields are errors at every level.
The loader accepts exactly one UTF-8 YAML 1.2 document of at most 1 MiB and
rejects anchors, aliases, merge keys, explicit tags, and directives. It never
performs environment interpolation or executes config content. The configured
Tea source and CSV must already be readable regular files.

Both `program.source` and `execution.provider.path` resolve relative to the
configuration file's directory, not the process working directory. An
optional provider `sha256` is checked against the exact file bytes before
strict UTF-8 decoding. This makes the example refer to the precise checked-in
Binance snapshot recorded in `examples/binance-btcusdt-1d.source.json`.

`execution.parameters` accepts scalar numbers, strings, and booleans. Omitted
parameters keep their Tea source defaults. A numeric sweep axis uses the
explicit form `{range: {start, stop, step}}`; the stop boundary is inclusive
when reached, and ranges expand in source parameter declaration order.
`execution.timeNow` is an optional safe epoch-millisecond integer. If omitted,
the host clock is captured once and shared by every binding in that execution.

The runtime fields are:

| Field                       | Contract                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `kind`                      | Required: `javascript` or `webgpu`.                                                           |
| `maxRowsPerChunk`           | Optional positive u32 WebGPU row ceiling; defaults to 65,536.                                 |
| `effectRecordsPerExecution` | Optional nonnegative u32 WebGPU sparse-effect capacity; when omitted, the runtime derives it. |
| `maxGpuBytes`               | Optional positive u32 WebGPU memory budget.                                                   |
| `maxCacheBytesPerWorkgroup` | Optional nonnegative u32 WebGPU workgroup-cache budget; zero selects storage-only execution.  |

The JavaScript runtime accepts only `kind`; WebGPU resource fields are physical
ceilings rather than language semantics. See [GPU Lowering](../advanced/gpu-lowering.md)
for their allocation behavior.

`execution.kind: run` rejects ranges and `maxExecutions`, producing exactly one
binding. `--trace` is valid only for a run and replaces its human table with
the machine trace format. `execution.kind: sweep` forms the Cartesian product
of its ranges; `maxExecutions` defaults to and cannot exceed 10,000, and
rejects an oversized product before it is materialized. A sweep with no ranges
is valid and has one binding. `--view` is valid only for a sweep with at least
two numeric ranges.
`--view` and `--trace` cannot be combined, and neither changes the execution
context stored in the file.

### Direct-command compatibility

`tea run` and `tea sweep` remain supported for quick invocations. They translate
their flags into the same structured parameter selections, provider, runtime,
and execution-context path used by `tea execute`:

```sh
tea run strategy.tea -i data.csv --length 10
tea sweep strategy.tea -i data.csv --length 2:20:2
```

The direct `run` spelling defaults to JavaScript and accepts `--gpu`; direct
`sweep` defaults to WebGPU and accepts `--cpu`. Their source and input paths
resolve from the invocation working directory. `tea execute` instead takes its
runtime and execution choices entirely from the config; v1 intentionally does
not merge CLI parameter or runtime overrides into that file.

## Lifecycle ownership

The calls are ordinary Tea:

1. `begin(open, bar_index)` processes a previously pending order and applies
   its fill.
2. Signal logic calls `entry` or `close`.
3. `end(close, isLast)` marks the portfolio and performs final expiry.

The compiler does not insert, reorder, count, or enforce these calls. A custom
strategy library can define a different explicit lifecycle.

## Parameter sweeps and GPU execution

`sweep` expands numeric `start:stop:step` axes in source declaration order and
uses GPU by default. `--cpu` runs the same binding list through JavaScript:

```sh
tea sweep examples/strategy-cpu-gpu.tea \
  --input examples/strategy-bars.csv \
  --slippage 0:0.2:0.1 --fee 0 --initial_cash 100

tea sweep examples/strategy-cpu-gpu.tea \
  --input examples/strategy-bars.csv \
  --slippage 0:0.2:0.1 --fee 0 --initial_cash 100 --cpu
```

Add `--view` when at least two parameters use range syntax:

```sh
tea sweep examples/strategy-cpu-gpu.tea \
  --input examples/strategy-bars.csv \
  --slippage 0:0.2:0.1 --fee 0:0.2:0.1 \
  --initial_cash 100 --view
```

The browser view lets you select X and Y from the numeric range parameters and
Z from the Program's final numeric outputs. A third or later range parameter
becomes an explicit slice selector, so every plotted point still represents
one concrete execution. Auto geometry uses a surface for a complete coordinate
grid with at least two values per axis and preserves null metrics as holes;
incomplete or degenerate grids render as points. Selecting Surface explicitly
keeps missing coordinates as holes rather than interpolating them.

Each binding has isolated runtime state and can eventually vary providers,
symbols, or other inputs—not just parameters. The sweep reporter requests only
final dense values and no effect payloads. The Bun CLI relays native Dawn execution
to Node 22; set `TEA_GPU_NODE` if Node 22 is not discovered automatically.
No path introduces a strategy compiler or host-side matching/accounting.

The result model and X/Y/Z/slice projection are renderer-neutral. The current
Plotly adapter is a presentation choice served with pinned local assets on an
IPv4 loopback address, so opening the view does not send strategy results to a
CDN.

See [Strategy model](../strategy.md) for the normative source contract and
[GPU Lowering](../advanced/gpu-lowering.md) for the target boundary.

For a fuller signal-driven example, `examples/ema-cross-strategy.tea` uses
`ta.ema`, `ta.crossover`, and `ta.crossunder` directly, trades the signals with
next-open execution, and runs unchanged through the checked-in `tea execute`
configuration or the compatible `tea run`, `tea run --gpu`, and `tea sweep`
commands. The adjacent source record pins the Binance API, coverage dates, row
count, and CSV SHA-256 for reproducibility.
