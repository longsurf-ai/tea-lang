// Purpose: Activate Tea execution tooling only when the dashboard command is invoked.

import * as vscode from 'vscode';
import {disposeTeaCliSessions} from './dashboard/cli';
import {SweepDashboardPanel} from './dashboard/panel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tea.openSweepDashboard', async () => {
      if (!vscode.workspace.isTrusted) {
        await vscode.window.showErrorMessage(
          'Tea execution requires a trusted workspace. Syntax highlighting remains available.',
        );
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (editor !== undefined && editor.document.uri.scheme !== 'file') {
        await vscode.window.showErrorMessage(
          'Tea execution configs and programs must use local workspace files.',
        );
        return;
      }
      const dashboard = await SweepDashboardPanel.create(context.extensionUri);
      if (dashboard !== null) context.subscriptions.push(dashboard);
    }),
  );
}

export function deactivate(): void {
  disposeTeaCliSessions();
}
