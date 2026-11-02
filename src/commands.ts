import * as path from 'node:path';
import * as vscode from 'vscode';

import { renderScorecardMarkdown } from './assess/markdown';
import type { Observation, Scorecard } from './core/types';
import { ScorecardPanel } from './ui/scorecardPanel';
import { ChangeWatcher } from './watcher';
import { log } from './util/log';

const ACCEPTED_KEY = 'donna.acceptedFindings';
export const INFERRED_OVERRIDES_KEY = 'donna.inferredFindingOverrides';

export interface AssessmentCommandController {
  card?: Scorecard;
  runAssessment(options: { withModel?: boolean; reason: string }): Promise<void>;
}

export function registerAssessmentCommands(
  context: vscode.ExtensionContext,
  options: {
    repoRoot: string;
    controller: AssessmentCommandController;
    watcher: ChangeWatcher;
    acceptedIds: () => string[];
    inferredOverrides: () => Record<string, 'accepted' | 'dismissed'>;
  },
): void {
  const { repoRoot, controller, watcher } = options;
  const register = (name: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  register('donna.assess', () => controller.runAssessment({ reason: 'requested' }));
  register('donna.assessWithModel', () =>
    controller.runAssessment({ reason: 'requested with model pass', withModel: true }),
  );
  register('donna.refresh', () => controller.runAssessment({ reason: 'refresh' }));

  register('donna.openScorecard', () => {
    const panel = ScorecardPanel.show(repoRoot);
    panel.update({ card: controller.card });
    if (!controller.card) void controller.runAssessment({ reason: 'scorecard opened' });
  });

  register('donna.openFinding', async (file: string, line: number) => {
    try {
      const uri = vscode.Uri.file(path.resolve(repoRoot, file));
      const document = await vscode.workspace.openTextDocument(uri);
      const target = Math.max(0, (line ?? 1) - 1);
      const range = new vscode.Range(target, 0, target, 0);
      await vscode.window.showTextDocument(document, { selection: range, preview: true });
    } catch (error) {
      log.warn(`Could not open ${file}:${line} — ${(error as Error).message}`);
      void vscode.window.showWarningMessage(`Donna could not open ${file}.`);
    }
  });

  register('donna.copyAssessment', async () => {
    if (!controller.card) {
      void vscode.window.showInformationMessage('Donna: no assessment to copy yet.');
      return;
    }
    await vscode.env.clipboard.writeText(renderScorecardMarkdown(controller.card));
    void vscode.window.showInformationMessage('Donna: assessment copied as markdown.');
  });

  register('donna.toggleWatch', async () => {
    const config = vscode.workspace.getConfiguration('donna');
    const next = !config.get<boolean>('watch.enabled', true);
    await config.update('watch.enabled', next, vscode.ConfigurationTarget.Workspace);
    watcher.start();
    void vscode.window.showInformationMessage(
      `Donna: watch mode ${next ? 'on — assessing as your agent writes' : 'off'}.`,
    );
  });

  register('donna.acceptFinding', async (node: unknown) => {
    const observation = extractObservation(node);
    if (!observation) return;

    const choice = await vscode.window.showWarningMessage(
      `Accept "${observation.title}"? It will be hidden from future assessments in this workspace.`,
      { modal: true },
      'Accept',
    );
    if (choice !== 'Accept') return;

    await context.workspaceState.update(ACCEPTED_KEY, [
      ...options.acceptedIds(),
      observation.id,
    ]);
    log.info(`Accepted finding ${observation.id} (${observation.checkId}).`);
    await controller.runAssessment({ reason: 'finding accepted' });
  });

  register('donna.overrideInferredFinding', async (nodeOrId: unknown) => {
    const nodeObservation = extractObservation(nodeOrId);
    const id = typeof nodeOrId === 'string' ? nodeOrId : nodeObservation?.id;
    const observation =
      nodeObservation ??
      controller.card?.dimensions
        .flatMap((dimension) => dimension.observations)
        .find((item) => item.id === id);
    if (!observation?.inferred) {
      void vscode.window.showWarningMessage('Donna: this finding is not an inferred ADR finding.');
      return;
    }

    const current = options.inferredOverrides();
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: 'Accept inferred concern',
          description: 'Keep it visible, but do not let it block the verdict.',
          value: 'accepted' as const,
        },
        {
          label: 'Dismiss as a false positive',
          description: 'Keep it visible as dismissed, but do not let it affect the verdict.',
          value: 'dismissed' as const,
        },
        ...(current[observation.id]
          ? [{ label: 'Clear saved override', value: 'clear' as const }]
          : []),
      ],
      { title: `Override inferred finding: ${observation.title}`, ignoreFocusOut: true },
    );
    if (!selected) return;

    const updated = { ...current };
    if (selected.value === 'clear') delete updated[observation.id];
    else updated[observation.id] = selected.value;
    await context.workspaceState.update(INFERRED_OVERRIDES_KEY, updated);
    log.info(
      `Inferred finding ${observation.id}: ${selected.value === 'clear' ? 'override cleared' : `marked ${selected.value}`}.`,
    );
    await controller.runAssessment({ reason: 'inferred finding override changed' });
  });
}

function extractObservation(node: unknown): Observation | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = (node as { observation?: unknown }).observation;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const observation = candidate as Observation;
  return typeof observation.id === 'string' ? observation : undefined;
}