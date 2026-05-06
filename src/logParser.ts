import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  upsertSession,
  addToSession,
  insertRateLimit,
  insertLimitSnapshot,
  getOffset,
  setOffset,
} from './db';
import { computeCost } from './pricing';

// ── types ──────────────────────────────────────────────────────────────────

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeLogEntry {
  type?: string;
  message?: {
    model?: string;
    usage?: ClaudeUsage;
    content?: unknown;
  };
  model?: string;
  usage?: ClaudeUsage;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  content?: string;
  duration_ms?: number;
  payload?: any;
}

interface LogRoot {
  dir: string;
  provider: 'claude' | 'codex';
}

// ── directory discovery ────────────────────────────────────────────────────

function getWslDistros(): string[] {
  try {
    // wsl -l -q outputs UTF-16 LE on Windows
    const raw = execSync('wsl -l -q', { timeout: 5000 });
    const distros = raw
      .toString('utf16le')
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    console.log(`[TokenTracker] WSL distros found: ${distros.join(', ')}`);
    return distros;
  } catch {
    console.log('[TokenTracker] WSL not available or wsl command failed');
    return [];
  }
}

function pushExisting(found: string[], dir: string, label: string): void {
  if (!fs.existsSync(dir)) { return; }
  console.log(`[TokenTracker] Found ${label}: ${dir}`);
  found.push(dir);
}

function findWslClaudeDirs(): string[] {
  const found: string[] = [];
  for (const distro of getWslDistros()) {
    // /home/* (regular users)
    try {
      const homeBase = `\\\\wsl$\\${distro}\\home`;
      for (const user of fs.readdirSync(homeBase)) {
        pushExisting(found, `${homeBase}\\${user}\\.claude\\projects`, 'WSL Claude dir');
      }
    } catch { /* distro stopped or no /home */ }

    // /root
    try {
      pushExisting(found, `\\\\wsl$\\${distro}\\root\\.claude\\projects`, 'WSL Claude dir (root)');
    } catch { /* ignore */ }
  }
  return found;
}

function findWslCodexSessionDirs(): string[] {
  const found: string[] = [];
  for (const distro of getWslDistros()) {
    try {
      const homeBase = `\\\\wsl$\\${distro}\\home`;
      for (const user of fs.readdirSync(homeBase)) {
        pushExisting(found, `${homeBase}\\${user}\\.codex\\sessions`, 'WSL Codex sessions dir');
        pushExisting(found, `${homeBase}\\${user}\\.Codex\\sessions`, 'WSL Codex sessions dir');
      }
    } catch { /* distro stopped or no /home */ }

    try {
      pushExisting(found, `\\\\wsl$\\${distro}\\root\\.codex\\sessions`, 'WSL Codex sessions dir (root)');
      pushExisting(found, `\\\\wsl$\\${distro}\\root\\.Codex\\sessions`, 'WSL Codex sessions dir (root)');
    } catch { /* ignore */ }
  }
  return found;
}

function findCodexSessionDirs(): string[] {
  const dirs: string[] = [];
  for (const rootName of ['.codex', '.Codex']) {
    const dir = path.join(os.homedir(), rootName, 'sessions');
    if (fs.existsSync(dir)) { dirs.push(dir); }
  }
  return [...new Set(dirs.map(d => path.normalize(d)))];
}

