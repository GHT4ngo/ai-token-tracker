import * as vscode from 'vscode';
import * as os from 'os';
import {
  queryTodayTotals,
  querySummary,
  queryProjects,
  ProjectRow,
  queryRateLimits,
  queryDailyByProvider,
  DailyByProvider,
  queryProviderRisk,
  ProviderRiskRow,
  queryCapPeriods,
  CapPeriod,
  queryCapPredictions,
  CapPrediction,
} from './db';

let panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;

// ── Folder state ──────────────────────────────────────────────────────────────

function getFolders(): Record<string, string[]> {
  return _context?.globalState.get<Record<string, string[]>>('projectFolders', {}) ?? {};
}
async function saveFolders(f: Record<string, string[]>): Promise<void> {
  await _context?.globalState.update('projectFolders', f);
}
function getChartRange(): number {
  return _context?.globalState.get<number>('chartRangeDays', 30) ?? 30;
}
async function saveChartRange(days: number): Promise<void> {
  await _context?.globalState.update('chartRangeDays', days);
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtCost(usd: number): string { return `$${usd.toFixed(2)}`; }
function fmtApprox(n: number): string { return n === 0 ? 'quiet' : `~${fmt(n)}`; }
function shortProject(p: string): string { return p.split(/[/\\]/).filter(Boolean).pop() ?? p; }
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtMB(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

// ── Date helpers ──────────────────────────────────────────────────────────────

function startOfToday(): string { return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'; }
function startOfWeek():  string { const d = new Date(); d.setDate(d.getDate() - 7);  return d.toISOString(); }
function startOfMonth(): string { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString(); }

// ── Project grouping ──────────────────────────────────────────────────────────

interface GroupedProject {
  id: string;
  name: string;
  provider: string;
  sessions: number;
  input: number;
  output: number;
  cost_usd: number;
  subrows?: GroupedProject[];
}

function groupProjects(rows: ProjectRow[], merges: Record<string, string[]>): GroupedProject[] {
  const aliasMap: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(merges)) {
    for (const alias of aliases) { aliasMap[alias.toLowerCase()] = canonical; }
  }
  const grouped: Record<string, { g: GroupedProject; srcs: GroupedProject[] }> = {};
  for (const p of rows) {
    if (p.input === 0 && p.output === 0) { continue; }
    const short     = shortProject(p.project);
    const canonical = aliasMap[short.toLowerCase()] ?? short;
    const provider  = p.provider || 'unknown';
    const key       = `${provider}:${canonical}`;
    if (!grouped[key]) {
      grouped[key] = { g: { id: key, name: canonical, provider, sessions: 0, input: 0, output: 0, cost_usd: 0 }, srcs: [] };
    }
    grouped[key].g.sessions += p.sessions;
    grouped[key].g.input    += p.input;
    grouped[key].g.output   += p.output;
    grouped[key].g.cost_usd += p.cost_usd;
    grouped[key].srcs.push({ id: `${provider}:${short}`, name: short, provider, sessions: p.sessions, input: p.input, output: p.output, cost_usd: p.cost_usd });
  }
  return Object.values(grouped).map(({ g, srcs }) => {
    if (srcs.length > 1) { g.subrows = srcs; }
    return g;
  }).sort((a, b) => a.name === b.name ? a.provider.localeCompare(b.provider) : b.cost_usd - a.cost_usd);
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

function smoothLinePath(pts: [number, number][]): string {
  if (pts.length === 0) { return ''; }
  if (pts.length === 1) { return `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`; }
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cpx = ((x0 + x1) / 2).toFixed(1);
    d += ` C ${cpx},${y0.toFixed(1)} ${cpx},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

function smoothAreaPath(pts: [number, number][], base: number): string {
  if (pts.length === 0) { return ''; }
  const n    = pts.length;
  const line = smoothLinePath(pts);
  return `${line} L ${pts[n-1][0].toFixed(1)},${base.toFixed(1)} L ${pts[0][0].toFixed(1)},${base.toFixed(1)} Z`;
}

function rlMarkerSvg(x: number, yTop: number, label: string): string {
  return `<circle cx="${x.toFixed(1)}" cy="${yTop.toFixed(1)}" r="4" fill="#f87171" stroke="currentColor" stroke-width="1" stroke-opacity="0.25" opacity="0.92"><title>${label}</title></circle>`;
}

function softcapLineSvg(x1: number, x2: number, y: number): string {
  return `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#f87171" stroke-width="2" stroke-linecap="round" opacity="0.85"/>`;
}

// Single-provider smooth area chart with soft bezier curves
function buildProviderChart(
  data: DailyByProvider[],
  provider: 'claude' | 'codex',
  color: string,
  gradId: string,
  rlDates: Set<string>,
  capPeriods: CapPeriod[]
): string {
  const W = 760, H = 190;
  const P = { t: 22, r: 12, b: 26, l: 50 };
  const iW = W - P.l - P.r, iH = H - P.t - P.b;

  const totals = data.map(d =>
    provider === 'claude'
      ? d.claude.input + d.claude.output
      : d.codex.input  + d.codex.output
  );
  const maxVal = Math.max(...totals, 1);
  const allZero = totals.every(v => v === 0);

  if (data.length === 0 || allZero) {
    const label = provider === 'claude' ? 'Claude Code' : 'Codex';
    return `<svg viewBox="0 0 ${W} ${H}" width="100%">
      <text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12" fill="currentColor" fill-opacity="0.3">No ${label} activity in this range</text>
    </svg>`;
  }

  const n    = data.length;
  const xOf  = (i: number) => P.l + (n <= 1 ? iW / 2 : (i / (n - 1)) * iW);
  const yOf  = (v: number) => P.t + iH - (v / maxVal) * iH;
  const base = P.t + iH;

  const pts: [number, number][] = data.map((_, i) => [xOf(i), yOf(totals[i])]);

  const grid = Array.from({ length: 5 }, (_, k) => {
    const v = (maxVal * k) / 4, y = yOf(v);
    return `
      <line x1="${P.l}" y1="${y.toFixed(1)}" x2="${(P.l+iW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.07" stroke-dasharray="3 3"/>
      <text x="${(P.l-5).toFixed(1)}" y="${(y+3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="currentColor" fill-opacity="0.4">${k === 0 ? '0' : fmt(maxVal * k / 4)}</text>`;
  }).join('');

  const step = Math.max(1, Math.floor(n / 7));
  const xLabels = data.map((d, i) => {
    if (i % step !== 0 && i !== n - 1) { return ''; }
    return `<text x="${xOf(i).toFixed(1)}" y="${(H-4).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.4">${d.date.slice(5).replace('-', '/')}</text>`;
  }).join('');

  // Cap bands: semi-transparent red columns for each day within a cap period
  const colW   = n > 1 ? iW / (n - 1) : iW;
  const halfCol = colW / 2;
  const providerPeriods = capPeriods.filter(cp => cp.provider === provider);
  const capBands = data.map((d, i) => {
    const dayStart = d.date + 'T00:00:00.000Z';
    const dayEnd   = d.date + 'T23:59:59.999Z';
    const hasSecondary = providerPeriods.some(cp => cp.window_type === 'secondary' && cp.start <= dayEnd && cp.end >= dayStart);
    const hasPrimary   = providerPeriods.some(cp => cp.window_type === 'primary'   && cp.start <= dayEnd && cp.end >= dayStart);
    if (!hasPrimary && !hasSecondary) { return ''; }
    const x    = xOf(i);
    const rx   = Math.max(P.l, x - halfCol);
    const rw   = Math.min(P.l + iW, x + halfCol) - rx;
    // Secondary cap (weekly) gets a stronger red; primary (5h) is subtler
    const fill  = hasSecondary ? 'rgba(248,113,113,0.28)' : 'rgba(248,113,113,0.15)';
    const label = hasSecondary ? 'Weekly cap active' : '5h cap active';
    return `<rect x="${rx.toFixed(1)}" y="${P.t.toFixed(1)}" width="${rw.toFixed(1)}" height="${iH.toFixed(1)}" fill="${fill}" rx="1"><title>${label} · ${d.date}</title></rect>`;
  }).join('');

  const markers = data.map((d, i) => {
    if (!rlDates.has(d.date)) { return ''; }
    return rlMarkerSvg(xOf(i), P.t - 8, `Rate limit · ${d.date.slice(5).replace('-', '/')}`);
  }).join('');

  const areaD = smoothAreaPath(pts, base);
  const lineD = smoothLinePath(pts);

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.50"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${grid}
    ${capBands}
    <path d="${areaD}" fill="url(#${gradId})"/>
    <path d="${lineD}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
    ${xLabels}${markers}
  </svg>`;
}

function buildRangeToggle(activeDays: number): string {
  return [90, 30, 7, 3].map(days => {
    const active = days === activeDays ? ' active' : '';
    return `<button class="range-btn${active}" data-range="${days}">${days}d</button>`;
  }).join('');
}

function riskCopy(r: ProviderRiskRow): string {
  if (r.status === 'capped') { return r.resets_at ? `Likely released ${new Date(r.resets_at).toLocaleString()}` : 'Softcap likely active'; }
  if (r.status === 'low')    { return 'Keep changes small'; }
  if (r.status === 'watch')  { return 'Good moment to plan'; }
  if (r.status === 'fresh')  { return 'Fresh window'; }
  return 'Steady';
}

function buildRiskCards(risks: ProviderRiskRow[]): string {
  if (risks.length === 0) {
    return '<div class="empty">No AI engine activity found yet</div>';
  }
  return risks.map(r => {
    const cls   = `risk-${r.status}`;
    const label = r.provider === 'codex' ? 'Codex' : r.provider === 'claude' ? 'Claude Code' : r.provider;
    return `<div class="risk-card ${cls}">
      <div class="risk-top"><span>${esc(label)}</span><span class="risk-confidence">${r.confidence}</span></div>
      <div class="risk-percent">~${r.used_percent}% used</div>
      <div class="risk-bar"><span style="width:${Math.max(2, r.used_percent)}%"></span></div>
      <div class="risk-note">${esc(riskCopy(r))}</div>
    </div>`;
  }).join('');
}

// ── Usage tracker bar (bottom of panel) ──────────────────────────────────────

function buildUsageTracker(risks: ProviderRiskRow[]): string {
  if (risks.length === 0) { return ''; }
  const bars = risks.map(r => {
    const label   = r.provider === 'codex' ? 'Codex' : r.provider === 'claude' ? 'Claude Code' : r.provider;
    const color   = r.provider === 'codex' ? '#22d3ee' : '#a78bfa';
    const dotColor = r.used_percent >= 80 ? '#f87171' : r.used_percent >= 50 ? '#fbbf24' : '#34d399';
    const pct     = Math.min(100, Math.max(2, r.used_percent));
    return `<div class="ut-row">
      <span class="ut-label">${esc(label)}</span>
      <div class="ut-bar-wrap">
        <div class="ut-bar-fill" style="width:${pct}%;background:${color};"></div>
      </div>
      <span class="ut-pct" style="color:${dotColor}">${r.used_percent}%</span>
      <span class="ut-conf dim">${r.confidence}</span>
    </div>`;
  }).join('');
  return `<div class="usage-tracker">
    <div class="ut-title">Estimated quota usage</div>
    ${bars}
  </div>`;
}

// ── Cap rate prediction card ──────────────────────────────────────────────────

function buildCapPrediction(predictions: CapPrediction[]): string {
  if (predictions.length === 0) { return ''; }

  const rows = predictions.map(p => {
    const providerLabel = p.provider === 'codex' ? 'Codex' : 'Claude Code';
    const windowLabel   = p.window_type === 'secondary' ? '7-day' : '5h';
    const rateStr       = `+${p.rate_per_hour.toFixed(1)}%/hr`;

    let timeStr = '';
    let timeColor = 'var(--green)';
    if (p.hours_to_cap !== null) {
      const h = p.hours_to_cap;
      timeColor = h < 1 ? 'var(--red)' : h < 4 ? 'var(--yellow)' : 'var(--green)';
      timeStr = h < 1
        ? `~${Math.round(h * 60)}m to cap`
        : h < 24
          ? `~${h.toFixed(1)}h to cap`
          : `~${(h / 24).toFixed(1)}d to cap`;
    } else if (p.current_percent >= 95) {
      timeColor = 'var(--red)';
      timeStr = 'capped';
    }

    const resetsStr = p.resets_at
      ? `resets ${new Date(p.resets_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    return `<div class="pred-row">
      <span class="pred-label">${esc(providerLabel)}</span>
      <span class="pred-win dim">${esc(windowLabel)} window</span>
      <span class="pred-rate dim">${rateStr}</span>
      ${timeStr ? `<span class="pred-time" style="color:${timeColor}">${esc(timeStr)}</span>` : ''}
      ${resetsStr ? `<span class="pred-resets dim">${esc(resetsStr)}</span>` : ''}
    </div>`;
  }).join('');

  return `<div class="prediction-card">
    <div class="pred-title">Cap Prediction</div>
    ${rows}
  </div>`;
}

// ── Memory section ────────────────────────────────────────────────────────────

interface ExtInfo { id: string; name: string; version: string; active: boolean; isUs: boolean; }

function collectExtensionInfo(): ExtInfo[] {
  return vscode.extensions.all
    .map(e => ({
      id:      e.id,
      name:    (e.packageJSON as Record<string, unknown>)?.['displayName'] as string ?? e.id,
      version: (e.packageJSON as Record<string, unknown>)?.['version'] as string ?? '?',
      active:  e.isActive,
      isUs:    e.id === 'tango-solutions.ai-token-tracker',
    }))
    .sort((a, b) => {
      if (a.isUs !== b.isUs) { return a.isUs ? -1 : 1; }
      if (a.active !== b.active) { return a.active ? -1 : 1; }
      return a.name.localeCompare(b.name);
    });
}

function buildMemorySection(): string {
  const mem  = process.memoryUsage();
  const exts = collectExtensionInfo();
  const activeCount   = exts.filter(e => e.active).length;
  const inactiveCount = exts.length - activeCount;

  const rows = exts.map(e => {
    const nameCls = e.isUs ? ' style="color:var(--purple);font-weight:700"' : '';
    const badge   = e.isUs ? ' <span class="us-badge">this extension</span>' : '';
    return `<tr class="${e.active ? '' : 'dim'}">
      <td class="pname"${nameCls}>${esc(e.name)}${badge}</td>
      <td class="dim" style="font-size:0.75em">${esc(e.id)}</td>
      <td class="num dim">${esc(e.version)}</td>
      <td>${e.active ? '<span class="active-dot">●</span>' : '<span class="dim">○</span>'}</td>
    </tr>`;
  }).join('');

  return `<div class="mem-section">
    <div class="mem-header">
      <div class="mem-stat-group">
        <div class="mem-stat">
          <div class="mem-stat-label">Extension Host Heap</div>
          <div class="mem-stat-val">${fmtMB(mem.heapUsed)} / ${fmtMB(mem.heapTotal)}</div>
        </div>
        <div class="mem-stat">
          <div class="mem-stat-label">Resident Set</div>
          <div class="mem-stat-val">${fmtMB(mem.rss)}</div>
        </div>
        <div class="mem-stat">
          <div class="mem-stat-label">Extensions loaded</div>
          <div class="mem-stat-val">${activeCount} active · ${inactiveCount} inactive</div>
        </div>
      </div>
      <div class="mem-note dim">Per-extension memory is not exposed by the VS Code API. The heap above covers the entire extension host process (all extensions combined). Use <button class="proc-btn" data-action="process-explorer">Process Explorer</button> for OS-level breakdown.</div>
    </div>
    <div class="table-card" style="margin-top:10px">
      <table>
        <thead><tr><th>Extension</th><th>ID</th><th>Version</th><th>Active</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Projects table ────────────────────────────────────────────────────────────

function buildProjectsTable(
  allProjects: GroupedProject[],
  folders: Record<string, string[]>
): string {
  let sgIdx = 0;

  const hasFolders      = Object.keys(folders).length > 0;
  const projectMap      = new Map(allProjects.map(p => [p.id, p]));
  const folderProjectIds = Object.values(folders).flat();
  const legacyNames     = new Set(folderProjectIds.filter(id => !id.includes(':')));
  const assignedSet     = new Set(folderProjectIds);
  const unfiled         = allProjects.filter(p => !assignedSet.has(p.id) && !legacyNames.has(p.name));

  function projectRow(p: GroupedProject, extraClass = '', indent = false): string {
    const providerLabel = p.provider === 'codex' ? 'Codex' : p.provider === 'claude' ? 'Claude Code' : p.provider;
    const hasSubrows    = !!(p.subrows?.length);
    const myIdx         = hasSubrows ? sgIdx++ : -1;
    const toggle        = hasSubrows ? `<span class="sub-toggle" data-sub-toggle="sg${myIdx}">▼</span> ` : '';

    const parentTr = `<tr class="proj-row ${extraClass}" data-project="${esc(p.id)}" draggable="true">
      <td class="pname${indent ? ' indent' : ''}">${toggle}${esc(p.name)}</td>
      <td><span class="provider-pill provider-${esc(p.provider)}">${esc(providerLabel)}</span></td>
      <td class="num dim">${p.sessions}</td>
      <td class="num" style="color:var(--blue)">${fmtApprox(p.input)}</td>
      <td class="num" style="color:var(--purple)">${fmtApprox(p.output)}</td>
      <td class="cost">${fmtCost(p.cost_usd)}</td>
    </tr>`;

    if (!hasSubrows) { return parentTr; }

    const subTrs = p.subrows!.map(sub => {
      const subLabel = sub.provider === 'codex' ? 'Codex' : sub.provider === 'claude' ? 'Claude Code' : sub.provider;
      return `<tr class="sub-row sg${myIdx}" style="display:none">
        <td class="pname indent2">${esc(sub.name)}</td>
        <td><span class="provider-pill provider-${esc(sub.provider)}">${esc(subLabel)}</span></td>
        <td class="num dim">${sub.sessions}</td>
        <td class="num" style="color:var(--blue)">${fmtApprox(sub.input)}</td>
        <td class="num" style="color:var(--purple)">${fmtApprox(sub.output)}</td>
        <td class="cost">${fmtCost(sub.cost_usd)}</td>
      </tr>`;
    }).join('');

    return parentTr + subTrs;
  }

  if (!hasFolders) {
    const rows = allProjects.map(p => projectRow(p)).join('') ||
      '<tr><td colspan="6" class="empty">No sessions recorded yet</td></tr>';
    return `<thead><tr><th>Project</th><th>Engine</th><th>Sessions</th><th>Input</th><th>Output</th><th>Est. Cost</th></tr></thead>
    <tbody>${rows}</tbody>`;
  }

  const folderRows = Object.entries(folders).map(([name, ids], idx) => {
    const projects = ids.flatMap(n => {
      const exact = projectMap.get(n);
      if (exact) { return [exact]; }
      return allProjects.filter(p => p.name === n);
    });
    const totalCost  = projects.reduce((s, p) => s + p.cost_usd, 0);
    const projectTrs = projects.map(p => projectRow(p, `fr${idx}`, true)).join('');

    return `
    <tr class="folder-hdr" data-drop-folder="${esc(name)}" data-folder-idx="${idx}">
      <td colspan="6" class="fhdr-cell">
        <span class="ftoggle" data-toggle="${idx}">▼</span>
        <span class="fname">${esc(name)}</span>
        <span class="fmeta dim">${projects.length} project${projects.length !== 1 ? 's' : ''} · ${fmtCost(totalCost)}</span>
        <button class="fdel" data-del-folder="${esc(name)}" title="Delete folder">✕</button>
      </td>
    </tr>
    ${projectTrs}`;
  }).join('');

  const unfiledTrs = unfiled.map(p => projectRow(p, 'unfiled-row')).join('');
  const unfiledSection = `
    <tr class="folder-hdr unfiled-hdr" data-drop-folder="" data-folder-idx="unfiled">
      <td colspan="6" class="fhdr-cell">
        <span class="ftoggle" data-toggle="unfiled">▼</span>
        <span class="fname dim">Unfiled</span>
        <span class="fmeta dim">${unfiled.length} project${unfiled.length !== 1 ? 's' : ''}</span>
      </td>
    </tr>
    ${unfiledTrs || '<tr class="unfiled-row"><td colspan="6" class="empty dim">Drop projects here to unfile them</td></tr>'}`;

  return `<thead><tr><th>Project</th><th>Engine</th><th>Sessions</th><th>Input</th><th>Output</th><th>Est. Cost</th></tr></thead>
    <tbody>${folderRows}${unfiledSection}</tbody>`;
}

// ── Main HTML ─────────────────────────────────────────────────────────────────

function buildHtml(activeTab: 'stats' | 'memory' = 'stats'): string {
  const today      = querySummary(startOfToday());
  const week       = querySummary(startOfWeek());
  const month      = querySummary(startOfMonth());
  const chartRange = getChartRange();
  const daily      = queryDailyByProvider(chartRange);
  const rlRange    = queryRateLimits(chartRange);
  const risks      = queryProviderRisk(30);
  const rlDates    = new Set(rlRange.map(r => r.timestamp.slice(0, 10)));
  const rl30       = queryRateLimits(30);
  const rl7        = rl30.filter(r => new Date(r.timestamp) >= new Date(Date.now() - 7 * 864e5));

  const cfg        = vscode.workspace.getConfiguration('tokenTracker');
  const merges     = cfg.get<Record<string, string[]>>('projectMerges', {});
  const folders    = getFolders();
  const allProjects = groupProjects(queryProjects(), merges);

  const hasCodex  = daily.some(d => d.codex.input + d.codex.output > 0);
  const hasRl     = rlDates.size > 0;
  const capPeriods      = queryCapPeriods(chartRange);
  const capPredictions  = queryCapPredictions();
  const hasCapPrediction = capPredictions.length > 0;
  const hasCaps   = capPeriods.length > 0;

  const rateLimitRows = rl7.length
    ? rl7.map(r => `
      <tr>
        <td class="dim">${new Date(r.timestamp).toLocaleString()}</td>
        <td>${esc(r.project.split(/[/\\]/).filter(Boolean).pop() ?? r.project)}</td>
        <td class="warn">${r.wait_seconds}s</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="empty">No rate-limit events in last 7 days ✓</td></tr>';

  const statsHidden  = activeTab !== 'stats'  ? ' style="display:none"' : '';
  const memHidden    = activeTab !== 'memory' ? ' style="display:none"' : '';
  const statsActive  = activeTab === 'stats'  ? ' active' : '';
  const memActive    = activeTab === 'memory' ? ' active' : '';

  const claudeChartHtml = buildProviderChart(daily, 'claude', '#a78bfa', 'gClaude', rlDates, capPeriods);
  const codexChartHtml  = hasCodex ? buildProviderChart(daily, 'codex', '#22d3ee', 'gCodex', rlDates, capPeriods) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
    --cyan:     #22d3ee;
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
  .header { display:flex; align-items:center; gap:10px; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid var(--vscode-panel-border); }
  .hex { font-size:22px; }
  .header h2 { font-size:1.05em; font-weight:700; flex:1; }

  /* Tabs */
  .tabs { display:flex; gap:2px; margin-bottom:18px; border-bottom:1px solid rgba(128,128,128,0.15); }
  .tab-btn { background:none; border:none; color:inherit; padding:6px 14px; font-size:0.82em; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; opacity:0.55; }
  .tab-btn.active { opacity:1; border-bottom-color:var(--purple); color:var(--purple); }
  .tab-btn:hover:not(.active) { opacity:0.8; }

  /* Stat cards */
  .stat-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:14px; }
  .stat-card { background:rgba(128,128,128,0.07); border:1px solid rgba(128,128,128,0.14); border-radius:10px; padding:15px; }
  .stat-label { font-size:0.67em; text-transform:uppercase; letter-spacing:.09em; font-weight:600; opacity:0.5; margin-bottom:7px; }
  .stat-cost  { font-size:1.6em; font-weight:700; line-height:1; margin-bottom:11px; font-variant-numeric:tabular-nums; }
  .stat-tokens { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .tok-label { font-size:0.67em; opacity:0.5; margin-bottom:2px; }
  .tok-val   { font-size:0.85em; font-weight:600; }

  /* Risk cards */
  .risk-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin-bottom:14px; }
  .risk-card { background:rgba(128,128,128,0.07); border:1px solid rgba(128,128,128,0.14); border-radius:8px; padding:13px 14px; }
  .risk-top { display:flex; justify-content:space-between; gap:10px; font-size:0.78em; font-weight:700; margin-bottom:8px; }
  .risk-confidence { opacity:0.45; font-size:0.82em; text-transform:uppercase; letter-spacing:.07em; }
  .risk-percent { font-size:1.35em; font-weight:700; margin-bottom:9px; }
  .risk-bar { height:7px; background:rgba(128,128,128,0.16); border-radius:999px; overflow:hidden; margin-bottom:8px; }
  .risk-bar span { display:block; height:100%; background:var(--green); border-radius:999px; }
  .risk-low .risk-bar span, .risk-capped .risk-bar span { background:var(--red); }
  .risk-watch .risk-bar span { background:var(--yellow); }
  .risk-note { font-size:0.78em; opacity:0.62; }

  /* Controls */
  .range-toggle { display:flex; gap:4px; align-items:center; }
  .range-btn { background:rgba(128,128,128,0.08); border:1px solid rgba(128,128,128,0.16); color:inherit; border-radius:5px; padding:2px 7px; font-size:0.72em; cursor:pointer; }
  .range-btn.active { background:var(--blue-bg); border-color:rgba(96,165,250,0.35); color:var(--blue); }
  .provider-pill { display:inline-block; border-radius:4px; padding:1px 6px; font-size:0.74em; background:rgba(128,128,128,0.12); opacity:0.85; }
  .provider-claude { background:rgba(167,139,250,0.12); color:var(--purple); border:1px solid rgba(167,139,250,0.24); }
  .provider-codex  { background:rgba(34,211,238,0.12);  color:var(--cyan);   border:1px solid rgba(34,211,238,0.24); }

  /* Chart cards */
  .chart-card { background:rgba(128,128,128,0.07); border:1px solid rgba(128,128,128,0.14); border-radius:10px; padding:15px 16px 8px; margin-bottom:14px; transition:box-shadow 0.15s; }
  .chart-card.zoomed {
    position:fixed; inset:16px; z-index:999;
    padding:20px; overflow:hidden;
    background:var(--vscode-editor-background);
    box-shadow:0 8px 40px rgba(0,0,0,0.5);
    max-width:none;
    display:flex; flex-direction:column;
  }
  .chart-card.zoomed svg { flex:1; height:0; min-height:0; }
  .chart-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; flex-wrap:wrap; gap:6px; }
  .chart-title  { font-size:0.87em; font-weight:600; }
  .chart-legend { display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .legend-item  { display:flex; align-items:center; gap:5px; font-size:0.73em; opacity:0.6; }
  .legend-dot   { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .zoom-hint    { font-size:0.68em; opacity:0.35; cursor:pointer; user-select:none; white-space:nowrap; }
  .zoom-hint:hover { opacity:0.65; }

  /* Table cards */
  .table-card { background:rgba(128,128,128,0.07); border:1px solid rgba(128,128,128,0.14); border-radius:10px; overflow:hidden; margin-bottom:14px; }
  .table-head { display:flex; align-items:center; justify-content:space-between; padding:11px 14px 8px; font-size:0.87em; font-weight:600; border-bottom:1px solid rgba(128,128,128,0.12); }
  table { width:100%; border-collapse:collapse; font-size:0.83em; }
  th { text-align:left; padding:5px 14px; font-size:0.68em; text-transform:uppercase; letter-spacing:.07em; font-weight:normal; opacity:0.45; border-bottom:1px solid rgba(128,128,128,0.12); }
  td { padding:7px 14px; border-bottom:1px solid rgba(128,128,128,0.06); vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  .proj-row:hover td { background:rgba(128,128,128,0.05); }

  /* Folder rows */
  .folder-hdr > td { padding:7px 14px; background:rgba(128,128,128,0.05); border-bottom:1px solid rgba(128,128,128,0.10); cursor:default; }
  .folder-hdr.drop-over > td { background:rgba(96,165,250,0.12); border-color:rgba(96,165,250,0.3); }
  .unfiled-hdr > td { background:transparent; }
  .fhdr-cell { display:flex; align-items:center; gap:8px; }
  .ftoggle { cursor:pointer; font-size:0.72em; width:14px; opacity:0.55; user-select:none; flex-shrink:0; }
  .fname { font-size:0.87em; font-weight:600; }
  .fmeta { font-size:0.74em; margin-left:auto; }
  .fdel { background:none; border:none; color:inherit; opacity:0.3; cursor:pointer; font-size:0.95em; padding:0 2px; line-height:1; }
  .fdel:hover { opacity:0.75; }
  .indent  { padding-left:30px !important; }
  .indent2 { padding-left:44px !important; }
  .proj-row[draggable="true"] { cursor:grab; }
  .proj-row[draggable="true"]:active { cursor:grabbing; }
  .proj-row.dragging { opacity:0.4; }
  .sub-toggle { cursor:pointer; font-size:0.72em; opacity:0.55; margin-right:3px; user-select:none; }
  .sub-row > td { opacity:0.75; }
  .new-folder-btn { background:rgba(128,128,128,0.08); border:1px solid rgba(128,128,128,0.16); color:inherit; border-radius:6px; padding:3px 10px; font-size:0.73em; cursor:pointer; white-space:nowrap; }
  .new-folder-btn:hover { background:rgba(128,128,128,0.16); }

  /* Usage tracker */
  .usage-tracker { background:rgba(128,128,128,0.07); border:1px solid rgba(128,128,128,0.14); border-radius:10px; padding:13px 16px; margin-bottom:14px; }
  .ut-title { font-size:0.72em; text-transform:uppercase; letter-spacing:.09em; font-weight:600; opacity:0.45; margin-bottom:10px; }
  .ut-row { display:flex; align-items:center; gap:10px; margin-bottom:7px; }
  .ut-row:last-child { margin-bottom:0; }
  .ut-label { font-size:0.78em; font-weight:600; min-width:100px; }
  .ut-bar-wrap { flex:1; height:6px; background:rgba(128,128,128,0.15); border-radius:999px; overflow:hidden; }
  .ut-bar-fill { height:100%; border-radius:999px; opacity:0.8; transition:width 0.3s; }
  .ut-pct { font-size:0.76em; font-weight:700; min-width:36px; text-align:right; }
  .ut-conf { font-size:0.68em; min-width:60px; }

  /* Memory section */
  .mem-section { margin-top:4px; }
  .mem-header { background:rgba(128,128,128,0.07); border:1px solid rgba(128,128,128,0.14); border-radius:10px; padding:14px 16px; margin-bottom:12px; }
  .mem-stat-group { display:flex; gap:24px; flex-wrap:wrap; margin-bottom:10px; }
  .mem-stat-label { font-size:0.67em; text-transform:uppercase; letter-spacing:.08em; opacity:0.45; margin-bottom:3px; }
  .mem-stat-val { font-size:1em; font-weight:700; font-variant-numeric:tabular-nums; }
  .mem-note { font-size:0.74em; line-height:1.55; }
  .proc-btn { background:rgba(128,128,128,0.12); border:1px solid rgba(128,128,128,0.2); color:inherit; border-radius:4px; padding:1px 7px; font-size:0.9em; cursor:pointer; }
  .proc-btn:hover { background:rgba(128,128,128,0.22); }
  .us-badge { display:inline-block; font-size:0.68em; background:rgba(167,139,250,0.18); color:var(--purple); border:1px solid rgba(167,139,250,0.3); border-radius:4px; padding:0 5px; margin-left:5px; vertical-align:middle; }
  .active-dot { color:var(--green); }

  /* Misc */
  .pname { max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .num  { font-variant-numeric:tabular-nums; }
  .cost { color:var(--yellow); font-weight:600; font-variant-numeric:tabular-nums; }
  .warn { color:var(--red); font-weight:600; }
  .dim  { opacity:0.50; }
  .empty { text-align:center; padding:14px; opacity:0.38; }

  /* Cap prediction */
  .prediction-card { background:rgba(128,128,128,0.07); border:1px solid rgba(128,128,128,0.14); border-radius:10px; padding:13px 16px; margin-bottom:14px; }
  .pred-title { font-size:0.72em; text-transform:uppercase; letter-spacing:.09em; font-weight:600; opacity:0.45; margin-bottom:10px; }
  .pred-row { display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap; }
  .pred-row:last-child { margin-bottom:0; }
  .pred-label { font-size:0.78em; font-weight:700; min-width:90px; }
  .pred-win { font-size:0.72em; min-width:75px; }
  .pred-rate { font-size:0.74em; min-width:70px; }
  .pred-time { font-size:0.78em; font-weight:700; }
  .pred-resets { font-size:0.70em; }

  /* Footer */
  .footer { margin-top:20px; padding-top:12px; border-top:1px solid var(--vscode-panel-border); font-size:0.70em; opacity:0.45; line-height:1.6; }
</style>
</head>
<body>

<div class="header">
  <span class="hex">⬡</span>
  <h2>AI Token Tracker</h2>
</div>

<div class="tabs">
  <button class="tab-btn${statsActive}" data-tab="stats">Stats</button>
  <button class="tab-btn${memActive}"   data-tab="memory">Memory</button>
</div>

<!-- ── Stats tab ── -->
<div id="tab-stats"${statsHidden}>

  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-label">Today</div>
      <div class="stat-cost">${fmtCost(today.cost_usd)}</div>
      <div class="stat-tokens">
        <div><div class="tok-label">↓ Input</div><div class="tok-val" style="color:var(--blue)">${fmtApprox(today.input)}</div></div>
        <div><div class="tok-label">↑ Output</div><div class="tok-val" style="color:var(--purple)">${fmtApprox(today.output)}</div></div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">7 Days</div>
      <div class="stat-cost">${fmtCost(week.cost_usd)}</div>
      <div class="stat-tokens">
        <div><div class="tok-label">↓ Input</div><div class="tok-val" style="color:var(--blue)">${fmtApprox(week.input)}</div></div>
        <div><div class="tok-label">↑ Output</div><div class="tok-val" style="color:var(--purple)">${fmtApprox(week.output)}</div></div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">30 Days</div>
      <div class="stat-cost">${fmtCost(month.cost_usd)}</div>
      <div class="stat-tokens">
        <div><div class="tok-label">↓ Input</div><div class="tok-val" style="color:var(--blue)">${fmtApprox(month.input)}</div></div>
        <div><div class="tok-label">↑ Output</div><div class="tok-val" style="color:var(--purple)">${fmtApprox(month.output)}</div></div>
      </div>
    </div>
  </div>

  <div class="risk-grid">${buildRiskCards(risks)}</div>

  ${hasCapPrediction ? buildCapPrediction(capPredictions) : ''}

  <!-- Claude Code activity chart -->
  <div class="chart-card" id="chart-claude">
    <div class="chart-head">
      <span class="chart-title">Claude Code — tokens/day</span>
      <div class="chart-legend">
        <span class="range-toggle">${buildRangeToggle(chartRange)}</span>
        <span class="legend-item"><span class="legend-dot" style="background:#a78bfa"></span>Claude Code</span>
        ${hasCaps ? '<span class="legend-item"><span class="legend-dot" style="background:rgba(248,113,113,0.6);border-radius:2px"></span>Cap active</span>' : ''}
        ${hasRl ? '<span class="legend-item"><span class="legend-dot" style="background:#f87171"></span>Rate limit</span>' : ''}
        <span class="zoom-hint" data-zoom="chart-claude">⤢ zoom</span>
      </div>
    </div>
    ${claudeChartHtml}
  </div>

  ${hasCodex ? `<!-- Codex activity chart -->
  <div class="chart-card" id="chart-codex">
    <div class="chart-head">
      <span class="chart-title">Codex — tokens/day</span>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-dot" style="background:#22d3ee"></span>Codex</span>
        ${hasCaps ? '<span class="legend-item"><span class="legend-dot" style="background:rgba(248,113,113,0.6);border-radius:2px"></span>Cap active</span>' : ''}
        ${hasRl ? '<span class="legend-item"><span class="legend-dot" style="background:#f87171"></span>Rate limit</span>' : ''}
        <span class="zoom-hint" data-zoom="chart-codex">⤢ zoom</span>
      </div>
    </div>
    ${codexChartHtml}
  </div>` : ''}

  <div class="table-card">
    <div class="table-head">
      <span>Projects — all time</span>
      <button class="new-folder-btn" data-action="create-folder">+ New folder</button>
    </div>
    <table>${buildProjectsTable(allProjects, folders)}</table>
  </div>

  <div class="table-card">
    <div class="table-head">Rate-limit events — last 7 days</div>
    <table>
      <thead><tr><th>Time</th><th>Project</th><th>Wait</th></tr></thead>
      <tbody>${rateLimitRows}</tbody>
    </table>
  </div>

  ${buildUsageTracker(risks)}

  <div class="footer">
    Costs are retail API equivalents — informational only.<br>
    All data stored locally. Nothing sent to any server.
  </div>

</div><!-- /tab-stats -->

<!-- ── Memory tab ── -->
<div id="tab-memory"${memHidden}>
  ${buildMemorySection()}
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  let dragging = null;

  // ── Tab switching ──────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      vscode.postMessage({ type: 'switchTab', tab });
    });
  });

  // ── Chart zoom ────────────────────────────────────────────────────────
  document.addEventListener('click', e => {
    const zoomBtn = e.target.closest('[data-zoom]');
    if (zoomBtn) {
      const card = document.getElementById(zoomBtn.dataset.zoom);
      if (card) {
        card.classList.toggle('zoomed');
        zoomBtn.textContent = card.classList.contains('zoomed') ? '⤡ close' : '⤢ zoom';
      }
      return;
    }

    // Close zoomed chart on click outside
    const zoomed = document.querySelector('.chart-card.zoomed');
    if (zoomed && !zoomed.contains(e.target)) {
      zoomed.classList.remove('zoomed');
      const hint = zoomed.querySelector('[data-zoom]');
      if (hint) { hint.textContent = '⤢ zoom'; }
    }

    // Drag & drop and other click handlers below...

    // Folder collapse/expand
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const idx  = toggle.dataset.toggle;
      const open = toggle.textContent.trim() === '▼';
      const rows = idx === 'unfiled'
        ? document.querySelectorAll('.unfiled-row')
        : document.querySelectorAll('.fr' + idx);
      rows.forEach(r => r.style.display = open ? 'none' : '');
      toggle.textContent = open ? '▶' : '▼';
      return;
    }

    const subTgl = e.target.closest('[data-sub-toggle]');
    if (subTgl) {
      const key  = subTgl.dataset.subToggle;
      const open = subTgl.textContent.trim() === '▼';
      document.querySelectorAll('.' + key).forEach(r => r.style.display = open ? 'none' : '');
      subTgl.textContent = open ? '▶' : '▼';
      return;
    }

    const rangeBtn = e.target.closest('[data-range]');
    if (rangeBtn) {
      vscode.postMessage({ type: 'setRange', days: Number(rangeBtn.dataset.range) });
      return;
    }

    const delBtn = e.target.closest('[data-del-folder]');
    if (delBtn) {
      vscode.postMessage({ type: 'deleteFolder', folder: delBtn.dataset.delFolder });
      return;
    }

    const createBtn = e.target.closest('[data-action="create-folder"]');
    if (createBtn) {
      vscode.postMessage({ type: 'createFolder' });
      return;
    }

    const procBtn = e.target.closest('[data-action="process-explorer"]');
    if (procBtn) {
      vscode.postMessage({ type: 'openProcessExplorer' });
      return;
    }
  });

  // ── Drag & drop ────────────────────────────────────────────────────────
  document.addEventListener('dragstart', e => {
    const row = e.target.closest('.proj-row[data-project]');
    if (!row) return;
    dragging = row.dataset.project;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragend', e => {
    const row = e.target.closest('.proj-row');
    if (row) row.classList.remove('dragging');
    dragging = null;
  });
  document.addEventListener('dragover', e => {
    const zone = e.target.closest('.folder-hdr[data-drop-folder]');
    if (zone && dragging) { e.preventDefault(); zone.classList.add('drop-over'); }
  });
  document.addEventListener('dragleave', e => {
    const zone = e.target.closest('.folder-hdr');
    if (zone && !zone.contains(e.relatedTarget)) { zone.classList.remove('drop-over'); }
  });
  document.addEventListener('drop', e => {
    const zone = e.target.closest('.folder-hdr[data-drop-folder]');
    if (zone && dragging) {
      e.preventDefault();
      zone.classList.remove('drop-over');
      vscode.postMessage({ type: 'moveProject', project: dragging, folder: zone.dataset.dropFolder });
      dragging = null;
    }
  });

  // ── Escape closes zoomed chart ──────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.chart-card.zoomed').forEach(c => {
        c.classList.remove('zoomed');
        const hint = c.querySelector('[data-zoom]');
        if (hint) { hint.textContent = '⤢ zoom'; }
      });
    }
  });
})();
</script>

