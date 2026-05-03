import * as vscode from 'vscode';
import { initDb } from './db';
import { startWatching, stopWatching } from './logParser';
import { createStatusBar, refresh as refreshBar, showRateLimitWarning } from './statusBar';
import { showPanel, refreshPanel } from './webviewPanel';
import { startServer, stopServer } from './server';

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('tokenTracker').get<T>(key) as T;
}

export function activate(context: vscode.ExtensionContext): void {
  try {
    activateInner(context);
  } catch (err) {
    vscode.window.showErrorMessage(`AI Token Tracker failed to start: ${err}`);
    console.error('[TokenTracker] Activation error:', err);
  }
}

function activateInner(context: vscode.ExtensionContext): void {
  const storagePath = context.globalStorageUri.fsPath;
  initDb(storagePath);

  // Status bar
  createStatusBar(context);

  // Determine log directory (user override or auto-detect)
  const logDir: string = cfg('logDirectory') ?? '';

  // Start watching log files; refresh the status bar on every change
  startWatching(
    logDir,
    () => {
      refreshBar();
      refreshPanel(cfg<number>('apiPort') ?? 7842);
    },
    () => showRateLimitWarning()
  );

  // Start local API server if the user has opted in
  if (cfg<boolean>('enableServer')) {
    startServer(cfg<number>('apiPort') ?? 7842);
  }

  // Re-apply server setting if config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('tokenTracker')) { return; }

      const enabled = cfg<boolean>('enableServer');
      const port    = cfg<number>('apiPort') ?? 7842;

      if (enabled) {
        startServer(port);
      } else {
        stopServer();
      }
    })
  );

  // Command: show in-editor summary panel
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenTracker.showPanel', () => {
      showPanel(context, cfg<number>('apiPort') ?? 7842);
    })
  );

  // Command: open the Lovable web dashboard in external browser
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenTracker.openDashboard', () => {
      const port = cfg<number>('apiPort') ?? 7842;
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
    })
  );

  // Command: reset the session counter display (just refreshes the bar)
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenTracker.resetSession', () => {
      refreshBar();
      vscode.window.showInformationMessage('Token Tracker: status bar refreshed.');
    })
  );
}


export function deactivate(): void {
  stopWatching();
  stopServer();
}
