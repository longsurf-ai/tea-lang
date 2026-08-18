// Purpose: Own one sweep dashboard panel and bridge validated messages to the Tea CLI.

import {randomBytes} from 'node:crypto';
import {basename, dirname} from 'node:path';
import * as vscode from 'vscode';
import {createSweepRendererModel} from '../../../../src/visualization/renderer';
import {projectSweepScene} from '../../../../src/visualization/sweep';
import {executeTeaCli, TeaCliError, type TeaCliExecution} from './cli';
import {dashboardDocument} from './document';
import {
  isSameDashboardGeneration,
  isCurrentDashboardOperation,
  settleDashboardOperation,
  type DashboardPhase,
} from './operation';
import {parseDashboardRequest, type MachineExecutionResult} from './protocol';
import {assertScenarioTrajectory} from './selection';

const VIEW_TYPE = 'tea.sweepDashboard';

export class SweepDashboardPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private execution: TeaCliExecution | null = null;
  private result: MachineExecutionResult | null = null;
  private runId = 0;
  private latestScenarioRequestId = -1;
  private phase: DashboardPhase = 'idle';
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private configUri: vscode.Uri,
    private readonly sourceColumn: vscode.ViewColumn,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
    panel.webview.html = webviewHtml(panel.webview, extensionUri);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage(value => void this.receive(value)),
    );
  }

  static async create(
    extensionUri: vscode.Uri,
    initialConfig?: vscode.Uri,
  ): Promise<SweepDashboardPanel | null> {
    const config = initialConfig ?? (await chooseExecutionConfig());
    if (config === undefined) return null;
    const sourceColumn =
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Tea Sweep · ${basename(config.fsPath)}`,
      {viewColumn: vscode.ViewColumn.Beside, preserveFocus: false},
      {enableFindWidget: true, retainContextWhenHidden: false},
    );
    return new SweepDashboardPanel(panel, extensionUri, config, sourceColumn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.execution?.cancel();
    this.execution = null;
    this.result = null;
    this.phase = 'idle';
    while (this.disposables.length > 0) this.disposables.pop()!.dispose();
  }

  private async receive(value: unknown): Promise<void> {
    const request = parseDashboardRequest(value);
    if (request === null || this.disposed) return;
    try {
      switch (request.type) {
        case 'ready':
          if (this.phase !== 'idle') {
            await this.postState('running', this.phase);
            return;
          }
          if (this.result?.sweep !== undefined) {
            const result = this.result;
            const runId = this.runId;
            const scenarioRequestId = this.latestScenarioRequestId;
            await this.postSweep(result, runId);
            if (
              this.disposed ||
              runId !== this.runId ||
              result !== this.result ||
              scenarioRequestId !== this.latestScenarioRequestId
            ) {
              return;
            }
            await this.postState('ready', undefined, runId);
            return;
          }
          await this.executeSweep();
          return;
        case 'rerun':
          await this.executeSweep();
          return;
        case 'chooseConfig': {
          const selected = await chooseExecutionConfig();
          if (selected === undefined) return;
          this.configUri = selected;
          this.panel.title = `Tea Sweep · ${basename(selected.fsPath)}`;
          await this.executeSweep();
          return;
        }
        case 'project': {
          if (this.result?.sweep === undefined) return;
          const scene = projectSweepScene(this.result.sweep, request.spec);
          await this.post({
            type: 'scene',
            runId: this.runId,
            requestId: request.requestId,
            scene,
          });
          return;
        }
        case 'selectScenario':
          await this.selectScenario(request.bindingIndex, request.requestId);
          return;
      }
    } catch (error) {
      await this.report(error);
    }
  }

  private async executeSweep(): Promise<void> {
    this.execution?.cancel();
    this.execution = null;
    const runId = ++this.runId;
    const configUri = this.configUri;
    this.latestScenarioRequestId = -1;
    this.phase = 'sweep';
    this.result = null;
    try {
      await this.postState('running', 'sweep', runId);
    } catch (error) {
      this.settlePending(runId);
      throw error;
    }
    if (this.disposed || runId !== this.runId) return;
    let execution: TeaCliExecution;
    try {
      execution = executeTeaCli({
        executable: teaExecutable(),
        configPath: configUri.fsPath,
        cwd: dirname(configUri.fsPath),
      });
    } catch (error) {
      this.settlePending(runId);
      throw error;
    }
    this.execution = execution;
    try {
      const result = await execution.result;
      if (!this.isCurrent(execution, runId)) return;
      if (result.schema !== 'tea.execution-result/v2') {
        throw new TeaCliError('Tea CLI did not return the sweep result');
      }
      if (
        result.system.kind !== 'sweep' ||
        result.sweep === undefined ||
        result.trajectories === undefined
      ) {
        throw new TeaCliError(
          'dashboard execution config must describe a sweep',
        );
      }
      await revealProgramSource(
        result.snapshot.programSource,
        this.sourceColumn,
      );
      if (!this.isCurrent(execution, runId)) return;
      this.result = result;
      await this.postSweep(result, runId);
      if (!this.isCurrent(execution, runId) || this.result !== result) return;
      if (!this.settleCurrent(execution, runId)) return;
      await this.postState('ready', undefined, runId);
    } catch (error) {
      if (!this.isCurrent(execution, runId)) return;
      this.settleCurrent(execution, runId);
      throw error;
    } finally {
      if (this.execution === execution) this.execution = null;
      if (runId === this.runId && this.phase === 'sweep') this.phase = 'idle';
    }
  }

  private async postSweep(
    result: MachineExecutionResult,
    runId: number,
  ): Promise<void> {
    if (result.sweep === undefined) return;
    await this.post({
      type: 'sweep',
      runId,
      result: result.sweep,
      model: createSweepRendererModel(result.sweep),
      system: result.system,
    });
  }

  private async selectScenario(
    bindingIndex: number,
    requestId: number,
  ): Promise<void> {
    const snapshot = this.result;
    if (snapshot?.sweep === undefined || snapshot.trajectories === undefined) {
      return;
    }
    const scenario = snapshot.sweep.scenarios.find(
      candidate => candidate.bindingIndex === bindingIndex,
    );
    if (scenario === undefined) {
      throw new TeaCliError(`unknown sweep execution ${bindingIndex}`);
    }
    const trajectory = snapshot.trajectories.find(
      candidate => candidate.bindingIndex === bindingIndex,
    );
    if (trajectory === undefined) {
      throw new TeaCliError(
        `Tea sweep result has no trajectory for execution ${bindingIndex}`,
      );
    }
    assertScenarioTrajectory(scenario, trajectory);
    this.latestScenarioRequestId = requestId;
    await this.post({
      type: 'trajectory',
      runId: this.runId,
      requestId,
      trajectory,
    });
    if (
      !this.disposed &&
      requestId === this.latestScenarioRequestId &&
      snapshot === this.result
    ) {
      await this.postState('ready', undefined, this.runId);
    }
  }

  private async postState(
    status: 'idle' | 'running' | 'ready' | 'error',
    phase?: 'sweep' | 'trajectory',
    runId: number = this.runId,
  ): Promise<void> {
    await this.post({
      type: 'state',
      runId,
      status,
      ...(phase === undefined ? {} : {phase}),
      configName: basename(this.configUri.fsPath),
      configPath: this.configUri.fsPath,
      ...(this.result === null
        ? {}
        : {
            programName: basename(this.result.snapshot.programSource),
            programPath: this.result.snapshot.programSource,
          }),
    });
  }

  private async report(error: unknown): Promise<void> {
    if (this.disposed) return;
    const runId = this.runId;
    const scenarioRequestId = this.latestScenarioRequestId;
    const message = error instanceof Error ? error.message : String(error);
    await this.postState('error', undefined, runId);
    if (
      !isSameDashboardGeneration(
        {
          disposed: this.disposed,
          runId: this.runId,
          scenarioRequestId: this.latestScenarioRequestId,
        },
        runId,
        scenarioRequestId,
      )
    ) {
      return;
    }
    await this.post({type: 'error', runId, message});
  }

  private async post(message: unknown): Promise<void> {
    if (!this.disposed) await this.panel.webview.postMessage(message);
  }

  private isCurrent(
    execution: TeaCliExecution,
    runId: number,
    requestId?: number,
  ): boolean {
    return isCurrentDashboardOperation(
      {
        disposed: this.disposed,
        runId: this.runId,
        scenarioRequestId: this.latestScenarioRequestId,
        phase: this.phase,
        execution: this.execution,
      },
      execution,
      runId,
      requestId,
    );
  }

  private settleCurrent(
    execution: TeaCliExecution,
    runId: number,
    requestId?: number,
  ): boolean {
    const settled = settleDashboardOperation(
      {
        disposed: this.disposed,
        runId: this.runId,
        scenarioRequestId: this.latestScenarioRequestId,
        phase: this.phase,
        execution: this.execution,
      },
      execution,
      runId,
      requestId,
    );
    if (settled === null) return false;
    this.phase = settled.phase;
    this.execution = settled.execution;
    return true;
  }

  private settlePending(runId: number, requestId?: number): boolean {
    const settled = settleDashboardOperation<TeaCliExecution | null>(
      {
        disposed: this.disposed,
        runId: this.runId,
        scenarioRequestId: this.latestScenarioRequestId,
        phase: this.phase,
        execution: this.execution,
      },
      null,
      runId,
      requestId,
    );
    if (settled === null) return false;
    this.phase = settled.phase;
    this.execution = settled.execution;
    return true;
  }
}

async function revealProgramSource(
  path: string,
  sourceColumn: vscode.ViewColumn,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path),
  );
  await vscode.window.showTextDocument(document, {
    viewColumn: sourceColumn,
    preserveFocus: true,
    preview: false,
  });
}

async function chooseExecutionConfig(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {'Tea execution config': ['yaml', 'yml', 'json']},
    title: 'Select a Tea sweep execution config',
    openLabel: 'Open Sweep',
  });
  return picked?.[0];
}

function teaExecutable(): string {
  return vscode.workspace
    .getConfiguration('tea', null)
    .get<string>('executablePath', 'tea');
}

function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const resource = (name: string) =>
    webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name))
      .toString();
  return dashboardDocument({
    cspSource: webview.cspSource,
    nonce: randomBytes(18).toString('base64'),
    stylesheet: resource('dashboard.css'),
    plotlyScript: resource('plotly-gl3d.min.js'),
    dashboardScript: resource('dashboard.js'),
  });
}
