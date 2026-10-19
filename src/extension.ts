import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { assess } from './assess/scorecard';
import { renderScorecardMarkdown } from './assess/markdown';
import { prepareAssessment, type PreparedAssessment } from './core/workspace';
import { scaffoldConfig } from './core/config';
import type { Observation, Scorecard } from './core/types';
import { runImpactPass } from './agents/impact';
import { collectExternalContext, connectIntegrations } from './integrations/mcp';
import { runDesignReview } from './agents/designReview';
import { validateEditAgainstFile, type SuggestedEdit } from './agents/guardrails';
import { AnthropicClient, ModelUnavailableError, type ModelClient } from './agents/model';
import { VsCodeModelClient } from './agents/vscodeModel';
import {
  applyScenario,
  loadScenarios,
  revertScenario,
  type AppliedScenario,
} from './agents/codingStandIn';
import { DiagnosticsPublisher } from './ui/diagnostics';
import { ScorecardPanel } from './ui/scorecardPanel';
import { StatusBar } from './ui/status';
import { AssessmentTreeProvider, ChecklistTreeProvider } from './ui/treeViews';
import { ChangeWatcher } from './watcher';
import { log } from './util/log';

const ACCEPTED_KEY = 'donna.acceptedFindings';
const SECRET_KEY = 'donna.anthropicApiKey';

