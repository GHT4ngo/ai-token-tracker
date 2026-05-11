import * as fs from 'fs';
import * as path from 'path';

// ── types ──────────────────────────────────────────────────────────────────

export interface Session {
  id: number;
  session_file: string;
  started_at: string;
  last_active_at?: string;
  project: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write: number;
  cache_read: number;
  cost_usd: number;
}

export interface RateLimitEvent {
  id: number;
  timestamp: string;
  wait_seconds: number;
  project: string;
  provider?: string;
  resets_at?: string;
  used_percent?: number;
  window_type?: 'primary' | 'secondary';
}

interface Store {
  sessions: Session[];
  rateLimits: RateLimitEvent[];
  limitSnapshots: RateLimitEvent[];
  offsets: Record<string, number>;
  nextSessionId: number;
  nextRateLimitId: number;
}

// ── in-memory store + persistence ─────────────────────────────────────────

let storePath = '';
let store: Store = {
  sessions: [],
  rateLimits: [],
  limitSnapshots: [],
  offsets: {},
  nextSessionId: 1,
  nextRateLimitId: 1,
};

export function initDb(storagePath: string): void {
  fs.mkdirSync(storagePath, { recursive: true });
  storePath = path.join(storagePath, 'token_tracker.json');

  if (fs.existsSync(storePath)) {
    try {
      const raw = fs.readFileSync(storePath, 'utf8');
      store = JSON.parse(raw) as Store;
      store.sessions = store.sessions.map(s => ({ ...s, provider: s.provider ?? inferProvider(s.model, s.session_file) }));
      store.rateLimits = store.rateLimits.map(r => ({ ...r, provider: r.provider ?? 'claude' }));
      store.limitSnapshots = (store.limitSnapshots ?? []).map(r => ({ ...r, provider: r.provider ?? 'codex' }));
    } catch {
      // corrupted file — start fresh but keep the old as backup
      const backup = storePath + '.bak';
      fs.copyFileSync(storePath, backup);
    }
  }
}

function inferProvider(model: string, sessionFile: string): string {
  const m = (model || '').toLowerCase();
  const f = (sessionFile || '').toLowerCase();
  if (m.includes('gpt') || m.includes('codex') || f.startsWith('codex:')) { return 'codex'; }
  return 'claude';
}

function save(): void {
  if (!storePath) { return; }
  fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
}

// ── sessions ──────────────────────────────────────────────────────────────

export function upsertSession(
  sessionFile: string,
  startedAt: string,
  project: string,
  provider = 'claude'
): number {
  const existing = store.sessions.find(s => s.session_file === sessionFile);
  if (existing) { return existing.id; }

  const session: Session = {
    id: store.nextSessionId++,
    session_file: sessionFile,
    started_at: startedAt,
    project,
    provider,
    model: '',
    input_tokens: 0,
    output_tokens: 0,
    cache_write: 0,
    cache_read: 0,
    cost_usd: 0,
  };
  store.sessions.push(session);
  save();
  return session.id;
}

export function addToSession(
  sessionId: number,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWrite: number,
  cacheRead: number,
  costUsd: number
): void {
  const s = store.sessions.find(s => s.id === sessionId);
  if (!s) { return; }
  s.model          = model;
  s.input_tokens  += inputTokens;
  s.output_tokens += outputTokens;
  s.cache_write   += cacheWrite;
  s.cache_read    += cacheRead;
  s.cost_usd      += costUsd;
  // last_active_at is set from file mtime by the caller, not from wall clock,
  // so historical files scanned for the first time don't appear as "today".
  save();
}

// ── rate limits ───────────────────────────────────────────────────────────

export function insertRateLimit(
  timestamp: string,
  waitSeconds: number,
  project: string,
  provider = 'claude',
  resetsAt?: string,
  usedPercent?: number
): void {
  store.rateLimits.push({
    id: store.nextRateLimitId++,
    timestamp,
    wait_seconds: waitSeconds,
    project,
    provider,
    resets_at: resetsAt,
    used_percent: usedPercent,
  });
  save();
}

