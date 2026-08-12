# Tea examples

## EMA crossover strategy

`ema-cross-strategy.tea` is a parameterized long-only EMA crossover over the
43-bar synthetic OHLCV fixture in `ema-cross-bars.csv`. Its deliberate
rise/fall/rise/fall shape produces two completed round trips with the default
5/13 lengths. The script uses ordinary Tea values for the two EMA recurrences
and prior spread, then delegates next-open fills, fees, and accounting to the
shipped broker/portfolio/strategy packages.

Run one backtest with defaults or overrides:

```sh
tea run examples/ema-cross-strategy.tea -i examples/ema-cross-bars.csv

tea run examples/ema-cross-strategy.tea -i examples/ema-cross-bars.csv \
  --fast_length 8 --slow_length 21 --initial_cash 25000 \
  --slippage 0.0005 --fee 0.001

tea run examples/ema-cross-strategy.tea -i examples/ema-cross-bars.csv --gpu \
  --fast_length 8 --slow_length 21 --initial_cash 25000
```

Run the same Program as a GPU-default Cartesian sweep, or add `--cpu` to use
the JavaScript runtime:

```sh
tea sweep examples/ema-cross-strategy.tea -i examples/ema-cross-bars.csv \
  --fast_length 3:9:2 --slow_length 12:24:6 \
  --fee 0.0005:0.0015:0.0005

tea sweep examples/ema-cross-strategy.tea -i examples/ema-cross-bars.csv \
  --fast_length 3:9:2 --slow_length 12:24:6 --fee 0.001 --cpu
```

The fixture is deterministic demonstration data rather than historical market
data. Its two full cycles make the submitted-order, next-open-fill, realized
PnL, fees, and drawdown sections easy to inspect.

## Minimal lifecycle fixture

`strategy-cpu-gpu.tea` is one deterministic strategy intended for the same
Program to run unchanged on CPU and GPU. Its source configures the ordinary
Tea-authored `broker`, `portfolio`, and `strategy` libraries; the host does not
recreate their execution, accounting, or lifecycle rules.

Run the strategy with the ordinary CLI and its default parameters:

```sh
tea run examples/strategy-cpu-gpu.tea -i examples/strategy-bars.csv
```

Override any source-declared parameter after the fixed CLI options are parsed:

```sh
tea run examples/strategy-cpu-gpu.tea -i examples/strategy-bars.csv \
  --slippage 0 --fee 0 --initial_cash 100
```

Run a Cartesian sweep. Sweeps use GPU by default; `--cpu` selects the ordinary
JavaScript runtime:

```sh
tea sweep examples/strategy-cpu-gpu.tea -i examples/strategy-bars.csv \
  --slippage 0:0.2:0.1 --fee 0 --initial_cash 100

tea sweep examples/strategy-cpu-gpu.tea -i examples/strategy-bars.csv \
  --slippage 0:0.2:0.1 --fee 0 --initial_cash 100 --cpu
```

The CLI compiles once to the same generic `Program`, then `executeProgram()`
selects JS or WGSL lowering. Both targets receive the same ordered
`BindInputs[]` and publish through generic sinks. `run` prints system
statistics, effective parameters, full dense rows, and typed sparse effects.
`sweep` keeps only each binding's final dense values and effect counts, so
reporting memory does not grow with bar history. The Bun launcher safely
relays Dawn execution to an installed Node 22 process (`TEA_GPU_NODE` may
select it); compilation and runtime semantics stay on the same public path.

The other `.tea` files demonstrate requests and value semantics. They are CPU
examples and are not necessarily inside the current fail-closed WGSL subset.
