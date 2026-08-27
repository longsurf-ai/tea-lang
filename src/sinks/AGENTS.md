# sinks

Application-owned Datum collectors for the CLI, reports, tests, and embedders.
Node and the runtimes never format or aggregate emissions.

## Invariants

- `TraceSink` is the sole owner of the machine trace format shared by
  `tea run --trace` and the run goldens under `tests/fixtures/run/`. Do not change
  that text shape without regenerating goldens.
- `RunReportSink` captures complete indexed outputs plus logical typed effects
  for one human-facing run. Sweep reporting returns only with a Sweep Recipe.
- `TableSink` remains a simple dense-output presenter for embedders. It buffers
  until `flush()` and must not be used for golden comparisons.
- `MemorySink` is the generic structured capture for one binding. It snapshots
  declarations and indexed `Datum` values, including recursively fixed
  sparse-effect payloads, but does not impose batch identity,
  capacity, schema serialization, or strategy-specific policy.
- Column padding belongs in `base/tabwriter.ts`, not in individual sinks.