function findAllLogDirs(override: string): LogRoot[] {
  if (override) return [{ dir: override, provider: override.toLowerCase().includes('.codex') ? 'codex' : 'claude' }];

  const dirs: LogRoot[] = [];

  const native = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(native)) dirs.push({ dir: native, provider: 'claude' });

  for (const dir of findCodexSessionDirs()) {
    dirs.push({ dir, provider: 'codex' });
  }

  // Auto-detect WSL installs on Windows hosts
  if (os.platform() === 'win32') {
    dirs.push(...findWslClaudeDirs().map(dir => ({ dir, provider: 'claude' as const })));
    dirs.push(...findWslCodexSessionDirs().map(dir => ({ dir, provider: 'codex' as const })));
  }

  const seen = new Set<string>();
  return dirs.filter(root => {
    const key = `${root.provider}:${path.normalize(root.dir).toLowerCase()}`;
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

// fs.watch does not work on UNC (\\wsl$) paths — use polling for those
function isUncPath(p: string): boolean {
  return p.startsWith('\\\\');
}

// ── helpers ────────────────────────────────────────────────────────────────

function parseWaitSeconds(content: string): number {
  const match = content.match(/(\d+)\s*second/i);
  return match ? parseInt(match[1], 10) : 60;
}

function isRateLimitEntry(entry: ClaudeLogEntry): boolean {
  const c = (entry.content ?? '').toLowerCase();
  return (
    entry.type === 'rate_limit' ||
    (entry.type === 'system' && (c.includes('rate limit') || c.includes('rate_limit') || c.includes('retry after') || c.includes('too many requests')))
  );
}

// ── core parser ────────────────────────────────────────────────────────────

type LineResult = 'ratelimit' | 'message' | null;

function processLine(line: string, sessionId: number, project: string): LineResult {
  if (!line.trim()) { return null; }

  let entry: ClaudeLogEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const timestamp = entry.timestamp ?? new Date().toISOString();

  if (isRateLimitEntry(entry)) {
    const wait = parseWaitSeconds(entry.content ?? '');
    insertRateLimit(timestamp, wait, project, 'claude');
    return 'ratelimit';
  }

  if (entry.type !== 'assistant') { return null; }

  const usage: ClaudeUsage = entry.message?.usage ?? entry.usage ?? {};
  const model: string = entry.message?.model ?? entry.model ?? 'unknown';

  const inputTokens  = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheWrite   = usage.cache_creation_input_tokens ?? 0;
  const cacheRead    = usage.cache_read_input_tokens ?? 0;

  if (inputTokens === 0 && outputTokens === 0) { return null; }

  const cost = computeCost(model, {
    input: inputTokens,
    output: outputTokens,
    cacheWrite,
    cacheRead,
  });

  addToSession(sessionId, model, inputTokens, outputTokens, cacheWrite, cacheRead, cost);
  return 'message';
}

// ── tail a single JSONL file from last known offset ───────────────────────

function tailFile(filePath: string): boolean /* hadRateLimit */ {
  const stats = fs.statSync(filePath);
  const currentOffset = getOffset(filePath);

  if (stats.size <= currentOffset) { return false; }

  const fd = fs.openSync(filePath, 'r');
  const length = stats.size - currentOffset;
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, currentOffset);
  fs.closeSync(fd);

  setOffset(filePath, stats.size);

  const sessionFile = path.basename(filePath, '.jsonl');
  const lines = buf.toString('utf8').split('\n');

  let project = path.basename(path.dirname(filePath));
  for (const line of lines) {
    if (!line.trim()) { continue; }
    try {
      const e: ClaudeLogEntry = JSON.parse(line);
      if (e.cwd) { project = e.cwd; break; }
    } catch { /* ignore */ }
  }

  let startedAt = new Date(stats.birthtime).toISOString();
  for (const line of lines) {
    if (!line.trim()) { continue; }
    try {
      const e: ClaudeLogEntry = JSON.parse(line);
      if (e.timestamp) { startedAt = e.timestamp; break; }
    } catch { /* ignore */ }
  }

  const sessionId = upsertSession(sessionFile, startedAt, project, 'claude');

  let hadRateLimit = false;
  for (const line of lines) {
    if (processLine(line, sessionId, project) === 'ratelimit') {
      hadRateLimit = true;
    }
  }
  return hadRateLimit;
}

function parseUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) { return undefined; }
  return new Date(value * 1000).toISOString();
}