export function insertLimitSnapshot(
  timestamp: string,
  project: string,
  provider: string,
  resetsAt?: string,
  usedPercent?: number,
  windowType?: 'primary' | 'secondary'
): void {
  const wt = windowType ?? 'primary';
  const last = [...store.limitSnapshots].reverse().find(r => r.provider === provider && (r.window_type ?? 'primary') === wt);
  if (last && last.used_percent === usedPercent && last.resets_at === resetsAt) { return; }
  store.limitSnapshots.push({
    id: store.nextRateLimitId++,
    timestamp,
    wait_seconds: 0,
    project,
    provider,
    resets_at: resetsAt,
    used_percent: usedPercent,
    window_type: wt,
  });
  if (store.limitSnapshots.length > 1000) {
    store.limitSnapshots = store.limitSnapshots.slice(-1000);
  }
  save();
}

export function touchSessionLastActive(sessionFile: string, mtime: string): void {
  const s = store.sessions.find(s => s.session_file === sessionFile);
  if (!s || s.last_active_at === mtime) { return; }
  s.last_active_at = mtime;
  save();
}

// ── file offsets ──────────────────────────────────────────────────────────

export function getOffset(filePath: string): number {
  return store.offsets[filePath] ?? 0;
}

export function setOffset(filePath: string, offset: number): void {
  store.offsets[filePath] = offset;
  save();
}

// ── helpers ────────────────────────────────────────────────────────────────

