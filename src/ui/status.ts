import * as vscode from 'vscode';

import { VERDICT_LABELS, type Scorecard } from '../core/types';

/**
 * The status bar item.
 *
 * This is the only part of Donna a developer sees when they are not looking
 * for it, so it carries exactly one thing: whether the current change is safe
 * to propose. The verdict word is spelled out rather than reduced to a colour,
 * because a coloured dot that means "escalate to design review" is a dot people
 * learn to ignore.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'donna.openScorecard';
    this.setIdle();
    this.item.show();
  }

  setIdle(message = 'no assessment yet'): void {
    this.item.text = `$(telescope) Donna: ${message}`;
    this.item.tooltip = 'Run Donna: Assess Current Change';
    this.item.backgroundColor = undefined;
  }

  setWorking(what: string): void {
    this.item.text = `$(sync~spin) Donna: ${what}`;
    this.item.tooltip = what;
    this.item.backgroundColor = undefined;
  }

  setQueued(): void {
    this.item.text = `$(watch) Donna: waiting for writes to settle`;
    this.item.tooltip =
      'The agent is still writing. Donna assesses once the burst of file changes stops.';
    this.item.backgroundColor = undefined;
  }

  setResult(card: Scorecard): void {
    const conflicts = card.dimensions
      .flatMap((d) => d.observations)
      .filter((o) => o.status === 'conflict').length;
    const unknowns = card.dimensions
      .flatMap((d) => d.observations)
      .filter((o) => o.status === 'unknown').length;

    const icon =
      card.verdict.value === 'ready-to-propose'
        ? '$(pass)'
        : card.verdict.value === 'needs-revision'
          ? '$(warning)'
          : '$(error)';

    const counts: string[] = [];
    if (conflicts) counts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
    if (unknowns) counts.push(`${unknowns} unchecked`);

    this.item.text = `${icon} Donna: ${VERDICT_LABELS[card.verdict.value]}${counts.length ? ` (${counts.join(', ')})` : ''}`;

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${VERDICT_LABELS[card.verdict.value]}**\n\n`);
    tooltip.appendMarkdown(`${card.verdict.rationale}\n\n`);
    tooltip.appendMarkdown(
      `${card.change.files} file${card.change.files === 1 ? '' : 's'} changed, +${card.change.added}/-${card.change.removed}\n\n`,
    );
    if (card.escalations.length) {
      tooltip.appendMarkdown(`Escalations: ${card.escalations.length}\n\n`);
    }
    tooltip.appendMarkdown(`_Click to open the scorecard._`);
    this.item.tooltip = tooltip;

    this.item.backgroundColor =
      card.verdict.value === 'escalate-to-design-review'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : card.verdict.value === 'needs-revision'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  }

  setError(message: string): void {
    this.item.text = `$(error) Donna: ${message}`;
    this.item.tooltip = 'Run Donna: Show Log for details.';
    this.item.command = 'donna.showLog';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
