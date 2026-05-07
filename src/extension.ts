import * as fs from 'fs';
import * as vscode from 'vscode';
import { initDb } from './db';
import { startWatching, stopWatching, getWatchedDirs, findWslClaudeDirs, findWslCodexSessionDirs } from './logParser';
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

  // Forward-slash UNC from VS Code URI: //wsl.localhost/... or //wsl$/...
  if (/^\/\/wsl[\.$]/i.test(p)) {
    p = '\\\\' + p.slice(2).replace(/\//g, '\\');
  }
  // Without leading slashes: wsl.localhost\... or wsl$/...
  else if (/^wsl[\.$]/i.test(p)) {
    p = '\\\\' + p.replace(/\//g, '\\');
  }
  // Already a UNC path — just normalise forward slashes
  else if (p.startsWith('\\\\')) {
    p = p.replace(/\//g, '\\');
  }

  // \\wsl.localhost\ is Windows 11 only and unreliable in Node.js fs.
  // \\wsl$\ works on both Windows 10 and 11 — always prefer it.
  p = p.replace(/^\\\\wsl\.localhost\\/i, '\\\\wsl$\\');

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

      type DiagnoseAction = { label: string; detail: string; id: 'wsl' | 'browse' | 'manual' | 'auto'; };
      const choice = await vscode.window.showQuickPick<DiagnoseAction>(
        [
          { label: '$(search) Scan WSL distros for log folders', detail: 'Automatically find .claude/projects and .codex/sessions across all WSL distros', id: 'wsl' },
          { label: '$(folder-opened) Browse for folder…',        detail: 'File dialog — works for native Windows paths only, not WSL', id: 'browse' },
          { label: '$(edit) Enter path manually',                detail: 'Paste a UNC or local path', id: 'manual' },
          { label: '$(sync) Auto-detect (clear custom path)',    detail: 'Let the extension scan for Claude Code and Codex automatically', id: 'auto' },
        ],
        { title: `AI Token Tracker — ${statusLine}`, placeHolder: 'How would you like to set the log path?' }
      );

      if (!choice) { return; }

      // ── Scan WSL distros ──────────────────────────────────────────────────
      if (choice.id === 'wsl') {
        const found = [...findWslClaudeDirs(), ...findWslCodexSessionDirs()];
        if (found.length === 0) {
          const action = await vscode.window.showWarningMessage(
            'No WSL log folders found automatically.\n\n' +
            'The most reliable fix when Claude Code runs inside WSL is to open VS Code ' +
            'connected to WSL — the extension will then find logs automatically without any path setup.',
            'How to connect VS Code to WSL',
            'Enter path manually'
          );
          if (action === 'How to connect VS Code to WSL') {
            vscode.env.openExternal(vscode.Uri.parse('https://code.visualstudio.com/docs/remote/wsl'));
          } else if (action === 'Enter path manually') {
            vscode.commands.executeCommand('tokenTracker.diagnose');
          }
          return;
        }
        type PathItem = vscode.QuickPickItem & { path: string };
        const picked = await vscode.window.showQuickPick<PathItem>(
          found.map(p => ({ label: p.split('\\').pop() ?? p, detail: p, path: p })),
          { title: 'Found WSL log folders — pick one to watch', placeHolder: 'Select a folder' }
        );
        if (!picked) { return; }
        await vscode.workspace.getConfiguration('tokenTracker').update('logDirectory', picked.path, vscode.ConfigurationTarget.Global);
        restartWatcher(picked.path);
        vscode.window.showInformationMessage(`Token Tracker: now watching "${picked.path}". Data will update shortly.`);
        return;
      }

      // ── Browse via file dialog (Windows local paths only) ─────────────────
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
