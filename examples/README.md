# Tea examples

## EMA crossover strategy

`ema-cross-strategy.tea` is a parameterized long-only EMA crossover over
`binance-btcusdt-1d.csv`: 3,283 real Binance Spot BTCUSDT daily bars from
2017-08-17 through 2026-08-12 UTC. The immutable source record and SHA-256 live
in `binance-btcusdt-1d.source.json`. The script uses the shipped `ta.ema`,
`ta.crossover`, and `ta.crossunder` functions directly, then delegates
next-open fills, fees, and accounting to the shipped
broker/portfolio/strategy packages.

The checked-in execution configuration runs a 100-scenario WebGPU sweep over
that exact dataset:

```sh
tea execute examples/ema-cross-sweep.yaml
tea execute examples/ema-cross-sweep.yaml --view
```

`program.source` and `execution.provider.path` are relative to the YAML file,
not the shell's working directory. The provider SHA-256 is copied from the
source record and checked against the exact CSV bytes before execution. The
fixed `timeNow` makes this historical execution independent of the host clock.

The direct commands remain available for one-off use. Run one backtest with
defaults or overrides:

```sh
tea run examples/ema-cross-strategy.tea -i examples/binance-btcusdt-1d.csv

tea run examples/ema-cross-strategy.tea -i examples/binance-btcusdt-1d.csv \
  --fast_length 10 --slow_length 32 --initial_cash 100000 \
  --slippage 0.0005 --fee 0.001

tea run examples/ema-cross-strategy.tea -i examples/binance-btcusdt-1d.csv --gpu \
  --fast_length 10 --slow_length 32 --initial_cash 100000
```

Run the same Program through the legacy GPU-default sweep spelling, or add
`--cpu` to use the JavaScript runtime:

```sh
tea sweep examples/ema-cross-strategy.tea -i examples/binance-btcusdt-1d.csv \
  --fast_length 2:20:2 --slow_length 24:60:4 \
  --initial_cash 100000 --slippage 0.0005 --fee 0.001 --view

tea sweep examples/ema-cross-strategy.tea -i examples/binance-btcusdt-1d.csv \
  --fast_length 2:20:2 --slow_length 24:60:4 \
  --initial_cash 100000 --slippage 0.0005 --fee 0.001 --cpu
```

`--view` opens a loopback-only interactive 3D view. Choose two numeric range
parameters for X and Y and any final numeric output for Z. If more parameters
are ranges, each remaining dimension gets an explicit slice selector. Auto
mode renders a complete grid with at least two values per axis as a surface,
preserving null metrics as holes; incomplete or degenerate grids use points.

This is a fixed historical snapshot rather than a claim about future returns.
It makes the sweep reproducible while still exercising real gaps, volatility,
cross timing, next-open fills, fees, and drawdowns.

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
`sweep` requests only each binding's final dense values and no effect payloads,
so reporting and transport memory do not grow with bar history. The optional
viewer projects the renderer-neutral sweep result into a selected scene and
serves its pinned Plotly adapter locally without a CDN. The Bun launcher safely
relays Dawn execution to an installed Node 22 process (`TEA_GPU_NODE` may
select it); compilation and runtime semantics stay on the same public path.

The other `.tea` files demonstrate requests and value semantics. They are CPU
examples and are not necessarily inside the current fail-closed WGSL subset.