function processCodexLine(line: string, sessionId: number, project: string): LineResult {
  if (!line.trim()) { return null; }

  let entry: ClaudeLogEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const timestamp = entry.timestamp ?? new Date().toISOString();
  if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') { return null; }

  const info = entry.payload.info;
  const usage = info?.last_token_usage ?? info?.total_token_usage ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheRead = usage.cached_input_tokens ?? 0;
  const model = entry.payload.model ?? 'gpt-5.3-codex';

  if (inputTokens > 0 || outputTokens > 0 || cacheRead > 0) {
    const cost = computeCost(model, {
      input: inputTokens,
      output: outputTokens,
      cacheWrite: 0,
      cacheRead,
    });
    addToSession(sessionId, model, inputTokens, outputTokens, 0, cacheRead, cost);
  }

  const limits = entry.payload.rate_limits;
  const primary = limits?.primary;
  const reached = limits?.rate_limit_reached_type;
  const used = typeof primary?.used_percent === 'number' ? primary.used_percent : undefined;
  if (used !== undefined || reached) {
    const resetsAt = parseUnixSeconds(primary?.resets_at);
    const wait = resetsAt ? Math.max(0, Math.round((new Date(resetsAt).getTime() - Date.now()) / 1000)) : 0;
    insertLimitSnapshot(timestamp, project, 'codex', resetsAt, used);
    if (reached || (used ?? 0) >= 95) {
      insertRateLimit(timestamp, wait, project, 'codex', resetsAt, used);
    }
    return reached ? 'ratelimit' : 'message';
  }

  return inputTokens > 0 || outputTokens > 0 || cacheRead > 0 ? 'message' : null;
}

function tailCodexFile(filePath: string): boolean {
  const stats = fs.statSync(filePath);
  const currentOffset = getOffset(filePath);

  if (stats.size <= currentOffset) { return false; }

  const fd = fs.openSync(filePath, 'r');
  const length = stats.size - currentOffset;
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, currentOffset);
  fs.closeSync(fd);

  setOffset(filePath, stats.size);

  const sessionFile = `codex:${path.basename(filePath, '.jsonl')}`;
  const lines = buf.toString('utf8').split('\n');

  let project = path.basename(path.dirname(filePath));
  let startedAt = new Date(stats.birthtime).toISOString();
  for (const line of lines) {
    if (!line.trim()) { continue; }
    try {
      const e: ClaudeLogEntry = JSON.parse(line);
      if (e.timestamp && startedAt === new Date(stats.birthtime).toISOString()) { startedAt = e.timestamp; }
      if (e.type === 'session_meta') {
        project = e.payload?.cwd ?? project;
        startedAt = e.payload?.timestamp ?? e.timestamp ?? startedAt;
        break;
      }
    } catch { /* ignore */ }
  }

  const sessionId = upsertSession(sessionFile, startedAt, project, 'codex');
  let hadRateLimit = false;
  for (const line of lines) {
    if (processCodexLine(line, sessionId, project) === 'ratelimit') {
      hadRateLimit = true;
    }
  }
  return hadRateLimit;
}

// ── async scan of a root directory ────────────────────────────────────────

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function collectJsonlFiles(rootDir: string, recursive: boolean): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory() && recursive) {
      found.push(...collectJsonlFiles(fullPath, true));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      found.push(fullPath);
    }
  }
  return found;
}

async function scanAllAsync(rootDir: string, provider: LogRoot['provider'], onChange: () => void): Promise<void> {
  if (provider === 'codex') {
    for (const file of collectJsonlFiles(rootDir, true)) {
      await yieldToEventLoop();
      try {
        tailCodexFile(file);
      } catch (err) {
        console.error(`[TokenTracker] Error processing Codex session ${file}:`, err);
      }
    }
    onChange();
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const projectDir of entries) {
    if (!projectDir.isDirectory()) { continue; }

    await yieldToEventLoop();

    const projectPath = path.join(rootDir, projectDir.name);
    let files: string[];
    try {
      files = fs.readdirSync(projectPath);
    } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) { continue; }
      try {
        tailFile(path.join(projectPath, file));
      } catch (err) {
        console.error(`[TokenTracker] Error processing ${file}:`, err);
      }
    }
  }

  onChange();
}

