# visualization

Standalone presentation models over renderer-neutral reporting data. This
directory never compiles, binds, schedules, decodes a Program, or starts a Tea
CLI/process host.

## Invariants

- `reporting/SweepResult` is the input boundary. Renderers never inspect
  `ExecutionSummary`, `OutputSink`, Program IR, or GPU artifacts directly.
- `sweep.ts` owns the pure X/Y/metric/slice projection. Hosts such as the
  editor consume `SweepScene`; third-party trace/config shapes stay
  host-private.
- Visualization hosts use pinned local assets and must not fetch code, fonts,
  or result data from a CDN.
- A complete finite rectangular grid may render as a surface. Auto geometry
  keeps incomplete or null grids as points; an explicit surface preserves null
  cells as holes. A renderer must not invent or interpolate missing scenarios.
