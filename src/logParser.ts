import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  upsertSession,
  addToSession,
  insertRateLimit,
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

function findWslClaudeDirs(): string[] {
  const found: string[] = [];
  for (const distro of getWslDistros()) {
    // /home/* (regular users)
    try {
      const homeBase = `\\\\wsl$\\${distro}\\home`;
      for (const user of fs.readdirSync(homeBase)) {
        const dir = `${homeBase}\\${user}\\.claude\\projects`;
        if (fs.existsSync(dir)) {
          console.log(`[TokenTracker] Found WSL Claude dir: ${dir}`);
          found.push(dir);
        }
      }
    } catch { /* distro stopped or no /home */ }

    // /root
    try {
      const rootDir = `\\\\wsl$\\${distro}\\root\\.claude\\projects`;
      if (fs.existsSync(rootDir)) {
        console.log(`[TokenTracker] Found WSL Claude dir (root): ${rootDir}`);
        found.push(rootDir);
      }
    } catch { /* ignore */ }
  }
  return found;
}

function findAllLogDirs(override: string): string[] {
  if (override) return [override];

  const dirs: string[] = [];

  const native = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(native)) dirs.push(native);

  // Auto-detect WSL installs on Windows hosts
  if (os.platform() === 'win32') {
    dirs.push(...findWslClaudeDirs());
  }

  return dirs;
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
    insertRateLimit(timestamp, wait, project);
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

  const sessionId = upsertSession(sessionFile, startedAt, project);

  let hadRateLimit = false;
  for (const line of lines) {
    if (processLine(line, sessionId, project) === 'ratelimit') {
      hadRateLimit = true;
    }
  }
  return hadRateLimit;
}

// ── async scan of a root directory ────────────────────────────────────────

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function scanAllAsync(rootDir: string, onChange: () => void): Promise<void> {
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
  onChange: () => void,
  onRateLimit?: () => void
): void {
  const watcher = fs.watch(projectPath, { recursive: false }, (event, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) { return; }
    const filePath = path.join(projectPath, filename);
    if (!fs.existsSync(filePath)) { return; }
    try {
      const hadRateLimit = tailFile(filePath);
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
  onChange: () => void,
  onRateLimit?: () => void
): void {
  watchedDirs.push(rootDir);

  // Always do an initial async scan regardless of path type
  scanAllAsync(rootDir, onChange).catch(err =>
    console.error('[TokenTracker] Error during initial scan:', err)
  );

  if (isUncPath(rootDir)) {
    // fs.watch is unreliable on UNC paths (\\wsl$) — poll instead
    console.log(`[TokenTracker] WSL path detected, polling every ${WSL_POLL_MS / 1000}s: ${rootDir}`);
    const id = setInterval(() => {
      scanAllAsync(rootDir, onChange).catch(err =>
        console.error('[TokenTracker] WSL poll error:', err)
      );
    }, WSL_POLL_MS);
    pollIntervals.push(id);
    return;
  }

  // Native path: use fs.watch for real-time updates
  try {
    const rootWatcher = fs.watch(rootDir, { recursive: false }, (event, filename) => {
      if (!filename) { return; }
      const fullPath = path.join(rootDir, filename);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        watchProjectDir(fullPath, onChange, onRateLimit);
      }
    });
    watchers.push(rootWatcher);

    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        watchProjectDir(path.join(rootDir, entry.name), onChange, onRateLimit);
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
    console.warn('[TokenTracker] No Claude log directories found. Install Claude Code CLI or set tokenTracker.logDirectory.');
    return;
  }

  for (const dir of dirs) {
    console.log(`[TokenTracker] Watching: ${dir}`);
    startWatchingDir(dir, onChange, onRateLimit);
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
