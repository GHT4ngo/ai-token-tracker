import * as fs from 'fs';
import * as vscode from 'vscode';
import { initDb } from './db';
import { startWatching, stopWatching, getWatchedDirs } from './logParser';
import { createStatusBar, refresh as refreshBar, showRateLimitWarning } from './statusBar';
import { showPanel, refreshPanel } from './webviewPanel';
import { queryProjects } from './db';

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('tokenTracker').get<T>(key) as T;
}

/**
 * Normalise a user-pasted WSL path to UNC form that Node.js fs can access.
 *
 * Windows 11 File Explorer shows WSL paths as:
 *   wsl.localhost\Ubuntu\home\user\.claude\projects   (no leading \\)
 *   wsl.localhost\Ubuntu\home\user\.codex\sessions    (no leading \\)
 *   wsl.localhost/Ubuntu/home/user/.claude/projects    (forward slashes)
 *   \\wsl.localhost\Ubuntu\...                         (already correct)
 *   \\wsl$\Ubuntu\...                                  (already correct)
 *
 * Node.js needs the \\server\share UNC form.
 */
function normalizeWslPath(raw: string): string {
  let p = raw.trim();

  // Already a proper UNC path — just normalise slashes
  if (p.startsWith('\\\\')) {
    return p.replace(/\//g, '\\');
  }

  // Starts with wsl.localhost or wsl$ (without leading \\)
  if (/^wsl[\.$]/i.test(p)) {
    return '\\\\' + p.replace(/\//g, '\\');
  }

  return p;
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
        : '⚠ No log directory found. Paste your .claude/projects or .codex/sessions path below.';

      const input = await vscode.window.showInputBox({
        title:          'AI Token Tracker — Log Path',
        prompt:          statusLine,
        value:           current,
        placeHolder:    'e.g. \\\\wsl$\\Ubuntu\\home\\username\\.claude\\projects or \\\\wsl$\\Ubuntu\\home\\username\\.codex\\sessions',
        ignoreFocusOut:  true,
      });

      if (input === undefined) { return; }   // cancelled

      const trimmed = input.trim();
      if (!trimmed) {
        // Empty → auto-detect
        await vscode.workspace
          .getConfiguration('tokenTracker')
          .update('logDirectory', '', vscode.ConfigurationTarget.Global);
        restartWatcher('');
        vscode.window.showInformationMessage('Token Tracker: auto-detect enabled. Rescanning now.');
        return;
      }

      // Normalise Windows Explorer WSL path formats to UNC
      const normalized = normalizeWslPath(trimmed);

      // Warn the user if the path cannot be found
      if (!fs.existsSync(normalized)) {
        const choice = await vscode.window.showWarningMessage(
          `Path not found: "${normalized}"\n\n` +
          `Expected UNC format for WSL:\n  \\\\wsl$\\Ubuntu\\home\\username\\.claude\\projects\n  \\\\wsl$\\Ubuntu\\home\\username\\.codex\\sessions\n\n` +
          `Tip: open File Explorer → Linux → Ubuntu → home → your username, then choose .claude/projects or .codex/sessions and copy the address bar.`,
          'Use Anyway',
          'Cancel'
        );
        if (choice !== 'Use Anyway') { return; }
      }

      // If normalisation changed the path, let the user see what was saved
      if (normalized !== trimmed) {
        vscode.window.showInformationMessage(`Token Tracker: path normalised to "${normalized}"`);
      }

      await vscode.workspace
        .getConfiguration('tokenTracker')
        .update('logDirectory', normalized, vscode.ConfigurationTarget.Global);

      restartWatcher(normalized);

      vscode.window.showInformationMessage(
        `Token Tracker: now watching "${normalized}". Data will update shortly.`
      );
    })
  );
}

export function deactivate(): void {
  stopWatching();
}
