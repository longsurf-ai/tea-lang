// Purpose: Generate a locked-down dashboard document from VS Code-owned resource URIs.

export interface DashboardResources {
  readonly cspSource: string;
  readonly nonce: string;
  readonly stylesheet: string;
  readonly plotlyScript: string;
  readonly dashboardScript: string;
}

export function dashboardDocument(resources: DashboardResources): string {
  const {cspSource, nonce, stylesheet, plotlyScript, dashboardScript} =
    resources;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesheet}">
  <title>Tea Sweep Dashboard</title>
</head>
<body>
  <header class="instrument-bar">
    <h1 class="visually-hidden">Tea Sweep Dashboard</h1>
    <div class="run-summary" aria-label="Execution summary">
      <span id="config-name">—</span>
      <span class="summary-separator" aria-hidden="true">·</span>
      <span id="runtime-summary">—</span>
    </div>
    <div class="run-actions">
      <span id="status" class="status" data-state="idle" role="status" aria-live="polite" title="Idle"><span class="visually-hidden">Idle</span></span>
      <button id="choose-config" class="quiet-button" type="button" aria-label="Choose execution config">Config</button>
      <button id="rerun" class="run-button" type="button">Run</button>
    </div>
  </header>

  <main id="dashboard" class="dashboard">
    <section class="plot-panel surface-panel" aria-label="Parameter sweep">
      <div class="panel-heading">
        <form id="surface-controls" class="controls" aria-label="Parameter field controls">
          <label>X<select id="x-axis"></select></label>
          <label>Y<select id="y-axis"></select></label>
          <label>Metric<select id="z-axis"></select></label>
          <label>View<select id="geometry"><option value="auto">Auto</option><option value="surface">Surface</option><option value="scatter3d">Points</option></select></label>
          <span id="slice-controls" class="slice-controls"></span>
        </form>
      </div>
      <div id="surface-empty" class="empty-state" role="status">No sweep results</div>
      <div id="surface-plot" class="plot" role="img" aria-label="Strategy parameter sweep"></div>
      <div class="surface-selection-layer" aria-hidden="true">
        <span id="surface-selection" class="surface-selection" hidden></span>
      </div>
    </section>

    <div id="splitter" class="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize plots" tabindex="0"></div>

    <section class="plot-panel trajectory-panel" aria-label="Selected execution trajectory">
      <div class="panel-heading">
        <div class="controls trajectory-controls">
          <label>Output<select id="trajectory-output"></select></label>
          <span id="scenario-label" class="scenario-label">Execution —</span>
        </div>
      </div>
      <div id="trajectory-empty" class="empty-state" role="status">No trajectory selected</div>
      <div id="trajectory-plot" class="plot" role="img" aria-label="Selected strategy output trajectory"></div>
    </section>
  </main>

  <div id="fatal-error" class="fatal-error" hidden role="alert"></div>
  <script nonce="${nonce}" src="${plotlyScript}"></script>
  <script nonce="${nonce}" src="${dashboardScript}"></script>
</body>
</html>`;
}
