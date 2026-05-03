import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

// ── helpers ────────────────────────────────────────────────────────────────

function defaultLogDir(override: string): string {
  if (override) { return override; }
  return path.join(os.homedir(), '.claude', 'projects');
}

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

  // Rate-limit event
  if (isRateLimitEntry(entry)) {
    const wait = parseWaitSeconds(entry.content ?? '');
    insertRateLimit(timestamp, wait, project);
    return 'ratelimit';
  }

  // Assistant message with token usage
  const isAssistant = entry.type === 'assistant';
  if (!isAssistant) { return null; }

  // Usage can sit at entry.message.usage or entry.usage (older format)
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

  // Determine project from cwd field of first parseable line, or use dir name
  let project = path.basename(path.dirname(filePath));
  for (const line of lines) {
    if (!line.trim()) { continue; }
    try {
      const e: ClaudeLogEntry = JSON.parse(line);
      if (e.cwd) { project = e.cwd; break; }
    } catch { /* ignore */ }
  }

  // Use the timestamp of the first line as session start, fallback to file mtime
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

// ── directory watcher ──────────────────────────────────────────────────────

const watchers: fs.FSWatcher[] = [];

export function startWatching(
  logDirOverride: string,
  onChange: () => void,
  onRateLimit?: () => void
): void {
  const rootDir = defaultLogDir(logDirOverride);

  if (!fs.existsSync(rootDir)) {
    console.warn(`[TokenTracker] Log directory not found: ${rootDir}`);
    return;
  }

  // Watch the root for new project subdirectories
  try {
    const rootWatcher = fs.watch(rootDir, { recursive: false }, (event, filename) => {
      if (!filename) { return; }
      const fullPath = path.join(rootDir, filename);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        watchProjectDir(fullPath, onChange, onRateLimit);
      }
    });
    watchers.push(rootWatcher);

    // Watch each existing project subdirectory
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        watchProjectDir(path.join(rootDir, entry.name), onChange, onRateLimit);
      }
    }
  } catch (err) {
    console.error('[TokenTracker] Error setting up watchers:', err);
  }

  // Defer the initial scan so activate() returns immediately — avoids blocking VS Code
  scanAllAsync(rootDir, onChange).catch(err =>
    console.error('[TokenTracker] Error during initial scan:', err)
  );
}

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

    await yieldToEventLoop(); // let VS Code breathe between each project dir

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

export function stopWatching(): void {
  for (const w of watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers.length = 0;
}
