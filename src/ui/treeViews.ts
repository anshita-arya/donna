import * as vscode from 'vscode';

import {
  DIMENSION_LABELS,
  ESCALATION_LABELS,
  VERDICT_LABELS,
  type ChecklistItem,
  type Dimension,
  type DimensionScore,
  type Observation,
  type ObservationStatus,
  type Scorecard,
} from '../core/types';

const ICON: Record<ObservationStatus, vscode.ThemeIcon> = {
  conflict: new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')),
  unknown: new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow')),
  attention: new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.blue')),
  pass: new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')),
};

// ---------------------------------------------------------------------------
// Assessment tree
// ---------------------------------------------------------------------------

type Node =
  | { kind: 'verdict'; card: Scorecard }
  | { kind: 'escalations'; card: Scorecard }
  | { kind: 'escalation'; index: number; card: Scorecard }
  | { kind: 'dimension'; dimension: Dimension; score: DimensionScore }
  | { kind: 'observation'; observation: Observation }
  | { kind: 'evidence'; observation: Observation; index: number }
  | { kind: 'action'; observation: Observation; index: number }
  | { kind: 'blindSpots'; card: Scorecard }
  | { kind: 'blindSpot'; text: string }
  | { kind: 'services'; card: Scorecard }
  | { kind: 'service'; index: number; card: Scorecard }
  | { kind: 'reviewers'; card: Scorecard }
  | { kind: 'reviewer'; index: number; card: Scorecard }
  | { kind: 'limits'; card: Scorecard }
  | { kind: 'limit'; text: string };

