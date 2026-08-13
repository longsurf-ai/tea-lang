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

Each binding has isolated runtime state and can eventually vary providers,
symbols, or other inputs—not just parameters. The sweep reporter requests only
final dense values and no effect payloads. The Bun CLI relays native Dawn execution
to Node 22; set `TEA_GPU_NODE` if Node 22 is not discovered automatically.
No path introduces a strategy compiler or host-side matching/accounting.

See [Strategy model](../strategy.md) for the normative source contract and
[GPU Lowering](../advanced/gpu-lowering.md) for the target boundary.

For a fuller signal-driven example, `examples/ema-cross-strategy.tea` uses
`ta.ema`, `ta.crossover`, and `ta.crossunder` directly, trades the signals with
next-open execution, and runs unchanged through `tea run`, `tea run --gpu`,
and `tea sweep` over the synthetic `examples/ema-cross-bars.csv` fixture.