</body>
</html>`;
}

// ── Panel lifecycle ───────────────────────────────────────────────────────────

let _activeTab: 'stats' | 'memory' = 'stats';

export function showPanel(context: vscode.ExtensionContext): void {
  _context = context;

  if (panel) {
    panel.reveal(vscode.ViewColumn.Two);
    panel.webview.html = buildHtml(_activeTab);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'tokenTracker',
    'Token Tracker',
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: false }
  );

  panel.webview.html = buildHtml(_activeTab);

  panel.webview.onDidReceiveMessage(async (msg) => {
    const folders = getFolders();

    switch (msg.type) {

      case 'switchTab': {
        if (msg.tab === 'stats' || msg.tab === 'memory') {
          _activeTab = msg.tab;
          if (panel) { panel.webview.html = buildHtml(_activeTab); }
        }
        break;
      }

      case 'openProcessExplorer': {
        vscode.commands.executeCommand('workbench.action.openProcessExplorer');
        break;
      }

      case 'createFolder': {
        const name = await vscode.window.showInputBox({
          title: 'New Folder',
          placeHolder: 'e.g. Work, Personal, Client A...',
          validateInput: v => (!v.trim() ? 'Name cannot be empty' : undefined),
        });
        if (name?.trim()) {
          if (!folders[name.trim()]) { folders[name.trim()] = []; }
          await saveFolders(folders);
          if (panel) { panel.webview.html = buildHtml(_activeTab); }
        }
        break;
      }

      case 'moveProject': {
        for (const key of Object.keys(folders)) {
          folders[key] = folders[key].filter((p: string) => p !== msg.project);
        }
        if (msg.folder) {
          folders[msg.folder] = [...(folders[msg.folder] ?? []), msg.project];
        }
        await saveFolders(folders);
        if (panel) { panel.webview.html = buildHtml(_activeTab); }
        break;
      }

      case 'deleteFolder': {
        const choice = await vscode.window.showWarningMessage(
          `Delete folder "${msg.folder}"? Projects inside will be moved to Unfiled.`,
          'Delete', 'Cancel'
        );
        if (choice === 'Delete') {
          delete folders[msg.folder];
          await saveFolders(folders);
          if (panel) { panel.webview.html = buildHtml(_activeTab); }
        }
        break;
      }

      case 'setRange': {
        const days = [90, 30, 7, 3].includes(Number(msg.days)) ? Number(msg.days) : 30;
        await saveChartRange(days);
        if (panel) { panel.webview.html = buildHtml(_activeTab); }
        break;
      }
    }
  }, null, context.subscriptions);

  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
}

export function refreshPanel(): void {
  if (panel?.visible) {
    panel.webview.html = buildHtml(_activeTab);
  }
}
