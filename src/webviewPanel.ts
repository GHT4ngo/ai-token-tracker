import * as vscode from 'vscode';
import {
  queryTodayTotals,
  querySummary,
  querySessions,
  queryRateLimits,
} from './db';

let panel: vscode.WebviewPanel | undefined;

function startOfToday(): string {
  return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
}

function startOfWeek(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function startOfMonth(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

function fmt(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(2)}M`; }
  if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}k`; }
  return String(n);
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function shortProject(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

function buildHtml(port: number): string {
  const today  = querySummary(startOfToday());
  const week   = querySummary(startOfWeek());
  const month  = querySummary(startOfMonth());
  const live   = queryTodayTotals();
  const sessions = querySessions(10);
  const rateLimits = queryRateLimits(7);

  const sessionRows = sessions.map(s => `
    <tr>
      <td>${shortProject(s.project)}</td>
      <td><span class="badge">${s.model.replace('claude-', '')}</span></td>
      <td>${fmt(s.input)}</td>
      <td>${fmt(s.output)}</td>
      <td>${fmtCost(s.cost_usd)}</td>
      <td>${new Date(s.started_at).toLocaleString()}</td>
    </tr>
  `).join('');

  const rateLimitRows = rateLimits.length
    ? rateLimits.map(r => `
      <tr>
        <td>${new Date(r.timestamp).toLocaleString()}</td>
        <td>${shortProject(r.project)}</td>
        <td>${r.wait_seconds}s</td>
      </tr>`).join('')
    : '<tr><td colspan="3" style="text-align:center;color:#666">No rate-limit events in last 7 days</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  h2 { margin-top: 0; font-size: 1.2em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
  h3 { font-size: 1em; margin: 16px 0 6px; }
  .cards { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .card { flex: 1; min-width: 140px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; }
  .card .label { font-size: 0.75em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .05em; }
  .card .value { font-size: 1.4em; font-weight: 600; margin: 4px 0 2px; }
  .card .sub { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-weight: normal; text-transform: uppercase; font-size: 0.75em; letter-spacing: .05em; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border, #333); }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; padding: 1px 5px; font-size: 0.8em; }
  .model { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  a.dash-link { display: inline-block; margin-top: 12px; padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 4px; text-decoration: none; font-size: 0.85em; }
  a.dash-link:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<h2>AI Token Tracker</h2>
<p class="model">Active model: <span class="badge">${live.model}</span></p>

<div class="cards">
  <div class="card">
    <div class="label">Today</div>
    <div class="value">${fmt(today.input + today.output)}</div>
    <div class="sub">${fmtCost(today.cost_usd)} est. cost</div>
  </div>
  <div class="card">
    <div class="label">7 days</div>
    <div class="value">${fmt(week.input + week.output)}</div>
    <div class="sub">${fmtCost(week.cost_usd)} est. cost</div>
  </div>
  <div class="card">
    <div class="label">30 days</div>
    <div class="value">${fmt(month.input + month.output)}</div>
    <div class="sub">${fmtCost(month.cost_usd)} est. cost</div>
  </div>
</div>

<h3>Recent sessions</h3>
<table>
  <thead><tr><th>Project</th><th>Model</th><th>In</th><th>Out</th><th>Est. Cost</th><th>Started</th></tr></thead>
  <tbody>${sessionRows || '<tr><td colspan="6" style="text-align:center;color:#666">No sessions yet</td></tr>'}</tbody>
</table>

<h3>Rate-limit events (last 7 days)</h3>
<table>
  <thead><tr><th>Time</th><th>Project</th><th>Wait</th></tr></thead>
  <tbody>${rateLimitRows}</tbody>
</table>

${port ? `<a class="dash-link" href="http://localhost:${port}" target="_blank">Open full dashboard →</a>` : ''}
<p style="font-size:0.75em;color:var(--vscode-descriptionForeground);margin-top:16px;">Costs are retail API equivalents — informational only.</p>
</body>
</html>`;
}

export function showPanel(context: vscode.ExtensionContext, port: number): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Two);
    panel.webview.html = buildHtml(port);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'tokenTracker',
    'Token Tracker',
    vscode.ViewColumn.Two,
    { enableScripts: false, retainContextWhenHidden: false }
  );

  panel.webview.html = buildHtml(port);

  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
}

export function refreshPanel(port: number): void {
  if (panel?.visible) {
    panel.webview.html = buildHtml(port);
  }
}
