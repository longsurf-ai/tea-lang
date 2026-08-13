# visualization

Browser-hosted views over renderer-neutral reporting data. This directory is
presentation only: it never compiles, binds, schedules, or decodes a Program.

## Invariants

- `reporting/SweepResult` is the input boundary. Renderers never inspect
  `ExecutionSummary`, `OutputSink`, Program IR, or GPU artifacts directly.
- `sweep.ts` owns the pure X/Y/metric/slice projection. Renderer adapters
  consume `SweepScene`; third-party trace/config shapes stay adapter-private.
- The viewer binds only to IPv4 loopback and serves pinned local assets. It
  must not fetch code, fonts, or data from a CDN.
- A complete finite rectangular grid may render as a surface. Auto geometry
  keeps incomplete or null grids as points; an explicit surface preserves null
  cells as holes. A renderer must not invent or interpolate missing scenarios.
