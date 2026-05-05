# AI Token Tracker — VS Code Extension

## Versioning Rule

**Always bump the version in `package.json` before packaging a new release.**
Use patch for small fixes/tweaks (`0.2.x`), minor for new features (`0.x.0`).
After bumping, commit, push, run `npx vsce package`, then upload the `.vsix`.

---

## Project Goal

A VS Code extension that passively monitors Claude Code usage by parsing local log files.
Tracks token consumption, model used, per-project breakdown, estimated costs, and rate-limit events — all without intercepting live API calls.

A discrete status bar item shows live session stats. Clicking it opens a rich summary panel inside VS Code with SVG charts and a projects breakdown.

---

## Architecture

```
VS Code Extension (TypeScript)
  └── Log Parser (logParser.ts)
        ├── Watches ~/.claude/projects/**/*.jsonl
        ├── Auto-detects WSL distros on Windows via wsl -l -q
        ├── Falls back to 30s polling for WSL/UNC paths (fs.watch unsupported on \\wsl$)
        └── Extracts: tokens in/out, model, timestamps, project path, rate-limit events

  └── Status Bar (statusBar.ts)
        └── Shows: ⬡ 12.4k · $0.18 · sonnet-4-6

  └── Webview Panel (webviewPanel.ts)
        ├── Stat cards: Today / 7-day / 30-day cost + tokens
        ├── SVG area chart: stacked input/output tokens over 30 days
        │     └── Red dot markers on days with rate-limit events
        ├── SVG bar chart: daily cost over 30 days
        │     └── Red dot markers on days with rate-limit events
        ├── Projects table: all-time usage grouped by folder name
        │     ├── User-defined folders (create / delete via VS Code input box)
        │     ├── Drag & drop projects into folders or back to Unfiled
        │     └── Collapse / expand folder rows
        └── Rate-limit events table

  └── DB (db.ts)
        ├── In-memory store, flushed to JSON on every write
        └── Queries: today totals, 7/30-day summary, per-project, daily rows, rate limits
```

---

## Key Features

- [x] Watch Claude Code log files for changes
- [x] Parse token usage (input, output, cache write, cache read)
- [x] Detect model per session (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5)
- [x] Associate usage with VS Code workspace (project-level tracking)
- [x] Persist records to JSON (`token_tracker.json` in extension global storage)
- [x] Status bar: `⬡ 12.4k · $0.18 · sonnet-4-6`
- [x] Webview panel with SVG charts (no external chart library)
- [x] Auto-detect WSL distros on Windows hosts (`wsl -l -q`, UNC `\\wsl$` paths)
- [x] 30s polling fallback for UNC paths where `fs.watch` is unreliable
- [x] `tokenTracker.diagnose` command — shows watched paths + session count, lets user paste a custom path
- [x] `tokenTracker.projectMerges` setting — fold multiple folder names into one entry
- [x] Rate-limit detection, wait-time logging, and red dot markers on charts
- [x] Project folders — create/delete via VS Code input box, stored in `globalState`
- [x] Drag & drop projects between folders and Unfiled
- [x] Collapse/expand folder rows in the projects table
- [x] Rows with zero input + output tokens are filtered out

---

## Token Cost Estimation

Shown costs are **retail API equivalents** — informational only.

### Pricing table (USD per million tokens)

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| claude-opus-4-7 | $15.00 | $75.00 | $18.75 | $1.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $3.75 | $0.30 |
| claude-haiku-4-5 | $0.80 | $4.00 | $1.00 | $0.08 |

Values live in `src/pricing.json` — edit without recompiling.

---

## Log File Locations

| Platform | Path |
|---|---|
| Windows | `%USERPROFILE%\.claude\projects\` |
| macOS / Linux | `~/.claude/projects\` |
| WSL (auto) | `\\wsl$\<distro>\home\<user>\.claude\projects\` |
| WSL root (auto) | `\\wsl$\<distro>\root\.claude\projects\` |

---

## Data Storage

- **File**: `<VS Code global storage>/token-tracker/token_tracker.json`
- **Folders**: `context.globalState` key `projectFolders` — `Record<string, string[]>`
- In-memory store, flushed to JSON on every write
- Nothing sent to any server

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension | TypeScript, VS Code Extension API |
| Log parsing | Node.js `fs.watch` + 30s polling, custom JSONL parser |
| Storage | JSON flat file (migrated from SQLite to avoid native module issues) |
| Charts | Inline SVG generated server-side — no external dependencies |
| WSL detection | `child_process.execSync('wsl -l -q')` + `\\wsl$` UNC paths |
| Folder state | `context.globalState` (persists across VS Code restarts) |
| Interactivity | Inline `<script>` in webview (event delegation, HTML5 drag & drop) |

---

## File Structure

```
token_counter/
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts       ← entry point, activates watchers + commands
│   ├── logParser.ts       ← reads and tails Claude log files, WSL detection
│   ├── db.ts              ← in-memory store + JSON persistence + query helpers
│   ├── pricing.ts         ← cost estimation logic
│   ├── pricing.json       ← editable pricing table
│   ├── statusBar.ts       ← VS Code status bar item
│   └── webviewPanel.ts    ← in-editor summary panel (HTML/CSS/SVG/JS)
├── images/
│   └── icon_128.png
├── .vscodeignore
└── README.md
```

---

## Development

```powershell
npm install
npm run compile    # type-check only (tsc --noEmit)
npm run bundle     # build with esbuild → out/extension.js
# Press F5 in VS Code to launch Extension Development Host
```

## Publishing

```powershell
# 1. Bump version in package.json (patch or minor)
# 2. Commit + push
npm run bundle
npx vsce package                    # creates ai-token-tracker-x.y.z.vsix
# Upload .vsix at marketplace.visualstudio.com/manage/publishers/tango-solutions
```

---

## Webview Panel — Implementation Notes

- `enableScripts: true` required for interactive folder/drag-drop JS
- CSP: `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`
- `retainContextWhenHidden: false` — panel re-renders on every open (keeps data fresh)
- Folder state read/written via `_context.globalState` (module-level `_context` set in `showPanel()`)
- Message handler in `showPanel()` handles: `createFolder`, `moveProject`, `deleteFolder`
- JS uses event delegation on `document.body` — avoids escaping issues with arbitrary project/folder names
- Rate-limit red dots: `rlMarkerSvg(x, yTop, label)` helper; both chart builders accept `rlDates: Set<string>`

## WSL Support — Implementation Notes

- `getWslDistros()`: runs `wsl -l -q`, decodes UTF-16 LE (`raw.toString('utf16le').replace(/\0/g, '')`)
- `findWslClaudeDirs()`: checks `/home/*` and `/root` for each distro via `\\wsl$` UNC paths
- `isUncPath(p)`: `p.startsWith('\\\\')` — UNC paths get 30s polling, never `fs.watch`
- If auto-detection fails, user can paste path via `tokenTracker.diagnose` command
