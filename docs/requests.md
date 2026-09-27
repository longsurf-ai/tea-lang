---
title: 'Requests: binding child DataStreams'
sidebarTitle: Requests
---

Tea does not fetch requested data. An application supplies the root DataStream
and binds each request child by its declaration name. Node owns child execution,
synchronization, history, and cancellation.

## Write the calculation in its own input context

A request is a direct top-level declaration. Its captured expression runs on
the child's bars, with the child's own history. Use an ordinary function when
that calculation needs several statements:

```tea
previousAverage() =>
    average = ta.sma(close, 20)
    average[1]

daily = request.security("AAPL", "D", previousAverage(), fill="carry")
plot("previous_daily_average", daily)
```

Here `average[1]` means the previous **child** bar's average. `daily[1]` in the
parent would instead mean the value seen on the previous **parent** bar.
History indexing requires a named binding: bind a function result first,
then index it; `ta.sma(close, 20)[1]` is not valid Tea.

The request call itself cannot be inside a function, local block, method, or
another request capture. The function above contains only the calculation;
the top-level `daily` declaration owns the request. Symbol and timeframe must
be static. Each capture returns one scalar. To obtain several values, declare
one named request per scalar; each declaration needs its own host binding,
even when their symbol and timeframe match. Tuple and struct captures are not
supported by the language checker.

The symbol and timeframe remain useful application-facing metadata in the
Program. They do not imply a registry, network client, or runtime
lookup. A browser, CLI, chart, or service decides how to turn that metadata into
a DataStream.

## Child execution

Each RequestEdge owns one recursive `Module` and one private child Node. The
child uses the same runtime rules as the root, but owns independent parameter
values and has no public outputs. `node.bind({length: 50}, ["daily"])` configures
the child named daily; `node.bind(stream, ["daily"])` connects its input. Both
return a new root Node and leave its previous tree unchanged. After each successful child step, Node copies the requested
scalar result into the synchronization buffer.

Only scalar results can cross the child boundary. Tuples, heap references,
resources, arrays, matrices, and maps are rejected by the language checker. Each
child owns and disposes its own runtime and Heap.

`request.security_lower_tf` still captures one scalar child result per child
index. Node groups those copied scalars and materializes the resulting Tea array
inside the parent Heap transaction.

## Bind streams by declaration name

```tea
daily = request.security("AAPL", "D", close)
lower = request.security_lower_tf("AAPL", "15", close)
```

The public binding key is the declaration name (`daily`, `lower`), never the
symbol. A root series and request with the same name are ambiguous and binding
fails before mutation.

```ts
batchRecipe(
  node,
  [parameters, rootStream, {daily: dailyStream, lower: lowerStream}],
  observer,
).execute();
```

Parameters and DataStreams remain the only `Node.bind()` forms. Request data is
not a third binding kind.

## Clock and event-time inputs

`DataStream.clock` describes a regular duration when known; `i` means irregular
or unknown. Event time is separate data, declared by ordinary Arrow fields:

```ts
import {Field, Float64, Schema, TimestampMillisecond} from 'apache-arrow';

const schema = new Schema([
  new Field('time', new TimestampMillisecond(), false),
  new Field('close', new Float64(), false),
]);
// {time: 0n, close: 10} opens at epoch millisecond 0.
```

These fields do not enter Tea numeric series. Timestamp values may be numbers
or bigints; Node requires exact safe epoch-ms integers in increasing order between
finalized steps. A non-nullable Bool `provisional` field enables repeated attempts
at the same timestamp; it defaults to false when absent. The current step must
finalize before time advances, and finalized timestamps cannot be revised.
A non-nullable Bool `realtime` field identifies live delivery, including final
live attempts; it defaults to false for historical sources.
Arrow `Int64` also supports existing bigint sources. Use non-nullable times for
timed request synchronization; nullable time fields can represent absent or
explicitly null event metadata.

## Synchronization policies

Node folds request edges in dense request-id order. The parent does not step
until every edge has supplied a value for the current parent input.

A child value is eligible for a parent input once the child's event time is at
or before the parent's event time. `request.security` uses one generic field:

- `fill="carry"` reuses the last eligible child value across later parent inputs,
  including when the child has no new observation. `fill="sparse"` leaves those
  gaps empty. For comparisons requiring matching observations, use sparse and
  preserve missing values; carry means "latest available", not "same time".

Tea intentionally does not expose Pine's `barmerge.gaps_*` or
`barmerge.lookahead_*` vocabulary, and it has no end-of-interval availability.
For a completed-interval calculation, select by the child's timestamp and the
host's interval boundaries. A child's `[1]` means its previous observation,
not necessarily its most recently completed interval: if no forming child row
is supplied, the latest child may already be complete. Test both input shapes.

| Request policy      | Required metadata                               | Parent value                                         |
| ------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| timed scalar        | `time` on both streams                          | newest child opened at or before the parent, filled  |
| scalar positional   | otherwise                                       | next child scalar                                    |
| event-time collect  | `time` on both streams                          | child opens between consecutive parent opens         |
| fixed-count collect | divisible known clocks and no usable event time | next `parentClock / childClock` child values         |
| positional collect  | otherwise                                       | next child scalar wrapped as a one-element Tea array |

Observed event boundaries outrank clock ratios because duration alone does not
prove phase alignment or the absence of missing observations.

An empty timed scalar child produces the result layout's typed empty value. An
empty timed collect window produces `[]`. Provisional parent attempts retain the
same child window; final parent attempts advance it. Multiple attempts of one
child step contribute only its latest value, never duplicate collect entries.
Positional final attempts wait for their child steps to finalize.

A new child step that arrives after its parent interval finalized is rejected
before that child step executes. Refinements of the current uncommitted child
step remain valid, even if its higher-timeframe open precedes the parent's last
time. They affect subsequent parent attempts only; child delivery alone does not
rerun a committed parent. Applications deliver known child changes before the
parent attempt that should use them. Future values remain buffered.

## Ordering, completion, errors, and cancellation

- Request children subscribe before their parent so cold finite sources can
  populate the synchronization buffer.
- A child error fails the shared Node graph once.
- A parent error or observer delivery error unsubscribes every child.
- Disposing the root Node recursively disposes all child runtimes.
- Timed synchronization may continue serving parent inputs after a finite child
  completes; carried scalar values and typed empty values do not require a live
  child subscription.

There is no request queue, source budget, context lease, or fixed result
column. Node retains only the buffered copied values required by the selected
policy.

## Static request metadata

Each module request entry retains the request declaration's symbol, timeframe,
mode, result layout, and synchronization policy. This is static language data,
not an instruction for Tea to acquire external data.

`calc_bars_count` remains visible to applications as a trailing-history hint.
An application may use it when constructing the child DataStream, but Node
correctness depends only on the stream it actually receives.

## Staged beyond this slice

- dynamic requests;
- requests nested inside another request capture;
- live watermark policies;
- an application-specific source registry, if an application chooses to build
  one.
