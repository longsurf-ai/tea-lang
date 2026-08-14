/* Purpose: Scientific Plotly dashboard client; all execution stays in the extension host. */

(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const restored = vscode.getState() || {};
  const elements = {
    dashboard: byId('dashboard'),
    configName: byId('config-name'),
    runtimeSummary: byId('runtime-summary'),
    status: byId('status'),
    rerun: byId('rerun'),
    chooseConfig: byId('choose-config'),
    x: byId('x-axis'),
    y: byId('y-axis'),
    z: byId('z-axis'),
    geometry: byId('geometry'),
    slices: byId('slice-controls'),
    surfaceEmpty: byId('surface-empty'),
    surfacePlot: byId('surface-plot'),
    surfaceSelection: byId('surface-selection'),
    trajectoryOutput: byId('trajectory-output'),
    scenarioLabel: byId('scenario-label'),
    trajectoryEmpty: byId('trajectory-empty'),
    trajectoryPlot: byId('trajectory-plot'),
    splitter: byId('splitter'),
    error: byId('fatal-error'),
  };

  let runId = -1;
  let requestId = 0;
  let latestProjectionRequest = -1;
  let latestTrajectoryRequest = -1;
  let sweepResult = null;
  let rendererModel = null;
  let scene = null;
  let scenarioByBinding = new Map();
  let projectedBindingByCoordinate = new Map();
  let trajectory = null;
  let system = null;
  let selectedBindingIndex = null;
  let loadingBindingIndex = null;
  let programName = '';
  let programPath = '';
  let trajectoryIntent = null;
  let trajectoryIntentFrame = 0;
  let surfaceClickBound = false;
  let surfaceSelectionPulse = 0;
  let resizeFrame = 0;
  let trajectoryResizeFrame = 0;
  const MAX_TRAJECTORY_DISPLAY_POINTS = 4000;
  const scheduleSurfaceRender = latestRenderQueue(renderLatestSurface);
  const scheduleTrajectoryRender = latestRenderQueue(renderLatestTrajectory);

  if (typeof restored.surfacePercent === 'number') {
    setSurfacePercent(restored.surfacePercent);
  }

  elements.rerun.addEventListener('click', () =>
    vscode.postMessage({type: 'rerun'}),
  );
  elements.chooseConfig.addEventListener('click', () =>
    vscode.postMessage({type: 'chooseConfig'}),
  );
  elements.x.addEventListener('change', () => changeAxes(elements.x));
  elements.y.addEventListener('change', () => changeAxes(elements.y));
  elements.z.addEventListener('change', projectCurrentView);
  elements.geometry.addEventListener('change', projectCurrentView);
  elements.trajectoryOutput.addEventListener('change', () => {
    persistState();
    drawTrajectory();
  });
  installSplitter();

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (Number.isInteger(message.runId) && message.runId < runId) return;
    if (Number.isInteger(message.runId) && message.runId > runId) {
      runId = message.runId;
      latestProjectionRequest = -1;
      latestTrajectoryRequest = -1;
      clearRunView();
    }
    switch (message.type) {
      case 'state':
        applyState(message);
        break;
      case 'sweep':
        installSweep(message);
        break;
      case 'scene':
        if (message.requestId < latestProjectionRequest) return;
        clearSurfaceSelection();
        scene = message.scene;
        void drawSurface();
        break;
      case 'trajectory':
        if (message.requestId < latestTrajectoryRequest) return;
        cancelTrajectoryIntent();
        trajectory = message.trajectory;
        loadingBindingIndex = null;
        selectedBindingIndex = trajectory.bindingIndex;
        elements.trajectoryEmpty.hidden = true;
        selectTrajectoryOutput();
        void drawTrajectory();
        break;
      case 'error':
        showError(message.message || 'Execution failed');
        break;
    }
  });

  const observer = new ResizeObserver(() => scheduleResize());
  observer.observe(elements.dashboard);
  new MutationObserver(() => {
    if (scene) void drawSurface();
    if (trajectory) void drawTrajectory();
  }).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  vscode.postMessage({type: 'ready'});

  function installSweep(message) {
    cancelTrajectoryIntent();
    sweepResult = message.result;
    scenarioByBinding = new Map(
      sweepResult.scenarios.map(scenario => [scenario.bindingIndex, scenario]),
    );
    rendererModel = message.model;
    system = message.system;
    scene = rendererModel.initialScene;
    trajectory = null;
    selectedBindingIndex = null;
    loadingBindingIndex = null;
    elements.surfaceEmpty.hidden = true;
    elements.trajectoryEmpty.hidden = false;
    fillSelect(
      elements.x,
      rendererModel.axes,
      validAxis(restored.xParameterId, rendererModel.axes)
        ? restored.xParameterId
        : rendererModel.initialSpec.xParameterId,
      item => item.label,
    );
    fillSelect(
      elements.y,
      rendererModel.axes,
      validAxis(restored.yParameterId, rendererModel.axes) &&
        restored.yParameterId !== elements.x.value
        ? restored.yParameterId
        : rendererModel.initialSpec.yParameterId,
      item => item.label,
    );
    fillSelect(
      elements.z,
      rendererModel.metrics,
      rendererModel.metrics.some(metric => metric.id === restored.zMetricId)
        ? restored.zMetricId
        : rendererModel.initialSpec.zMetricId,
      item => item.label,
    );
    elements.geometry.value = ['auto', 'surface', 'scatter3d'].includes(
      restored.geometry,
    )
      ? restored.geometry
      : rendererModel.initialSpec.geometry;
    separateAxes(elements.x);
    rebuildSlices(restored.slices || rendererModel.initialSpec.slices);
    renderSystem(system);
    hideError();
    projectCurrentView();
  }

  function applyState(message) {
    if (typeof message.configName === 'string') {
      elements.configName.textContent = message.configName;
      elements.configName.dataset.path =
        message.configPath || message.configName;
    }
    if (typeof message.programName === 'string') {
      programName = message.programName;
      programPath = message.programPath || message.programName;
    }
    updateConfigIdentity();
    const state = message.status || 'idle';
    setStatus(
      state,
      state === 'running'
        ? message.phase === 'trajectory'
          ? 'Loading trajectory'
          : 'Running sweep'
        : state === 'ready'
          ? 'Ready'
          : state === 'error'
            ? 'Error'
            : 'Idle',
    );
    elements.rerun.disabled = state === 'running';
    if (state !== 'error') hideError();
  }

  function renderSystem(value) {
    if (!value) return;
    const backend = String(value.backend).toUpperCase();
    const executions = integer(value.executions);
    const rows = integer(value.rows);
    const elapsed = milliseconds(value.timing?.totalMs);
    elements.runtimeSummary.textContent = `${backend} · ${executions} × ${rows} · ${elapsed}`;
    const details = [
      `Runtime: ${backend} (${value.numericProfile})`,
      value.device ? `Device: ${value.device}` : '',
      `Executions: ${executions}`,
      `Rows: ${rows}`,
      `Total time: ${elapsed}`,
    ]
      .filter(Boolean)
      .join('\n');
    elements.runtimeSummary.title = details;
    elements.runtimeSummary.setAttribute(
      'aria-label',
      details.replaceAll('\n', '. '),
    );
  }

  function updateConfigIdentity() {
    const configPath = elements.configName.dataset.path || '';
    const details = [
      configPath ? `Config: ${configPath}` : '',
      programPath
        ? `Program: ${programPath}`
        : programName
          ? `Program: ${programName}`
          : '',
    ]
      .filter(Boolean)
      .join('\n');
    elements.configName.title = details;
    elements.configName.setAttribute(
      'aria-label',
      details ? details.replaceAll('\n', '. ') : 'No execution config selected',
    );
  }

  function changeAxes(changed) {
    separateAxes(changed);
    rebuildSlices(currentSlices());
    projectCurrentView();
  }

  function separateAxes(changed) {
    if (elements.x.value !== elements.y.value) return;
    const target = changed === elements.x ? elements.y : elements.x;
    const replacement = Array.from(target.options).find(
      option => option.value !== changed.value,
    );
    if (replacement) target.value = replacement.value;
  }

  function rebuildSlices(previous) {
    elements.slices.replaceChildren();
    if (!rendererModel) return;
    for (const axis of rendererModel.axes) {
      if (axis.id === elements.x.value || axis.id === elements.y.value)
        continue;
      const label = document.createElement('label');
      label.append(document.createTextNode('Slice'));
      const select = document.createElement('select');
      select.dataset.axis = axis.id;
      select.setAttribute('aria-label', `Slice ${axis.label}`);
      for (const value of axis.values) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `${axis.label} ${formatNumber(value)}`;
        option.selected =
          String(previous?.[axis.id] ?? axis.values[0]) === String(value);
        select.append(option);
      }
      select.addEventListener('change', projectCurrentView);
      label.append(select);
      elements.slices.append(label);
    }
  }

  function currentSlices() {
    const slices = {};
    for (const select of elements.slices.querySelectorAll('select')) {
      slices[select.dataset.axis] = Number(select.value);
    }
    return slices;
  }

  function currentSpec() {
    return {
      xParameterId: elements.x.value,
      yParameterId: elements.y.value,
      zMetricId: elements.z.value,
      slices: currentSlices(),
      geometry: elements.geometry.value,
    };
  }

  function projectCurrentView() {
    if (!rendererModel) return;
    const spec = currentSpec();
    latestProjectionRequest = ++requestId;
    persistState();
    vscode.postMessage({
      type: 'project',
      requestId: latestProjectionRequest,
      spec,
    });
  }

  function drawSurface() {
    if (!scene || typeof Plotly === 'undefined') return;
    scheduleSurfaceRender();
  }

  async function renderLatestSurface() {
    if (!scene || typeof Plotly === 'undefined') return;
    const renderedScene = scene;
    const ink = color('--vscode-editor-foreground', '#d4d4d4');
    const muted = color('--vscode-descriptionForeground', '#8b8b8b');
    const background = color('--vscode-editor-background', '#1e1e1e');
    const grid = color(
      '--vscode-editorIndentGuide-background1',
      mix(background, ink, 0.12),
    );
    const colorscale = [
      [0, mix(background, ink, 0.12)],
      [0.5, mix(background, ink, 0.48)],
      [1, mix(background, ink, 0.9)],
    ];
    const traces = [];
    const renderedBindingByCoordinate = sceneBindingMap(
      renderedScene,
      scenarioByBinding.values(),
    );
    if (renderedScene.geometry === 'surface') {
      traces.push({
        type: 'surface',
        x: renderedScene.x.values,
        y: renderedScene.y.values,
        z: renderedScene.z.values,
        customdata: surfaceBindingMatrix(
          renderedScene,
          renderedBindingByCoordinate,
        ),
        colorscale,
        showscale: false,
        connectgaps: false,
        contours: {
          x: hoverContour(ink),
          y: hoverContour(ink),
          z: hoverContour(ink),
        },
        lighting: {ambient: 0.92, diffuse: 0.55, specular: 0.08, roughness: 1},
        hovertemplate:
          `${escapeTemplate(renderedScene.x.label)} %{x}<br>` +
          `${escapeTemplate(renderedScene.y.label)} %{y}<br>` +
          `${escapeTemplate(renderedScene.z.label)} %{z:.6g}<br>` +
          `execution %{customdata}<extra></extra>`,
      });
    } else {
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        x: renderedScene.points.map(point => point.x),
        y: renderedScene.points.map(point => point.y),
        z: renderedScene.points.map(point => point.z),
        customdata: renderedScene.points.map(point => point.bindingIndex),
        marker: {
          size: 3.5,
          color: renderedScene.points.map(point => point.z),
          colorscale,
          showscale: false,
          opacity: 0.88,
          line: {color: background, width: 0.5},
        },
        hovertemplate:
          `${escapeTemplate(renderedScene.x.label)} %{x}<br>` +
          `${escapeTemplate(renderedScene.y.label)} %{y}<br>` +
          `${escapeTemplate(renderedScene.z.label)} %{z:.6g}<br>` +
          `execution %{customdata}<extra></extra>`,
      });
    }
    const axis = title => ({
      title: {
        text: title,
        font: {family: uiFont(), size: plotFontSize(), color: ink},
      },
      tickfont: {
        family: uiFont(),
        size: Math.max(10, plotFontSize() - 1),
        color: muted,
      },
      gridcolor: grid,
      gridwidth: 1,
      zeroline: false,
      showbackground: false,
      showspikes: false,
      ticks: '',
    });
    await Plotly.react(
      elements.surfacePlot,
      traces,
      {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: {family: uiFont(), size: plotFontSize(), color: ink},
        hoverlabel: plotHoverLabel(ink, background),
        margin: {l: 2, r: 2, t: 2, b: 2},
        showlegend: false,
        uirevision: 'tea-surface-v1',
        scene: {
          xaxis: axis(renderedScene.x.label),
          yaxis: axis(renderedScene.y.label),
          zaxis: axis(renderedScene.z.label),
          bgcolor: 'rgba(0,0,0,0)',
          camera: {eye: {x: 1.5, y: 1.5, z: 1.05}},
          aspectmode: 'auto',
        },
      },
      plotConfig(),
    );
    if (renderedScene !== scene) {
      if (scene === null) {
        Plotly.purge(elements.surfacePlot);
        surfaceClickBound = false;
        projectedBindingByCoordinate = new Map();
      }
      return;
    }
    projectedBindingByCoordinate = renderedBindingByCoordinate;
    elements.surfacePlot.setAttribute(
      'aria-label',
      `${renderedScene.z.label} over ${renderedScene.x.label} and ${renderedScene.y.label}; ${renderedScene.scenarioCount} executions`,
    );
    if (!surfaceClickBound && typeof elements.surfacePlot.on === 'function') {
      elements.surfacePlot.on('plotly_click', event => {
        const point = event?.points?.[0];
        const bindingIndex = bindingIndexForPlotPoint(
          point,
          projectedBindingByCoordinate,
        );
        if (bindingIndex !== null) {
          showSurfaceSelection(event);
          requestTrajectory(bindingIndex);
        }
      });
      elements.surfacePlot.on('plotly_hover', event => {
        const point = event?.points?.[0];
        const bindingIndex = bindingIndexForPlotPoint(
          point,
          projectedBindingByCoordinate,
        );
        if (bindingIndex === null) {
          clearSurfaceHover();
          return;
        }
        elements.surfacePlot.classList.add('is-clickable');
      });
      elements.surfacePlot.on('plotly_unhover', clearSurfaceHover);
      elements.surfacePlot.on('plotly_relayout', clearSurfaceSelection);
      surfaceClickBound = true;
    }
  }

  function sceneBindingMap(projectedScene, candidates) {
    const byCoordinate = new Map();
    for (const candidate of candidates) {
      if (
        !Object.entries(projectedScene.slices).every(
          ([id, value]) => candidate.parameters[id] === value,
        )
      ) {
        continue;
      }
      const x = candidate.parameters[projectedScene.x.id];
      const y = candidate.parameters[projectedScene.y.id];
      byCoordinate.set(
        `${String(x)}\u0000${String(y)}`,
        candidate.bindingIndex,
      );
    }
    return byCoordinate;
  }

  function surfaceBindingMatrix(projectedScene, byCoordinate) {
    // Plotly surface event arrays are indexed X first even though Z is Y-major.
    return projectedScene.x.values.map(x =>
      projectedScene.y.values.map(
        y => byCoordinate.get(`${String(x)}\u0000${String(y)}`) ?? null,
      ),
    );
  }

  function bindingIndexForPlotPoint(point, byCoordinate) {
    if (
      point === null ||
      typeof point !== 'object' ||
      typeof point.x !== 'number' ||
      !Number.isFinite(point.x) ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.y)
    ) {
      return null;
    }
    const bindingIndex = byCoordinate.get(
      `${String(point.x)}\u0000${String(point.y)}`,
    );
    return typeof bindingIndex === 'number' &&
      Number.isSafeInteger(bindingIndex) &&
      bindingIndex >= 0
      ? bindingIndex
      : null;
  }

  function coordinateKey(x, y) {
    return `${String(x)}\u0000${String(y)}`;
  }

  function hoverContour(ink) {
    return {
      show: false,
      highlight: true,
      highlightcolor: ink,
      highlightwidth: 2,
    };
  }

  function clearSurfaceHover() {
    elements.surfacePlot.classList.remove('is-clickable');
  }

  function surfaceSelectionPosition(event, bounds) {
    const pointer = event?.event;
    if (
      !pointer ||
      typeof pointer.clientX !== 'number' ||
      !Number.isFinite(pointer.clientX) ||
      typeof pointer.clientY !== 'number' ||
      !Number.isFinite(pointer.clientY) ||
      typeof bounds?.left !== 'number' ||
      typeof bounds?.top !== 'number' ||
      typeof bounds?.width !== 'number' ||
      typeof bounds?.height !== 'number' ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      return null;
    }
    return {
      x: Math.min(Math.max(pointer.clientX - bounds.left, 0), bounds.width),
      y: Math.min(Math.max(pointer.clientY - bounds.top, 0), bounds.height),
    };
  }

  function showSurfaceSelection(event) {
    const position = surfaceSelectionPosition(
      event,
      elements.surfacePlot.getBoundingClientRect(),
    );
    if (position === null) return;
    elements.surfaceSelection.style.left = `${position.x}px`;
    elements.surfaceSelection.style.top = `${position.y}px`;
    elements.surfaceSelection.hidden = false;
    surfaceSelectionPulse = (surfaceSelectionPulse + 1) % 2;
    elements.surfaceSelection.dataset.pulse = String(surfaceSelectionPulse);
  }

  function clearSurfaceSelection() {
    elements.surfaceSelection.hidden = true;
    elements.surfaceSelection.removeAttribute('data-pulse');
  }

  function requestTrajectory(bindingIndex) {
    if (
      bindingIndex === selectedBindingIndex &&
      (loadingBindingIndex === bindingIndex ||
        trajectory?.bindingIndex === bindingIndex)
    ) {
      return;
    }
    latestTrajectoryRequest = ++requestId;
    selectedBindingIndex = bindingIndex;
    elements.scenarioLabel.textContent = `Execution ${bindingIndex}`;
    loadingBindingIndex = bindingIndex;
    trajectory = null;
    elements.trajectoryEmpty.hidden = false;
    elements.trajectoryEmpty.textContent = 'Loading trajectory…';
    scheduleTrajectoryRequest({
      type: 'selectScenario',
      requestId: latestTrajectoryRequest,
      bindingIndex,
    });
  }

  function scheduleTrajectoryRequest(intent) {
    cancelTrajectoryIntent();
    trajectoryIntent = {...intent, runId};
    trajectoryIntentFrame = window.requestAnimationFrame(() => {
      trajectoryIntentFrame = 0;
      const pending = trajectoryIntent;
      trajectoryIntent = null;
      if (
        pending === null ||
        pending.runId !== runId ||
        pending.requestId !== latestTrajectoryRequest ||
        pending.bindingIndex !== loadingBindingIndex
      ) {
        return;
      }
      vscode.postMessage({
        type: pending.type,
        requestId: pending.requestId,
        bindingIndex: pending.bindingIndex,
      });
    });
  }

  function cancelTrajectoryIntent() {
    if (trajectoryIntentFrame !== 0) {
      window.cancelAnimationFrame(trajectoryIntentFrame);
      trajectoryIntentFrame = 0;
    }
    trajectoryIntent = null;
  }

  function clearRunView() {
    cancelTrajectoryIntent();
    cancelAnimationFrame(trajectoryResizeFrame);
    trajectoryResizeFrame = 0;
    sweepResult = null;
    rendererModel = null;
    scene = null;
    scenarioByBinding = new Map();
    projectedBindingByCoordinate = new Map();
    trajectory = null;
    system = null;
    selectedBindingIndex = null;
    loadingBindingIndex = null;
    programName = '';
    programPath = '';
    surfaceClickBound = false;
    clearSurfaceHover();
    clearSurfaceSelection();
    elements.configName.textContent = '—';
    elements.configName.dataset.path = '';
    elements.configName.removeAttribute('title');
    elements.configName.removeAttribute('aria-label');
    elements.runtimeSummary.textContent = '—';
    elements.runtimeSummary.removeAttribute('title');
    elements.runtimeSummary.removeAttribute('aria-label');
    elements.x.replaceChildren();
    elements.y.replaceChildren();
    elements.z.replaceChildren();
    elements.slices.replaceChildren();
    elements.trajectoryOutput.replaceChildren();
    elements.geometry.value = 'auto';
    elements.scenarioLabel.removeAttribute('title');
    elements.trajectoryPlot.removeAttribute('title');
    hideError();
    elements.surfaceEmpty.hidden = false;
    elements.surfaceEmpty.textContent = 'Running sweep…';
    elements.trajectoryEmpty.hidden = false;
    elements.trajectoryEmpty.textContent = 'No trajectory selected';
    elements.scenarioLabel.textContent = 'Execution —';
    if (typeof Plotly !== 'undefined') {
      Plotly.purge(elements.surfacePlot);
      Plotly.purge(elements.trajectoryPlot);
    }
  }

  function selectTrajectoryOutput() {
    if (!trajectory) return;
    const numeric = trajectory.outputs.filter(
      output => output.type === 'int' || output.type === 'float',
    );
    const zMetric = rendererModel?.metrics.find(
      metric => metric.id === elements.z.value,
    );
    const preferred = [
      restored.trajectoryOutputId,
      zMetric?.output,
      numeric.find(output => output.label.toLowerCase() === 'equity')?.id,
      numeric[0]?.id,
    ].find(id => numeric.some(output => output.id === id));
    fillSelect(
      elements.trajectoryOutput,
      numeric,
      preferred || '',
      output => output.label,
    );
    const parameters = trajectory.parameters
      .filter(parameter => parameter.active)
      .map(parameter => `${parameter.name}=${formatCell(parameter.value)}`)
      .join(' · ');
    elements.scenarioLabel.textContent = `Execution ${trajectory.bindingIndex}${parameters ? ` · ${parameters}` : ''}`;
    elements.scenarioLabel.title = parameters;
  }

  function drawTrajectory() {
    if (!trajectory || typeof Plotly === 'undefined') return;
    scheduleTrajectoryRender();
  }

  async function renderLatestTrajectory() {
    if (!trajectory || typeof Plotly === 'undefined') return;
    const renderedTrajectory = trajectory;
    const renderedOutputId = elements.trajectoryOutput.value;
    const output = renderedTrajectory.outputs.find(
      candidate => candidate.id === renderedOutputId,
    );
    if (!output) return;
    persistState();
    const ink = color('--vscode-editor-foreground', '#d4d4d4');
    const muted = color('--vscode-descriptionForeground', '#8b8b8b');
    const background = color('--vscode-editor-background', '#1e1e1e');
    const grid = color(
      '--vscode-editorIndentGuide-background1',
      mix(background, ink, 0.12),
    );
    const entry = color('--vscode-charts-green', '#3f8f5f');
    const exit = color('--vscode-charts-red', '#b94a48');
    const useTime =
      Array.isArray(renderedTrajectory.time) &&
      renderedTrajectory.time.length === renderedTrajectory.rows &&
      renderedTrajectory.time.some(value => typeof value === 'number');
    const xAt = row =>
      useTime && typeof renderedTrajectory.time[row] === 'number'
        ? new Date(renderedTrajectory.time[row]).toISOString()
        : row;
    const displayIndices = extremaPreservingIndices(
      output.values,
      trajectoryDisplayPointBudget(),
    );
    const displayX = displayIndices.map(xAt);
    const displayY = displayIndices.map(row => output.values[row]);
    const fills = fillEvents(renderedTrajectory, output.values, xAt);
    const traces = [
      {
        type: 'scatter',
        mode: 'lines',
        name: output.label,
        x: displayX,
        y: displayY,
        connectgaps: false,
        line: {color: ink, width: 1.35},
        showlegend: false,
        hovertemplate: useTime
          ? `%{x|%Y-%m-%d %H:%M}<br>${escapeTemplate(output.label)} %{y:.7g}<extra></extra>`
          : `row %{x}<br>${escapeTemplate(output.label)} %{y:.7g}<extra></extra>`,
      },
      markerTrace('Entry', fills.entries, entry, 'triangle-up'),
      markerTrace('Exit', fills.exits, exit, 'triangle-down'),
    ];
    await Plotly.react(
      elements.trajectoryPlot,
      traces,
      {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: {family: uiFont(), size: plotFontSize(), color: ink},
        hoverlabel: plotHoverLabel(ink, background),
        margin: {l: 36, r: 8, t: 8, b: 20},
        hovermode: 'closest',
        showlegend: fills.entries.length + fills.exits.length > 0,
        legend: {
          orientation: 'h',
          x: 0,
          y: 1,
          font: {family: uiFont(), size: plotFontSize(), color: muted},
          bgcolor: 'rgba(0,0,0,0)',
        },
        uirevision: `tea-trajectory-${renderedTrajectory.bindingIndex}-${output.id}`,
        xaxis: cartesianAxis(muted, grid, useTime, false),
        yaxis: cartesianAxis(muted, grid, false, true),
      },
      plotConfig(),
    );
    if (
      renderedTrajectory !== trajectory ||
      renderedOutputId !== elements.trajectoryOutput.value
    ) {
      if (trajectory === null) Plotly.purge(elements.trajectoryPlot);
      return;
    }
    elements.trajectoryPlot.setAttribute(
      'aria-label',
      `${output.label} trajectory for execution ${renderedTrajectory.bindingIndex}; ` +
        `${fills.entries.length} entries and ${fills.exits.length} exits; ` +
        `displaying ${displayIndices.length} of ${output.values.length} trajectory points`,
    );
    elements.trajectoryPlot.title =
      displayIndices.length < output.values.length
        ? `Display sampled to ${integer(displayIndices.length)} extrema-preserving points from ${integer(output.values.length)} rows. Entry and exit markers use exact event rows.`
        : '';
    scheduleTrajectoryResize();
  }

  function latestRenderQueue(renderLatest) {
    let running = false;
    let pending = false;

    const request = () => {
      pending = true;
      if (!running) void drain();
    };

    const drain = async () => {
      running = true;
      try {
        while (pending) {
          pending = false;
          await renderLatest();
        }
      } finally {
        running = false;
        if (pending) void drain();
      }
    };

    return request;
  }

  function extremaPreservingIndices(values, requestedMaxPoints) {
    const length = values.length;
    const maxPoints = Math.max(4, Math.floor(requestedMaxPoints));
    if (length <= maxPoints) {
      return Array.from({length}, (_, index) => index);
    }
    const selected = new Set([0, length - 1]);
    let previousIsFinite =
      typeof values[0] === 'number' && Number.isFinite(values[0]);
    for (let index = 1; index < length; index += 1) {
      const isFinite =
        typeof values[index] === 'number' && Number.isFinite(values[index]);
      if (isFinite !== previousIsFinite) {
        selected.add(index - 1);
        selected.add(index);
      }
      previousIsFinite = isFinite;
    }
    const bucketCount = Math.floor((maxPoints - selected.size) / 2);
    if (bucketCount <= 0) {
      return Array.from(selected).sort((left, right) => left - right);
    }
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const start = Math.floor((bucket * length) / bucketCount);
      const end = Math.min(
        length,
        Math.floor(((bucket + 1) * length) / bucketCount),
      );
      let minimumIndex = -1;
      let maximumIndex = -1;
      for (let index = start; index < end; index += 1) {
        const value = values[index];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          continue;
        }
        if (minimumIndex === -1 || value < values[minimumIndex]) {
          minimumIndex = index;
        }
        if (maximumIndex === -1 || value > values[maximumIndex]) {
          maximumIndex = index;
        }
      }
      if (minimumIndex !== -1) selected.add(minimumIndex);
      if (maximumIndex !== -1) selected.add(maximumIndex);
    }
    return Array.from(selected).sort((left, right) => left - right);
  }

  function trajectoryDisplayPointBudget() {
    const width = elements.trajectoryPlot.clientWidth || 800;
    return Math.min(
      MAX_TRAJECTORY_DISPLAY_POINTS,
      Math.max(512, Math.round(width * 2)),
    );
  }

  function fillEvents(result, values, xAt) {
    const schemas = new Map(
      result.effectSchemas.map(schema => [schema.id, schema.payload]),
    );
    const entries = [];
    const exits = [];
    for (const effect of result.effects) {
      const schema = schemas.get(effect.effectId);
      if (
        schema?.kind !== 'user-type' ||
        schema.typeId !== 'broker.FillExecuted'
      ) {
        continue;
      }
      const fill = effect.payload?.fill;
      if (!fill || (fill.side !== 'buy' && fill.side !== 'sell')) continue;
      const point = {
        x: xAt(effect.row),
        y: nearestFinite(values, effect.row),
        customdata: [fill.commandId, fill.price, fill.quantity, fill.fee],
      };
      if (point.y === null) continue;
      (fill.side === 'buy' ? entries : exits).push(point);
    }
    return {entries, exits};
  }

  function markerTrace(name, points, markerColor, symbol) {
    return {
      type: 'scatter',
      mode: 'markers',
      name,
      showlegend: points.length > 0,
      x: points.map(point => point.x),
      y: points.map(point => point.y),
      customdata: points.map(point => point.customdata),
      marker: {
        color: markerColor,
        size: 8,
        symbol,
      },
      hovertemplate:
        `${name}<br>command %{customdata[0]}<br>` +
        `fill %{customdata[1]:.7g}<br>quantity %{customdata[2]:.7g}<br>` +
        `fee %{customdata[3]:.7g}<extra></extra>`,
    };
  }

  function cartesianAxis(muted, grid, isDate, showGrid) {
    return {
      type: isDate ? 'date' : 'linear',
      color: muted,
      tickfont: {family: uiFont(), size: plotFontSize(), color: muted},
      showgrid: showGrid,
      gridcolor: grid,
      gridwidth: 1,
      zeroline: false,
      showline: false,
      ticks: '',
      automargin: true,
    };
  }

  function installSplitter() {
    let dragging = false;
    elements.splitter.addEventListener('pointerdown', event => {
      dragging = true;
      elements.splitter.setPointerCapture(event.pointerId);
    });
    elements.splitter.addEventListener('pointermove', event => {
      if (!dragging) return;
      const bounds = elements.dashboard.getBoundingClientRect();
      setSurfacePercent(((event.clientY - bounds.top) / bounds.height) * 100);
    });
    elements.splitter.addEventListener('pointerup', event => {
      dragging = false;
      elements.splitter.releasePointerCapture(event.pointerId);
      persistState();
    });
    elements.splitter.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const current = surfacePercent();
      setSurfacePercent(current + (event.key === 'ArrowUp' ? -2 : 2));
      persistState();
    });
  }

  function setSurfacePercent(value) {
    const bounded = Math.max(32, Math.min(74, value));
    document.documentElement.style.setProperty(
      '--surface-height',
      `${bounded}%`,
    );
    scheduleResize();
  }

  function surfacePercent() {
    return Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--surface-height',
      ),
    );
  }

  function scheduleResize() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (scene && elements.surfacePlot.childElementCount) {
        Plotly.Plots.resize(elements.surfacePlot);
      }
      if (trajectory && elements.trajectoryPlot.childElementCount) {
        Plotly.Plots.resize(elements.trajectoryPlot);
      }
    });
  }

  function scheduleTrajectoryResize() {
    cancelAnimationFrame(trajectoryResizeFrame);
    trajectoryResizeFrame = requestAnimationFrame(() => {
      trajectoryResizeFrame = 0;
      if (trajectory && elements.trajectoryPlot.childElementCount) {
        Plotly.Plots.resize(elements.trajectoryPlot);
      }
    });
  }

  function persistState() {
    vscode.setState({
      xParameterId: elements.x.value,
      yParameterId: elements.y.value,
      zMetricId: elements.z.value,
      geometry: elements.geometry.value,
      slices: currentSlices(),
      trajectoryOutputId: elements.trajectoryOutput.value,
      surfacePercent: surfacePercent(),
    });
  }

  function showError(message) {
    if (trajectoryIntent === null) loadingBindingIndex = null;
    elements.error.textContent = String(message);
    elements.error.hidden = false;
    setStatus('error', 'Error');
    elements.rerun.disabled = false;
  }

  function hideError() {
    elements.error.hidden = true;
    elements.error.textContent = '';
  }

  function fillSelect(select, values, selected, label) {
    select.replaceChildren(
      ...values.map(value => {
        const option = document.createElement('option');
        option.value = value.id;
        option.textContent = label(value);
        option.selected = value.id === selected;
        return option;
      }),
    );
  }

  function validAxis(id, axes) {
    return typeof id === 'string' && axes.some(axis => axis.id === id);
  }

  function nearestFinite(values, row) {
    if (typeof values[row] === 'number' && Number.isFinite(values[row])) {
      return values[row];
    }
    for (let distance = 1; distance < values.length; distance++) {
      for (const candidate of [row - distance, row + distance]) {
        if (
          candidate >= 0 &&
          candidate < values.length &&
          typeof values[candidate] === 'number' &&
          Number.isFinite(values[candidate])
        ) {
          return values[candidate];
        }
      }
    }
    return null;
  }

  function color(name, fallback) {
    return (
      getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim() || fallback
    );
  }

  function mix(background, foreground, weight) {
    const bg = rgb(background);
    const fg = rgb(foreground);
    if (!bg || !fg) return weight < 0.5 ? background : foreground;
    const component = index =>
      Math.round(bg[index] * (1 - weight) + fg[index] * weight);
    return `rgb(${component(0)},${component(1)},${component(2)})`;
  }

  function rgb(value) {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const match = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(computed);
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : null;
  }

  function setStatus(state, label) {
    elements.status.dataset.state = state;
    elements.status.title = label;
    elements.status.setAttribute('aria-label', label);
    let accessibleLabel = elements.status.querySelector('.visually-hidden');
    if (!accessibleLabel) {
      accessibleLabel = document.createElement('span');
      accessibleLabel.className = 'visually-hidden';
      elements.status.append(accessibleLabel);
    }
    accessibleLabel.textContent = label;
  }

  function uiFont() {
    return color('--vscode-font-family', 'system-ui, sans-serif');
  }

  function plotFontSize() {
    const value = Number.parseFloat(color('--vscode-font-size', '13px'));
    return Number.isFinite(value) ? Math.max(10, value) : 13;
  }

  function plotHoverLabel(ink, background) {
    return {
      align: 'left',
      bgcolor: color('--vscode-editorHoverWidget-background', background),
      bordercolor: color(
        '--vscode-editorHoverWidget-border',
        mix(background, ink, 0.2),
      ),
      font: {
        family: uiFont(),
        size: plotFontSize(),
        color: color('--vscode-editorHoverWidget-foreground', ink),
      },
      namelength: -1,
    };
  }

  function plotConfig() {
    return {
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
      modeBarButtonsToRemove: [
        'toImage',
        'sendDataToCloud',
        'lasso2d',
        'select2d',
      ],
    };
  }

  function milliseconds(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? `${value.toFixed(value < 10 ? 2 : 1)} ms`
      : '—';
  }

  function integer(value) {
    return typeof value === 'number'
      ? new Intl.NumberFormat().format(value)
      : '—';
  }

  function formatCell(value) {
    return typeof value === 'number' ? formatNumber(value) : String(value);
  }

  function formatNumber(value) {
    return Number(value).toLocaleString(undefined, {
      maximumSignificantDigits: 7,
    });
  }

  function escapeTemplate(value) {
    return String(value).replaceAll('%', '%%');
  }

  function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing dashboard element ${id}`);
    return element;
  }
})();
