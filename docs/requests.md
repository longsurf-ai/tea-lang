# Requests: cross-context data and the source facade

Authority for request execution and the data-source registry. `docs/ir.md`
owns the compile-time shape (RequestEdge, capture rules); `docs/runtime.md`
owns the runtime basics this builds on (frames, rings, provisional protocol,
SeriesView). This document owns everything between a `request.*()` call and
a driver fetching bytes.

```text
Tea script   request.security("FRED:CPIAUCSL", "M", close)     Pine surface,
                 |  compile: the whole family lowers            unchanged
                 v  to one primitive
IR           RequestEdge{symbol, timeframe, merge, child Program}
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

interface RangeDemand {
  from: number | null; // epoch ms; null = source's full extent
  to: number | null; // epoch ms; null = latest available
  bars: number | null; // alternative: trailing bar count
}

interface TimeAxis {
  time(row: number): number; // bar OPEN time, epoch ms UTC
  closeTime(row: number): number; // bar CLOSE time, epoch ms UTC
}

interface ProviderContext {
  rows: number;
  axis: TimeAxis | null; // null = axis-less context
  series(id: string): SeriesData | null; // same alignment contract
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
- `RangeDemand` is what makes pagination tractable: bind computes it (the
  primary axis extent, depth demands, `calcBarsCount`) so a driver knows
  when to stop paging and never fetches blindly.
- Time is the join key for merge, so a merging context must expose both
  bar-open and bar-close times — the primary context included, since it
  serves as the merge parent (csv fixtures provide an epoch-ms `time`
  column of bar opens; a bar closes when the next opens, the last spanning
  its predecessor's interval).
- `ContextError` is a typed result (`unknownSource | unknownSymbol |
unsupportedTimeframe | fetchFailed`), never a thrown string: the runtime
  maps it to BindError, runtime error, or `na` per `ignoreInvalidSymbol`.
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
  or the runtime.
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
   standard ambient series set. Single-valued sources (FRED) map the value
   to `close` and collapse `open`/`high`/`low` to it; `volume` is na.
   Derived ids (`hl2`, `hlc3`, …) follow from the standard set. A demanded
   id the driver cannot serve is a `ContextError`, never a silent na fill
   of a whole series.
2. **Resampling is driver-owned**: a request for `"W"` against a
   daily-native source aggregates in the driver (OHLC first/max/min/last,
   volume sum). A driver that cannot produce the requested timeframe
   reports `unsupportedTimeframe` — it never returns a mislabeled axis.
3. **Honest axes**: `time`/`closeTime` reflect the source's real bar
   boundaries. The runtime never guesses session calendars; alignment
   quality is a driver property.

## Child execution

The generated module gains one nested module-shaped object per RequestEdge
(`manifest.requests[rid]` carrying the child's manifest + init/bind/funcs/main).
The runtime binds a child instance exactly as it binds a program — same
frames, rings, commit machinery, recursively for nested requests — against
the resolved ProviderContext, with two differences:

- Params are compilation-global (`ir.md`): the child reads the parent's
  bound params and declares none.
- A child has no outputs. Its sole emission is `resultName`, an ordinary
  ring in the child's program frame; merge reads that ring's **committed**
  values.

Child instances are keyed `(edge, symbol, timeframe)` in a per-binding
instance table. Identical pairs on one edge share an instance; cross-edge
dedup is a later optimization, not a semantic requirement.

## Merge

Merge is a pure function of (parent axis, child axis, child committed
result, MergePolicy). Its product is **a parent-row-indexed SeriesView per
edge**, which `rt.request(rid, offset)` reads — so `result[1]` is "whatever
the request returned on the previous parent bar", regardless of which pair
served that bar (dynamic requests included).

The view contract deliberately does not say the merged column is
materialized. **Merge is alignment, not data movement**: the view is
defined by the child's committed storage plus a parent→child row mapping
(per row under dynamic requests, an (instance, childRow) pair — still
indices, never values). A sample-merge mapping is monotonic, so it
compresses to O(child bars) breakpoints; a low-resolution child under a
dense parent axis — or a wide multi-column child later — must never be
duplicated across parent rows. Materializing the merged column is a legal
first implementation, not the contract; the zero-copy mapping
implementation must remain reachable without touching the ABI or this
section's semantics.

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

Collect mode (`security_lower_tf`) returns the array of child results whose
bars fall inside the parent bar — gated on the collections slice (staged).

## Static and dynamic requests

Pine v6 semantics (`dynamic_requests`, default **true**):

- Context args (`symbol`, `timeframe`) may be series; the requested
  expression is always a static template — it cannot depend on enclosing
  local-scope variables. The checker enforces this in the existing capture
  rules; the IR needs nothing new (bind-evaluability of the context args
  distinguishes the forms, published as `RequestSpec.dynamic`).
  `dynamic_requests=false` on the indicator declaration restores the
  static-only gate (a noder error).
- Unique contexts are capped: default 40 per binding (Pine parity),
  configurable via `BindInputs.maxRequestContexts`; the budget spans
  request children. Exceeding it is a `RequestError`.

Execution:

- **Static edges** (const/input context args): the frame-aware bind section
  evaluates the args (like bindOutput args), awaits `resolveContext`, runs each
  child over its full history, and prepares the merged view. No row ever
  suspends.
- **Dynamic edges**: the offset-0 read evaluates the context args inline
  and calls `rt.requestFor(rid, sym, tf)` — and that read IS the edge's
  execution, so the noder materializes it: no alias binding, no history
  collapse onto the place. `r = request.security(sym, …)` stays a real
  per-row Name write and `r[1]` is a name-ring read (the parent-row
  history of "whatever the request returned", whichever pair served each
  row); direct `request(...)[k]` rides the synthetic $hist name. The
  edge's own result ring backs `rt.request(rid, offset)` for hand-written
  modules. One merged view per `(edge, pair)`, built on first encounter.
- **Suspension**: an unresolved pair throws `ContextSuspension` out of
  `executeRow`; the host awaits `resolvePending()` (where
  `resolveContext`, the child's full-history run, and the merge happen)
  and re-executes the same row. **The aborted execution vanishes
  entirely** — the retry resets ALL scratch, varip included, from
  committed state, so results are byte-identical to having had the data
  upfront. `runAll` performs this loop itself; live hosts follow the same
  protocol per tick. Determinism holds; no async ever touches row code.
- Errors: for static edges a failed context is a `BindError`; for dynamic
  pairs it is a `RequestError` mid-run — or a per-row na (plus a warn
  event) when the edge's `ignoreInvalidSymbol` is set. na context args
  yield na for the row. The unique-context ceiling
  (`BindInputs.maxRequestContexts`, default 40, shared across children)
  is a `RequestError` when exceeded.

## Staged beyond this slice

Collect merge and `security_lower_tf` (needs collections);
`dividends/splits/earnings/economic/financial` catalog sugar over the
namespace conventions; `MergePolicy.currency` conversion;
`calcBarsCount` limits; live ticks driving child contexts (child
provisional state exists, push feeds do not); cross-edge instance dedup;
disk caching for network drivers.
