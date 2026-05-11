# AI Token Tracker

<p align="center">
  <img src="images/icon_128.png" width="96" alt="AI Token Tracker"/>
</p>

<p align="center">
  <strong>Track Claude Code and Codex token usage, cost estimates, project activity, and softcap signals inside VS Code.</strong><br/>
  Reads local log files only. No API interception, no telemetry, nothing leaves your machine.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.85-blue?style=flat-square&logo=visualstudiocode" alt="VS Code"/>
  <img src="https://img.shields.io/badge/Claude%20Code-supported-a78bfa?style=flat-square" alt="Claude Code"/>
  <img src="https://img.shields.io/badge/Codex-supported-60a5fa?style=flat-square" alt="Codex"/>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT"/>
</p>

---

## Requirements

This extension works after you have used at least one supported local AI coding tool:

- Claude Code, which writes session logs under `.claude/projects`
- Codex, which writes session logs under `.codex/sessions`

If those logs do not exist yet, the extension will open normally but usage will show as quiet until a session is recorded.

---

## What it does

The status bar shows live stats while you work. When there is activity, it displays:

```
⬡  79.2k ●  4.1M ●
```

- **⬡** — the token tracker hex icon (click to open panel)
- **Purple number** — Claude Code tokens used today
- **●** — Claude Code quota health (green / yellow / red)
- **Cyan number** — Codex tokens used today
- **●** — Codex quota health (green / yellow / red)

Each provider's dot is colored independently based on that provider's estimated usage. A provider's tokens and dot are hidden when it has no activity today. When nothing has been recorded yet, only the **⬡** icon is shown.

Click the status bar to open a summary panel inside VS Code:

- **Stats tab**: Today / 7-day / 30-day cost and token totals
- Separate activity charts for Claude Code and Codex with soft bezier curves
- **Red cap bands** on activity charts — each day a quota cap was active is highlighted in red; 5-hour primary caps are light red, weekly caps are stronger red
- Click **⤢ zoom** on any chart to expand it to fill the panel; press Escape or click outside to close
- Provider risk cards with estimated usage percentage and reset time when logs include limit signals
- **Cap Prediction card** — shows current usage rate (%/hr) and estimated time until the next cap for each active provider and window (5-hour and 7-day windows tracked separately for Codex)
- Estimated quota usage tracker at the bottom showing each engine's usage bar
- Projects table with Claude Code and Codex as separate engine rows
- Rate-limit events table for recent pauses or softcap windows
- **Memory tab**: Extension host heap usage and a list of all active VS Code extensions

Costs are retail API equivalents for planning only. They are not your actual subscription bill.

---

## Features

- Live status bar showing `⬡  [claude tokens] ●  [codex tokens] ●` — each colored dot reflects that provider's own quota health independently
- Rich VS Code webview with inline SVG charts
- Claude Code and Codex usage parsing from local JSONL logs
- Per-project tracking tied to the recorded workspace or session path
- Separate engine labels and colors in the projects table
- Approximate usage display, avoiding overly exact token/limit claims
- **Cap period bands** on charts — red columns mark every day a quota cap was active, saved historically so past caps remain visible after a window resets
- **Cap rate prediction** — linear rate fit over recent snapshots estimates how many hours until the next 5-hour or 7-day cap, shown with color-coded urgency
- **Weekly (secondary) window tracking** for Codex — captures the 7-day rolling usage window separately from the 5-hour window, with its own snapshot history and prediction
- Backfills secondary window data from session files that were fully read before the weekly window was added — no re-scan needed
- Softcap planning cards with estimated provider usage percentage when logs expose it
- Auto-detects native Windows, macOS, Linux, and WSL log folders
- Polling fallback for WSL/UNC paths where file watching is unreliable
- Project merging via settings
- Project folders with drag-and-drop organization
- All data stored locally in JSON

---

## Claude Code And Codex

Both Claude Code and Codex use token accounting in the same broad sense: prompts, tool context, file contents, and model replies are counted as input/output tokens. The exact internal accounting and subscription limits are provider-specific, so the extension treats local logs as the source of truth and shows estimates rather than exact quota numbers.

