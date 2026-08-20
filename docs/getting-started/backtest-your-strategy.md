---
title: Backtest your strategy
hide_title: true
---

# Backtest your strategy

This walkthrough uses Tea's explicit broker, portfolio, and trade coordinator
values. All execution and accounting policy is Tea source compiled into the
same `Program` as the user's signals.

## 1. Read the strategy

The runnable source is `examples/strategy/cpu-gpu-next-open/strategy.tea`:

```tea
//@version=1
strategy("Next-open strategy", shorttitle="Next open", overlay=false)

import broker
import portfolio
import trade

slippage = input.float(0.1, "Slippage", minval=0.0)
fee = input.float(0.1, "Fee", minval=0.0)
initial_cash = input.float(121.0, "Initial cash", minval=1.0)

var strat = trade.nextOpen(
    broker = broker.new(
        commission = broker.commissionRate(fee),
        slippage = broker.slippageRate(slippage),
        processOrdersOnClose = false
    ),
    portfolio = portfolio.new(
        initialCash = initial_cash,
        pyramiding = 1,
        marginLong = 100.0,
        marginShort = 100.0
    )
)

strat.begin_bar(open, bar_index)

if bar_index == 0
    strat.entry("Long", trade.Direction.long)
if bar_index == 1
    strat.close("Long")
if bar_index == 2
    strat.entry("Long", trade.Direction.long)

expired = strat.end_bar(close, barstate.islast)
metrics = strat.snapshot()

plot(metrics.cash, "cash")
plot(metrics.positionQuantity, "position quantity")
plot(metrics.equity, "equity")
plot(metrics.realizedPnl, "realized pnl")
plot(metrics.totalFees, "total fees")
plot(metrics.fillCount, "fill count")
plot(metrics.roundTripCount, "round-trip count")
plot(metrics.maxDrawdown, "maximum drawdown")
plot(na(expired) or na(expired.pending) ? 0 : expired.pending.id, "expired order id")
```

`strategy()` is the native first-statement declaration; it publishes script
metadata and does not create an execution object. `import trade` binds the
ordinary coordinator library. There is no `strategy` package. `broker`,
`portfolio`, and `trade` are explicit because their policy is part of the
program, not a platform setting.

`broker.new` selects decimal commission and slippage rates and keeps fills at
the next open. `portfolio.new` selects a signed net portfolio with a 100%
capital requirement in either direction. This example only opens long and
omits `qty`, so the broker uses its commission-aware all-available-cash sizing.
`trade.nextOpen` stores those two concrete values directly and exposes only the
next-open lifecycle; it does not wrap a universal strategy object.

## 2. Read the bars

`examples/data/demo/strategy-bars.csv` contains:

```csv
open,close
10,10
10,11
20,18
```

The entry submitted after row 0's `begin_bar` fills at row 1's open. The close
submitted after row 1 fills at row 2's open. The final entry has no later open,
so the last `end_bar` expires order id `3`.

## 3. Run it

```sh
tea run examples/strategy/cpu-gpu-next-open/strategy.tea \
  --input examples/data/demo/strategy-bars.csv
```

`run` uses the JavaScript CPU backend by default. It prints system statistics,
effective parameters, the complete dense table, and typed sparse effects.
Source parameters become CLI options after compilation:

```sh
tea run examples/strategy/cpu-gpu-next-open/strategy.tea \
  --input examples/data/demo/strategy-bars.csv \
  --slippage 0 --fee 0 --initial_cash 100
```

With 10% adverse slippage and a 10% taker fee, the fixture ends with two fills,
one completed round trip, cash/equity `162`, realized PnL `41`, total fees `29`,
and maximum drawdown `11 / 121`. Those values come from the Tea-authored
packages, not from the host runner.

## 4. Make an execution reproducible

The canonical durable command is:

```text
tea execute <config> [--json]
```

For example, the repository includes a real Binance Spot BTCUSDT daily sweep:

```sh
tea execute examples/strategy/ema-cross/sweep.yaml
```

The configuration is ordinary YAML (JSON is also accepted):

