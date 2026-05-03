import * as fs from 'fs';
import * as path from 'path';

// ── types ──────────────────────────────────────────────────────────────────

export interface Session {
  id: number;
  session_file: string;
  started_at: string;
  project: string;
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
}

interface Store {
  sessions: Session[];
  rateLimits: RateLimitEvent[];
  offsets: Record<string, number>;
  nextSessionId: number;
  nextRateLimitId: number;
}

// ── in-memory store + persistence ─────────────────────────────────────────

let storePath = '';
let store: Store = {
  sessions: [],
  rateLimits: [],
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
    } catch {
      // corrupted file — start fresh but keep the old as backup
      const backup = storePath + '.bak';
      fs.copyFileSync(storePath, backup);
    }
  }
}

function save(): void {
  if (!storePath) { return; }
  fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
}

// ── sessions ──────────────────────────────────────────────────────────────

export function upsertSession(
  sessionFile: string,
  startedAt: string,
  project: string
): number {
  const existing = store.sessions.find(s => s.session_file === sessionFile);
  if (existing) { return existing.id; }

  const session: Session = {
    id: store.nextSessionId++,
    session_file: sessionFile,
    started_at: startedAt,
    project,
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
  s.model = model;
  s.input_tokens  += inputTokens;
  s.output_tokens += outputTokens;
  s.cache_write   += cacheWrite;
  s.cache_read    += cacheRead;
  s.cost_usd      += costUsd;
  save();
}

// ── rate limits ───────────────────────────────────────────────────────────

export function insertRateLimit(
  timestamp: string,
  waitSeconds: number,
  project: string
): void {
  store.rateLimits.push({
    id: store.nextRateLimitId++,
    timestamp,
    wait_seconds: waitSeconds,
    project,
  });
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
  const filtered = store.sessions.filter(s => s.started_at >= fromDate);
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
}

export function queryDaily(days: number): DailyRow[] {
  const cutoff = daysAgoIso(days);
  const byDate: Record<string, DailyRow> = {};

  for (const s of store.sessions) {
    if (s.started_at < cutoff) { continue; }
    const date = isoDate(s.started_at);
    if (!byDate[date]) {
      byDate[date] = { date, input: 0, output: 0, cost_usd: 0, model: s.model };
    }
    byDate[date].input    += s.input_tokens;
    byDate[date].output   += s.output_tokens;
    byDate[date].cost_usd += s.cost_usd;
    if (s.model) { byDate[date].model = s.model; }
  }

  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

export interface ProjectRow {
  project: string;
  input: number;
  output: number;
  cost_usd: number;
  sessions: number;
}

export function queryProjects(): ProjectRow[] {
  const byProject: Record<string, ProjectRow> = {};

  for (const s of store.sessions) {
    if (!byProject[s.project]) {
      byProject[s.project] = { project: s.project, input: 0, output: 0, cost_usd: 0, sessions: 0 };
    }
    byProject[s.project].input    += s.input_tokens;
    byProject[s.project].output   += s.output_tokens;
    byProject[s.project].cost_usd += s.cost_usd;
    byProject[s.project].sessions += 1;
  }

  return Object.values(byProject).sort((a, b) => b.cost_usd - a.cost_usd);
}

export interface RateLimitRow {
  timestamp: string;
  wait_seconds: number;
  project: string;
}

export function queryRateLimits(days: number): RateLimitRow[] {
  const cutoff = daysAgoIso(days);
  return store.rateLimits
    .filter(r => r.timestamp >= cutoff)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map(({ timestamp, wait_seconds, project }) => ({ timestamp, wait_seconds, project }));
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

export function queryTodayTotals(): LiveTotals {
  const today = todayStartIso();
  const row = querySummary(today);
  return { ...row, model: queryLatestModel() };
}
