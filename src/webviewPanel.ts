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

function modelBadge(model: string): string {
  const short = model.replace(/^claude-/, '');
  const cls = model.includes('opus')   ? 'badge-opus'
            : model.includes('haiku')  ? 'badge-haiku'
            : model.includes('sonnet') ? 'badge-sonnet'
            : 'badge-other';
  return `<span class="badge ${cls}">${short}</span>`;
}

function buildHtml(): string {
  const today  = querySummary(startOfToday());
  const week   = querySummary(startOfWeek());
  const month  = querySummary(startOfMonth());
  const live   = queryTodayTotals();
  const sessions = querySessions(10);
  const rateLimits = queryRateLimits(7);

  const sessionRows = sessions.map(s => `
    <tr>
      <td>${shortProject(s.project)}</td>
      <td>${modelBadge(s.model)}</td>
      <td>${fmt(s.input)}</td>
      <td>${fmt(s.output)}</td>
      <td class="cost">${fmtCost(s.cost_usd)}</td>
      <td class="dim">${new Date(s.started_at).toLocaleString()}</td>
    </tr>
  `).join('');

  const rateLimitRows = rateLimits.length
    ? rateLimits.map(r => `
      <tr>
        <td class="dim">${new Date(r.timestamp).toLocaleString()}</td>
        <td>${shortProject(r.project)}</td>
        <td class="warn">${r.wait_seconds}s</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="empty">No rate-limit events in last 7 days ✓</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  :root {
    --accent:      #a78bfa;
    --accent-dark: #7c3aed;
    --accent-bg:   rgba(167,139,250,0.10);
    --blue:        #60a5fa;
    --blue-bg:     rgba(96,165,250,0.10);
    --green:       #34d399;
    --green-bg:    rgba(52,211,153,0.10);
    --orange:      #fb923c;
    --yellow:      #fbbf24;
    --red:         #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 18px 20px 24px;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .hex-icon {
    font-size: 26px;
    color: var(--accent);
    text-shadow: 0 0 14px var(--accent-dark);
    line-height: 1;
  }
  .header h2 { font-size: 1.1em; font-weight: 700; letter-spacing: -0.01em; }
  .model-chip {
    margin-left: auto;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 0.75em;
    font-weight: 600;
    letter-spacing: 0.03em;
    background: var(--accent-bg);
    color: var(--accent);
    border: 1px solid rgba(124,58,237,0.35);
  }

  /* ── Stat cards ── */
  .cards { display: flex; gap: 10px; margin-bottom: 22px; flex-wrap: wrap; }
  .card {
    flex: 1;
    min-width: 120px;
    border-radius: 8px;
    padding: 13px 15px;
    border: 1px solid;
    position: relative;
    overflow: hidden;
  }
  .card::after {
    content: attr(data-emoji);
    position: absolute;
    right: 10px; bottom: 6px;
    font-size: 22px;
    opacity: 0.18;
  }
  .card-today { background: var(--accent-bg);  border-color: rgba(167,139,250,0.25); }
  .card-week  { background: var(--blue-bg);    border-color: rgba(96,165,250,0.25); }
  .card-month { background: var(--green-bg);   border-color: rgba(52,211,153,0.25); }

  .card .label {
    font-size: 0.68em;
    text-transform: uppercase;
    letter-spacing: .09em;
    font-weight: 600;
    margin-bottom: 5px;
  }
  .card-today .label { color: var(--accent); }
  .card-week  .label { color: var(--blue); }
  .card-month .label { color: var(--green); }

  .card .value { font-size: 1.55em; font-weight: 700; line-height: 1.1; margin-bottom: 3px; }
  .card-today .value { color: var(--accent); }
  .card-week  .value { color: var(--blue); }
  .card-month .value { color: var(--green); }

  .card .sub { font-size: 0.75em; opacity: 0.55; }

  /* ── Section headers ── */
  .section-head {
    font-size: 0.69em;
    text-transform: uppercase;
    letter-spacing: .09em;
    font-weight: 600;
    opacity: 0.5;
    margin: 20px 0 8px;
  }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; font-size: 0.84em; }
  th {
    text-align: left;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: .07em;
    font-weight: normal;
    opacity: 0.45;
  }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,0.08); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(167,139,250,0.04); }

  /* ── Badges ── */
  .badge {
    display: inline-block;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.77em;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge-opus   { background: rgba(251,146,60,0.14); color: var(--orange); border: 1px solid rgba(251,146,60,0.28); }
  .badge-sonnet { background: var(--accent-bg);      color: var(--accent); border: 1px solid rgba(167,139,250,0.28); }
  .badge-haiku  { background: var(--green-bg);        color: var(--green);  border: 1px solid rgba(52,211,153,0.28); }
  .badge-other  { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  /* ── Misc ── */
  .cost  { color: var(--yellow); font-weight: 600; font-variant-numeric: tabular-nums; }
  .warn  { color: var(--red); font-weight: 600; }
  .dim   { opacity: 0.55; }
  .empty { text-align: center; padding: 12px; opacity: 0.45; }

  /* ── Dashboard button ── */
  .dash-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 20px;
    padding: 8px 18px;
    background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
    color: #fff !important;
    border-radius: 6px;
    text-decoration: none;
    font-size: 0.84em;
    font-weight: 700;
    letter-spacing: 0.03em;
    box-shadow: 0 2px 12px rgba(124,58,237,0.35);
    border: 1px solid rgba(255,255,255,0.12);
  }
  .dash-btn:hover { filter: brightness(1.12); }

  /* ── Footer ── */
  .footer {
    margin-top: 18px;
    padding-top: 10px;
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 0.71em;
    opacity: 0.38;
    line-height: 1.5;
  }
</style>
</head>
<body>

<div class="header">
  <span class="hex-icon">⬡</span>
  <h2>AI Token Tracker</h2>
  <span class="model-chip">${live.model.replace(/^claude-/, '')}</span>
</div>

<div class="cards">
  <div class="card card-today" data-emoji="⚡">
    <div class="label">Today</div>
    <div class="value">${fmt(today.input + today.output)}</div>
    <div class="sub">${fmtCost(today.cost_usd)} est. cost</div>
  </div>
  <div class="card card-week" data-emoji="📅">
    <div class="label">7 days</div>
    <div class="value">${fmt(week.input + week.output)}</div>
    <div class="sub">${fmtCost(week.cost_usd)} est. cost</div>
  </div>
  <div class="card card-month" data-emoji="📊">
    <div class="label">30 days</div>
    <div class="value">${fmt(month.input + month.output)}</div>
    <div class="sub">${fmtCost(month.cost_usd)} est. cost</div>
  </div>
</div>

<div class="section-head">Recent sessions</div>
<table>
  <thead><tr><th>Project</th><th>Model</th><th>In</th><th>Out</th><th>Est. Cost</th><th>Started</th></tr></thead>
  <tbody>${sessionRows || '<tr><td colspan="6" class="empty">No sessions recorded yet</td></tr>'}</tbody>
</table>

<div class="section-head">Rate-limit events — last 7 days</div>
<table>
  <thead><tr><th>Time</th><th>Project</th><th>Wait</th></tr></thead>
  <tbody>${rateLimitRows}</tbody>
</table>

<a class="dash-btn" href="command:tokenTracker.openDashboard">⬡ Open full dashboard</a>

<div class="footer">
  Costs are retail API equivalents — informational only.<br>
  All data stored locally. Nothing sent to any server.
</div>
</body>
</html>`;
}

export function showPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Two);
    panel.webview.html = buildHtml();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'tokenTracker',
    'Token Tracker',
    vscode.ViewColumn.Two,
    {
      enableScripts: false,
      retainContextWhenHidden: false,
      enableCommandUris: ['tokenTracker.openDashboard'],
    }
  );

  panel.webview.html = buildHtml();

  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
}

export function refreshPanel(): void {
  if (panel?.visible) {
    panel.webview.html = buildHtml();
  }
}
