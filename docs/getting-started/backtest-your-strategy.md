---
title: Backtest a strategy
sidebarTitle: Backtest a strategy
---

A finite backtest is one Node bound to finite DataStreams and executed by a
Batch Recipe. The embedding application owns data acquisition.

## 1. Write the strategy

```tea


import broker
import portfolio
import trade

fast_length = input.int(20)
slow_length = input.int(50)

fast = ta.ema(close, fast_length)
slow = ta.ema(close, slow_length)

var state = trade.nextOpen(
    broker.new(),
    portfolio.new(initialCash = 100000.0)
)

state.begin_bar(open, bar_index)
if ta.crossover(fast, slow)
    state.entry("Long", "Short cover", trade.Direction.long)
if ta.crossunder(fast, slow)
    state.entry("Short", "Long close", trade.Direction.short)

state.mark(close)
metrics = state.snapshot()
plot("equity", metrics.equity, "equity")
```

The strategy source owns trading policy. Broker, portfolio, and coordinator
libraries own their concrete execution and accounting semantics.

## 2. Prepare finite data

For the CLI, use a numeric CSV:

```csv
time,open,high,low,close,volume
1704067200000,100,103,99,102,1200
1704153600000,102,104,100,103,980
```

`time` is exact epoch milliseconds. The CLI gives the resulting DataStream an
exact finite `indices` count.

Embedding applications can construct the same input directly:

```ts
import {Field, Float64, Schema, TimestampMillisecond} from 'apache-arrow';
import {from} from 'rxjs';
import {DataStream, d} from 'tea';

const values = [
  {
    time: 1704067200000n,
    open: 100,
    high: 103,
    low: 99,
    close: 102,
  },
  {
    time: 1704153600000n,
    open: 102,
    high: 104,
    low: 100,
    close: 103,
  },
];
const bars = new DataStream(
  new Schema([
    new Field('time', new TimestampMillisecond(), false),
    ...['open', 'high', 'low', 'close'].map(
      name => new Field(name, new Float64(), false),
    ),
  ]),
  from(values),
  d,
  values.length,
);
```

The application decides whether values came from a file, broker, database, or
network API. Tea receives only the DataStream.

## 3. Run one CLI Batch

```bash
tea run strategy.tea -i bars.csv \
  --fast_length 20 \
  --slow_length 50
```

`tea run` compiles once, binds the CSV DataStream and parameters, executes one
Batch Recipe, and renders complete Datums. Use `--trace` for the stable machine
trace format.

The CLI currently exposes one finite `run`. Parameter grids return with the
future Sweep Recipe so sweep semantics have one real owner.

## 4. Use the public API

```ts
const node = tea`
length = input.int(20)
plot(ta.ema(close, length))
`;

const sink = new StdoutSink<Datum>();
const result = await batchRecipe(node, [{length: 10}, bars], sink).execute();

console.log(result.indices);
```

The Recipe stores ordinary public bindings and an observer. It adds no executor
or storage model; `execute()` calls `Node.bind()` and `Node.to()` and waits for
completion.

## Request data

For a strategy with requests, bind each child stream by declaration name:

```tea
daily = request.security("AAPL", "D", close)
lower = request.security_lower_tf("AAPL", "15", close)
```

```ts
await batchRecipe(
  node,
  [rootBars, {daily: dailyBars, lower: fifteenMinuteBars}],
  sink,
).execute();
```

The symbol and timeframe tell the application what data the child represents;
Tea does not fetch or resample it. Node owns synchronization once the streams
are bound. See [Requests](../requests.md).

## Reproducibility

Pin the source data and parameter values in the application or test that creates
the Recipe. A deterministic finite run is identified by:

- the Tea source closure;
- exact input values and event times;
- parameter bindings;
- request-child streams;
- the Pine historical execution clock when `timenow` is used.

Tests should hash immutable data files when provenance matters. That is an
application/test responsibility, not a runtime config schema.

## GPU boundary

GPU execution is a separate target-specific API over a compiled WGSL artifact
and concrete numeric arrays. It has no generic CPU/GPU backend wrapper and no
caller memory/chunk/cache controls. See [GPU lowering](../advanced/gpu-lowering.md).

A future GPU Recipe may package that common use, just as Batch packages the
public Node path. Until then, applications call `createGpuExecution()` directly.
