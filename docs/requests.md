---
title: 'Requests: cross-context data and the source facade'
sidebarTitle: Requests
---

Authority for request execution and the data-source registry. `docs/ir.md`
owns the compile-time shape (RequestEdge, capture rules); `docs/runtime.md`
owns the runtime basics this builds on (frames, bounded history, provisional protocol,
SeriesView). This document owns everything between a `request.*()` call and
a driver fetching bytes.

```text
Tea script   request.security("FRED:CPIAUCSL", "M", close)     Pine surface,
                 |  compile: the whole family lowers            unchanged
                 v  to one primitive
IR           RequestEdge{symbol, timeframe, context order,
                          option expressions/order, child Program}
                 |  bind (async)
                 v
Runtime      child instance per (edge, symbol, timeframe)
             child rows -> commit -> MERGE onto the parent axis
             (sample/collect, gaps/lookahead — source-independent)
                 |  resolveContext(symbol, timeframe, range)
                 v
Provider     prefix registry:  "FRED:" -> fred(apiKey)
             "" -> host primary | unprefixed -> yahoo   csv
             drivers normalize + resample; errors are typed
                 ^
Host config  registry construction + API keys (CLI config / OpenChart)
```

- One primitive: every `request.*` family member lowers to a RequestEdge.
  `security_lower_tf` is collect merge; `dividends`/`splits`/`earnings`/
  `economic`/`financial` are namespace conventions plus a fixed child body.
  One merge engine, N drivers.
- The facade is not a language feature. Pine already namespaces symbols by
  prefix (`NASDAQ:AAPL`, `FRED:UNRATE` are valid TradingView symbols), so
  source routing lives entirely in the host's registry; existing Pine
  scripts run unchanged. This is the superset-while-compliant mechanism:
  quantmod's `src="FRED"` becomes the `FRED:` prefix.
- Named `symbol` and `timeframe` arguments evaluate in source order and are
  then assembled into the canonical runtime pair. The captured expression is
  not part of that parent schedule; it executes once per row in the child
  Program's context.
- Merge semantics are runtime-owned and never delegated to drivers: a FRED
  monthly series sampled onto a daily axis obeys exactly the gaps/lookahead
  rules an equity HTF request obeys.

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
  CLI hands in `process.env`; OpenChart hands in its own store). Driver
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
`abi`/shared-layout/manifest/bind/funcs/main shape as its parent;
`manifest.requests[rid]` owns only the JSON-safe edge metadata.
The fixed-historical adapter binds a child exactly as it binds the root — same
frames, State/Intermediate transition, recursively for nested requests — against
the resolved ProviderContext, with two differences:

- Params are compilation-global (`ir.md`): the child reads the parent's
  bound params and declares none.
- A child has no outputs. Its `resultName` is an ordinary root-frame value;
  after each successful final step the host copies that current value into the
  result column.

The root binding constructs one shared host environment containing the exact
value-layout registry, request-context budget, fixed-value logical-byte budget,
and the Heap-limit configuration. Every static child receives those shared
facts but constructs an independent Heap, `StructStorageRuntime`, and
`CollectionRuntime`. The configured Heap limits therefore apply separately to
each execution context.

The request boundary admits only scalars and recursively scalar-only tuples;
the checker rejects structs, collections, resources, and tuples containing any
of them, and binding validates the physical result layout again. Each successful
child-row result is recursively copied into a parent-owned column. That column
reserves exactly `rows * shallowBytes(layout)` from the shared fixed-value
budget. After copying the column, the fixed-historical adapter disposes the
child `JSRuntime` and its Heap; the parent view retains only copied values and
their logical storage accounting. A `Ref` never crosses the request boundary.
Aggregate request results remain unsupported until they
have an explicit deep graph-copy contract.

Each static edge owns one completed result view for its bind-time context pair.
Cross-edge deduplication is a later optimization, not a semantic requirement.
Heap isolation means parent and child transactions never contend for one arena.

## Merge

Merge is a pure function of (parent axis, child axis, child committed
result, MergePolicy). Its product is **a parent-row-indexed SeriesView per
edge**, which `rt.request(rid, offset)` reads — so `result[1]` is "whatever
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

Collect mode (`security_lower_tf`) will return the array of child results whose
bars fall inside the parent bar. It requires both the collect merge policy and
an explicit child-to-parent aggregate graph-copy contract, so it remains a
separate staged request feature.

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
provide. The request-context budget still spans recursively bound static child
contexts, with one context pair per edge.

The fixed-historical host adapter recursively executes these static children
through the sole `JSRuntime`. Each bound `JSModule` directly stores its static
pair, options, child module, and retention, but `TeaNode.to()` currently
rejects a ready module with requests because its
child Observable/runtime wiring has not been implemented. Binding readiness is
therefore not a claim that TeaNode can execute requests yet. Request-source
bindings still participate in TeaNode's atomic mutable binding step: a failed
keyed bind leaves both the recursive module state and the already-built
Observable graph unchanged.

Each edge also owns four bind-time options in canonical order: `gaps`,
`lookahead`, `ignore_invalid_symbol`, and `calc_bars_count`. They remain
concrete Program expressions, and their separate evaluation-order permutation
preserves source order among options before assembling that canonical vector.
Omitted values are the concrete defaults `false`, `false`, `false`, and `0`.
The generated module's pure `evaluateBinding(values)` function returns exactly one request
entry containing the pair and four options for every edge. The manifest retains
only merge mode, so there is no second owner for bound option values.

All four options accept `simple` expressions evaluable from the root bind
frame. Function/capture locals and row-varying dependencies are rejected.
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

- `JSModule.evaluateBinding(values)` evaluates each edge's context args and output args and
  returns immutable request data. The fixed-historical host then awaits
  `resolveContext` with the bound range demand, runs the child over its exposed
  extent, and prepares the merged view. No supported row execution discovers a
  context or suspends.
- The parent reads the prepared view through `rt.request(rid, offset)`. History
  is parent-row-indexed and follows the same direct-readable-binding rule as
  other values.
- Empty symbol/timeframe values inherit the current Program context's effective
  identity. At the root that may still be the host's empty/default pair; in a
  nested request it means the surrounding child, never an accidental jump back
  to the root provider default.
- A failed context is a `BindError`, or an empty prepared view when the edge's
  `ignoreInvalidSymbol` option is enabled. Context-budget exhaustion is also a
  bind-time failure.

## Staged beyond this slice

Dynamic series context arguments and their execution suspension protocol;
collect merge and `security_lower_tf`;
`dividends/splits/earnings/economic/financial` catalog sugar over the
namespace conventions; currency-aware context identity and FX conversion;
live ticks driving child contexts (child
provisional state exists, push feeds do not); cross-edge instance dedup;
disk caching for network drivers.
