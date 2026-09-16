# Tea examples

`examples/` is the human-facing runnable catalog. It is intentionally separate
from the test corpus under [`tests/fixtures`](../tests/fixtures/): embedding
examples may use live application sources, while automated tests never reach
the network.

## Layout

| Directory                  | Contents                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`api/`](api/)             | Runnable TypeScript embedding examples using the public `tea` package export and local or live sources/sinks.                                                                   |
| [`tea/`](tea/)             | Small Tea programs for inspecting compiler-generated TypeScript.                                                                                                                |
| [`strategy/`](strategy/)   | Runnable strategies, one directory per strategy. Each directory owns Tea source, behavioral notes, and provenance. The catalog README records the clean-room TradingView audit. |
| [`indicator/`](indicator/) | Indicator and data-request demonstrations that do not place orders.                                                                                                             |
| [`language/`](language/)   | Focused demonstrations of Tea language semantics.                                                                                                                               |
| [`data/`](data/)           | Inputs for the runnable examples. Venue snapshots live under venue-specific directories with adjacent provenance; small synthetic inputs live under `data/demo/`.               |

Code under `src/` and fixtures under `tests/fixtures/` must not depend on this
directory. Add reusable test inputs to `tests/fixtures/`, not here.

## JavaScript API examples

`npm install` builds the JavaScript package entry automatically. After changing
compiler or API source, refresh it with `npm run build:package` before invoking
an example directly with Node.

Start with the self-contained synchronous example. It compiles Tea, binds
parameters and a finite in-memory stream, and subscribes stdout to execute and
print every result:

```sh
node examples/api/simple-sync.ts
```

To inspect the TypeScript actually emitted by the compiler, build
[`tea/accumulate.tea`](tea/accumulate.tea). The source contains two independent
accumulator calls and parameter-bound history:

```sh
tea build examples/tea/accumulate.tea -o /tmp/accumulate.ts
```

The Batch Recipe example performs the same public `bind()` and `to()` wiring,
but keeps it as one reusable finite run and waits for completion:

```sh
node examples/api/simple-batch.ts
```

To see live stream processing, run the Subject-backed example. It pushes one
datum per second after execution starts and publishes each result to stdout and
`tea-stream-output.csv` from the same runtime:

```sh
node examples/api/simple-tail.ts
```

The descriptive `simple-stream.ts` name runs the same example:

```sh
node examples/api/simple-stream.ts
```

The remaining examples demonstrate concrete I/O adapters. Run deterministic
local CSV examples through the built `tea` package:

```sh
node examples/api/csv-to-stdout.ts examples/data/demo/primary.csv
node examples/api/csv-to-csv.ts examples/data/demo/primary.csv /tmp/tea-output.csv
node examples/api/csv-request-to-csv.ts \
  examples/data/demo/primary.csv examples/data/demo/primary.csv /tmp/tea-request.csv
```

The examples provide explicit numeric Zod schemas because CSV headers describe
columns, not scalar types. Each public Node Datum keeps its `index`, optional
`time`, exact output and channel arrays, effects, and provisional state.

Final-datum JSON WebSocket examples are also available:

```sh
node examples/api/websocket-to-stdout.ts ws://localhost:8080/input
node examples/api/websocket-to-websocket.ts \
  ws://localhost:8080/input ws://localhost:8080/output
```

They require caller-owned Zod schemas, do not reconnect, and treat every JSON
message as one final datum. Automated tests use fake sockets and never access
the network.

## Strategy stress catalog

[`strategy/README.md`](strategy/README.md) audits twelve open-source
TradingView strategies and links each clean-room Tea implementation. Together
with the first-party `cpu-gpu-next-open` and `ema-cross` examples, the runnable
strategy catalog contains fourteen sources. Every conversion owns a documented
historical profile and measured results over real market data. The set
deliberately exercises rolling statistics, requests, arrays,
nested loops, per-lot state, long/short accounting, target allocations,
pyramiding, pending orders, cancel/replace, brackets, trailing exits, and
deterministic same-bar OHLC matching.

Every source composes an explicit direct trade family: `trade.nextOpen`,
`trade.ohlc`, `trade.path`, or `trade.lots`. The coordinator stores its concrete
broker and portfolio values directly; examples do not implement accounts,
construct fills, or emit broker lifecycle effects.

Compile every conversion without making network requests:

```sh
npm test -- tests/strategy-catalog.test.ts
```

All fourteen strategies use struct-backed broker, portfolio, or trade state,
so current execution uses JavaScript. WGSL lowering of one of these complete
programs fails with
`struct-reference-lowering-unimplemented`; Tea does not silently fall back to
CPU. Scalar and numeric programs that do not reach a struct can still use the
current WGSL subset. Each strategy README records its public mode, deliberate
boundaries, data provenance, and any source-page discrepancy.

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

Run one scenario on CPU:

```sh
tea run examples/strategy/ema-cross/strategy.tea \
  -i examples/data/binance/btcusdt-1d.csv \
  --fast_length 10 --slow_length 32 --initial_cash 100000
```

The snapshot is a reproducible stress input, not a claim about future returns.

## Small next-open strategy

[`strategy/cpu-gpu-next-open/strategy.tea`](strategy/cpu-gpu-next-open/strategy.tea)
is a small deterministic CPU example. It delegates next-open fills, fees, and
accounting to the shipped Tea-authored broker, portfolio, and trade libraries.

```sh
tea run examples/strategy/cpu-gpu-next-open/strategy.tea \
  -i examples/data/demo/strategy-bars.csv
```

## Indicators and language demonstrations

Request examples require the embedding application to bind each named child
DataStream. [`api/csv-request-to-csv.ts`](api/csv-request-to-csv.ts) shows the
complete two-stream public path.

```sh
tea run examples/language/struct-references.tea \
  -i examples/data/demo/primary.csv
```