```yaml
schema: tea.execution/v1

program:
  source: ./strategy.tea

runtime:
  kind: javascript

execution:
  kind: sweep
  provider:
    kind: csv
    path: ../../data/binance/btcusdt-1d.csv
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
Binance snapshot recorded in `examples/data/binance/btcusdt-1d.source.json`.

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
binding. `execution.kind: sweep` forms the Cartesian product of its ranges;
`maxExecutions` defaults to and cannot exceed 10,000, and rejects an oversized
product before it is materialized. A sweep with no ranges is valid and has one
binding. `tea execute` accepts no runtime, parameter, tracing, or visualization
overrides: the config is its single execution specification. `--json` changes
only publication into the versioned renderer-neutral result.

### Explore a sweep in VS Code or Cursor

The Tea editor extension can use the same execution config without adding an
editor-specific run format. In a trusted local workspace, run
`Tea: Open Sweep Dashboard` and select the YAML or JSON file. The normal Tea
editor stays open on the left; the dashboard opens beside it with a restrained
3D parameter surface above a selected execution's trajectory.

Tea's one-shot JSON result contains the compact sweep summary plus each
execution's row-aligned scalar outputs and typed effects captured during that
same sweep. Clicking a point selects its trajectory locally; it does not retain
a Tea process or rerun the strategy. The trajectory uses provider timestamps
and can annotate `broker.FillExecuted` entries and exits. The extension calls
the versioned `tea execute <config> --json` interface, then uses the shared
visualization projection without embedding another compiler or runtime.

Because drill-down comes from the completed sweep, Programs using
request-backed contexts retain the same result they originally produced.
Snapshot hashes identify the config, Tea source closure, primary provider, and
clock used by that result.

If `tea` is not available on the extension host's `PATH`, set the
application-scoped `tea.executablePath` setting to an absolute executable path.
The command is intentionally unavailable in untrusted workspaces.

JSON sweep capture accepts scalar output transports and has a 256 MiB charged
retention/projection limit. Use it for daily data and other moderate histories.
Multi-million-row minute sweeps require output selection or another generic
result transport; Tea fails clearly rather than truncating or silently
rerunning them.

### Direct source commands

`tea run` and `tea sweep` are the source-and-dynamic-parameter entry points.
They translate their flags into the same structured parameter selections,
provider, runtime, and execution-context path used by `tea execute`:

```sh
tea run strategy.tea -i data.csv --length 10
tea sweep strategy.tea -i data.csv --length 2:20:2
```

The direct `run` spelling defaults to JavaScript and accepts `--gpu`; direct
`sweep` defaults to WebGPU and accepts `--cpu`. A source still has to fit the
selected backend. Today, every canonical strategy reaches struct-backed trade
state and therefore needs JavaScript. Their source and input paths resolve from
the invocation working directory. `tea execute` instead takes its runtime and
execution choices entirely from the config; v1 intentionally does not merge
CLI parameter or runtime overrides into that file.

## Lifecycle ownership

The calls are ordinary Tea:

1. `begin_bar(open, bar_index)` processes a previously pending order and
   applies its fill.
2. Signal logic calls `entry` or `close`.
3. `end_bar(close, isLast)` optionally processes and applies an on-close fill
   when `processOrdersOnClose=true`, then marks the portfolio.
4. On the final bar, `end_bar` expires any command that remains pending.

The compiler does not insert, reorder, count, or enforce these calls. A custom
strategy can select `trade.ohlc`, `trade.path`, or `trade.lots` when it needs a
different explicit lifecycle. Each family is a direct concrete coordinator
constrained by compatible broker and portfolio interfaces; no host dispatches
on the family name.

## Parameter sweeps and the current GPU boundary

`sweep` expands numeric `start:stop:step` axes in source declaration order. It
selects WebGPU by default, but this strategy contains struct-backed broker,
portfolio, and trade values. Run it with `--cpu`:

```sh
tea sweep examples/strategy/cpu-gpu-next-open/strategy.tea \
  --input examples/data/demo/strategy-bars.csv \
  --slippage 0:0.2:0.1 --fee 0 --initial_cash 100 --cpu
```

If you omit `--cpu`, Tea stops during WGSL eligibility checking with
`struct-reference-lowering-unimplemented`. It does not run part of the
strategy on the GPU and it does not silently switch runtimes. The existing
WebGPU backend remains usable for scalar and numeric programs that do not
reach struct values.

Visualization is a separate consumer of Tea's renderer-neutral JSON result.
The editor dashboard uses the shared visualization projection; the Tea CLI
does not start a browser or own visualization state.

Each binding has isolated runtime state and can eventually vary providers,
symbols, or other inputs—not just parameters. The sweep reporter requests only
final dense values and no effect payloads. The `tea` CLI runs under Node with
the packaged `tsx` loader; GPU commands dynamically load the optional `webgpu`
Dawn binding in that same process.
No path introduces a strategy compiler or host-side matching/accounting.

The result model and X/Y/Z/slice projection are renderer-neutral. The editor's
Plotly adapter uses pinned local assets, so visualization does not send strategy
results to a CDN.

See [Strategy model](../strategy.md) for the normative source contract and
[GPU Lowering](../advanced/gpu-lowering.md) for the backend boundary.

For a fuller signal-driven example, `examples/strategy/ema-cross/strategy.tea`
uses `ta.ema`, `ta.crossover`, and `ta.crossunder` directly and trades the
signals with next-open execution. Its checked-in `tea execute` configuration
selects JavaScript; `tea run` and `tea sweep --cpu` use the same source. The
adjacent source record pins the Binance API, coverage dates, row count, and CSV
SHA-256 for reproducibility.
