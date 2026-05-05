import * as vscode from 'vscode';
import {
  queryTodayTotals,
  querySummary,
  queryProjects,
  ProjectRow,
  queryRateLimits,
  queryDaily,
  DailyRow,
} from './db';

let panel: vscode.WebviewPanel | undefined;

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function shortProject(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

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

// ── Project grouping ──────────────────────────────────────────────────────────

interface GroupedProject {
  name: string;
  sessions: number;
  input: number;
  output: number;
  cost_usd: number;
}

function groupProjects(
  rows: ProjectRow[],
  merges: Record<string, string[]>
): GroupedProject[] {
  // Build alias → canonical map (case-insensitive short names)
  const aliasMap: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(merges)) {
    for (const alias of aliases) {
      aliasMap[alias.toLowerCase()] = canonical;
    }
  }

  const grouped: Record<string, GroupedProject> = {};

  for (const p of rows) {
    if (p.input === 0 && p.output === 0) continue;          // skip zero-token rows
    const short     = shortProject(p.project);
    const canonical = aliasMap[short.toLowerCase()] ?? short;

    if (!grouped[canonical]) {
      grouped[canonical] = { name: canonical, sessions: 0, input: 0, output: 0, cost_usd: 0 };
    }
    grouped[canonical].sessions += p.sessions;
    grouped[canonical].input    += p.input;
    grouped[canonical].output   += p.output;
    grouped[canonical].cost_usd += p.cost_usd;
  }

  return Object.values(grouped).sort((a, b) => b.cost_usd - a.cost_usd);
}

// ── Model badge ───────────────────────────────────────────────────────────────

function modelBadge(model: string): string {
  const short = model.replace(/^claude-/, '');
  const cls = model.includes('opus')   ? 'badge-opus'
            : model.includes('haiku')  ? 'badge-haiku'
            : model.includes('sonnet') ? 'badge-sonnet'
            : 'badge-other';
  return `<span class="badge ${cls}">${short}</span>`;
}

// ── SVG chart helpers ─────────────────────────────────────────────────────────

function linePts(pts: [number, number][]): string {
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ');
}

