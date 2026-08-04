# data

`DataProvider` implementations. The runtime never loads series data; hosts
inject these.

## Invariants

- `csv.ts` maps CSV header names to ambient series ids and synthesizes the
  derived ambients (`hl2`, `hlc3`, `ohlc4`, `hlcc4`). It is the offline,
  deterministic substrate for `tea run` and the run goldens.
