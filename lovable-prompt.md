# Lovable.dev Prompt — AI Token Tracker Dashboard

> Paste the block below into Lovable.dev to scaffold the web frontend.
> The local VS Code extension must be running with the optional API server enabled (port 7842).

---

## Prompt (copy everything between the lines)

---

Build a clean, dark-mode web dashboard called **AI Token Tracker** that reads data from a local API at `http://localhost:7842`.

### API endpoints available

**GET /api/summary**
Returns total tokens and cost for today, this week, this month.
```json
{
  "today":   { "input": 45200, "output": 12300, "cost_usd": 0.48 },
  "week":    { "input": 310000, "output": 88000, "cost_usd": 3.21 },
  "month":   { "input": 1200000, "output": 340000, "cost_usd": 12.80 },
  "model":   "claude-sonnet-4-6"
}
```

**GET /api/daily?days=30**
Returns one entry per day for the last N days.
```json
[
  { "date": "2026-05-03", "input": 45200, "output": 12300, "cost_usd": 0.48, "model": "claude-sonnet-4-6" },
  ...
]
```

**GET /api/projects**
Returns token usage grouped by project path.
```json
[
  { "project": "C:/NAC/Python/projects/token_counter", "input": 120000, "output": 34000, "cost_usd": 2.10, "sessions": 8 },
  ...
]
```

**GET /api/ratelimits?days=7**
Returns rate-limit and wait events.
```json
[
  { "timestamp": "2026-05-03T14:22:00Z", "wait_seconds": 60, "project": "token_counter" },
  ...
]
```

**GET /api/sessions?limit=20**
Returns recent sessions.
```json
[
  { "id": 1, "started_at": "2026-05-03T13:00:00Z", "project": "token_counter", "model": "claude-sonnet-4-6", "input": 8200, "output": 2100, "cost_usd": 0.056 },
  ...
]
```

---

### Design requirements

- Dark background (#0f0f13), card surfaces (#1a1a24), accent color electric blue (#4f8ef7)
- Sidebar navigation: Dashboard | Projects | Rate Limits | Sessions | Settings
- **Dashboard page** — 3 summary cards (Today / Week / Month) showing tokens + estimated cost, then:
  - Area chart: daily input + output tokens over the last 30 days (two series, stacked)
  - Bar chart: estimated cost per day (last 30 days)
  - Small pill badge showing current model name
- **Projects page** — horizontal bar chart of cost per project, table below with columns: Project | Sessions | Input tokens | Output tokens | Est. cost
- **Rate Limits page** — timeline / scatter plot of rate-limit events over the last 7 days, with wait duration on Y axis
- **Sessions page** — paginated table of recent sessions with model badge, token counts, cost, timestamp
- **Settings page** — text input to change the API port (default 7842), toggle for dark/light mode
- Recharts for all charts
- Auto-refresh every 60 seconds
- If the API is unreachable, show a friendly banner: "Extension API offline — make sure the Token Tracker extension is running in VS Code with the server enabled."
- No auth required (localhost only)
- Use React + Tailwind + Recharts
- Keep all API calls in a single `api.ts` service file
- Pricing note footer: "Costs are retail API equivalents — for informational use only."

---

## Notes for regenerating

If you need to update the frontend later, re-paste this prompt into Lovable and describe what to change.
The API contract above is the source of truth — keep it in sync with `src/server.ts`.
