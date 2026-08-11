# data

`DataProvider` implementations. The runtime never loads series data; hosts
inject these. `docs/requests.md` owns the provider contract.

## Invariants

- The contract is context resolution: `resolveContext(symbol, timeframe,
range)` → a fixed-extent `ProviderContext` (or a typed `ContextError`,
  never a thrown string). All asynchrony — pagination, rate limits,
  caching — lives inside `resolveContext`; a returned context answers
  synchronously.
- `csv.ts` maps numeric CSV header names to series ids, synthesizes the
  derived numeric sources (`hl2`, `hlc3`, `ohlc4`, `hlcc4`), and serves exactly
  one context (the empty pair). An epoch-ms `time` column provides the
  merge/execution axis only — it is never also a numeric series. Without it the
  context is axis-less. It is the offline, deterministic substrate for
  `tea run` and the run goldens; `csvContext` is exported for drivers and
  tests that assemble multi-context providers from csv-shaped payloads.
- `registry.ts` routes by symbol prefix (`FRED:CPIAUCSL` →
  `sources["FRED"]` with the prefix stripped); unregistered prefixes and
  the empty symbol go untouched to the default driver. API keys live in
  drivers, never in the runtime or Tea source.
- `builtin-sources.ts` owns the package's standard wiring (the quantmod
  division: routing policy in the package, hosts only parameterize):
  '' → the host's primary context, other unprefixed symbols → yahoo,
  prefixes → the built-in drivers, FRED without a key → a typed
  configuration error. Driver configuration conventions (which keys exist,
  their names — `FRED_API_KEY`) also live HERE: hosts hand in an opaque
  config record (the CLI passes `process.env`) and never know which driver
  needs what. Hosts (main.ts, OpenChart) call `builtinSources` and never
  assemble driver registries inline.
- Network drivers (`yahoo.ts` — unofficial v8 chart API, keyless, intraday
  capable, the default source; `fred.ts` — macro observations, key via
  options, single-valued → close collapse) all take an injectable
  `fetchImpl` and are tested fully offline with canned payloads — no test
  may touch the network. The roster follows quantmod's: sources it
  supports, we support, with the same key treatment (alphavantage/tiingo
  staged). EOD axes use the csv next-open convention with a nominal
  last-bar span (deviation-ledger item: real session closes differ).
- Drivers normalize (single-valued sources map to `close`, collapsing
  OHLC), resample in-driver or report `unsupportedTimeframe`, and keep
  axes honest — the runtime never guesses session calendars.
- Every resolved context exposes one exact `builtinValue` accessor for
  `syminfo`/`timeframe` keys. Missing metadata is `undefined`; typed empty
  values remain values. `ExecutionSource.domain` is identifier taxonomy only
  and must never grow corresponding runtime context classes.
- `RangeDemand` is either full or an exact positive trailing-bar count.
  Drivers may project the requested tail, but runtime independently clamps
  over-returned contexts before child execution.
