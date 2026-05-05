import * as vscode from 'vscode';
import { initDb } from './db';
import { startWatching, stopWatching, getWatchedDirs } from './logParser';
import { createStatusBar, refresh as refreshBar, showRateLimitWarning } from './statusBar';
import { showPanel, refreshPanel } from './webviewPanel';
import { queryProjects } from './db';

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
  initDb(context.globalStorageUri.fsPath);
  createStatusBar(context);

  const onChange    = () => { refreshBar(); refreshPanel(); };
  const onRateLimit = () => showRateLimitWarning();

  startWatching(cfg<string>('logDirectory') ?? '', onChange, onRateLimit);

  function restartWatcher(newPath: string): void {
    stopWatching();
    startWatching(newPath, onChange, onRateLimit);
    refreshBar();
    refreshPanel();
  }

  // Show summary panel
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenTracker.showPanel', () => {
      showPanel(context);
    })
  );

  // Refresh status bar
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenTracker.resetSession', () => {
      refreshBar();
      vscode.window.showInformationMessage('Token Tracker: status bar refreshed.');
    })
  );

  // Diagnose + set log path
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenTracker.diagnose', async () => {
      const watched  = getWatchedDirs();
      const sessions = queryProjects().reduce((n, p) => n + p.sessions, 0);
      const current  = cfg<string>('logDirectory') ?? '';

      const statusLine = watched.length > 0
        ? `Watching ${watched.length} path(s) · ${sessions} sessions loaded — ${watched.join(' | ')}`
        : '⚠ No log directory found. Paste your .claude/projects path below.';

      const input = await vscode.window.showInputBox({
        title:          'AI Token Tracker — Log Path',
        prompt:          statusLine,
        value:           current,
        placeHolder:    'e.g. \\\\wsl$\\Ubuntu\\home\\username\\.claude\\projects  (leave empty to auto-detect)',
        ignoreFocusOut:  true,
      });

      if (input === undefined) { return; }   // cancelled

      const trimmed = input.trim();
      await vscode.workspace
        .getConfiguration('tokenTracker')
        .update('logDirectory', trimmed, vscode.ConfigurationTarget.Global);

      restartWatcher(trimmed);

      vscode.window.showInformationMessage(
        trimmed
          ? `Token Tracker: now watching "${trimmed}". Data will update shortly.`
          : 'Token Tracker: auto-detect enabled. Rescanning now.'
      );
    })
  );
}

export function deactivate(): void {
  stopWatching();
}
