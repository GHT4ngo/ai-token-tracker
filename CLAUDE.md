# AI Token Tracker — VS Code Extension

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
        ├── Falls back to polling for WSL paths (fs.watch unsupported on UNC)
        └── Extracts: tokens in/out, model, timestamps, project path, rate-limit events

  └── Status Bar (statusBar.ts)
        └── Shows: ⬡ 12.4k · $0.18 · sonnet-4-6

  └── Webview Panel (webviewPanel.ts)
        ├── Stat cards: Today / 7-day / 30-day cost + tokens
        ├── SVG area chart: stacked input/output tokens over 30 days
        ├── SVG bar chart: daily cost over 30 days
        ├── Projects table: all-time usage grouped by folder name
        └── Rate-limit events table
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
- [x] Auto-detect WSL distros on Windows hosts
- [x] `tokenTracker.diagnose` command — shows status + lets user paste a custom path
- [x] `tokenTracker.projectMerges` setting — fold multiple folder names into one entry
- [x] Rate-limit detection and wait-time logging

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
| macOS / Linux | `~/.claude/projects/` |
| WSL (auto) | `\\wsl$\<distro>\home\<user>\.claude\projects\` |

---

## Data Storage

- **File**: `<VS Code global storage>/token-tracker/token_tracker.json`
- In-memory store, flushed to JSON on every write
- Nothing sent to any server

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension | TypeScript, VS Code Extension API |
| Log parsing | Node.js `fs.watch` + polling, custom JSONL parser |
| Storage | JSON flat file (was SQLite, migrated to avoid native module issues) |
| Charts | Inline SVG generated server-side — no external dependencies |
| WSL detection | `child_process.execSync('wsl -l -q')` + `\\wsl$` UNC paths |

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
│   └── webviewPanel.ts    ← in-editor summary panel (HTML/CSS/SVG)
├── images/
│   └── icon_128.png
├── .vscodeignore
└── README.md
```

---

## Development

```powershell
npm install
npm run compile    # type-check only
npm run bundle     # build with esbuild → out/extension.js
# Press F5 in VS Code to launch Extension Development Host
```

## Publishing

```powershell
npm run bundle
npx vsce package                    # creates .vsix
# Upload .vsix at marketplace.visualstudio.com/manage/publishers/tango-solutions
```
