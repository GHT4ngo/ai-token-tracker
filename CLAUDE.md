# AI Token Tracker — VS Code Extension

## Project Goal

Build a VS Code extension that passively monitors Claude Code usage by parsing local log files.
It tracks token consumption, model/engine used, per-project breakdown, estimated costs, and rate-limit/wait events — all without intercepting live API calls.

A discrete status bar item shows live session stats inside VS Code.
A separate web frontend (built via Lovable.dev) provides rich charts and history from the same local data.

---

## Architecture Overview

```
VS Code Extension (TypeScript)
  └── Log Parser
        ├── Watches Claude Code log files (~/.claude/logs/ or %APPDATA%\Claude\logs\)
        ├── Extracts: tokens in/out, model name, timestamps, project path, rate-limit events
        └── Writes structured records to local SQLite DB

  └── Status Bar Item
        └── Shows: session tokens used | estimated cost | model name
        └── Click → opens summary Webview panel inside VS Code

  └── Local REST API (optional, tiny Express server)
        └── Serves token data as JSON for the Lovable frontend

Lovable Frontend (React web app)
  └── Reads from local REST API or exported JSON
  └── Charts: daily usage, per-project, cost over time, rate-limit events
  └── Prompt template included in this repo to regenerate/extend the frontend
```

---

## Key Features

### Phase 1 — Log Parsing + Status Bar (this repo)
- [x] Watch Claude Code log files for changes
- [x] Parse token usage per message (input tokens, output tokens, cache tokens)
- [x] Detect model/engine per session (claude-opus-4-7, claude-sonnet-4-6, etc.)
- [x] Associate usage with the active VS Code workspace (project-level tracking)
- [x] Persist all records to SQLite (`token_tracker.db` in extension storage)
- [x] Status bar item: `⬡ 12.4k tokens | ~$0.18 | sonnet-4-6`
- [x] Click status bar → Webview panel with session summary table
- [x] Detect and log rate-limit events and wait times from log entries

### Phase 2 — Lovable Frontend
- [ ] Tiny local Express server bundled with extension (opt-in, default port 7842)
- [ ] Lovable.dev prompt (see `lovable-prompt.md`) to scaffold the web app
- [ ] Web app reads from local API: daily/weekly/monthly charts
- [ ] Per-project cost breakdown
- [ ] Rate-limit timeline view

---

## Token Cost Estimation

Even on a Claude subscription (Max, Pro), we estimate the **retail API equivalent cost** so you
understand the real value consumed. This is informational only — it does not reflect your actual bill.

### Pricing table (as of May 2026, USD per million tokens)

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| claude-opus-4-7 | $15.00 | $75.00 | $18.75 | $1.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $3.75 | $0.30 |
| claude-haiku-4-5 | $0.80 | $4.00 | $1.00 | $0.08 |

These values live in `src/pricing.ts` and can be updated without a code change by editing
the bundled `pricing.json` file.

---

## Log File Locations

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Claude\logs\` |
| macOS | `~/Library/Logs/Claude/` |
| Linux | `~/.config/Claude/logs/` or `~/.claude/logs/` |

Claude Code also writes to a session JSONL file. The parser targets both formats.

---

## Data Storage

All data is stored **locally only** — nothing is sent to any server unless you opt in to the
Lovable frontend's local API (which only binds to `localhost`).

- **SQLite DB**: `<VS Code global storage>/token-tracker/token_tracker.db`
- **Tables**: `sessions`, `messages`, `projects`, `rate_limit_events`
- **Export**: JSON export available from the command palette

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension | TypeScript, VS Code Extension API |
| Log parsing | Node.js `fs.watch`, custom JSONL/text parser |
| Storage | SQLite via `better-sqlite3` |
| Status bar | VS Code `StatusBarItem` API |
| Webview panel | VS Code Webview + vanilla HTML/JS |
| Local API (Phase 2) | Express.js (bundled, opt-in) |
| Frontend (Phase 2) | React + Recharts, scaffolded via Lovable.dev |

---

## File Structure

```
token_counter/
├── CLAUDE.md                  ← this file
├── lovable-prompt.md          ← prompt to generate the Lovable frontend
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts           ← entry point, activates watchers + status bar
│   ├── logParser.ts           ← reads and tails Claude log files
│   ├── db.ts                  ← SQLite schema + queries
│   ├── pricing.ts             ← cost estimation logic
│   ├── pricing.json           ← editable pricing table
│   ├── statusBar.ts           ← VS Code status bar item
│   ├── webviewPanel.ts        ← in-editor summary panel
│   └── server.ts              ← optional local REST API (Phase 2)
├── .vscodeignore
└── README.md
```

---

## Development

```powershell
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Launch extension in VS Code debug host
# Press F5 in VS Code with this folder open
```

---

## Lovable Frontend Prompt

See `lovable-prompt.md` for a ready-to-paste prompt that builds the web dashboard.
The prompt describes the local API contract so Lovable generates compatible code.
