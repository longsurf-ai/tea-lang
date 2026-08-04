# data

`DataProvider` implementations. The runtime never loads series data; hosts
inject these. `docs/requests.md` owns the provider contract.

## Invariants

- The contract is context resolution: `resolveContext(symbol, timeframe,
range)` → a fixed-extent `ProviderContext` (or a typed `ContextError`,
  never a thrown string). All asynchrony — pagination, rate limits,
  caching — lives inside `resolveContext`; a returned context answers
  synchronously.
- `csv.ts` maps CSV header names to ambient series ids, synthesizes the
  derived ambients (`hl2`, `hlc3`, `ohlc4`, `hlcc4`), and serves exactly
  one context (the empty pair). An epoch-ms `time` column provides the
  merge axis (bar opens; a bar closes when the next opens); without it the
  context is axis-less. It is the offline, deterministic substrate for
  `tea run` and the run goldens; `csvContext` is exported for drivers and
  tests that assemble multi-context providers from csv-shaped payloads.
- `registry.ts` routes by symbol prefix (`FRED:CPIAUCSL` →
  `sources["FRED"]` with the prefix stripped); unregistered prefixes and
  the empty symbol go untouched to the default driver. Registry
  construction is host configuration — API keys live in drivers, never in
  the runtime or Tea source.
- Drivers normalize (single-valued sources map to `close`, collapsing
  OHLC), resample in-driver or report `unsupportedTimeframe`, and keep
  axes honest — the runtime never guesses session calendars.
