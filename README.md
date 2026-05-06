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

The status bar shows live stats while you work:

```text
AI 12.4k - $0.18 - sonnet-4-6
```

Click it to open a summary panel inside VS Code:

- Today / 7-day / 30-day cost and token totals
- Activity chart with 90-day, 30-day, 7-day, and 3-day ranges
- Estimated cost chart over the selected range
- Softcap markers and provider risk cards when logs include limit signals
- Projects table with Claude Code and Codex listed as separate engine rows
- Rate-limit events table for recent pauses or softcap windows

Costs are retail API equivalents for planning only. They are not your actual subscription bill.

---

## Features

- Live status bar item, always visible while coding
- Rich VS Code webview with inline SVG charts
- Claude Code and Codex usage parsing from local JSONL logs
- Per-project tracking tied to the recorded workspace or session path
- Separate engine labels and colors in the projects table
- Approximate usage display, avoiding overly exact token/limit claims
- Softcap planning cards with estimated provider usage percentage when logs expose it
- Auto-detects native Windows, macOS, Linux, and WSL log folders
- Polling fallback for WSL/UNC paths where file watching is unreliable
- Project merging via settings
- Project folders with drag-and-drop organization
- All data stored locally in JSON

---

## Claude Code And Codex

Both Claude Code and Codex use token accounting in the same broad sense: prompts, tool context, file contents, and model replies are counted as input/output tokens. The exact internal accounting and subscription limits are provider-specific, so the extension treats local logs as the source of truth and shows estimates rather than exact quota numbers.

Codex logs can include `token_count` events and sometimes rate-limit metadata such as used percentage and reset time. When available, the extension records those snapshots to estimate whether Codex is fresh, worth watching, low, or likely capped.

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
| gpt-5.3-codex | $1.25/M | $10/M | $0/M | $0.125/M |
| gpt-5.2-codex | $1.25/M | $10/M | $0/M | $0.125/M |
| gpt-5.1-codex | $1.25/M | $10/M | $0/M | $0.125/M |
| gpt-5-codex | $1.25/M | $10/M | $0/M | $0.125/M |

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
