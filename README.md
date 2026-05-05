# AI Token Tracker

<p align="center">
  <img src="images/icon_128.png" width="96" alt="AI Token Tracker"/>
</p>

<p align="center">
  <strong>Track your Claude Code token usage, cost, and rate-limit events — right inside VS Code.</strong><br/>
  Reads local log files only. No API interception, no telemetry, nothing leaves your machine.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.85-blue?style=flat-square&logo=visualstudiocode" alt="VS Code"/>
  <img src="https://img.shields.io/badge/Claude%20Code-required-a78bfa?style=flat-square" alt="Claude Code"/>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT"/>
</p>

---

## Requirements

> **This extension only works if you have [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and have used it.**
>
> Claude Code writes local log files as you work. This extension reads those files — if they don't exist, everything will show zero.

---

## What it does

The status bar shows live stats while you work:

```
⬡ 12.4k · $0.18 · sonnet-4-6
```

Click it to open a summary panel inside VS Code:

- **Today / 7-day / 30-day** cost and token totals
- **Stacked area chart** — input vs output tokens over the last 30 days
- **Bar chart** — estimated cost per day over the last 30 days
- **Projects table** — all-time token and cost breakdown per project, collapsed by folder name
- **Rate-limit events** — when Claude Code paused and for how long

---

## Features

- Live status bar item — always visible while coding
- Coloured webview panel — blue/purple/green palette, model badges per family
- Per-project tracking tied to the active VS Code workspace
- Detects `claude-opus`, `claude-sonnet`, `claude-haiku` — with distinct badge colours
- Auto-detects Claude Code logs on Windows, macOS, and Linux
- **WSL support** — automatically finds Claude Code logs inside WSL distros on Windows hosts
- Project merging — fold multiple folder names into one display entry via settings
- Rate-limit detection and wait-time logging
- All data stored locally in JSON — nothing sent anywhere

---

## WSL Support

If you run Claude Code inside a WSL distro (Ubuntu, Debian, etc.) but VS Code on Windows, the extension automatically finds your logs at:

```
\\wsl$\<distro>\home\<username>\.claude\projects
```

No configuration needed. On startup it scans all installed WSL distros and picks up any that have Claude Code log files. New sessions are detected by polling every 30 seconds.

If auto-detection doesn't work, set the path manually in settings:

```
tokenTracker.logDirectory = \\wsl$\Ubuntu\home\myusername\.claude\projects
```

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `tokenTracker.logDirectory` | *(auto)* | Override the Claude log path (leave empty for auto-detect) |
| `tokenTracker.projectMerges` | `{}` | Merge project folder names into one entry. Example: `{ "my-app": ["my-app", "my-app-v2"] }` |

---

## Log file locations

| Platform | Path watched |
|---|---|
| Windows | `%USERPROFILE%\.claude\projects\` |
| macOS / Linux | `~/.claude/projects/` |
| WSL (auto) | `\\wsl$\<distro>\home\<user>\.claude\projects\` |

---

## Cost estimates

Shown costs are **retail API equivalents** — informational only.
They do not reflect your actual Claude subscription bill.

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| claude-opus-4-7 | $15/M | $75/M | $18.75/M | $1.50/M |
| claude-sonnet-4-6 | $3/M | $15/M | $3.75/M | $0.30/M |
| claude-haiku-4-5 | $0.80/M | $4/M | $1.00/M | $0.08/M |

Edit `src/pricing.json` to update rates — no recompile needed.

---

## Data storage

```
%APPDATA%\Code\User\globalStorage\tango-solutions.ai-token-tracker\token_tracker.json
```

Nothing leaves your machine.

---

## Project structure

```
ai-token-tracker/
├── src/
│   ├── extension.ts      ← entry point — activates watchers, status bar, commands
│   ├── logParser.ts      ← tails Claude log files, emits token/rate-limit events
│   ├── db.ts             ← in-memory store + JSON persistence + query helpers
│   ├── pricing.ts        ← cost estimation logic
│   ├── pricing.json      ← editable pricing table (copied to out/ at build)
│   ├── statusBar.ts      ← VS Code status bar item
│   └── webviewPanel.ts   ← in-editor summary panel (HTML/CSS/SVG charts)
├── images/
│   └── icon_128.png
├── CLAUDE.md             ← architecture notes for AI-assisted development
└── package.json
```

---

## Development

```powershell
git clone https://github.com/GHT4ngo/ai-token-tracker.git
cd ai-token-tracker
npm install
npm run compile     # type-check
npm run bundle      # build with esbuild
```

Press **F5** in VS Code to launch the Extension Development Host.

---

## Contributing

PRs and issues welcome. See `CLAUDE.md` for architecture notes.

---

## License

MIT
