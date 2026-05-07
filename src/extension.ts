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

      const statusLine = watched.length > 0
        ? `Watching ${watched.length} path(s) · ${sessions} sessions loaded`
        : 'No log directory found — choose an option below';

      type DiagnoseAction = { label: string; detail: string; id: 'browse' | 'manual' | 'auto'; };
      const choice = await vscode.window.showQuickPick<DiagnoseAction>(
        [
          { label: '$(folder-opened) Browse for folder…',     detail: 'Pick the .claude/projects or .codex/sessions folder with a file dialog', id: 'browse' },
          { label: '$(edit) Enter path manually',             detail: 'Paste a UNC or local path — useful for WSL paths', id: 'manual' },
          { label: '$(sync) Auto-detect (clear custom path)', detail: 'Let the extension scan for Claude Code and Codex automatically', id: 'auto' },
        ],
        { title: `AI Token Tracker — ${statusLine}`, placeHolder: 'How would you like to set the log path?' }
      );

      if (!choice) { return; }

      // ── Browse via file dialog ────────────────────────────────────────────
      if (choice.id === 'browse') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles:   false,
          canSelectFolders: true,
          canSelectMany:    false,
          title:            'Select your .claude/projects or .codex/sessions folder',
          openLabel:        'Select Folder',
        });
        if (!uris || uris.length === 0) { return; }
        const selected   = uris[0].fsPath;
        const normalized = normalizeWslPath(selected);
        if (!fs.existsSync(normalized)) {
          vscode.window.showErrorMessage(`Token Tracker: folder not found after selection — "${normalized}"`);
          return;
        }
        await vscode.workspace.getConfiguration('tokenTracker').update('logDirectory', normalized, vscode.ConfigurationTarget.Global);
        restartWatcher(normalized);
        vscode.window.showInformationMessage(`Token Tracker: now watching "${normalized}". Data will update shortly.`);
        return;
      }

      // ── Auto-detect ───────────────────────────────────────────────────────
      if (choice.id === 'auto') {
        await vscode.workspace.getConfiguration('tokenTracker').update('logDirectory', '', vscode.ConfigurationTarget.Global);
        restartWatcher('');
        vscode.window.showInformationMessage('Token Tracker: auto-detect enabled. Rescanning now.');
        return;
      }

      // ── Manual entry ──────────────────────────────────────────────────────
      const current = cfg<string>('logDirectory') ?? '';
      const input   = await vscode.window.showInputBox({
        title:          'AI Token Tracker — Enter Log Path',
        prompt:          watched.length > 0 ? `Currently watching: ${watched.join(' | ')}` : 'No path set',
        value:           current,
        placeHolder:    'e.g. \\\\wsl$\\Ubuntu\\home\\username\\.claude\\projects',
        ignoreFocusOut:  true,
      });

      if (input === undefined) { return; }

      const trimmed = input.trim();
      if (!trimmed) {
        await vscode.workspace.getConfiguration('tokenTracker').update('logDirectory', '', vscode.ConfigurationTarget.Global);
        restartWatcher('');
        vscode.window.showInformationMessage('Token Tracker: auto-detect enabled. Rescanning now.');
        return;
      }

      const normalized = normalizeWslPath(trimmed);

      if (!fs.existsSync(normalized)) {
        const proceed = await vscode.window.showWarningMessage(
          `Path not found: "${normalized}"\n\nTip: use "Browse for folder…" instead — it handles WSL paths automatically.`,
          'Use Anyway', 'Cancel'
        );
        if (proceed !== 'Use Anyway') { return; }
      }

      if (normalized !== trimmed) {
        vscode.window.showInformationMessage(`Token Tracker: path normalised to "${normalized}"`);
      }

      await vscode.workspace.getConfiguration('tokenTracker').update('logDirectory', normalized, vscode.ConfigurationTarget.Global);
      restartWatcher(normalized);
      vscode.window.showInformationMessage(`Token Tracker: now watching "${normalized}". Data will update shortly.`);
    })
  );
}

export function deactivate(): void {
  stopWatching();
}