Codex logs can include `token_count` events and rate-limit metadata for both the 5-hour primary window and the 7-day secondary window. When available, the extension records snapshots for each window separately, shows risk cards with estimated usage and reset time, draws red cap bands on the activity chart for every day a cap was active, and predicts time to the next cap based on your current usage rate.

---

## WSL Support

If you run Claude Code or Codex inside a WSL distro but VS Code on Windows, the extension looks for logs such as:

```text
\\wsl$\<distro>\home\<username>\.claude\projects
\\wsl$\<distro>\home\<username>\.codex\sessions
\\wsl$\<distro>\root\.claude\projects
\\wsl$\<distro>\root\.codex\sessions
```

On startup it scans installed WSL distros and picks up any supported log folders. WSL paths are polled every 30 seconds because `fs.watch` is unreliable on UNC paths.

If auto-detection does not work, run `AI Token Tracker: Diagnose / Set Log Path` from the command palette and paste either a `.claude/projects` or `.codex/sessions` path. Windows Explorer style paths such as `wsl.localhost/Ubuntu/home/user/.codex/sessions` are normalized to UNC format.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `tokenTracker.logDirectory` | auto | Override the Claude Code or Codex log path. Leave empty for auto-detect. |
| `tokenTracker.projectMerges` | `{}` | Merge project folder names into one display entry. Example: `{ "my-app": ["my-app", "my-app-v2"] }` |

---

## Log File Locations

| Tool | Platform | Path watched |
|---|---|---|
| Claude Code | Windows | `%USERPROFILE%\.claude\projects\` |
| Claude Code | macOS / Linux | `~/.claude/projects/` |
| Claude Code | WSL | `\\wsl$\<distro>\home\<user>\.claude\projects\` |
| Codex | Windows | `%USERPROFILE%\.codex\sessions\` |
| Codex | macOS / Linux | `~/.codex/sessions/` |
| Codex | WSL | `\\wsl$\<distro>\home\<user>\.codex\sessions\` |

The extension also checks `.Codex/sessions` variants for installations that use a capitalized folder name.

---

## Cost Estimates

Shown costs are retail API equivalents, informational only.

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| claude-opus-4-7 | $15/M | $75/M | $18.75/M | $1.50/M |
| claude-sonnet-4-6 | $3/M | $15/M | $3.75/M | $0.30/M |
| claude-haiku-4-5 | $0.80/M | $4/M | $1.00/M | $0.08/M |
| gpt-5.3-codex | $1.75/M | $14/M | $0.175/M | $0.175/M |
| gpt-5.2-codex | $1.75/M | $14/M | $0.175/M | $0.175/M |
| gpt-5.1-codex | $1.25/M | $10/M | $0.125/M | $0.125/M |
| gpt-5-codex | $1.25/M | $10/M | $0.125/M | $0.125/M |

Edit `src/pricing.json` to update rates. The pricing file is copied into the extension bundle at build time.

---

## Data Storage

```text
%APPDATA%\Code\User\globalStorage\tango-solutions.ai-token-tracker\token_tracker.json
```

Stored data includes sessions, provider labels, token totals, cost estimates, rate-limit events, softcap snapshots, file offsets, and folder organization. Nothing is sent to any server.

---

## Project Structure

```text
ai-token-tracker/
+-- src/
|   +-- extension.ts      # entry point, commands, diagnostics
|   +-- logParser.ts      # Claude Code/Codex log discovery and parsing
|   +-- db.ts             # in-memory store, JSON persistence, queries
|   +-- pricing.ts        # cost estimation logic
|   +-- pricing.json      # editable pricing table
|   +-- statusBar.ts      # VS Code status bar item
|   +-- webviewPanel.ts   # in-editor summary panel
+-- images/
|   +-- icon_128.png
+-- CLAUDE.md
+-- AGENTS.md
+-- package.json
```

---

## Development

```powershell
git clone https://github.com/GHT4ngo/ai-token-tracker.git
cd ai-token-tracker
npm install
npm run compile
npm run bundle
```

Press F5 in VS Code to launch the Extension Development Host.

---

## Release Checklist

Before publishing a release:

1. Bump `package.json` and `package-lock.json`.
2. Update this README and the in-extension descriptions for user-facing changes.
3. Run `npm run compile`.
4. Run `npm run bundle`.
5. Commit and push.
6. Run `npx vsce package`.

---

## License

MIT
