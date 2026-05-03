import * as vscode from 'vscode';
import { queryTodayTotals } from './db';

let item: vscode.StatusBarItem;

function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}k`; }
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) { return '<$0.01'; }
  return `$${usd.toFixed(2)}`;
}

function shortModel(model: string): string {
  // "claude-sonnet-4-6" → "sonnet-4-6"
  return model.replace(/^claude-/, '');
}

export function createStatusBar(context: vscode.ExtensionContext): void {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'tokenTracker.showPanel';
  item.tooltip = 'AI Token Tracker — click to open summary panel';
  context.subscriptions.push(item);
  refresh();
  item.show();
}

export function refresh(): void {
  if (!item) { return; }
  try {
    const t = queryTodayTotals();
    const total = t.input + t.output;
    item.text = `⬡ ${formatTokens(total)} ${formatCost(t.cost_usd)} ${shortModel(t.model)}`;
    item.backgroundColor = undefined;
  } catch {
    item.text = '⬡ Token Tracker';
  }
}

export function showRateLimitWarning(): void {
  if (!item) { return; }
  item.text = '⬡ ⏸ Rate limited';
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  setTimeout(() => refresh(), 90_000);
}