function isoDate(dt: string): string {
  return dt.slice(0, 10);
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function todayStartIso(): string {
  return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
}

// ── API query helpers ─────────────────────────────────────────────────────

export interface SummaryRow {
  input: number;
  output: number;
  cost_usd: number;
}

export function querySummary(fromDate: string): SummaryRow {
  const filtered = store.sessions.filter(s => (s.last_active_at ?? s.started_at) >= fromDate);
  return filtered.reduce(
    (acc, s) => ({
      input:    acc.input    + s.input_tokens,
      output:   acc.output   + s.output_tokens,
      cost_usd: acc.cost_usd + s.cost_usd,
    }),
    { input: 0, output: 0, cost_usd: 0 }
  );
}

export function queryLatestModel(): string {
  const last = [...store.sessions].sort((a, b) => b.id - a.id)[0];
  return last?.model || 'unknown';
}

export interface DailyRow {
  date: string;
  input: number;
  output: number;
  cost_usd: number;
  model: string;
  provider: string;
}

export function queryDaily(days: number): DailyRow[] {
  const cutoff = daysAgoIso(days);
  const byDate: Record<string, DailyRow> = {};

  for (const s of store.sessions) {
    if (s.started_at < cutoff) { continue; }
    const date = isoDate(s.started_at);
    if (!byDate[date]) {
      byDate[date] = { date, input: 0, output: 0, cost_usd: 0, model: s.model, provider: s.provider ?? inferProvider(s.model, s.session_file) };
    }
    byDate[date].input    += s.input_tokens;
    byDate[date].output   += s.output_tokens;
    byDate[date].cost_usd += s.cost_usd;
    if (s.model) { byDate[date].model = s.model; }
    if (s.provider) { byDate[date].provider = s.provider; }
  }

  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

export interface ProjectRow {
  project: string;
  provider: string;
  input: number;
  output: number;
  cost_usd: number;
  sessions: number;
}

export function queryProjects(): ProjectRow[] {
  const byProject: Record<string, ProjectRow> = {};

  for (const s of store.sessions) {
    const provider = s.provider ?? inferProvider(s.model, s.session_file);
    const key = `${provider}:${s.project}`;
    if (!byProject[key]) {
      byProject[key] = { project: s.project, provider, input: 0, output: 0, cost_usd: 0, sessions: 0 };
    }
    byProject[key].input    += s.input_tokens;
    byProject[key].output   += s.output_tokens;
    byProject[key].cost_usd += s.cost_usd;
    byProject[key].sessions += 1;
  }

  return Object.values(byProject).sort((a, b) => b.cost_usd - a.cost_usd);
}

export interface RateLimitRow {
  timestamp: string;
  wait_seconds: number;
  project: string;
  provider: string;
  resets_at?: string;
  used_percent?: number;
}

export interface DailyByProvider {
  date: string;
  claude: { input: number; output: number; cost_usd: number; };
  codex:  { input: number; output: number; cost_usd: number; };
}

export function queryDailyByProvider(days: number): DailyByProvider[] {
  const cutoff = daysAgoIso(days);
  const byDate: Record<string, DailyByProvider> = {};
  for (const s of store.sessions) {
    if (s.started_at < cutoff) { continue; }
    const date = isoDate(s.started_at);
    if (!byDate[date]) {
      byDate[date] = {
        date,
        claude: { input: 0, output: 0, cost_usd: 0 },
        codex:  { input: 0, output: 0, cost_usd: 0 },
      };
    }
    const provider = s.provider ?? inferProvider(s.model, s.session_file);
    const bucket = provider === 'codex' ? byDate[date].codex : byDate[date].claude;
    bucket.input    += s.input_tokens;
    bucket.output   += s.output_tokens;
    bucket.cost_usd += s.cost_usd;
  }

  // Fill in zero-value entries for every calendar day in the range so the
  // chart x-axis reflects actual time rather than just days-with-data.
  const cursor = new Date(cutoff);
  const today  = new Date();
  while (cursor <= today) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (!byDate[dateStr]) {
      byDate[dateStr] = {
        date: dateStr,
        claude: { input: 0, output: 0, cost_usd: 0 },
        codex:  { input: 0, output: 0, cost_usd: 0 },
      };
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

export function queryRateLimits(days: number): RateLimitRow[] {
  const cutoff = daysAgoIso(days);
  return store.rateLimits
    .filter(r => r.timestamp >= cutoff)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map(({ timestamp, wait_seconds, project, provider, resets_at, used_percent }) => ({
      timestamp,
      wait_seconds,
      project,
      provider: provider ?? 'claude',
      resets_at,
      used_percent,
    }));
}

export interface SessionRow {
  id: number;
  started_at: string;
  project: string;
  model: string;
  input: number;
  output: number;
  cost_usd: number;
}

export function querySessions(limit: number): SessionRow[] {
  return [...store.sessions]
    .sort((a, b) => b.id - a.id)
    .slice(0, limit)
    .map(s => ({
      id:         s.id,
      started_at: s.started_at,
      project:    s.project,
      model:      s.model,
      input:      s.input_tokens,
      output:     s.output_tokens,
      cost_usd:   s.cost_usd,
    }));
}

// ── live totals for status bar ────────────────────────────────────────────

export interface LiveTotals {
  input: number;
  output: number;
  cost_usd: number;
  model: string;
}

export interface ProviderRiskRow {
  provider: string;
  used_percent: number;
  confidence: 'observed' | 'estimated' | 'unknown';
  resets_at?: string;
  status: 'fresh' | 'steady' | 'watch' | 'low' | 'capped';
}

export function queryProviderRisk(days = 30): ProviderRiskRow[] {
  const recentLimits = queryRateLimits(days);
  const cutoff = daysAgoIso(days);
  const recentSnapshots = store.limitSnapshots
    .filter(r => r.timestamp >= cutoff)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const providers = new Set<string>([
    ...store.sessions.map(s => s.provider ?? inferProvider(s.model, s.session_file)),
    ...recentLimits.map(r => r.provider),
    ...recentSnapshots.map(r => r.provider ?? 'codex'),
  ]);

  return [...providers].sort().map(provider => {
    const providerLimits = recentLimits.filter(r => r.provider === provider);
    const latestObserved = recentSnapshots.find(r => (r.provider ?? 'codex') === provider && typeof r.used_percent === 'number')
      ?? providerLimits.find(r => typeof r.used_percent === 'number');
    if (latestObserved?.used_percent !== undefined) {
      const used      = latestObserved.used_percent;
      const resetsAt  = latestObserved.resets_at;
      const resetSoon = resetsAt && new Date(resetsAt) > new Date();
      const staleMs   = Date.now() - new Date(latestObserved.timestamp).getTime();
      const stale     = staleMs > 20 * 60 * 1000; // snapshot older than 20 min
      // If a reset window is pending, usage was high, and we haven't seen a new
      // snapshot in 20+ minutes — activity has stopped, infer capped.
      const likelyCapped = resetSoon && used >= 70 && stale;
      return riskRow(provider, likelyCapped ? 100 : used, likelyCapped ? 'estimated' : 'observed', resetsAt);
    }

    const capped = providerLimits[0];
    const sessions = store.sessions.filter(s => (s.provider ?? inferProvider(s.model, s.session_file)) === provider);
    if (capped) {
      return riskRow(provider, 95, 'estimated', capped.resets_at);
    }

    const recentTokens = sessions
      .filter(s => s.started_at >= cutoff)
      .reduce((sum, s) => sum + s.input_tokens + s.output_tokens + s.cache_write + s.cache_read, 0);
    if (recentTokens === 0) {
      return riskRow(provider, 0, 'unknown');
    }

    const maxRecent = Math.max(recentTokens, ...sessions.map(s => s.input_tokens + s.output_tokens + s.cache_write + s.cache_read), 1);
    return riskRow(provider, Math.min(70, Math.round((recentTokens / maxRecent) * 35)), 'estimated');
  });
}

function riskRow(
  provider: string,
  usedPercent: number,
  confidence: ProviderRiskRow['confidence'],
  resetsAt?: string
): ProviderRiskRow {
  const used_percent = Math.max(0, Math.min(100, Math.round(usedPercent)));
  const status = used_percent >= 95 ? 'capped'
    : used_percent >= 80 ? 'low'
    : used_percent >= 60 ? 'watch'
    : used_percent <= 10 ? 'fresh'
    : 'steady';
  return { provider, used_percent, confidence, resets_at: resetsAt, status };
}

export interface TodayByProvider {
  claude: { input: number; output: number; };
  codex:  { input: number; output: number; };
}

export function queryTodayByProvider(): TodayByProvider {
  const today = todayStartIso();
  const result: TodayByProvider = {
    claude: { input: 0, output: 0 },
    codex:  { input: 0, output: 0 },
  };
  for (const s of store.sessions) {
    // Use last_active_at if available so sessions that span midnight are included
    const activeAt = s.last_active_at ?? s.started_at;
    if (activeAt < today) { continue; }
    const provider = s.provider ?? inferProvider(s.model, s.session_file);
    const bucket = provider === 'codex' ? result.codex : result.claude;
    bucket.input  += s.input_tokens;
    bucket.output += s.output_tokens;
  }
  return result;
}

export function queryTodayTotals(): LiveTotals {
  const today = todayStartIso();
  const row = querySummary(today);
  return { ...row, model: queryLatestModel() };
}

// ── cap periods (for chart bands) ─────────────────────────────────────────

export interface CapPeriod {
  start: string;
  end: string;
  provider: string;
  window_type: 'primary' | 'secondary';
}

export function queryCapPeriods(days: number): CapPeriod[] {
  const cutoff = daysAgoIso(days);
  const periods: CapPeriod[] = [];

  // Claude Code caps: derive from rate-limit events (provider === 'claude')
  for (const rl of store.rateLimits) {
    if (rl.timestamp < cutoff) { continue; }
    if ((rl.provider ?? 'claude') !== 'claude') { continue; }
    const end = rl.resets_at
      ?? new Date(new Date(rl.timestamp).getTime() + rl.wait_seconds * 1000).toISOString();
    periods.push({ start: rl.timestamp, end, provider: 'claude', window_type: 'primary' });
  }

  // Codex caps: derive from limit snapshots by detecting sustained high usage
  const codexSnaps = store.limitSnapshots
    .filter(r => r.timestamp >= cutoff && (r.provider ?? 'codex') === 'codex')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const byWt = new Map<'primary' | 'secondary', RateLimitEvent[]>();
  for (const s of codexSnaps) {
    const wt = s.window_type ?? 'primary';
    if (!byWt.has(wt)) { byWt.set(wt, []); }
    byWt.get(wt)!.push(s);
  }

  for (const [window_type, snaps] of byWt.entries()) {
    let inCap = false;
    let capStart = '';
    let capResets = '';

    for (const s of snaps) {
      const used = s.used_percent ?? 0;
      if (!inCap && used >= 90) {
        inCap = true;
        capStart = s.timestamp;
        capResets = s.resets_at ?? '';
      } else if (inCap) {
        if (s.resets_at && s.resets_at !== capResets && used < 50) {
          // Window reset — end current period
          periods.push({ start: capStart, end: s.timestamp, provider: 'codex', window_type });
          inCap = false;
        } else if (s.resets_at) {
          capResets = s.resets_at;
        }
      }
    }

    if (inCap) {
      const end = capResets || new Date().toISOString();
      periods.push({ start: capStart, end, provider: 'codex', window_type });
    }
  }

  return periods;
}

// ── cap rate predictions ──────────────────────────────────────────────────

export interface CapPrediction {
  provider: string;
  window_type: 'primary' | 'secondary';
  current_percent: number;
  rate_per_hour: number;
  hours_to_cap: number | null;
  resets_at?: string;
}

export function queryCapPredictions(): CapPrediction[] {
  const now = Date.now();
  // Look back 4h for primary, 24h for secondary
  const lookbackMs: Record<string, number> = { primary: 4 * 3600_000, secondary: 24 * 3600_000 };

  const byKey = new Map<string, RateLimitEvent[]>();
  for (const s of store.limitSnapshots) {
    const wt = s.window_type ?? 'primary';
    const cutoffMs = lookbackMs[wt] ?? 4 * 3600_000;
    if (now - new Date(s.timestamp).getTime() > cutoffMs) { continue; }
    const key = `${s.provider ?? 'codex'}:${wt}`;
    if (!byKey.has(key)) { byKey.set(key, []); }
    byKey.get(key)!.push(s);
  }

  const predictions: CapPrediction[] = [];

  for (const [key, rawSnaps] of byKey.entries()) {
    const [provider, wt] = key.split(':') as [string, 'primary' | 'secondary'];
    const snaps = rawSnaps.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (snaps.length < 2) { continue; }

    const latest = snaps[snaps.length - 1];
    // Only use snapshots from the same window cycle (same resets_at)
    const windowSnaps = latest.resets_at
      ? snaps.filter(s => s.resets_at === latest.resets_at)
      : snaps;
    if (windowSnaps.length < 2) { continue; }

    const first = windowSnaps[0];
    const last  = windowSnaps[windowSnaps.length - 1];
    const deltaPercent = (last.used_percent ?? 0) - (first.used_percent ?? 0);
    const deltaMs = new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
    if (deltaMs <= 0 || deltaPercent <= 0) { continue; }

    const ratePerHour = (deltaPercent / deltaMs) * 3_600_000;
    const remaining = 100 - (last.used_percent ?? 0);
    const hoursToCapFromNow = remaining > 0 && ratePerHour > 0 ? remaining / ratePerHour : null;

    predictions.push({
      provider,
      window_type: wt,
      current_percent: last.used_percent ?? 0,
      rate_per_hour: ratePerHour,
      hours_to_cap: hoursToCapFromNow,
      resets_at: last.resets_at,
    });
  }

  return predictions.sort((a, b) =>
    a.provider !== b.provider
      ? a.provider.localeCompare(b.provider)
      : a.window_type === 'primary' ? -1 : 1
  );
}
