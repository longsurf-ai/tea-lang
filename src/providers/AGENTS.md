# providers

Host-side implementations of the runtime's injected seams. The kernel never
loads series data or formats emissions; it only calls these.

## Layout

- `data/` — `DataProvider` implementations (`csv.ts`).
- `sinks/` — `OutputSink` implementations (`TableSink`, `TraceSink`).
