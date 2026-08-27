---
title: 'Requests: binding child DataStreams'
sidebarTitle: Requests
---

Tea does not fetch requested data. An application supplies the root DataStream
and binds each request child by its declaration name. Node owns child execution,
synchronization, history, and cancellation.

```text
Tea source   daily = request.security("AAPL", "D", close)
                         │
                         ▼
Program      RequestEdge{name: "daily", child Program, policy}
                         │
application              │ node.bind({daily: dailyStream})
                         ▼
Node         child Node ──sync──▶ parent Node
```

The symbol and timeframe remain useful application-facing metadata in the
Program. They do not imply a registry, network client, or runtime
lookup. A browser, CLI, chart, or service decides how to turn that metadata into
a DataStream.

## Child execution

Each RequestEdge owns one recursive `JSModule` and one private child Node. The
child uses the same parameter values and runtime rules as the root, but has no
public outputs. After each successful child step, Node copies the requested
scalar result into the synchronization buffer.

Only scalar and recursively scalar-tuple results can cross the child boundary.
Heap references, resources, arrays, matrices, and maps never cross it. Each
child owns and disposes its own runtime and Heap.

`request.security_lower_tf` still captures one scalar child result per child
index. Node groups those copied scalars and materializes the resulting Tea array
inside the parent Heap transaction.

## Direct declaration and binding identity

Supported requests must be direct top-level declarations:

```tea
daily = request.security("AAPL", "D", close)
lower = request.security_lower_tf("AAPL", "15", close)
```

Requests inside local blocks, functions, methods, or another request capture
remain unsupported. Dynamic symbol and timeframe values fail during noding.

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
or unknown. Event time is separate data. A Zod object schema may declare:

```ts
time: z.bigint(); // exact epoch-ms interval open
time_close: z.bigint(); // exact epoch-ms interval close
```

These fields do not enter Tea numeric series. Node validates safe epoch-ms
values, nondecreasing opens and closes, and `time_close >= time`. A close field
is interval metadata only when the same schema declares `time`.

For finite execution, `DataStream.indices` is the exact number of emissions.
Node validates it and the Pine Extension uses it for `last_bar_index` and
`barstate.islast`. Live streams leave `indices` null and cannot use
extent-dependent Pine builtins.

## Synchronization policies

Node folds request edges in dense request-id order. The parent does not step
until every edge has supplied a value for the current parent input.

`request.security` uses two generic fields:

- `availability="start" | "end"` chooses when a child interval becomes
  eligible;
- `fill="carry" | "sparse"` chooses whether the last eligible value continues
  across later parent inputs.

Tea intentionally does not expose Pine's `barmerge.gaps_*` or
`barmerge.lookahead_*` vocabulary.

| Request policy             | Required metadata                               | Parent value                                         |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| start-available scalar     | `time` on both streams                          | child selected at interval start, with chosen fill   |
| end-available scalar       | `time` and `time_close` on both streams         | child selected at interval end, with chosen fill     |
| scalar positional          | otherwise                                       | next child scalar                                    |
| contained interval collect | `time` and `time_close` on both streams         | child intervals fully contained by parent interval   |
| event-time collect         | `time` on both streams                          | child opens between consecutive parent opens         |
| fixed-count collect        | divisible known clocks and no usable event time | next `parentClock / childClock` child values         |
| positional collect         | otherwise                                       | next child scalar wrapped as a one-element Tea array |

Observed event boundaries outrank clock ratios because duration alone does not
prove phase alignment or the absence of missing observations.

An empty timed scalar child produces the result layout's typed empty value. An
empty timed collect window produces `[]`. Child values that arrive after their
parent boundary are consumed as late and never reassigned to a later interval.
Future values remain buffered.

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

The generated manifest retains the request declaration's symbol, timeframe,
mode, result layout, and synchronization policy. This is static language data,
not an instruction for Tea to acquire external data.

`calc_bars_count` remains visible to applications as a trailing-history hint.
An application may use it when constructing the child DataStream, but Node
correctness depends only on the stream it actually receives.

## Staged beyond this slice

- dynamic requests;
- requests nested inside another request capture;
- live watermark and provisional-child policies;
- an application-specific source registry, if an application chooses to build
  one.
