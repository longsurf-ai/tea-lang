---
title: 'Requests: cross-context data and the source facade'
sidebarTitle: Requests
---

Authority for request execution, public Node request-stream synchronization,
and the data-source registry. `docs/ir.md` owns the compile-time Program shape;
`docs/runtime.md` owns frames, bounded history, transactions, and publication.
This document owns the direct request-declaration restriction, Node binding and
`sync()` policies, and the separate fixed-history provider path.

```text
Tea script   cpi = request.security("FRED:CPIAUCSL", "M", close)
                 |  supported direct declaration lowers
                 v  to one primitive
IR           RequestEdge{name, symbol, timeframe, mode,
                          capture/result types, child Program}
                 |
       +---------+--------------------------------+
       |                                          |
       v                                          v
Node   bind DataStream by `name`          Fixed history (async bind)
       child JSRuntime -> sync policy     resolveContext(symbol, timeframe)
       -> parent step                     -> child JSRuntime -> sample merge
                                                  |
                                                  v
                                         Provider prefix registry + drivers
```

- One primitive: every supported `request.*` family member lowers to a
  RequestEdge. `security` carries one scalar child value; `security_lower_tf`
  carries scalar child values that public Node collects into a parent-owned Tea
  array. The fixed-history adapter supports only scalar `security` sample merge
  and rejects collect. `dividends`/`splits`/`earnings`/
  `economic`/`financial` are namespace conventions plus a fixed child body.
  Fixed-history keeps one sample-merge engine for N drivers; Node uses the
  separate `sync()` projectors specified below.
- The facade is not a language feature. Pine already namespaces symbols by
  prefix (`NASDAQ:AAPL`, `FRED:UNRATE` are valid TradingView symbols), so
  source routing lives entirely in the host's registry; existing Pine
  scripts retain the same symbol spelling. This is the
  superset-while-compliant mechanism:
  quantmod's `src="FRED"` becomes the `FRED:` prefix.
- Named `symbol` and `timeframe` arguments evaluate in source order and are
  then assembled into the canonical runtime pair. The captured expression is
  not part of that parent schedule; it executes once per row in the child
  Program's context.
- Fixed-history merge semantics are runtime-owned and never delegated to
  drivers: a FRED monthly series sampled onto a daily axis obeys exactly the
  gaps/lookahead rules an equity HTF request obeys.

## The provider contract

Context resolution replaces today's `DataProvider.series()` — the primary
context resolves through the same call as every request context, so context
acquisition has exactly one owner. Everything else about series access
(SeriesView, alignment, depth-as-contract) is unchanged from `runtime.md`.

```ts
interface DataProvider {
  resolveContext(
    symbol: string, // '' = host default (the csv file, the chart)
    timeframe: string, // '' = source-native timeframe
    range: RangeDemand,
  ): Promise<ProviderContext | ContextError>;
}

type RangeDemand = {kind: 'full'} | {kind: 'trailing-bars'; bars: number};

interface TimeAxis {
  time(row: number): number; // bar OPEN time, epoch ms UTC
  closeTime(row: number): number; // bar CLOSE time, epoch ms UTC
}

interface ProviderContext {
  rows: number;
  axis: TimeAxis | null; // null = axis-less context
  series(id: string): SeriesData | null; // same alignment contract
  builtinValue(
    source: Extract<BuiltinSource, {domain: 'syminfo' | 'timeframe'}>,
  ): Value | undefined;
}
```

An axis-less context (a csv without a `time` column) still executes; it
just cannot participate in a merge — any request edge over it is a
BindError, so plain single-context scripts keep working on bare fixtures.

- `ProviderContext` and `SeriesData` are accessor contracts, not
  containers — the SeriesView rule. But they answer **synchronously** over
  a **fixed extent**: by hand-over, every row is resident or synchronously
  servable. All asynchrony — pagination, rate limiting, retry/backoff,
  caching — lives inside `resolveContext`, which is async precisely so
  drivers can page until covered. **bind becomes async**; the per-row hot
  path never awaits.
- Fixed-extent is not an implementation convenience but a semantic
  requirement: `last_bar_index`, `barstate.islast`, and lookahead merges
  are statements about the end of history, unanswerable over a stream of
  unknown length. Live growth arrives as ticks through the push protocol,
  never as unbounded iteration. A source too large to materialize is
  served as a narrower `range`, not a streaming row loop.
