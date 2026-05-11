import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, execFileSync } from 'child_process';
import {
  upsertSession,
  addToSession,
  touchSessionLastActive,
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
  wslDistro?: string;   // set when using wsl.exe exec instead of Node.js fs
  linuxBase?: string;   // Linux path inside WSL: /home/user/.claude/projects
}

// ── wsl.exe subprocess helpers ─────────────────────────────────────────────
// Used when Node.js fs cannot access \\wsl$\ UNC paths (common in extension host).
// wsl.exe is a built-in Windows binary — no extra software required.

function wslExec(distro: string, shellCmd: string): Buffer {
  return execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-c', shellCmd], {
    timeout: 15_000,
    maxBuffer: 50 * 1024 * 1024,
  });
}

interface WslFile { linuxPath: string; size: number; }

function wslListJsonl(distro: string, linuxDir: string, maxDepth: number): WslFile[] {
  try {
    const cmd = `find "${linuxDir}" -maxdepth ${maxDepth} -name '*.jsonl' -printf '%p\\t%s\\n' 2>/dev/null`;
    const out = wslExec(distro, cmd).toString('utf8');
    return out.trim().split('\n').filter(Boolean).flatMap(line => {
      const tab = line.lastIndexOf('\t');
      if (tab < 0) { return []; }
      return [{ linuxPath: line.slice(0, tab), size: parseInt(line.slice(tab + 1), 10) || 0 }];
    });
  } catch {
    return [];
  }
}

// ── directory discovery ────────────────────────────────────────────────────

// UNC server names to try — wsl$ works on Win10+, wsl.localhost on Win11 only.
// Node.js fs handles wsl$ more reliably; try both when scanning.
const WSL_SERVERS = ['wsl$', 'wsl.localhost'];

function getWslDistros(): string[] {
  const distros = new Set<string>();

  // Method 1: read \\wsl$\ and \\wsl.localhost\ as directories directly.
  // This avoids the wsl -l -q subprocess and UTF-16 encoding issues.
  for (const server of WSL_SERVERS) {
    try {
      for (const d of fs.readdirSync(`\\\\${server}\\`)) {
        if (d && !d.startsWith('.')) { distros.add(d); }
      }
    } catch { /* server not accessible */ }
  }

  // Method 2: wsl -l -q fallback (UTF-16 LE output)
  if (distros.size === 0) {
    try {
      const raw = execSync('wsl -l -q', { timeout: 5000 });
      raw.toString('utf16le')
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(d => distros.add(d));
    } catch { /* WSL not available */ }
  }

  const result = [...distros];
  console.log(`[TokenTracker] WSL distros: ${result.join(', ') || '(none found)'}`);
  return result;
}

function pushExisting(found: string[], dir: string, label: string): void {
  if (!fs.existsSync(dir)) { return; }
  console.log(`[TokenTracker] Found ${label}: ${dir}`);
  found.push(dir);
}

// Try both \\wsl$\ and \\wsl.localhost\ for a given sub-path; return first accessible home dir list.
function tryReadHome(distro: string): { server: string; users: string[] } | null {
  for (const server of WSL_SERVERS) {
    try {
      const users = fs.readdirSync(`\\\\${server}\\${distro}\\home`);
      return { server, users };
    } catch { /* try next */ }
  }
  return null;
}

export function findWslClaudeDirs(): string[] {
  const found: string[] = [];
  for (const distro of getWslDistros()) {
    const home = tryReadHome(distro);
    if (home) {
      for (const user of home.users) {
        pushExisting(found, `\\\\wsl$\\${distro}\\home\\${user}\\.claude\\projects`, 'WSL Claude dir');
      }
    }
    pushExisting(found, `\\\\wsl$\\${distro}\\root\\.claude\\projects`, 'WSL Claude dir (root)');
  }
  // Fallback: UNC inaccessible — try wsl.exe exec to find dirs
  if (found.length === 0) {
    for (const root of findWslRootsViaExec()) {
      if (root.provider === 'claude') { found.push(root.dir); }
    }
  }
  return found;
}

export function findWslCodexSessionDirs(): string[] {
  const found: string[] = [];
  for (const distro of getWslDistros()) {
    const home = tryReadHome(distro);
    if (home) {
      for (const user of home.users) {
        pushExisting(found, `\\\\wsl$\\${distro}\\home\\${user}\\.codex\\sessions`,  'WSL Codex dir');
        pushExisting(found, `\\\\wsl$\\${distro}\\home\\${user}\\.Codex\\sessions`,  'WSL Codex dir');
      }
    }
    pushExisting(found, `\\\\wsl$\\${distro}\\root\\.codex\\sessions`, 'WSL Codex dir (root)');
    pushExisting(found, `\\\\wsl$\\${distro}\\root\\.Codex\\sessions`, 'WSL Codex dir (root)');
  }
  // Fallback: UNC inaccessible — try wsl.exe exec to find dirs
  if (found.length === 0) {
    for (const root of findWslRootsViaExec()) {
      if (root.provider === 'codex') { found.push(root.dir); }
    }
  }
  return found;
}

