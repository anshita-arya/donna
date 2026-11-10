import * as fs from 'node:fs';
import * as vscode from 'vscode';

import type { Scorecard } from './core/types';
import { connectIntegrations } from './integrations/mcp';
import { runDesignReview } from './agents/designReview';
import { resolveEditTarget, validateEditAgainstFile } from './agents/guardrails';
import { ModelUnavailableError } from './agents/model';
import { DiagnosticsPublisher } from './ui/diagnostics';
import { ScorecardPanel } from './ui/scorecardPanel';
import { StatusBar } from './ui/status';
import { AssessmentTreeProvider, ChecklistTreeProvider } from './ui/treeViews';
import { ChangeWatcher } from './watcher';
import { log } from './util/log';
import {
  ANTHROPIC_API_KEY_SECRET,
  AssessmentController,
  createModelClient,
} from './assessmentController';
import { INFERRED_OVERRIDES_KEY, registerAssessmentCommands } from './commands';

const ACCEPTED_KEY = 'donna.acceptedFindings';

export function activate(context: vscode.ExtensionContext): void {
  const channel = log.init();
  context.subscriptions.push(channel);
  log.info('Donna activated.');

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    log.warn('No workspace folder open; Donna is idle.');
    return;
  }

  const repoRoot = folder.uri.fsPath;

  const status = new StatusBar();
  const diagnostics = new DiagnosticsPublisher(repoRoot);
  const assessmentTree = new AssessmentTreeProvider();
  const checklistTree = new ChecklistTreeProvider();

  const assessmentView = vscode.window.createTreeView('donna.assessment', {
    treeDataProvider: assessmentTree,
    showCollapseAll: true,
  });
  const checklistView = vscode.window.createTreeView('donna.checklist', {
    treeDataProvider: checklistTree,
  });

  context.subscriptions.push(status, diagnostics, assessmentView, checklistView);

  // -------------------------------------------------------------------------
  // Assessment
  // -------------------------------------------------------------------------

  const acceptedIds = (): string[] => context.workspaceState.get<string[]>(ACCEPTED_KEY, []);
  const inferredOverrides = (): Record<string, 'accepted' | 'dismissed'> => {
    const stored = context.workspaceState.get<Record<string, unknown>>(INFERRED_OVERRIDES_KEY, {});
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, 'accepted' | 'dismissed'] =>
          entry[1] === 'accepted' || entry[1] === 'dismissed',
      ),
    );
  };

  const controller = new AssessmentController({
    context,
    repoRoot,
    status,
    acceptedIds,
    inferredOverrides,
    publish,
  });
  const runAssessment = (options: { withModel?: boolean; reason: string }) =>
    controller.runAssessment(options);

  function publish(card: Scorecard): void {
    status.setResult(card);
    assessmentTree.setCard(card);
    checklistTree.setCard(card);
    diagnostics.publish(card);

    const blocking = card.checklist.filter((c) => c.blocking).length;
    checklistView.badge = blocking
      ? { value: blocking, tooltip: `${blocking} blocking item${blocking === 1 ? '' : 's'}` }
      : undefined;
    assessmentView.message = card.contextPack?.synthetic
      ? `Assessed against the synthetic pack "${card.contextPack.name}".`
      : undefined;

    ScorecardPanel.existing?.update({ card, busy: undefined, error: undefined });
  }

  // -------------------------------------------------------------------------
  // Watcher
  // -------------------------------------------------------------------------

  const watcher = new ChangeWatcher(
    async (reason) => {
      await runAssessment({ reason });
    },
    () =>
      context.workspaceState.get<boolean>('donna.watch.enabled') ??
      vscode.workspace.getConfiguration('donna').get<boolean>('watch.enabled', true),
  );
  context.subscriptions.push(watcher);
  watcher.start();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('donna.watch')) watcher.start();
      if (
        event.affectsConfiguration('donna.baseRef')
      ) {
        void runAssessment({ reason: 'configuration changed' });
      }
    }),
  );

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  const register = (name: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  registerAssessmentCommands(context, {
    repoRoot,
    controller,
    watcher,
    acceptedIds,
    inferredOverrides,
  });

  register('donna.connectIntegrations', async () => {
    const results = await connectIntegrations(context);
    const message = results.length ? results.join('\n') : 'No integrations were connected.';
    void vscode.window.showInformationMessage(`Donna integrations:\n${message}`);
  });

  register('donna.showLog', () => log.show());

  register('donna.setApiKey', async () => {
    const key = await vscode.window.showInputBox({
      title: 'Anthropic API key',
      prompt: 'Stored in VS Code secret storage, not in your settings or your repo.',
      password: true,
      placeHolder: 'sk-ant-…',
    });
    if (!key) return;
    await context.secrets.store(ANTHROPIC_API_KEY_SECRET, key.trim());
    void vscode.window.showInformationMessage('Donna: API key stored.');
  });

  register('donna.clearApiKey', async () => {
    await context.secrets.delete(ANTHROPIC_API_KEY_SECRET);
    void vscode.window.showInformationMessage('Donna: API key cleared.');
  });

  // --- Design-review agent ---------------------------------------------------

  register('donna.requestDesignReview', async () => {
    if (!controller.card || !controller.prepared) {
      void vscode.window.showInformationMessage('Donna: run an assessment first.');
      return;
    }
    const conflicts = controller.card.dimensions
      .flatMap((d) => d.observations)
      .filter((o) => o.status === 'conflict' || o.status === 'unknown');

    if (conflicts.length === 0) {
      void vscode.window.showInformationMessage(
        'Donna: nothing to revise — no conflicts or unchecked findings.',
      );
      return;
    }

    const panel = ScorecardPanel.show(repoRoot);
    panel.update({ card: controller.card, busy: 'Design-review agent is preparing a revision…' });

    try {
      const config = vscode.workspace.getConfiguration('donna');
      const client = await createModelClient(context);
      const prepared = controller.prepared;

      const result = await runDesignReview({
        client,
        scorecard: controller.card,
        change: prepared.input.change,
        adrs: prepared.input.adrs,
        config: prepared.input.config,
        readFile: prepared.input.readFile,
        maxFiles: config.get<number>('llm.maxFilesPerReview', 8),
      });

      if (!result.request) {
        panel.update({ busy: undefined, error: result.error ?? 'The design-review agent returned nothing.' });
        return;
      }

      controller.proposedEdits = result.applicableEdits;

      if (result.violations.length) {
        log.warn(
          `Design-review agent proposed ${result.violations.length} edit(s) the guardrails rejected: ${result.violations.map((v) => v.path).join(', ')}`,
        );
      }

      panel.update({
        busy: undefined,
        changeRequest: {
          request: result.request,
          applicable: result.applicableEdits,
          violations: result.violations,
          unapplicable: result.unapplicable,
          provider: result.provider,
          model: result.model,
        },
      });
    } catch (error) {
      const message =
        error instanceof ModelUnavailableError
          ? `${error.message}${error.hint ? ` ${error.hint}` : ''}`
          : (error as Error).message;
      log.error('Design review failed', error);
      panel.update({ busy: undefined, error: message });
    }
  });

  /**
   * Applies one proposed edit — and only on an explicit click, after showing
   * the developer exactly what will change. The agent never reaches this code
   * path; the webview does, in response to a human.
   */
  register('donna.applyProposedEdit', async (indexRaw: string) => {
    const index = Number(indexRaw);
    const edit = controller.proposedEdits[index];
    if (!edit) return;

    // Re-check at apply time rather than trusting the review: a symlink can
    // change between the two, and the write must land where the check looked.
    const config = controller.prepared?.input.config;
    if (!config) {
      void vscode.window.showWarningMessage('Donna: re-run the assessment before applying a proposed edit.');
      return;
    }
    const target = resolveEditTarget(edit.file, config);
    if (!target.ok) {
      void vscode.window.showErrorMessage(`Donna: refused to apply the edit to ${edit.file}. ${target.detail}`);
      log.warn(`Refused proposed edit to ${edit.file}: ${target.rule}`);
      return;
    }
    const abs = target.abs;
    let current: string;
    try {
      current = fs.readFileSync(abs, 'utf8');
    } catch (error) {
      void vscode.window.showErrorMessage(`Donna: could not read ${edit.file}.`);
      log.error(`Reading ${edit.file} failed`, error);
      return;
    }

    const check = validateEditAgainstFile(edit, current);
    if (!check.ok) {
      void vscode.window.showWarningMessage(`Donna: ${check.reason}`);
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Apply the proposed edit to ${edit.file}?`,
      {
        modal: true,
        detail: `This replaces:\n\n${edit.find.slice(0, 400)}\n\nwith:\n\n${edit.replace.slice(0, 400)}`,
      },
      'Apply',
    );
    if (choice !== 'Apply') return;

    fs.writeFileSync(abs, current.replace(edit.find, edit.replace), 'utf8');
    log.info(`Applied proposed edit to ${edit.file} (developer-confirmed).`);
    void vscode.window.showInformationMessage(
      `Donna: applied the edit to ${edit.file}. Re-assessing.`,
    );
    await runAssessment({ reason: 'proposed edit applied' });
  });

  // Kick off a first assessment so the views are not empty on open.
  void runAssessment({ reason: 'startup' });
}

export function deactivate(): void {
  log.info('Donna deactivated.');
}