function buildAreaChart(data: DailyRow[]): string {
  const W = 760, H = 210;
  const P = { t: 14, r: 12, b: 26, l: 50 };
  const iW = W - P.l - P.r;
  const iH = H - P.t - P.b;

  if (data.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" width="100%">
      <text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12"
        fill="currentColor" fill-opacity="0.3">No data yet — start a Claude Code session</text>
    </svg>`;
  }

  const maxVal = Math.max(...data.map(d => d.input + d.output), 1);
  const n = data.length;
  const xOf = (i: number) => P.l + (n <= 1 ? iW / 2 : (i / (n - 1)) * iW);
  const yOf = (v: number) => P.t + iH - (v / maxVal) * iH;
  const base = P.t + iH;

  const inputPts = data.map((d, i): [number, number] => [xOf(i), yOf(d.input)]);
  const totalPts = data.map((d, i): [number, number] => [xOf(i), yOf(d.input + d.output)]);

  const inputAreaD  = `M ${linePts(inputPts)} L ${xOf(n-1).toFixed(1)},${base.toFixed(1)} L ${xOf(0).toFixed(1)},${base.toFixed(1)} Z`;
  const outputAreaD = `M ${linePts(totalPts)} L ${linePts([...inputPts].reverse())} Z`;

  const grid = Array.from({ length: 5 }, (_, k) => {
    const v = (maxVal * k) / 4;
    const y = yOf(v);
    return `
      <line x1="${P.l}" y1="${y.toFixed(1)}" x2="${(P.l+iW).toFixed(1)}" y2="${y.toFixed(1)}"
        stroke="currentColor" stroke-opacity="0.07" stroke-dasharray="3 3"/>
      <text x="${(P.l-5).toFixed(1)}" y="${(y+3.5).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="currentColor" fill-opacity="0.4">${fmt(Math.round(v))}</text>`;
  }).join('');

  const step = Math.max(1, Math.floor(n / 7));
  const xLabels = data.map((d, i) => {
    if (i % step !== 0 && i !== n - 1) return '';
    return `<text x="${xOf(i).toFixed(1)}" y="${(H-4).toFixed(1)}" text-anchor="middle"
      font-size="9.5" fill="currentColor" fill-opacity="0.4">${d.date.slice(5).replace('-', '/')}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.50"/>
        <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.03"/>
      </linearGradient>
      <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.50"/>
        <stop offset="100%" stop-color="#a78bfa" stop-opacity="0.03"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${inputAreaD}" fill="url(#gIn)"/>
    <path d="${outputAreaD}" fill="url(#gOut)"/>
    <path d="M ${linePts(inputPts)}" fill="none" stroke="#60a5fa" stroke-width="1.5"/>
    <path d="M ${linePts(totalPts)}" fill="none" stroke="#a78bfa" stroke-width="1.5"/>
    ${xLabels}
  </svg>`;
}

function buildBarChart(data: DailyRow[]): string {
  const W = 760, H = 170;
  const P = { t: 14, r: 12, b: 26, l: 52 };
  const iW = W - P.l - P.r;
  const iH = H - P.t - P.b;

  if (data.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" width="100%">
      <text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12"
        fill="currentColor" fill-opacity="0.3">No data yet</text>
    </svg>`;
  }

  const maxCost = Math.max(...data.map(d => d.cost_usd), 0.01);
  const n = data.length;
  const slotW = iW / n;
  const barW  = Math.max(2, slotW * 0.65);

  const bars = data.map((d, i) => {
    const barH = Math.max(0.5, (d.cost_usd / maxCost) * iH);
    const x = P.l + i * slotW + (slotW - barW) / 2;
    const y = P.t + iH - barH;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}"
      height="${barH.toFixed(1)}" rx="3" fill="#34d399" opacity="0.75"/>`;
  }).join('');

  const grid = Array.from({ length: 4 }, (_, k) => {
    const v = (maxCost * k) / 3;
    const y = P.t + iH - (v / maxCost) * iH;
    return `
      <line x1="${P.l}" y1="${y.toFixed(1)}" x2="${(P.l+iW).toFixed(1)}" y2="${y.toFixed(1)}"
        stroke="currentColor" stroke-opacity="0.07" stroke-dasharray="3 3"/>
      <text x="${(P.l-5).toFixed(1)}" y="${(y+3.5).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="currentColor" fill-opacity="0.4">$${v.toFixed(2)}</text>`;
  }).join('');

  const step = Math.max(1, Math.floor(n / 7));
  const xLabels = data.map((d, i) => {
    if (i % step !== 0 && i !== n - 1) return '';
    const x = P.l + i * slotW + slotW / 2;
    return `<text x="${x.toFixed(1)}" y="${(H-4).toFixed(1)}" text-anchor="middle"
      font-size="9.5" fill="currentColor" fill-opacity="0.4">${d.date.slice(5).replace('-', '/')}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">
    ${grid}
    ${bars}
    ${xLabels}
  </svg>`;
}

// ── Main HTML ─────────────────────────────────────────────────────────────────

function buildHtml(): string {
  const today      = querySummary(startOfToday());
  const week       = querySummary(startOfWeek());
  const month      = querySummary(startOfMonth());
  const live       = queryTodayTotals();
  const rateLimits = queryRateLimits(7);
  const daily      = queryDaily(30);

  const cfg    = vscode.workspace.getConfiguration('tokenTracker');
  const merges = cfg.get<Record<string, string[]>>('projectMerges', {});
  const grouped = groupProjects(queryProjects(), merges);

  const projectRows = grouped.map(p => `
    <tr>
      <td>${p.name}</td>
      <td class="num dim">${p.sessions}</td>
      <td class="num" style="color:var(--blue)">${fmt(p.input)}</td>
      <td class="num" style="color:var(--purple)">${fmt(p.output)}</td>
      <td class="cost">${fmtCost(p.cost_usd)}</td>
    </tr>`).join('');

  const rateLimitRows = rateLimits.length
    ? rateLimits.map(r => `
      <tr>
        <td class="dim">${new Date(r.timestamp).toLocaleString()}</td>
        <td>${shortProject(r.project)}</td>
        <td class="warn">${r.wait_seconds}s</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="empty">No rate-limit events in last 7 days ✓</td></tr>';

  const modelShort = live.model.replace(/^claude-/, '');
  const chipCls    = live.model.includes('opus')  ? 'chip-opus'
                   : live.model.includes('haiku') ? 'chip-haiku'
                   : 'chip-sonnet';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  :root {
    --blue:     #60a5fa;
    --blue-bg:  rgba(96,165,250,0.10);
    --purple:   #a78bfa;
    --purp-bg:  rgba(167,139,250,0.10);
    --green:    #34d399;
    --green-bg: rgba(52,211,153,0.10);
    --yellow:   #fbbf24;
    --orange:   #fb923c;
    --red:      #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 22px 32px;
    max-width: 900px;
  }

  /* Header */
  .header {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 22px; padding-bottom: 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .hex { font-size: 22px; }
  .header h2 { font-size: 1.05em; font-weight: 700; flex: 1; }
  .chip {
    padding: 3px 10px; border-radius: 20px;
    font-size: 0.73em; font-weight: 600; letter-spacing: 0.03em;
  }
  .chip-sonnet { background: var(--purp-bg);  color: var(--purple); border: 1px solid rgba(167,139,250,0.28); }
  .chip-opus   { background: rgba(251,146,60,0.10); color: var(--orange); border: 1px solid rgba(251,146,60,0.28); }
  .chip-haiku  { background: var(--green-bg); color: var(--green);  border: 1px solid rgba(52,211,153,0.28); }

  /* Stat cards */
  .stat-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin-bottom: 14px; }
  .stat-card {
    background: rgba(128,128,128,0.07);
    border: 1px solid rgba(128,128,128,0.14);
    border-radius: 10px; padding: 15px;
  }
  .stat-label {
    font-size: 0.67em; text-transform: uppercase; letter-spacing: .09em;
    font-weight: 600; opacity: 0.5; margin-bottom: 7px;
  }
  .stat-cost {
    font-size: 1.6em; font-weight: 700; line-height: 1;
    margin-bottom: 11px; font-variant-numeric: tabular-nums;
  }
  .stat-tokens { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .tok-label { font-size: 0.67em; opacity: 0.5; margin-bottom: 2px; }
  .tok-val   { font-size: 0.85em; font-weight: 600; }

  /* Chart cards */
  .chart-card {
    background: rgba(128,128,128,0.07);
    border: 1px solid rgba(128,128,128,0.14);
    border-radius: 10px; padding: 15px 16px 8px; margin-bottom: 14px;
  }
  .chart-head {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
  }
  .chart-title  { font-size: 0.87em; font-weight: 600; }
  .chart-legend { display: flex; gap: 14px; }
  .legend-item  { display: flex; align-items: center; gap: 5px; font-size: 0.73em; opacity: 0.6; }
  .legend-dot   { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

  /* Table cards */
  .table-card {
    background: rgba(128,128,128,0.07);
    border: 1px solid rgba(128,128,128,0.14);
    border-radius: 10px; overflow: hidden; margin-bottom: 14px;
  }
  .table-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 11px 14px 8px; font-size: 0.87em; font-weight: 600;
    border-bottom: 1px solid rgba(128,128,128,0.12);
  }
  .table-hint { font-size: 0.72em; font-weight: normal; opacity: 0.4; }
  table { width: 100%; border-collapse: collapse; font-size: 0.83em; }
  th {
    text-align: left; padding: 5px 14px;
    font-size: 0.68em; text-transform: uppercase; letter-spacing: .07em;
    font-weight: normal; opacity: 0.45;
    border-bottom: 1px solid rgba(128,128,128,0.12);
  }
  td { padding: 7px 14px; border-bottom: 1px solid rgba(128,128,128,0.06); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(128,128,128,0.05); }

  /* Badges */
  .badge { display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 0.76em; font-weight: 600; }
  .badge-opus   { background: rgba(251,146,60,0.12); color: var(--orange); border: 1px solid rgba(251,146,60,0.25); }
  .badge-sonnet { background: var(--purp-bg); color: var(--purple); border: 1px solid rgba(167,139,250,0.25); }
  .badge-haiku  { background: var(--green-bg); color: var(--green);  border: 1px solid rgba(52,211,153,0.25); }
  .badge-other  { background: rgba(128,128,128,0.12); opacity: 0.6; }

  /* Misc */
  .num  { font-variant-numeric: tabular-nums; }
  .cost { color: var(--yellow); font-weight: 600; font-variant-numeric: tabular-nums; }
  .warn { color: var(--red); font-weight: 600; }
  .dim  { opacity: 0.50; }
  .empty { text-align: center; padding: 14px; opacity: 0.38; }

  /* Footer */
  .footer {
    margin-top: 20px; padding-top: 12px;
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 0.70em; opacity: 0.45; line-height: 1.6;
  }
</style>
</head>
<body>

<div class="header">
  <span class="hex">⬡</span>
  <h2>AI Token Tracker</h2>
  <span class="chip ${chipCls}">${modelShort || 'unknown'}</span>
</div>

<div class="stat-grid">
  <div class="stat-card">
    <div class="stat-label">Today</div>
    <div class="stat-cost">${fmtCost(today.cost_usd)}</div>
    <div class="stat-tokens">
      <div><div class="tok-label">↓ Input</div><div class="tok-val" style="color:var(--blue)">${fmt(today.input)}</div></div>
      <div><div class="tok-label">↑ Output</div><div class="tok-val" style="color:var(--purple)">${fmt(today.output)}</div></div>
    </div>
  </div>
  <div class="stat-card">
    <div class="stat-label">7 Days</div>
    <div class="stat-cost">${fmtCost(week.cost_usd)}</div>
    <div class="stat-tokens">
      <div><div class="tok-label">↓ Input</div><div class="tok-val" style="color:var(--blue)">${fmt(week.input)}</div></div>
      <div><div class="tok-label">↑ Output</div><div class="tok-val" style="color:var(--purple)">${fmt(week.output)}</div></div>
    </div>
  </div>
  <div class="stat-card">
    <div class="stat-label">30 Days</div>
    <div class="stat-cost">${fmtCost(month.cost_usd)}</div>
    <div class="stat-tokens">
      <div><div class="tok-label">↓ Input</div><div class="tok-val" style="color:var(--blue)">${fmt(month.input)}</div></div>
      <div><div class="tok-label">↑ Output</div><div class="tok-val" style="color:var(--purple)">${fmt(month.output)}</div></div>
    </div>
  </div>
</div>

<div class="chart-card">
  <div class="chart-head">
    <span class="chart-title">Tokens — last 30 days</span>
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#60a5fa"></span>Input</span>
      <span class="legend-item"><span class="legend-dot" style="background:#a78bfa"></span>Output</span>
    </div>
  </div>
  ${buildAreaChart(daily)}
</div>

<div class="chart-card">
  <div class="chart-head">
    <span class="chart-title">Estimated cost — last 30 days</span>
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#34d399"></span>USD</span>
    </div>
  </div>
  ${buildBarChart(daily)}
</div>

<div class="table-card">
  <div class="table-head">
    <span>Projects — all time</span>
    <span class="table-hint">Merge via Settings → tokenTracker.projectMerges</span>
  </div>
  <table>
    <thead><tr><th>Project</th><th>Sessions</th><th>Input</th><th>Output</th><th>Est. Cost</th></tr></thead>
    <tbody>${projectRows || '<tr><td colspan="5" class="empty">No sessions recorded yet</td></tr>'}</tbody>
  </table>
</div>

<div class="table-card">
  <div class="table-head">Rate-limit events — last 7 days</div>
  <table>
    <thead><tr><th>Time</th><th>Project</th><th>Wait</th></tr></thead>
    <tbody>${rateLimitRows}</tbody>
  </table>
</div>

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