export class AssessmentTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private card: Scorecard | undefined;

  setCard(card: Scorecard | undefined): void {
    this.card = card;
    this.emitter.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    const card = this.card;
    if (!card) return [];

    if (!element) {
      const roots: Node[] = [{ kind: 'verdict', card }];
      if (card.escalations.length) roots.push({ kind: 'escalations', card });
      for (const score of card.dimensions) {
        if (score.observations.length === 0) continue;
        roots.push({ kind: 'dimension', dimension: score.dimension, score });
      }
      if (card.affectedServices.length) roots.push({ kind: 'services', card });
      if (card.reviewers.length) roots.push({ kind: 'reviewers', card });
      if (card.blindSpots.length) roots.push({ kind: 'blindSpots', card });
      roots.push({ kind: 'limits', card });
      return roots;
    }

    switch (element.kind) {
      case 'escalations':
        return element.card.escalations.map((_, index) => ({
          kind: 'escalation' as const,
          index,
          card: element.card,
        }));
      case 'dimension':
        return element.score.observations.map((observation) => ({
          kind: 'observation' as const,
          observation,
        }));
      case 'observation': {
        const children: Node[] = [];
        element.observation.requiredActions.forEach((_, index) =>
          children.push({ kind: 'action', observation: element.observation, index }),
        );
        element.observation.evidence.forEach((_, index) =>
          children.push({ kind: 'evidence', observation: element.observation, index }),
        );
        return children;
      }
      case 'blindSpots':
        return element.card.blindSpots.map((text) => ({ kind: 'blindSpot' as const, text }));
      case 'services':
        return element.card.affectedServices.map((_, index) => ({
          kind: 'service' as const,
          index,
          card: element.card,
        }));
      case 'reviewers':
        return element.card.reviewers.map((_, index) => ({
          kind: 'reviewer' as const,
          index,
          card: element.card,
        }));
      case 'limits':
        return element.card.limits.map((text) => ({ kind: 'limit' as const, text }));
      default:
        return [];
    }
  }

  getTreeItem(element: Node): vscode.TreeItem {
    const expanded = vscode.TreeItemCollapsibleState.Expanded;
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const none = vscode.TreeItemCollapsibleState.None;

    switch (element.kind) {
      case 'verdict': {
        const card = element.card;
        const item = new vscode.TreeItem(VERDICT_LABELS[card.verdict.value], none);
        item.description = `${card.change.files} file${card.change.files === 1 ? '' : 's'} · +${card.change.added}/-${card.change.removed}`;
        item.iconPath =
          card.verdict.value === 'ready-to-propose'
            ? ICON.pass
            : card.verdict.value === 'needs-revision'
              ? ICON.attention
              : ICON.conflict;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${VERDICT_LABELS[card.verdict.value]}**\n\n${card.verdict.rationale}`);
        if (card.contextPack?.synthetic) {
          tooltip.appendMarkdown(
            `\n\n_Assessed against the synthetic context pack "${card.contextPack.name}"._`,
          );
        }
        item.tooltip = tooltip;
        item.command = { command: 'donna.openScorecard', title: 'Open scorecard' };
        item.contextValue = 'verdict';
        return item;
      }

      case 'escalations': {
        const item = new vscode.TreeItem('Escalations', expanded);
        item.description = String(element.card.escalations.length);
        item.iconPath = new vscode.ThemeIcon('arrow-up');
        item.contextValue = 'escalations';
        return item;
      }

      case 'escalation': {
        const escalation = element.card.escalations[element.index];
        const item = new vscode.TreeItem(ESCALATION_LABELS[escalation.reason], none);
        item.description = escalation.owners.join(', ');
        item.tooltip = new vscode.MarkdownString(
          `${escalation.detail}\n\n${escalation.owners.length ? `Route to: ${escalation.owners.join(', ')}` : 'No owner recorded.'}`,
        );
        item.iconPath = ICON.conflict;
        return item;
      }

      case 'dimension': {
        const item = new vscode.TreeItem(
          DIMENSION_LABELS[element.dimension],
          element.score.status === 'pass' ? collapsed : expanded,
        );
        const counts = element.score.observations.reduce(
          (acc, o) => {
            acc[o.status]++;
            return acc;
          },
          { conflict: 0, unknown: 0, attention: 0, pass: 0 } as Record<ObservationStatus, number>,
        );
        const bits: string[] = [];
        if (counts.conflict) bits.push(`${counts.conflict} conflict`);
        if (counts.unknown) bits.push(`${counts.unknown} unchecked`);
        if (counts.attention) bits.push(`${counts.attention} to note`);
        if (!bits.length) bits.push('clear');
        item.description = bits.join(', ');
        item.iconPath = ICON[element.score.status];
        item.tooltip = element.score.summary;
        item.contextValue = 'dimension';
        return item;
      }

      case 'observation': {
        const observation = element.observation;
        const hasChildren =
          observation.requiredActions.length + observation.evidence.length > 0;
        const item = new vscode.TreeItem(
          observation.title,
          hasChildren
            ? observation.status === 'conflict'
              ? expanded
              : collapsed
            : none,
        );
        item.id = observation.id;
        item.iconPath = ICON[observation.status];
        item.description = [
          observation.source === 'model' ? 'model' : undefined,
          observation.confidence !== 'high' ? `${observation.confidence} confidence` : undefined,
          observation.location
            ? `${observation.location.file.split('/').pop()}:${observation.location.line}`
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ');

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${observation.title}**\n\n${observation.detail}\n\n`);
        tooltip.appendMarkdown(`*Check:* \`${observation.checkId}\`\n\n`);
        tooltip.appendMarkdown(`*Confidence:* ${observation.confidence}\n\n`);
        if (observation.escalate) {
          tooltip.appendMarkdown(`*Escalates:* ${ESCALATION_LABELS[observation.escalate]}\n\n`);
        }
        if (observation.owners.length) {
          tooltip.appendMarkdown(`*Owners:* ${observation.owners.join(', ')}`);
        }
        item.tooltip = tooltip;

        if (observation.location) {
          item.command = {
            command: 'donna.openFinding',
            title: 'Go to finding',
            arguments: [observation.location.file, observation.location.line],
          };
        }

        item.contextValue = [
          'observation',
          observation.location ? 'locatable' : '',
          observation.status,
        ]
          .filter(Boolean)
          .join(' ');
        return item;
      }

      case 'action': {
        const text = element.observation.requiredActions[element.index];
        const item = new vscode.TreeItem(text, none);
        item.iconPath = new vscode.ThemeIcon('circle-large-outline');
        item.tooltip = text;
        return item;
      }

      case 'evidence': {
        const evidence = element.observation.evidence[element.index];
        const label = `${evidence.ref}${evidence.line ? `:${evidence.line}` : ''}`;
        const item = new vscode.TreeItem(label, none);
        item.description = evidence.note ?? evidence.kind;
        item.iconPath = new vscode.ThemeIcon(
          evidence.kind === 'adr'
            ? 'book'
            : evidence.kind === 'diff'
              ? 'diff'
              : evidence.kind === 'graph'
                ? 'type-hierarchy'
                : evidence.kind === 'tests'
                  ? 'beaker'
                  : evidence.kind === 'ownership'
                    ? 'organization'
                    : 'link',
        );
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${evidence.kind}** — ${evidence.ref}\n\n`);
        if (evidence.excerpt) tooltip.appendCodeblock(evidence.excerpt, 'text');
        if (evidence.note) tooltip.appendMarkdown(`\n${evidence.note}`);
        item.tooltip = tooltip;

        if ((evidence.kind === 'diff' || evidence.kind === 'graph' || evidence.kind === 'tests') && /[./]/.test(evidence.ref) && !evidence.ref.includes('*')) {
          item.command = {
            command: 'donna.openFinding',
            title: 'Go to evidence',
            arguments: [evidence.ref, evidence.line ?? 1],
          };
          item.contextValue = 'evidence locatable';
        } else {
          item.contextValue = 'evidence';
        }
        return item;
      }

      case 'blindSpots': {
        const item = new vscode.TreeItem('What this did not check', collapsed);
        item.description = String(element.card.blindSpots.length);
        item.iconPath = new vscode.ThemeIcon('eye-closed');
        item.tooltip =
          'Gaps in the assessment itself. These are not findings — they are the parts Donna could not verify.';
        return item;
      }

      case 'blindSpot': {
        const item = new vscode.TreeItem(element.text, none);
        item.tooltip = element.text;
        item.iconPath = new vscode.ThemeIcon('circle-outline');
        return item;
      }

      case 'services': {
        const item = new vscode.TreeItem('Affected services', collapsed);
        item.description = String(element.card.affectedServices.length);
        item.iconPath = new vscode.ThemeIcon('server-process');
        return item;
      }

      case 'service': {
        const service = element.card.affectedServices[element.index];
        const item = new vscode.TreeItem(service.service, none);
        item.description = `${service.reach} · ${service.modules.length} module${service.modules.length === 1 ? '' : 's'}`;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${service.service}** (${service.reach})\n\n`);
        if (service.via) tooltip.appendMarkdown(`${service.via}\n\n`);
        tooltip.appendMarkdown(`Owners: ${service.owners.join(', ') || 'unrecorded'}\n\n`);
        tooltip.appendMarkdown(
          service.modules.slice(0, 12).map((m) => `- \`${m}\``).join('\n') +
            (service.modules.length > 12 ? `\n- +${service.modules.length - 12} more` : ''),
        );
        item.tooltip = tooltip;
        item.iconPath = new vscode.ThemeIcon(
          service.reach === 'direct' ? 'circle-filled' : 'circle',
        );
        return item;
      }

      case 'reviewers': {
        const item = new vscode.TreeItem('Reviewers', collapsed);
        const required = element.card.reviewers.filter((r) => r.weight === 'required').length;
        item.description = `${required} required, ${element.card.reviewers.length - required} suggested`;
        item.iconPath = new vscode.ThemeIcon('organization');
        item.tooltip =
          'Read from ownership records and CODEOWNERS. Donna does not assign ownership and does not infer it from git history.';
        return item;
      }

      case 'reviewer': {
        const reviewer = element.card.reviewers[element.index];
        const item = new vscode.TreeItem(reviewer.handle, none);
        item.description = reviewer.weight;
        item.tooltip = new vscode.MarkdownString(`**${reviewer.handle}** — ${reviewer.reason}`);
        item.iconPath = new vscode.ThemeIcon(
          reviewer.weight === 'required' ? 'person-filled' : 'person',
        );
        return item;
      }

      case 'limits': {
        const item = new vscode.TreeItem('What this agent does not do', collapsed);
        item.iconPath = new vscode.ThemeIcon('shield');
        item.tooltip =
          'Enforced in code, not just stated: the guardrail module rejects edits to design records, ownership, config, test expectations and CI.';
        return item;
      }

      case 'limit': {
        const item = new vscode.TreeItem(element.text, none);
        item.tooltip = element.text;
        item.iconPath = new vscode.ThemeIcon('circle-slash');
        return item;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Checklist tree
// ---------------------------------------------------------------------------

type ChecklistNode =
  | { kind: 'group'; label: string; blocking: boolean; items: ChecklistItem[] }
  | { kind: 'item'; item: ChecklistItem };

export class ChecklistTreeProvider implements vscode.TreeDataProvider<ChecklistNode> {
  private readonly emitter = new vscode.EventEmitter<ChecklistNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private items: ChecklistItem[] = [];

  setCard(card: Scorecard | undefined): void {
    this.items = card?.checklist ?? [];
    this.emitter.fire(undefined);
  }

  getChildren(element?: ChecklistNode): ChecklistNode[] {
    if (!element) {
      const blocking = this.items.filter((i) => i.blocking);
      const optional = this.items.filter((i) => !i.blocking);
      const groups: ChecklistNode[] = [];
      if (blocking.length) {
        groups.push({
          kind: 'group',
          label: 'Resolve before opening a PR',
          blocking: true,
          items: blocking,
        });
      }
      if (optional.length) {
        groups.push({
          kind: 'group',
          label: 'Say in the PR description',
          blocking: false,
          items: optional,
        });
      }
      return groups;
    }
    if (element.kind === 'group') {
      return element.items.map((item) => ({ kind: 'item' as const, item }));
    }
    return [];
  }

  getTreeItem(element: ChecklistNode): vscode.TreeItem {
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = String(element.items.length);
      item.iconPath = new vscode.ThemeIcon(element.blocking ? 'error' : 'info');
      return item;
    }

    const item = new vscode.TreeItem(element.item.text, vscode.TreeItemCollapsibleState.None);
    item.id = element.item.id;
    item.iconPath = new vscode.ThemeIcon(
      element.item.blocking ? 'circle-large-outline' : 'circle-outline',
    );
    item.description = [
      DIMENSION_LABELS[element.item.dimension],
      element.item.owners.length ? element.item.owners.join(', ') : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(
      `${element.item.text}\n\n*${DIMENSION_LABELS[element.item.dimension]}*${element.item.owners.length ? ` · ${element.item.owners.join(', ')}` : ''}`,
    );
    item.contextValue = 'checklistItem';
    return item;
  }
}
