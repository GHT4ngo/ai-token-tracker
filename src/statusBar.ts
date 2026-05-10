import * as vscode from 'vscode';
import { queryTodayByProvider, queryProviderRisk } from './db';

let hexItem:    vscode.StatusBarItem;
let claudeItem: vscode.StatusBarItem;
let codexItem:  vscode.StatusBarItem;
let riskItem:   vscode.StatusBarItem;

function fmt(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}k`; }
  return String(n);
}

export function createStatusBar(context: vscode.ExtensionContext): void {
  hexItem    = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
  claudeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  codexItem  = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  riskItem   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  hexItem.command    = 'tokenTracker.showPanel';
  claudeItem.command = 'tokenTracker.showPanel';
  codexItem.command  = 'tokenTracker.showPanel';
  riskItem.command   = 'tokenTracker.showPanel';

  hexItem.tooltip    = 'AI Token Tracker — click to open';
  claudeItem.tooltip = 'Claude Code tokens today';
  codexItem.tooltip  = 'Codex tokens today';

  hexItem.color    = '#a78bfa';
  claudeItem.color = '#a78bfa';
  codexItem.color  = '#22d3ee';

  context.subscriptions.push(hexItem, claudeItem, codexItem, riskItem);
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

    hexItem.text = '⬡';
    hexItem.backgroundColor = undefined;
    hexItem.color = '#a78bfa';

    if (total === 0) {
      claudeItem.hide();
      codexItem.hide();
      riskItem.hide();
      return;
    }

    if (claudeTotal > 0) {
      claudeItem.text = fmt(claudeTotal);
      claudeItem.show();
    } else {
      claudeItem.hide();
    }

    if (codexTotal > 0) {
      codexItem.text = fmt(codexTotal);
      codexItem.show();
    } else {
      codexItem.hide();
    }

    const risks   = queryProviderRisk(30);
    const maxUsed = risks.length > 0 ? Math.max(...risks.map(r => r.used_percent)) : 0;

    if (maxUsed >= 80) {
      riskItem.text    = '●';
      riskItem.color   = '#f87171';
      riskItem.tooltip = `Estimated usage ~${maxUsed}% — high, consider pausing`;
    } else if (maxUsed >= 50) {
      riskItem.text    = '●';
      riskItem.color   = '#fbbf24';
      riskItem.tooltip = `Estimated usage ~${maxUsed}% — watch`;
    } else {
      riskItem.text    = '●';
      riskItem.color   = '#34d399';
      riskItem.tooltip = `Estimated usage ~${maxUsed}% — healthy`;
    }
    riskItem.show();

  } catch {
    hexItem.text = '⬡';
    claudeItem.hide();
    codexItem.hide();
    riskItem.hide();
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