- `RangeDemand` is closed: `full` requests the source extent and
  `trailing-bars` requests exactly the latest positive safe-integer count.
  A driver may use it to avoid overfetching, but runtime correctness never
  depends on that optimization: an over-returned child is defensively exposed
  as its exact trailing view.
- Time is the join key for merge, so a merging context must expose both
  bar-open and bar-close times — the primary context included, since it
  serves as the merge parent (csv fixtures provide an epoch-ms `time`
  column of bar opens; a bar closes when the next opens, the last spanning
  its predecessor's interval).
- `ContextError` is a typed result (`unknownSource | unknownSymbol |
unsupportedTimeframe | fetchFailed`), never a thrown string: the runtime
  maps it to BindError, runtime error, or `na` per `ignoreInvalidSymbol`.
- `builtinValue` is the only typed symbol/timeframe metadata seam.
  `BuiltinSource.domain` is merely the exact builtin namespace, not a
  factory for provider or runtime context classes. `undefined` means missing
  metadata and fails binding only when the compiled Program demands that
  source; `null`, `NaN`, and `false` remain legitimate typed empty values.
- The runtime resolves the primary context as `resolveContext(inputs.symbol,
inputs.timeframe, range)` with host-named values from BindInputs (empty
  for "the driver's default" — a csv file has exactly one context).

### The source registry

A provider implementation routes by symbol prefix — the quantmod pattern
(`getSymbols` src dispatch + `setSymbolLookup` routing + `setDefaults`
keys), with the prefix as the routing key:

- Registry: `prefix -> driver`; unprefixed symbols go to the default
  driver. The quantmod division of labor: drivers AND the default-source
  policy belong to the package (`builtinSources` — '' is the host's
  primary context, any other unprefixed symbol defaults to yahoo, so
  `request.security("AAPL", …)` works over a csv-driven chart); hosts only
  parameterize it — a primary context and an opaque config record (the
  CLI hands in `process.env`; an embedding host hands in its own store). Driver
  configuration conventions (`FRED_API_KEY`) belong to `builtinSources`,
  the way quantmod's `getSymbols.av` owns its `av.key` convention — hosts
  never know which driver needs what, and keys never appear in Tea source
  or the runtime. Routing may strip a prefix when calling a driver, but the
  returned `syminfo.tickerid` must retain the caller-visible full identity.
- In-package drivers: **csv** (existing), **yahoo** (default; unofficial
  chart API — free, intraday-capable, also carries dividend/split events
  for the later sugar; no contractual stability, an accepted tradeoff for
  a dev tool), **fred** (macro, free key). The roster follows quantmod's:
  the sources it supports, we support, with the same key treatment
  (alphavantage/tiingo staged; stooq was dropped — its csv endpoint now
  sits behind a JavaScript challenge). All are plain `fetch` +
  normalization, zero dependencies.

### Driver obligations

1. **Normalization** (the xts role in quantmod): every context presents the
   standard numeric series set. Single-valued sources (FRED) map the value
   to `close` and collapse `open`/`high`/`low` to it; `volume` is na.
   Derived ids (`hl2`, `hlc3`, …) follow from the standard set. A demanded
   id the driver cannot serve makes `series(id)` return `null`; the runtime
   turns a demanded missing series into `BindError`, never a silent na fill of
   a whole series. `ContextError` is reserved for context resolution failure.
2. **Resampling is driver-owned**: a request for `"W"` against a
   daily-native source aggregates in the driver (OHLC first/max/min/last,
   volume sum). A driver that cannot produce the requested timeframe
   reports `unsupportedTimeframe` — it never returns a mislabeled axis.
3. **Honest axes**: `time`/`closeTime` reflect the source's real bar
   boundaries. The runtime never guesses session calendars; alignment
   quality is a driver property.
4. **Exact identity metadata**: demanded `syminfo.*` and `timeframe.*`
   values come from `builtinValue` with the type promised by the catalog.
   `timeframe.period` names the effective canonical period after any driver
   normalization or resampling. Missing and typed-empty values remain
   distinct.

## Child execution

The generated root gains one nested `JSModule` per RequestEdge.
`JSModule.requests[rid]` is a complete child with the same
`abi`/shared-layout/manifest/concretize/funcs/main shape as its parent;
`manifest.requests[rid]` owns the JSON-safe edge metadata and its late concrete
context.
The fixed-historical adapter binds a child exactly as it binds the root — same
frames and State/Intermediate transition — against the resolved
ProviderContext. Current source rules reject requests inside another request
capture. A child otherwise differs from the root in two ways:

- Params are compilation-global (`ir.md`): the child declares no new UI inputs,
  and its immutable manifest snapshot receives the root's current parameter
  values before child concretization and execution.
- A child has no outputs. Its `resultName` is an ordinary root-frame value;
  after each successful final step the host copies that current value into the
  result column.

Fixed-history root binding constructs one shared host environment containing
the exact value-layout registry, request-context budget, fixed-value
logical-byte budget, and Heap-limit configuration. Every static child receives
those shared facts but constructs an independent Heap,
`StructStorageRuntime`, and `CollectionRuntime`. The configured Heap limits
therefore apply separately to each execution context.

The request boundary admits only scalar child values. The checker rejects
structs, resources, collections, and tuples, and each execution adapter
validates the physical `resultLayout` again. In fixed-history sample mode, each
successful child-row scalar is copied into a parent-owned column. That column
reserves exactly `rows * shallowBytes(resultLayout)` from the shared fixed-value
budget. After copying it, fixed-history disposes the child `JSRuntime` and Heap;
the parent view retains only copied values and their logical accounting. A
`Ref` never crosses the request boundary.

`security_lower_tf` does not transport a child collection. Public Node carries
a frozen batch of copied scalar values into the parent step, where runtime
creates the ordinary Tea array inside the parent Heap transaction. This collect
path is Node-only. Fixed-history rejects collect before resolving its child
provider.

In fixed-history, each static edge owns one completed result view for its
bind-time context pair. Cross-edge deduplication is a later optimization, not a
semantic requirement. Heap isolation means parent and child transactions never
contend for one arena.

## Fixed-history sample merge

Merge is a pure function of (parent axis, child axis, child committed
result, MergePolicy). Its product is **a parent-row-indexed SeriesView per
edge**, which `ctx.request(rid, offset)` reads — so `result[1]` is "whatever
the request returned on the previous parent bar" for that edge's static child.

**Merge is alignment, not repeated data movement**. The child first produces one
parent-owned, by-value transport column; the merged view then combines that
column with a parent→child row mapping. A sample-merge
mapping is monotonic, so it compresses to O(child bars) breakpoints; a
low-resolution child under a dense parent axis must never duplicate its value
for every parent row. The view may avoid materializing the aligned parent-sized
column, but it never retains the disposed child's runtime or Heap.

Sample mode (`security`):

- **lookahead_off** (default): the merged value at parent row `p` is the
  child's result at the last child bar with `closeTime <= time(p) +
barSpan(p)` — i.e. the most recent child bar that has _closed_ by the
  parent bar's close. A child bar still forming contributes nothing:
  under live ticks the child's provisional scratch is invisible to merge,
  which reads committed cells only. HTF repaint-safety falls out of the
  commit protocol instead of being a special case.
- **lookahead_on**: the merged value is the child's result at the child
  bar containing the parent bar's time — on historical data this reads a
  value that was not yet final (Pine's documented repaint footgun,
  implemented for compliance; ledger entry for exact TV boundary
  behavior).
- **gaps_on**: rows where no _new_ child bar closed merge as na;
  **gaps_off** carries the last merged value forward.

Fixed-history accepts only Sample mode. A `security_lower_tf` Collect edge fails
before child-provider resolution; it never silently applies sample alignment. Public
Node collect behavior is the separate synchronization contract below.

## Public Node request streams

Public Node does not resolve provider contexts or reuse the fixed-history axis
merge. The host binds one `DataStream` to each request declaration, and Node
builds one lazy RxJS execution graph from those streams.

### Direct declaration and binding identity

A request call must directly initialize one ordinary top-level variable:

```tea
daily = request.security("X", "D", close)
intraday = request.security_lower_tf("X", "15", close)
```

That variable name is the public binding key:

```ts
node.bind({daily: dailyStream, intraday: intradayStream});
```

The symbol is context configuration, not stream identity. Two declarations may
request the same symbol at different timeframes and bind different streams.
Changing a bound symbol parameter does not clear the declaration's stream. A
key that names both a root series and a request is ambiguous; unknown and
ambiguous keys fail before any module marker or Observable changes.

Inline calls, bare expression statements, tuple targets, `var`/`varip`
declarations, local blocks, functions or methods, and calls inside another
request capture are rejected. The captured child value must be scalar.
`request.security` has source-visible type `T`; `request.security_lower_tf`
captures the same scalar `T` but has source-visible type `array<T>`.

### Clock and event-time inputs

`DataStream.clock` is a regular duration in Tea's nanosecond-based `Clock`
units; `i` means irregular or unknown. Concrete request timeframes convert to a
clock only for positive minute strings and `[N]S`, `[N]D`, `[N]W`, or `[N]M`;
unsupported or empty strings produce `i`. Known clocks bound into one Node must
agree. A known request-timeframe clock must also agree with a known child clock;
`.to()` reports a setup error rather than resampling.

Event time is separate metadata: a directly bound Zod object schema may declare
the reserved field `time: bigint`, representing Unix epoch seconds. It is not a
Tea numeric series and never enters `StepInput.series`. Each source's event time
must be nondecreasing; synchronized root fields that both carry time must agree.
Event-window selection additionally requires strictly increasing main times.

### Synchronization policies

Every request child owns an independent `JSRuntime` and produces its captured
scalar after each successful final step. Node folds request edges in dense rid
order. Each fold uses the existing target-driven `sync()` operator to write one
result into the main datum under the edge's declaration name. Before stepping,
Node projects those named fields back into manifest rid order. The parent
runtime does not step until every edge has supplied its entry.

| Request and policy | Selection                                                  | Ready condition                     | Parent value                                         | Consumed child values            |
| ------------------ | ---------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- | -------------------------------- |
| scalar one-to-one  | every `security` edge                                      | at least one child result           | first `T`                                            | 1                                |
| count window       | Collect; main and child clocks known; `main % child === 0` | at least `N = main / child` results | first `N` values                                     | `N`                              |
| event-time window  | remaining Collect; both schemas declare `time: bigint`     | immediately for each main datum     | values with `previousMain < child.time <= main.time` | late values plus selected prefix |
| array one-to-one   | remaining Collect                                          | at least one child result           | `[first]`                                            | 1                                |

Collect policy precedence is count window, then event-time window, then array
one-to-one. A count ratio must fit in a JavaScript safe integer. The first event
window has no lower bound and selects every buffered child with
`child.time <= main.time`; later windows are open on the left and closed on the
right. An empty event window emits `[]`. A child value arriving at or before the
already emitted lower boundary is late: Node consumes and drops it silently.
Buffered future values remain for a later main datum. Scalar `security` always
uses one-to-one synchronization in Node; its fixed-history `gaps`, `lookahead`,
`ignore_invalid_symbol`, and `calc_bars_count` settings do not select a Node
policy.

### Ordering, completion, errors, and cancellation

`sync()` subscribes its buffered source before its target. Consequently every
child graph is connected before the main stream, even though a main datum may
wait in the target FIFO until enough child values exist. A child/source error
fails the synchronized stream immediately. Target completion discards unused
source values. If a completed source cannot satisfy the oldest pending target,
the synchronized output completes instead of retaining an impossible wait.

The root Node owns one execution connection and one public result
`Subject<Datum>`.
Later sinks observe future root results only. The Subscription returned by
`.to()` controls only that sink; unsubscribing it does not stop the Node-owned
execution. Connection termination or idempotent `dispose()` tears down the
complete child graph, interrupts an in-flight step Effect, and disposes every
runtime once.

### Parent-Heap collect materialization

For a Collect edge, Node passes a frozen raw scalar batch in the corresponding
`StepInput.requests` slot. After the parent Heap transaction opens and before
generated `main`, runtime validates every element against `resultLayout` and
uses the ordinary `array.from` operation to create the array described by the
parent `layout`. `ctx.request` and request history see that parent-owned array.
A failed step aborts its allocation; successful final state retains it through
ordinary Heap root discovery. No child `Ref` or array header crosses runtimes.

## Static requests

The supported request surface requires `symbol` and `timeframe` to be known
during binding. Constants, input-qualified expressions, and
provider-independent root-safe `simple` expressions are accepted. A
series-qualified context expression is classified as `RequestEdge.dynamic` by
the noder and then rejected with:

```text
dynamic requests are not supported yet; symbol and timeframe must be bind-time-known
```

This is fail-closed even when source declares `dynamic_requests=true`; the
declaration option does not enable an execution feature that the runtime cannot
provide. Fixed-history reserves one request-context budget entry for each
accepted static edge.

The fixed-historical host adapter executes each static child
through the sole `JSRuntime`. Each concrete `JSModule` manifest directly stores
its static pair, options, depth, and child metadata, while `requests[rid]` owns
the child code module. It executes only Sample edges and rejects Collect before
provider resolution. Public Node instead receives explicitly bound request
streams by declaration name and applies the synchronization policies above;
symbol identity never selects or fans out a Node stream.

Each edge also owns four bind-time options in canonical order: `gaps`,
`lookahead`, `ignore_invalid_symbol`, and `calc_bars_count`. They remain
concrete Program expressions, and their separate evaluation-order permutation
preserves source order among options before assembling that canonical vector.
Omitted values are the concrete defaults `false`, `false`, `false`, and `0`.
The generated module's `concretize()` method writes exactly one `context`
containing the pair and four options into each request manifest entry. Static
values are emitted there directly; there is no second owner for request
configuration.

All four options accept `simple` expressions reducible during direct
concretization from parameters, immutable root-safe aliases, and permitted
context constants. Function/capture locals and row-varying dependencies are
rejected.
`calc_bars_count` rejects na and known negative values in the checker; runtime
binding then requires a non-negative safe integer. Omitted or zero means full
extent. A positive `N` produces `{kind:'trailing-bars', bars:N}` and exposes
the latest `min(N, available)` child rows even when a provider over-returns:
the child's `bar_index` restarts at zero, history before the retained tail is
typed empty, and parent rows before the limited child window merge to typed
empty.

Option evaluation and context-pair evaluation retain separate source-order
schedules during binding. Options execute before the static context pair. The
captured expression belongs to neither schedule because it runs in the child
Program.

`currency` remains in the positional source signature so later optional
arguments do not shift, but its catalog availability is staged. Supplying it
is a checker error and the generated reference marks it unsupported until
currency becomes part of context identity with a real FX/unit model;
multiplying the final request result is not an acceptable approximation.

Execution:

- Binding deep-copies the recursive manifests, installs parameter values, and
  runs each module's direct `concretize()` method.
- The fixed-historical host reads the frozen request context, awaits
  `resolveContext` with its range demand, runs the child over its exposed
  extent, and prepares the merged view. No supported row execution discovers a
  context or suspends.
- Public Node never resolves that context. It consumes the host-bound
  `DataStream`, synchronizes each child value into the main datum under its
  declaration name, then projects the manifest-ordered request vector passed to
  the same `JSRuntime` interface.
- The parent reads the current or historical value through
  `ctx.request(rid, offset)`. Request history is parent-step-indexed and follows
  the same direct-readable-binding rule as other values.
- Empty symbol/timeframe values inherit the current Program context's effective
  identity in fixed-history. At the root that may still be the host's
  empty/default pair.
- A failed context is a `BindError`, or an empty prepared view when the edge's
  `ignoreInvalidSymbol` option is enabled. Context-budget exhaustion is also a
  bind-time failure. These provider rules do not apply to Node's already-bound
  streams.

## Staged beyond this slice

Dynamic series context arguments and their execution suspension protocol;
fixed-history execution of `security_lower_tf`; request calls outside one
direct plain top-level declaration, including nested request captures;
`dividends/splits/earnings/economic/financial` catalog sugar over the
namespace conventions; currency-aware context identity and FX conversion;
provisional/final live request updates, watermarks, and implicit resampling;
cross-edge instance dedup; disk caching for network drivers.