interface Session {
  repoRoot: string;
  card?: Scorecard;
  prepared?: PreparedAssessment;
  proposedEdits: SuggestedEdit[];
  demo?: AppliedScenario;
  running: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = log.init();
  context.subscriptions.push(channel);
  log.info('Donna activated.');

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    log.warn('No workspace folder open; Donna is idle.');
    return;
  }

  const session: Session = {
    repoRoot: folder.uri.fsPath,
    proposedEdits: [],
    running: false,
  };

  const status = new StatusBar();
  const diagnostics = new DiagnosticsPublisher(session.repoRoot);
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

  async function modelClient(): Promise<ModelClient> {
    const config = vscode.workspace.getConfiguration('donna');
    const provider = config.get<string>('llm.provider', 'vscode');

    if (provider === 'anthropic') {
      const key = await context.secrets.get(SECRET_KEY);
      if (!key) {
        throw new ModelUnavailableError(
          'No Anthropic API key is stored.',
          'Run "Donna: Set Anthropic API Key", or switch the provider to "vscode".',
        );
      }
      return new AnthropicClient(key, config.get<string>('llm.anthropicModel', 'claude-sonnet-4-5'));
    }

    return VsCodeModelClient.create(config.get<string>('llm.vscodeModel', '') || undefined);
  }

  async function runAssessment(options: { withModel?: boolean; reason: string }): Promise<void> {
    if (session.running) {
      log.info(`Skipping assessment (${options.reason}) — one is already running.`);
      return;
    }
    session.running = true;
    const started = Date.now();

    try {
      status.setWorking('assessing');
      ScorecardPanel.existing?.update({ busy: 'Assessing the current change…', error: undefined });
      log.info(`Assessing: ${options.reason}`);

      const config = vscode.workspace.getConfiguration('donna');
      const packSetting = config.get<string>('contextPack', '').trim();
      const packDir = packSetting
        ? path.isAbsolute(packSetting)
          ? packSetting
          : path.resolve(session.repoRoot, packSetting)
        : undefined;
      const baseRef = config.get<string>('baseRef', '').trim() || undefined;

      const prepared = prepareAssessment({ repoRoot: session.repoRoot, packDir, baseRef });
      session.prepared = prepared;

      // Findings the developer has explicitly accepted are suppressed. These
      // live in workspace state rather than in donna.json, so that
      // accepting a finding never looks like the tool editing its own config.
      prepared.input.config.accepted = [
        ...prepared.input.config.accepted,
        ...acceptedIds(),
      ];

      if (prepared.input.change.files.length === 0) {
        const empty = assess(prepared.input, {
          maxDepth: config.get<number>('blastRadiusDepth', 3),
          loadIssues: prepared.loadIssues,
          adrFiles: prepared.adrFiles,
          testExpectations: prepared.testExpectations,
          modelPass: { ran: false, skippedBecause: 'there is nothing to assess' },
        });
        publish(empty);
        status.setIdle('no changes against the base ref');
        return;
      }

      // Deterministic pass first, always. The model pass is additive and never
      // gates the result — if it fails, the assessment still stands.
      let card = assess(prepared.input, {
        maxDepth: config.get<number>('blastRadiusDepth', 3),
        loadIssues: prepared.loadIssues,
        adrFiles: prepared.adrFiles,
        testExpectations: prepared.testExpectations,
        modelPass: { ran: false, skippedBecause: 'not requested for this run' },
      });

      const trigger = config.get<string>('llm.trigger', 'onConflict');
      const llmEnabled = config.get<boolean>('llm.enabled', true);
      const hasSomethingToJudge = card.dimensions
        .flatMap((d) => d.observations)
        .some((o) => o.status === 'conflict' || o.status === 'unknown');

      const wantModel =
        llmEnabled &&
        (options.withModel ||
          trigger === 'everyAssessment' ||
          (trigger === 'onConflict' && hasSomethingToJudge));

      if (wantModel) {
        publish(card); // show deterministic findings immediately
        status.setWorking('model pass');
        ScorecardPanel.existing?.update({ busy: 'Running the model pass…' });

        try {
          const client = await modelClient();
          const manualRun = ['requested', 'requested with model pass', 'scorecard opened'].includes(
            options.reason,
          );
          const external = await collectExternalContext(prepared.input.change, context, manualRun);
          const pass = await runImpactPass({
            client,
            change: prepared.input.change,
            adrs: prepared.input.adrs,
            config: prepared.input.config,
            staticObservations: card.dimensions.flatMap((d) => d.observations),
            maxFiles: config.get<number>('llm.maxFilesPerReview', 8),
            externalContext: external.context,
          });

          card = assess(prepared.input, {
            maxDepth: config.get<number>('blastRadiusDepth', 3),
            loadIssues: [...prepared.loadIssues, ...external.notes, ...pass.notes],
            adrFiles: prepared.adrFiles,
            testExpectations: prepared.testExpectations,
            modelObservations: pass.observations,
            modelPass: pass.modelPass,
          });
          log.info(
            `Model pass: ${pass.modelPass.ran ? `${pass.observations.length} observations` : `skipped — ${pass.modelPass.skippedBecause}`}`,
          );
        } catch (error) {
          const message =
            error instanceof ModelUnavailableError
              ? `${error.message}${error.hint ? ` ${error.hint}` : ''}`
              : (error as Error).message;
          log.warn(`Model pass unavailable: ${message}`);
          card = assess(prepared.input, {
            maxDepth: config.get<number>('blastRadiusDepth', 3),
            loadIssues: prepared.loadIssues,
            adrFiles: prepared.adrFiles,
            testExpectations: prepared.testExpectations,
            modelPass: { ran: false, skippedBecause: message },
          });
        }
      }

      publish(card);
      log.timing('Assessment', started);
    } catch (error) {
      log.error('Assessment failed', error);
      status.setError('assessment failed');
      ScorecardPanel.existing?.update({
        busy: undefined,
        error: (error as Error).message,
      });
    } finally {
      session.running = false;
    }
  }

  function publish(card: Scorecard): void {
    session.card = card;
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

  const watcher = new ChangeWatcher(async (reason) => {
    await runAssessment({ reason });
  });
  context.subscriptions.push(watcher);
  watcher.start();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('donna.watch')) watcher.start();
      if (
        event.affectsConfiguration('donna.contextPack') ||
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

  register('donna.assess', () => runAssessment({ reason: 'requested' }));

  register('donna.assessWithModel', () =>
    runAssessment({ reason: 'requested with model pass', withModel: true }),
  );

  register('donna.refresh', () => runAssessment({ reason: 'refresh' }));

  register('donna.connectIntegrations', async () => {
    const results = await connectIntegrations(context);
    const message = results.length ? results.join('\n') : 'No integrations were connected.';
    void vscode.window.showInformationMessage(`Donna integrations:\n${message}`);
  });

  register('donna.showLog', () => log.show());

  register('donna.openScorecard', () => {
    const panel = ScorecardPanel.show(session.repoRoot);
    panel.update({ card: session.card });
    if (!session.card) void runAssessment({ reason: 'scorecard opened' });
  });

  register('donna.openFinding', async (file: string, line: number) => {
    try {
      const uri = vscode.Uri.file(path.resolve(session.repoRoot, file));
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
    if (!session.card) {
      void vscode.window.showInformationMessage('Donna: no assessment to copy yet.');
      return;
    }
    await vscode.env.clipboard.writeText(renderScorecardMarkdown(session.card));
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

    await context.workspaceState.update(ACCEPTED_KEY, [...acceptedIds(), observation.id]);
    log.info(`Accepted finding ${observation.id} (${observation.checkId}).`);
    await runAssessment({ reason: 'finding accepted' });
  });

  register('donna.initConfig', async () => {
    const target = path.join(session.repoRoot, 'donna.json');
    if (fs.existsSync(target)) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(document);
      return;
    }
    fs.writeFileSync(target, scaffoldConfig(), 'utf8');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document);
    void vscode.window.showInformationMessage(
      'Donna: starter config created. Fill in your services, ADR directory and ownership, then re-assess.',
    );
  });

  register('donna.setApiKey', async () => {
    const key = await vscode.window.showInputBox({
      title: 'Anthropic API key',
      prompt: 'Stored in VS Code secret storage, not in your settings or your repo.',
      password: true,
      placeHolder: 'sk-ant-…',
    });
    if (!key) return;
    await context.secrets.store(SECRET_KEY, key.trim());
    void vscode.window.showInformationMessage('Donna: API key stored.');
  });

  register('donna.clearApiKey', async () => {
    await context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('Donna: API key cleared.');
  });

  // --- Design-review agent ---------------------------------------------------

  register('donna.requestDesignReview', async () => {
    if (!session.card || !session.prepared) {
      void vscode.window.showInformationMessage('Donna: run an assessment first.');
      return;
    }
    const conflicts = session.card.dimensions
      .flatMap((d) => d.observations)
      .filter((o) => o.status === 'conflict' || o.status === 'unknown');

    if (conflicts.length === 0) {
      void vscode.window.showInformationMessage(
        'Donna: nothing to revise — no conflicts or unchecked findings.',
      );
      return;
    }

    const panel = ScorecardPanel.show(session.repoRoot);
    panel.update({ card: session.card, busy: 'Design-review agent is preparing a revision…' });

    try {
      const config = vscode.workspace.getConfiguration('donna');
      const client = await modelClient();
      const prepared = session.prepared;

      const result = await runDesignReview({
        client,
        scorecard: session.card,
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

      session.proposedEdits = result.applicableEdits;

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
    const edit = session.proposedEdits[index];
    if (!edit) return;

    const abs = path.resolve(session.repoRoot, edit.file);
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

  // --- Demo: the coding-agent stand-in --------------------------------------

  register('donna.runDemoScenario', async () => {
    const config = vscode.workspace.getConfiguration('donna');
    const configured = config.get<string>('demo.scenarioDir', '').trim();
    const dir = configured
      ? path.isAbsolute(configured)
        ? configured
        : path.resolve(session.repoRoot, configured)
      : path.resolve(session.repoRoot, 'scenarios');

    const { scenarios, issues } = loadScenarios(dir);
    for (const issue of issues) log.warn(issue);

    if (scenarios.length === 0) {
      void vscode.window.showWarningMessage(
        `Donna: no demo scenarios found in ${dir}. Set "donna.demo.scenarioDir".`,
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      scenarios.map((scenario) => ({
        label: scenario.title,
        description: scenario.id,
        detail: scenario.agentPrompt,
        scenario,
      })),
      {
        title: 'Coding-agent stand-in — pick a change to produce',
        placeHolder: 'This writes files, standing in for Claude Code or Cursor.',
      },
    );
    if (!picked) return;

    try {
      if (session.demo) {
        revertScenario(session.repoRoot, session.demo);
        session.demo = undefined;
      }
      session.demo = applyScenario(session.repoRoot, picked.scenario);
      log.info(
        `Coding-agent stand-in applied "${session.demo.scenario.id}" to ${session.demo.touched.join(', ')}.`,
      );
      void vscode.window.showInformationMessage(
        `Coding agent changed ${session.demo.touched.length} file${session.demo.touched.length === 1 ? '' : 's'}. Donna is assessing in parallel.`,
      );
      await runAssessment({ reason: `demo scenario ${session.demo.scenario.id}` });
      void vscode.commands.executeCommand('donna.openScorecard');
    } catch (error) {
      log.error('Demo scenario failed to apply', error);
      void vscode.window.showErrorMessage(`Donna demo: ${(error as Error).message}`);
    }
  });

  register('donna.revertDemoScenario', async () => {
    if (!session.demo) {
      void vscode.window.showInformationMessage('Donna: no demo scenario is applied.');
      return;
    }
    const restored = revertScenario(session.repoRoot, session.demo);
    log.info(`Reverted demo scenario, restoring ${restored.join(', ')}.`);
    session.demo = undefined;
    void vscode.window.showInformationMessage(
      `Donna: reverted ${restored.length} file${restored.length === 1 ? '' : 's'}.`,
    );
    await runAssessment({ reason: 'demo scenario reverted' });
  });

  // Kick off a first assessment so the views are not empty on open.
  void runAssessment({ reason: 'startup' });
}

/** Tree nodes arrive as `unknown` through the command layer. */
function extractObservation(node: unknown): Observation | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = (node as { observation?: unknown }).observation;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const observation = candidate as Observation;
  return typeof observation.id === 'string' ? observation : undefined;
}

export function deactivate(): void {
  log.info('Donna deactivated.');
}
