# Tea IDE sweep dashboard

Status: implemented

## Goal

Add a scientific sweep dashboard to the existing VS Code/Cursor extension
without creating another execution architecture. The native Tea editor remains
the code surface on the left. One command opens a Webview beside it with:

1. the parameter surface on top;
2. the selected execution's complete output trajectory below;
3. typed broker fill annotations on that trajectory.

The execution configuration remains the sole specification of the Program,
provider, runtime, parameters, and sweep ranges.

## Boundary

The extension is a host for existing public products:

- `tea execute <config> --json` returns one versioned, renderer-neutral sweep
  result, execution summary, and all bounded trajectories captured by that
  sweep;
- the CLI serializes that generic JSON result once and exits; the editor selects
  trajectories locally without a persistent session or second execution;
- the Webview never executes Tea, reads providers, parses terminal tables, or
  loads a native GPU implementation;
- the CLI child retains the existing Bun-to-Node/Dawn relay and owns runtime
  disposal.

The machine output is presentation-neutral. It contains no Plotly objects,
VS Code objects, HTML, camera state, or strategy-specific runtime behavior.

## Data policy

Human sweeps retain only each execution's final dense values and no effects.
`tea execute <config> --json` instead stores scalar dense columns and typed
effects in a compact 256 MiB charged-retention/projection archive while the
original sweep runs, then returns the sweep summary and every `TrajectoryResult`
in one ordinary JSON document. Selection is local to the editor.

Trajectory X uses the provider's bar-open timestamp when present and falls
back to the absolute row otherwise.

Entry and exit annotations are a host presentation adapter over the canonical
`broker.FillExecuted` logical effect schema. Unknown effects remain available
as generic typed annotations; runtimes and reporters never recognize strategy
packages by name.

## Extension

The TextMate grammar remains activation-free. Executable extension code is
activated only by the explicit `Tea: Open Sweep Dashboard` command.

The controller:

1. asks for a YAML/JSON execution config;
2. invokes the configured Tea executable without a shell;
3. validates the versioned JSON envelope;
4. opens or refreshes a `WebviewPanel` in `ViewColumn.Beside`;
5. projects X/Y/Z and slices in the extension host through the existing pure
   `projectSweepScene` function;
6. cancels the child process when requested and ignores stale responses;
7. reads one binding from the completed generic JSON result when the Webview
   selects a surface point.

The Webview loads only packaged local assets through `asWebviewUri`, uses a
nonce Content Security Policy, binds no server, and has no network access.

## Visual design

The right panel uses a two-row scientific workspace rather than decorative
cards:

- compact runtime/config metadata strip;
- upper 3D surface or point plot with X/Y/Z and slice controls;
- lower trajectory plot with output selector and entry/exit annotations.

It follows VS Code theme variables, transparent chart backgrounds, grayscale
surfaces, thin axes and grid lines, and no shadows or ornamental gradients.
Muted semantic entry/exit markers are the only accents, and marker shape/text
also communicates meaning. The layout collapses to one column at narrow panel
widths and respects reduced-motion settings.

## Protocol

Host and Webview messages use small discriminated objects. The Webview may ask
to change the view projection, select a binding, or rerun. The host may publish
status, sweep data, a projected scene, a trajectory, or a typed error. Every
asynchronous response carries a request/run identity so stale work cannot
replace a newer dashboard state.

## Verification

- Reporting tests pin complete dense rows, logical effect schemas/payloads,
  non-finite normalization, and binding identity.
- CLI integration tests parse the generic JSON envelope and prove every
  trajectory matches its sweep binding.
- Extension tests pin command arguments, message validation, escaping/CSP, and
  child cancellation/failure behavior.
- The extension build packages its CommonJS host and local Plotly asset; the
  VSIX inventory must contain no unbundled `node_modules` or remote asset.
- A real example sweep is opened in a browser/editor smoke test and checked at
  desktop and narrow widths before delivery.

## Deferred

- live updates and scans;
- simultaneous comparison of multiple selected trajectories;
- viewport-aware decimation and streaming for multi-million-row trajectories;
- persistence of completed sweep result files;
- a language server or custom code editor;
- renderer-specific state in the execution config.
