import * as http from 'http';
import express, { Request, Response } from 'express';
import cors from 'cors';
import {
  querySummary,
  queryLatestModel,
  queryDaily,
  queryProjects,
  queryRateLimits,
  querySessions,
} from './db';

let server: http.Server | null = null;

function startOfPeriod(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function startOfToday(): string {
  return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
}

function startOfWeek(): string  { return startOfPeriod(7); }
function startOfMonth(): string { return startOfPeriod(30); }

export function startServer(port: number): void {
  if (server) { return; }

  const app = express();
  app.use(cors({ origin: '*' }));

  app.get('/api/summary', (_req: Request, res: Response) => {
    const today = querySummary(startOfToday());
    const week  = querySummary(startOfWeek());
    const month = querySummary(startOfMonth());
    res.json({
      today: { input: today.input, output: today.output, cost_usd: today.cost_usd },
      week:  { input: week.input,  output: week.output,  cost_usd: week.cost_usd  },
      month: { input: month.input, output: month.output, cost_usd: month.cost_usd },
      model: queryLatestModel(),
    });
  });

  app.get('/api/daily', (req: Request, res: Response) => {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10), 1), 365);
    res.json(queryDaily(days));
  });

  app.get('/api/projects', (_req: Request, res: Response) => {
    res.json(queryProjects());
  });

  app.get('/api/ratelimits', (req: Request, res: Response) => {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '7'), 10), 1), 90);
    res.json(queryRateLimits(days));
  });

  app.get('/api/sessions', (req: Request, res: Response) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10), 1), 200);
    res.json(querySessions(limit));
  });

  // Health check used by the frontend offline banner
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  server = app.listen(port, '127.0.0.1', () => {
    console.log(`[TokenTracker] API server listening on http://localhost:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[TokenTracker] Port ${port} already in use — API server not started.`);
    }
  });
}

export function stopServer(): void {
  server?.close();
  server = null;
}
