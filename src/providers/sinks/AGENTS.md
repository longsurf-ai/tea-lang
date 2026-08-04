# sinks

`OutputSink` implementations for the CLI and golden harness. Presentation
only — the runtime never formats emissions.

## Invariants

- `TraceSink` is the sole owner of the machine trace format shared by
  `tea run --trace` and the run goldens under `testdata/run/`. Do not change
  that text shape without regenerating goldens.
- `TableSink` is the human presentation for default `tea run`: preamble for
  channel-less outputs, then one aligned row-per-bar table with headers from
  plot titles. It buffers until `flush()`; it must not be used for golden
  comparisons.
- Column padding belongs in `base/tabwriter.ts`, not in individual sinks.
