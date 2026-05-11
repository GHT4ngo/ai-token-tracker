import * as vscode from 'vscode';
import { queryTodayByProvider, queryProviderRisk } from './db';

let hexItem:         vscode.StatusBarItem;
let claudeItem:      vscode.StatusBarItem;
let claudeRiskItem:  vscode.StatusBarItem;
let codexItem:       vscode.StatusBarItem;
let codexRiskItem:   vscode.StatusBarItem;

function fmt(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}k`; }
  return String(n);
}

function riskColor(usedPercent: number): string {
  if (usedPercent >= 80) { return '#f87171'; }
  if (usedPercent >= 50) { return '#fbbf24'; }
  return '#34d399';
}

function riskTooltip(provider: string, usedPercent: number): string {
  const label = provider === 'codex' ? 'Codex' : 'Claude Code';
  const level = usedPercent >= 80 ? 'high' : usedPercent >= 50 ? 'watch' : 'healthy';
  return `${label} ~${usedPercent}% used — ${level}`;
}

export function createStatusBar(context: vscode.ExtensionContext): void {
  hexItem        = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 105);
  claudeItem     = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
  claudeRiskItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
  codexItem      = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  codexRiskItem  = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);

  for (const item of [hexItem, claudeItem, claudeRiskItem, codexItem, codexRiskItem]) {
    item.command = 'tokenTracker.showPanel';
  }

  hexItem.tooltip        = 'AI Token Tracker — click to open';
  claudeItem.tooltip     = 'Claude Code tokens today';
  codexItem.tooltip      = 'Codex tokens today';

  hexItem.color    = '#a78bfa';
  claudeItem.color = '#a78bfa';
  codexItem.color  = '#22d3ee';

  context.subscriptions.push(hexItem, claudeItem, claudeRiskItem, codexItem, codexRiskItem);
  refresh();
  hexItem.show();
}

export function refresh(): void {
  if (!hexItem) { return; }
  try {
    const today       = queryTodayByProvider();
    const claudeTotal = today.claude.input + today.claude.output;
    const codexTotal  = today.codex.input  + today.codex.output;
    const total       = claudeTotal + codexTotal;

    hexItem.text            = '⬡';
    hexItem.backgroundColor = undefined;
    hexItem.color           = '#a78bfa';

    if (total === 0) {
      claudeItem.hide();
      claudeRiskItem.hide();
      codexItem.hide();
      codexRiskItem.hide();
      return;
    }

    const risks       = queryProviderRisk(30);
    const claudeRisk  = risks.find(r => r.provider === 'claude');
    const codexRisk   = risks.find(r => r.provider === 'codex');

    if (claudeTotal > 0) {
      claudeItem.text = fmt(claudeTotal);
      claudeItem.show();

      const pct = claudeRisk?.used_percent ?? 0;
      claudeRiskItem.text    = '●';
      claudeRiskItem.color   = riskColor(pct);
      claudeRiskItem.tooltip = riskTooltip('claude', pct);
      claudeRiskItem.show();
    } else {
      claudeItem.hide();
      claudeRiskItem.hide();
    }

    if (codexTotal > 0) {
      codexItem.text = fmt(codexTotal);
      codexItem.show();

      const pct = codexRisk?.used_percent ?? 0;
      codexRiskItem.text    = '●';
      codexRiskItem.color   = riskColor(pct);
      codexRiskItem.tooltip = riskTooltip('codex', pct);
      codexRiskItem.show();
    } else {
      codexItem.hide();
      codexRiskItem.hide();
    }

  } catch {
    hexItem.text = '⬡';
    claudeItem.hide();
    claudeRiskItem.hide();
    codexItem.hide();
    codexRiskItem.hide();
  }
}

export function showRateLimitWarning(): void {
  if (!hexItem) { return; }
  hexItem.text            = '⬡ ⏸';
  hexItem.color           = undefined;
  hexItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  setTimeout(() => {
    hexItem.backgroundColor = undefined;
    hexItem.color           = '#a78bfa';
    refresh();
  }, 90_000);
}