// Discover WSL log dirs via wsl.exe exec for distros where UNC paths are inaccessible.
function findWslRootsViaExec(): LogRoot[] {
  const result: LogRoot[] = [];
  let distros: string[];
  try {
    const raw = execSync('wsl.exe -l --quiet', { timeout: 5000 });
    distros = raw.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return result;
  }

  for (const distro of distros) {
    try {
      const script = `for u in $(ls /home 2>/dev/null); do
  [ -d "/home/$u/.claude/projects" ] && echo "claude:/home/$u/.claude/projects"
  [ -d "/home/$u/.codex/sessions"  ] && echo "codex:/home/$u/.codex/sessions"
  [ -d "/home/$u/.Codex/sessions"  ] && echo "codex:/home/$u/.Codex/sessions"
done
[ -d "/root/.claude/projects" ] && echo "claude:/root/.claude/projects"
[ -d "/root/.codex/sessions"  ] && echo "codex:/root/.codex/sessions"
[ -d "/root/.Codex/sessions"  ] && echo "codex:/root/.Codex/sessions"`;

      const out = execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-c', script], {
        timeout: 10_000, maxBuffer: 64 * 1024,
      }).toString('utf8');

      for (const line of out.split('\n').map(l => l.trim()).filter(Boolean)) {
        const colon = line.indexOf(':');
        if (colon < 0) { continue; }
        const provider = line.slice(0, colon) as 'claude' | 'codex';
        const linuxBase = line.slice(colon + 1);
        const dir = `\\\\wsl$\\${distro}` + linuxBase.replace(/\//g, '\\');
        result.push({ dir, provider, wslDistro: distro, linuxBase });
        console.log(`[TokenTracker] WSL exec found ${provider}: wsl://${distro}${linuxBase}`);
      }
    } catch (err) {
      console.log(`[TokenTracker] WSL exec probe failed for "${distro}":`, err instanceof Error ? err.message : String(err));
    }
  }
  return result;
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
  if (override) {
    const provider = override.toLowerCase().includes('.codex') ? 'codex' as const : 'claude' as const;

    // If the override is an inaccessible UNC path, try wsl.exe exec mode instead
    if (isUncPath(override) && !fs.existsSync(override)) {
      const m = override.match(/^\\\\wsl[^\\]*\\([^\\]+)\\(.+)$/i);
      if (m) {
        const distro = m[1];
        const linuxBase = '/' + m[2].replace(/\\/g, '/');
        try {
          const exists = execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-c', `[ -d "${linuxBase}" ] && echo yes`], { timeout: 5000 }).toString().trim();
          if (exists === 'yes') {
            console.log(`[TokenTracker] UNC override inaccessible, switching to wsl.exe exec mode: ${distro}${linuxBase}`);
            return [{ dir: override, provider, wslDistro: distro, linuxBase }];
          }
        } catch { /* fall through to regular mode */ }
      }
    }

    return [{ dir: override, provider }];
  }

  const dirs: LogRoot[] = [];

  const native = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(native)) { dirs.push({ dir: native, provider: 'claude' }); }

  for (const dir of findCodexSessionDirs()) {
    dirs.push({ dir, provider: 'codex' });
  }

  if (os.platform() === 'win32') {
    // Phase 1: UNC paths via Node.js fs (these only include dirs that pass fs.existsSync)
    const distros = getWslDistros();
    const uncClaude: string[] = [];
    const uncCodex:  string[] = [];
    for (const distro of distros) {
      const home = tryReadHome(distro);
      if (home) {
        for (const user of home.users) {
          const cp = `\\\\wsl$\\${distro}\\home\\${user}\\.claude\\projects`;
          if (fs.existsSync(cp)) { uncClaude.push(cp); }
          for (const dot of ['.codex', '.Codex']) {
            const xp = `\\\\wsl$\\${distro}\\home\\${user}\\${dot}\\sessions`;
            if (fs.existsSync(xp)) { uncCodex.push(xp); }
          }
        }
      }
      const rcp = `\\\\wsl$\\${distro}\\root\\.claude\\projects`;
      if (fs.existsSync(rcp)) { uncClaude.push(rcp); }
      for (const dot of ['.codex', '.Codex']) {
        const rxp = `\\\\wsl$\\${distro}\\root\\${dot}\\sessions`;
        if (fs.existsSync(rxp)) { uncCodex.push(rxp); }
      }
    }
    for (const dir of uncClaude) { dirs.push({ dir, provider: 'claude' }); }
    for (const dir of uncCodex)  { dirs.push({ dir, provider: 'codex' }); }

    // Track which distros are covered by UNC so we don't double-watch them
    const distrosWithUnc = new Set<string>();
    for (const dir of [...uncClaude, ...uncCodex]) {
      const m = dir.match(/^\\\\wsl[^\\]*\\([^\\]+)\\/i);
      if (m) { distrosWithUnc.add(m[1].toLowerCase()); }
    }

    // Phase 2: wsl.exe exec for distros where UNC is inaccessible
    for (const root of findWslRootsViaExec()) {
      if (!distrosWithUnc.has((root.wslDistro ?? '').toLowerCase())) {
        dirs.push(root);
      }
    }
  }

  const seen = new Set<string>();
  return dirs.filter(root => {
    const key = root.linuxBase
      ? `${root.provider}:wsl:${root.wslDistro}:${root.linuxBase}`
      : `${root.provider}:${path.normalize(root.dir).toLowerCase()}`;
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

  if (stats.size <= currentOffset) {
    // No new bytes — touch last_active_at so cross-midnight sessions stay visible
    touchSessionLastActive(path.basename(filePath, '.jsonl'), stats.mtime.toISOString());
    return false;
  }

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
  // Stamp last_active_at from file mtime so historical initial scans
  // don't falsely appear as today's activity.
  touchSessionLastActive(sessionFile, stats.mtime.toISOString());
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
  const primary   = limits?.primary;
  const secondary = limits?.secondary;
  const reached   = limits?.rate_limit_reached_type;

  const usedPrimary   = typeof primary?.used_percent   === 'number' ? primary.used_percent   : undefined;
  const usedSecondary = typeof secondary?.used_percent === 'number' ? secondary.used_percent : undefined;

  if (usedPrimary !== undefined || reached) {
    const resetsAt = parseUnixSeconds(primary?.resets_at);
    const wait = resetsAt ? Math.max(0, Math.round((new Date(resetsAt).getTime() - Date.now()) / 1000)) : 0;
    insertLimitSnapshot(timestamp, project, 'codex', resetsAt, usedPrimary, 'primary');
    if (reached || (usedPrimary ?? 0) >= 95) {
      insertRateLimit(timestamp, wait, project, 'codex', resetsAt, usedPrimary);
    }
  }

  if (usedSecondary !== undefined) {
    const resetsAtSec = parseUnixSeconds(secondary?.resets_at);
    insertLimitSnapshot(timestamp, project, 'codex', resetsAtSec, usedSecondary, 'secondary');
  }

  if (usedPrimary !== undefined || reached || usedSecondary !== undefined) {
    return reached ? 'ratelimit' : 'message';
  }

  return inputTokens > 0 || outputTokens > 0 || cacheRead > 0 ? 'message' : null;
}

function tailCodexFile(filePath: string): boolean {
  const stats = fs.statSync(filePath);
  const currentOffset = getOffset(filePath);

  if (stats.size <= currentOffset) {
    touchSessionLastActive(`codex:${path.basename(filePath, '.jsonl')}`, stats.mtime.toISOString());
    return false;
  }

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
  touchSessionLastActive(sessionFile, stats.mtime.toISOString());
  return hadRateLimit;
}

// ── wsl.exe file readers (bypass Node.js fs for WSL paths) ───────────────

function tailFileViaWsl(distro: string, linuxPath: string): boolean {
  const key = `wsl:${distro}:${linuxPath}`;
  const currentOffset = getOffset(key);
  let buf: Buffer;
  try {
    buf = wslExec(distro, `tail -c +${currentOffset + 1} "${linuxPath}" 2>/dev/null`);
  } catch { return false; }
  if (buf.length === 0) { return false; }
  setOffset(key, currentOffset + buf.length);

  const sessionFile = path.basename(linuxPath, '.jsonl');
  const lines = buf.toString('utf8').split('\n');

  let project = linuxPath.split('/').slice(-2, -1)[0] ?? 'unknown';
  for (const line of lines) {
    if (!line.trim()) { continue; }
    try { const e: ClaudeLogEntry = JSON.parse(line); if (e.cwd) { project = e.cwd; break; } } catch { /* */ }
  }

  let startedAt = new Date().toISOString();
  for (const line of lines) {
    if (!line.trim()) { continue; }
    try { const e: ClaudeLogEntry = JSON.parse(line); if (e.timestamp) { startedAt = e.timestamp; break; } } catch { /* */ }
  }

  const sessionId = upsertSession(sessionFile, startedAt, project, 'claude');
  let hadRateLimit = false;
  for (const line of lines) {
    if (processLine(line, sessionId, project) === 'ratelimit') { hadRateLimit = true; }
  }
  return hadRateLimit;
}

function tailCodexFileViaWsl(distro: string, linuxPath: string): boolean {
  const key = `wsl:${distro}:${linuxPath}`;
  const currentOffset = getOffset(key);
  let buf: Buffer;
  try {
    buf = wslExec(distro, `tail -c +${currentOffset + 1} "${linuxPath}" 2>/dev/null`);
  } catch { return false; }
  if (buf.length === 0) { return false; }
  setOffset(key, currentOffset + buf.length);

  const sessionFile = `codex:${path.basename(linuxPath, '.jsonl')}`;
  const lines = buf.toString('utf8').split('\n');

  let project = linuxPath.split('/').slice(-2, -1)[0] ?? 'unknown';
  let startedAt: string | undefined;
  for (const line of lines) {
    if (!line.trim()) { continue; }
    try {
      const e: ClaudeLogEntry = JSON.parse(line);
      if (!startedAt && e.timestamp) { startedAt = e.timestamp; }
      if (e.type === 'session_meta') {
        project = e.payload?.cwd ?? project;
        startedAt = e.payload?.timestamp ?? e.timestamp ?? startedAt;
        break;
      }
    } catch { /* */ }
  }

  const sessionId = upsertSession(sessionFile, startedAt ?? new Date().toISOString(), project, 'codex');
  let hadRateLimit = false;
  for (const line of lines) {
    if (processCodexLine(line, sessionId, project) === 'ratelimit') { hadRateLimit = true; }
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

async function scanAllAsyncViaWsl(root: LogRoot, onChange: () => void, onRateLimit?: () => void): Promise<void> {
  const { wslDistro, linuxBase, provider } = root;
  if (!wslDistro || !linuxBase) { return; }

  const maxDepth = provider === 'codex' ? 5 : 2;
  const files = wslListJsonl(wslDistro, linuxBase, maxDepth);
  let anyRateLimit = false;

  for (const { linuxPath, size } of files) {
    await yieldToEventLoop();
    if (size <= getOffset(`wsl:${wslDistro}:${linuxPath}`)) { continue; }
    try {
      const hadRateLimit = provider === 'codex'
        ? tailCodexFileViaWsl(wslDistro, linuxPath)
        : tailFileViaWsl(wslDistro, linuxPath);
      if (hadRateLimit) { anyRateLimit = true; }
    } catch (err) {
      console.error(`[TokenTracker] WSL exec error processing ${linuxPath}:`, err);
    }
  }

  onChange();
  if (anyRateLimit) { onRateLimit?.(); }
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

function startWatchingDir(root: LogRoot, onChange: () => void, onRateLimit?: () => void): void {
  watchedDirs.push(root.dir);

  // WSL exec mode — bypass Node.js fs entirely, always poll
  if (root.wslDistro) {
    console.log(`[TokenTracker] WSL exec mode, polling every ${WSL_POLL_MS / 1000}s: wsl://${root.wslDistro}${root.linuxBase}`);
    scanAllAsyncViaWsl(root, onChange, onRateLimit).catch(err =>
      console.error('[TokenTracker] WSL exec initial scan error:', err)
    );
    const id = setInterval(() => {
      scanAllAsyncViaWsl(root, onChange, onRateLimit).catch(err =>
        console.error('[TokenTracker] WSL exec poll error:', err)
      );
    }, WSL_POLL_MS);
    pollIntervals.push(id);
    return;
  }

  // Node.js fs mode (native or UNC path)
  scanAllAsync(root.dir, root.provider, onChange).catch(err =>
    console.error('[TokenTracker] Error during initial scan:', err)
  );

  if (isUncPath(root.dir)) {
    console.log(`[TokenTracker] WSL UNC path, polling every ${WSL_POLL_MS / 1000}s: ${root.dir}`);
    const id = setInterval(() => {
      scanAllAsync(root.dir, root.provider, onChange).catch(err =>
        console.error('[TokenTracker] WSL poll error:', err)
      );
    }, WSL_POLL_MS);
    pollIntervals.push(id);
    return;
  }

  // Native path: fs.watch for real-time updates (Codex always polls)
  try {
    if (root.provider === 'codex') {
      const id = setInterval(() => {
        scanAllAsync(root.dir, root.provider, onChange).catch(err =>
          console.error('[TokenTracker] Codex poll error:', err)
        );
      }, WSL_POLL_MS);
      pollIntervals.push(id);
      return;
    }

    const rootWatcher = fs.watch(root.dir, { recursive: false }, (event, filename) => {
      if (!filename) { return; }
      const fullPath = path.join(root.dir, filename);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        watchProjectDir(fullPath, root.provider, onChange, onRateLimit);
      }
    });
    watchers.push(rootWatcher);

    for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        watchProjectDir(path.join(root.dir, entry.name), root.provider, onChange, onRateLimit);
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
    startWatchingDir(root, onChange, onRateLimit);
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
