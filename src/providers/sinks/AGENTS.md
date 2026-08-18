# sinks

`OutputSink` implementations for hosts, the CLI, and the golden harness. The
runtime never formats or aggregates emissions.

## Invariants

- `TraceSink` is the sole owner of the machine trace format shared by
  `tea run --trace` and the run goldens under `tests/fixtures/run/`. Do not change
  that text shape without regenerating goldens.
- `RunReportSink` captures complete dense rows plus logical typed effects for
  one human-facing run. `SweepReportSink` requests
  `{denseRows: 'final', effects: 'none'}`, so its transport and memory are
  independent of bar-history length.
- `TableSink` remains a simple dense-output presenter for embedders. It buffers
  until `flush()` and must not be used for golden comparisons.
- `MemorySink` is the generic structured capture for one binding. It snapshots
  declarations and unified row publications, including recursively fixed
  sparse-effect payloads, but does not impose batch identity,
  capacity, schema serialization, or strategy-specific policy.
- `TrajectoryArchive` is the bounded generic sweep-result capture. It stores
  complete scalar trajectories and typed effects from the original execution;
  JSON/reporting consumers project all bindings without replay or host-specific
  request protocols.
- Column padding belongs in `base/tabwriter.ts`, not in individual sinks.