// ── directory watcher ──────────────────────────────────────────────────────

const watchers:      fs.FSWatcher[] = [];
const pollIntervals: ReturnType<typeof setInterval>[] = [];
const watchedDirs:   string[] = [];

export function getWatchedDirs(): string[] {
  return [...watchedDirs];
}

const WSL_POLL_MS = 30_000;

function watchProjectDir(
  projectPath: string,
  provider: LogRoot['provider'],
  onChange: () => void,
  onRateLimit?: () => void
): void {
  const watcher = fs.watch(projectPath, { recursive: false }, (event, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) { return; }
    const filePath = path.join(projectPath, filename);
    if (!fs.existsSync(filePath)) { return; }
    try {
      const hadRateLimit = provider === 'codex' ? tailCodexFile(filePath) : tailFile(filePath);
      onChange();
      if (hadRateLimit) { onRateLimit?.(); }
    } catch (err) {
      console.error(`[TokenTracker] Error tailing ${filename}:`, err);
    }
  });
  watchers.push(watcher);
}

function startWatchingDir(
  rootDir: string,
  provider: LogRoot['provider'],
  onChange: () => void,
  onRateLimit?: () => void
): void {
  watchedDirs.push(rootDir);

  // Always do an initial async scan regardless of path type
  scanAllAsync(rootDir, provider, onChange).catch(err =>
    console.error('[TokenTracker] Error during initial scan:', err)
  );

  if (isUncPath(rootDir)) {
    // fs.watch is unreliable on UNC paths (\\wsl$) — poll instead
    console.log(`[TokenTracker] WSL path detected, polling every ${WSL_POLL_MS / 1000}s: ${rootDir}`);
    const id = setInterval(() => {
      scanAllAsync(rootDir, provider, onChange).catch(err =>
        console.error('[TokenTracker] WSL poll error:', err)
      );
    }, WSL_POLL_MS);
    pollIntervals.push(id);
    return;
  }

  // Native path: use fs.watch for real-time updates
  try {
    if (provider === 'codex') {
      const id = setInterval(() => {
        scanAllAsync(rootDir, provider, onChange).catch(err =>
          console.error('[TokenTracker] Codex poll error:', err)
        );
      }, WSL_POLL_MS);
      pollIntervals.push(id);
      return;
    }

    const rootWatcher = fs.watch(rootDir, { recursive: false }, (event, filename) => {
      if (!filename) { return; }
      const fullPath = path.join(rootDir, filename);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        watchProjectDir(fullPath, provider, onChange, onRateLimit);
      }
    });
    watchers.push(rootWatcher);

    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        watchProjectDir(path.join(rootDir, entry.name), provider, onChange, onRateLimit);
      }
    }
  } catch (err) {
    console.error('[TokenTracker] Error setting up watchers:', err);
  }
}

export function startWatching(
  logDirOverride: string,
  onChange: () => void,
  onRateLimit?: () => void
): void {
  const dirs = findAllLogDirs(logDirOverride);

  if (dirs.length === 0) {
    console.warn('[TokenTracker] No AI log directories found. Install Claude Code/Codex or set tokenTracker.logDirectory.');
    return;
  }

  for (const root of dirs) {
    console.log(`[TokenTracker] Watching ${root.provider}: ${root.dir}`);
    startWatchingDir(root.dir, root.provider, onChange, onRateLimit);
  }
}

export function stopWatching(): void {
  for (const w of watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers.length = 0;

  for (const id of pollIntervals) {
    clearInterval(id);
  }
  pollIntervals.length = 0;
  watchedDirs.length   = 0;
}
