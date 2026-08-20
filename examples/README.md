# Tea examples

`examples/` is the human-facing runnable catalog. It is intentionally separate
from the test corpus under [`tests/fixtures`](../tests/fixtures/): examples may
use live data providers, while automated tests never reach the network.

## Layout

| Directory                  | Contents                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`strategy/`](strategy/)   | Runnable strategies, one directory per strategy. A strategy directory owns its Tea source and any execution configuration specific to it. The catalog README also records the clean-room TradingView audit. |
| [`indicator/`](indicator/) | Indicator and data-request demonstrations that do not place orders.                                                                                                                                         |
| [`language/`](language/)   | Focused demonstrations of Tea language semantics.                                                                                                                                                           |
| [`data/`](data/)           | Inputs for the runnable examples. Venue snapshots live under a provider-specific directory with adjacent provenance; small synthetic inputs live under `data/demo/`.                                        |

Code under `src/` and fixtures under `tests/fixtures/` must not depend on this
directory. Add reusable test inputs to `tests/fixtures/`, not here.

## Strategy stress catalog

[`strategy/README.md`](strategy/README.md) audits twelve open-source
TradingView strategies and links each clean-room Tea implementation. Together
with the first-party `cpu-gpu-next-open` and `ema-cross` examples, the runnable
strategy catalog contains fourteen sources. Every conversion owns an execution
config, a documented historical profile, and measured results over real market
data. The set deliberately exercises rolling statistics, requests, arrays,
nested loops, per-lot state, long/short accounting, target allocations,
pyramiding, pending orders, cancel/replace, brackets, trailing exits, and
deterministic same-bar OHLC matching.

Every source composes an explicit direct trade family: `trade.nextOpen`,
`trade.ohlc`, `trade.path`, or `trade.lots`. The coordinator stores its concrete
broker and portfolio values directly; examples do not implement accounts,
construct fills, or emit broker lifecycle effects.

Compile every conversion and validate its exact Cartesian grid without making
network requests:

```sh
bun test tests/strategy-catalog.test.ts
```

Run a particular measured sweep through its checked-in config, for example:

```sh
tea execute examples/strategy/turtle-system/sweep.yaml
tea execute examples/strategy/alice-grid/sweep.yaml
```

The catalog pins four of fourteen sources as currently WGSL-eligible:
`atr-zigzag-breakout`, `cpu-gpu-next-open`, `ema-cross`, and `turtle-system`.
The other ten fail closed on a specific unsupported generic Program construct;
they do not silently fall back to CPU. A source may be WGSL-eligible while its
checked-in measured config deliberately selects JavaScript. Among the twelve
audited profiles, Turtle publishes a WebGPU sweep and the others publish
JavaScript sweeps. Each strategy README records its selected public mode,
deliberate boundaries, data provenance, and any source-page discrepancy.

## Real market data

`data/binance/` contains two immutable BTCUSDT fixtures:

- `btcusdt-1d.csv`: 3,283 daily bars used by the broad historical sweeps.
- `btcusdt-15m.csv`: 20,000 complete 15-minute bars used by the intraday grid
  and Cowabunga execution tests.

Each CSV has an adjacent source manifest containing its SHA-256, time range,
normalization rules, and provenance. Automated tests verify hashes, cadence,
finite OHLCV values, and price envelopes. The 15-minute file is a deterministic
aggregation of a separately hash-pinned Binance one-minute archive; its
[`derive-btcusdt-15m.ts`](data/binance/derive-btcusdt-15m.ts) script reproduces
the checked-in bytes from that exact normalized parent. The manifest explicitly
records that the raw archive inventory and timestamp-normalization log were not
retained, so this is derivation-verifiable rather than a claim of full raw-source
reproducibility.

## EMA crossover strategy

[`strategy/ema-cross/strategy.tea`](strategy/ema-cross/strategy.tea) is a
parameterized long-only EMA crossover over 3,283 Binance Spot BTCUSDT daily
bars from 2017-08-17 through 2026-08-12 UTC. The CSV, immutable source record,
and SHA-256 are under [`data/binance/`](data/binance/).

Run the checked-in 100-scenario WebGPU sweep:

```sh
tea execute examples/strategy/ema-cross/sweep.yaml
```

Paths in the execution config are relative to the YAML file. Its fixed
`timeNow` and pinned provider digest make the historical run independent of the
working directory, host clock, and later data changes.

Run one scenario on CPU or GPU:

```sh
tea run examples/strategy/ema-cross/strategy.tea \
  -i examples/data/binance/btcusdt-1d.csv

tea run examples/strategy/ema-cross/strategy.tea \
  -i examples/data/binance/btcusdt-1d.csv --gpu \
  --fast_length 10 --slow_length 32 --initial_cash 100000
```

The direct sweep command remains available. It uses GPU by default; add
`--cpu` to select the JavaScript runtime.

```sh
tea sweep examples/strategy/ema-cross/strategy.tea \
  -i examples/data/binance/btcusdt-1d.csv \
  --fast_length 2:20:2 --slow_length 24:60:4 \
  --initial_cash 100000 --slippage 0.0005 --fee 0.001
```

The snapshot is a reproducible stress input, not a claim about future returns.

## CPU/GPU lifecycle strategy

[`strategy/cpu-gpu-next-open/strategy.tea`](strategy/cpu-gpu-next-open/strategy.tea)
is a small deterministic strategy for exercising the same compiled `Program`
on both runtimes. It delegates next-open fills, fees, and accounting to the
shipped Tea-authored broker, portfolio, and trade libraries.

```sh
tea run examples/strategy/cpu-gpu-next-open/strategy.tea \
  -i examples/data/demo/strategy-bars.csv

tea sweep examples/strategy/cpu-gpu-next-open/strategy.tea \
  -i examples/data/demo/strategy-bars.csv \
  --slippage 0:0.2:0.1 --fee 0 --initial_cash 100 --cpu
```

## Indicators and language demonstrations

The request examples use the local primary timeline but fetch requested series
through the configured providers. They may therefore require network access or
provider credentials.

```sh
tea run examples/indicator/requests-tour.tea \
  -i examples/data/demo/primary.csv

tea run examples/indicator/dynamic-rotation.tea \
  -i examples/data/demo/primary.csv

tea run examples/language/struct-references.tea \
  -i examples/data/demo/primary.csv
```
