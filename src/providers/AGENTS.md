# providers

Host-side implementations of the runtime's injected seams. The runtime never
loads series data or formats emissions; it only calls these.

## Layout

- `data/` — `DataProvider` implementations (`csv.ts`).
- `gpu/` — optional host adapters for device ownership and safe process
  selection; target-independent execution remains in
  `src/execution/execute.ts`.
- `sinks/` — `OutputSink` implementations for traces, tables, structured
  capture, and modular run/sweep reports.
