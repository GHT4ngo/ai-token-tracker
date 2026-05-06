# AI Token Tracker - VS Code Extension

## Release Rules

Always bump the version in `package.json` and `package-lock.json` for each user-facing update.
Use patch for small fixes and tweaks (`0.2.x`) and minor for larger feature sets (`0.x.0`).

For every feature change, also update:

- `README.md`, because it is the GitHub and Marketplace information page.
- `package.json` metadata/settings descriptions when the user-facing behavior changes.
- This project information file when architecture, supported tools, paths, or release rules change.

After changes, run `npm run compile` and `npm run bundle`, then commit and push.

---

## Project Goal

AI Token Tracker is a VS Code extension that passively monitors local AI coding tool usage by parsing log files. It tracks Claude Code and Codex token consumption, model/provider, per-project breakdown, estimated retail API-equivalent costs, rate-limit events, and softcap planning signals without intercepting live API calls.

A small status bar item shows live session stats. Clicking it opens a richer VS Code webview with charts, provider risk cards, project breakdowns, folders, and recent rate-limit events.

---

## Architecture

```text
VS Code Extension (TypeScript)
  +-- Log Parser (logParser.ts)
  |     +-- Watches Claude Code .claude/projects JSONL logs
  |     +-- Polls Codex .codex/sessions JSONL logs recursively
  |     +-- Auto-detects WSL distros on Windows via wsl -l -q
  |     +-- Falls back to 30s polling for WSL/UNC paths
  |     +-- Extracts tokens, model, provider, timestamps, project path, rate-limit events
  |
  +-- Status Bar (statusBar.ts)
  |     +-- Shows live estimated usage and current model
  |
  +-- Webview Panel (webviewPanel.ts)
  |     +-- Stat cards: Today / 7-day / 30-day cost + approximate tokens
  |     +-- Provider risk cards: Claude Code and Codex softcap estimates
  |     +-- Range toggle: 90 days / 30 days / 7 days / 3 days
  |     +-- SVG activity and cost charts with softcap markers
  |     +-- Projects table grouped by project and provider
  |     +-- User-defined folders with drag/drop organization
  |     +-- Rate-limit events table
  |
  +-- DB (db.ts)
        +-- In-memory store, flushed to JSON on every write
        +-- Sessions, offsets, rate limits, limit snapshots, project folders
```

---

## Supported Logs

| Tool | Native path | WSL path |
|---|---|---|
| Claude Code | `~/.claude/projects` | `\\wsl$\<distro>\home\<user>\.claude\projects` |
| Codex | `~/.codex/sessions` | `\\wsl$\<distro>\home\<user>\.codex\sessions` |

The parser also checks root-user WSL paths and `.Codex/sessions` variants.

Manual paths are set with `tokenTracker.diagnose`. Windows Explorer paths such as `wsl.localhost/Ubuntu/home/user/.codex/sessions` are normalized to UNC paths before scanning.

---

## Token And Softcap Model

Both Claude Code and Codex are treated as token-based engines with input, output, cache write, and cache read buckets when those values exist in logs.

The extension intentionally shows approximate token/usage numbers for planning. Local logs can provide useful signals, but they do not guarantee an exact subscription quota. Codex logs can include `token_count` events and `rate_limits.primary.used_percent`; these are stored as limit snapshots and used for risk cards and softcap markers.

---

## Cost Estimation

Shown costs are retail API equivalents only. Values live in `src/pricing.json` and are copied into `out/pricing.json` during `npm run bundle`.

---

## Data Storage

- File: `<VS Code global storage>/token-tracker/token_tracker.json`
- Folders: `context.globalState` key `projectFolders`
- Stored locally only. Nothing is sent to a server.

---

## Development

```powershell
npm install
npm run compile
npm run bundle
```

Press F5 in VS Code to launch the Extension Development Host.

---

## Publishing

```powershell
npm run bundle
npx vsce package
```

Upload the generated `.vsix` at the Visual Studio Marketplace publisher dashboard.
