import * as vscode from 'vscode';

import { assess } from './assess/scorecard';
import { parseRawConfig, WORKSPACE_CONTEXT_KEY, type RawConfig } from './core/config';
import { prepareAssessment, type PreparedAssessment } from './core/workspace';
import type { Scorecard } from './core/types';
import { runImpactPass } from './agents/impact';
import { collectExternalContext } from './integrations/mcp';
import { AnthropicClient, ModelUnavailableError, type ModelClient } from './agents/model';
import { VsCodeModelClient } from './agents/vscodeModel';
import { ScorecardPanel } from './ui/scorecardPanel';
import { StatusBar } from './ui/status';
import type { SuggestedEdit } from './agents/guardrails';
import { log } from './util/log';

export const ANTHROPIC_API_KEY_SECRET = 'donna.anthropicApiKey';

export interface AssessmentControllerOptions {
  context: vscode.ExtensionContext;
  repoRoot: string;
  status: StatusBar;
  acceptedIds: () => string[];
  inferredOverrides: () => Record<string, 'accepted' | 'dismissed'>;
  publish: (card: Scorecard) => void;
}

export interface AssessmentRequest {
  withModel?: boolean;
  reason: string;
}

export class AssessmentController {
  card?: Scorecard;
  prepared?: PreparedAssessment;
  proposedEdits: SuggestedEdit[] = [];
  private running = false;

  constructor(private readonly options: AssessmentControllerOptions) {}

  async runAssessment(request: AssessmentRequest): Promise<void> {
    const { context, repoRoot, status } = this.options;
    if (this.running) {
      log.info(`Skipping assessment (${request.reason}) — one is already running.`);
      return;
    }
    this.running = true;
    const started = Date.now();

    try {
      status.setWorking('assessing');
      ScorecardPanel.existing?.update({ busy: 'Assessing the current change…', error: undefined });
      log.info(`Assessing: ${request.reason}`);

      const config = vscode.workspace.getConfiguration('donna');
      const storedContext = context.workspaceState.get<RawConfig | undefined>(WORKSPACE_CONTEXT_KEY);
      const rawConfig = storedContext
        ? parseRawConfig(JSON.stringify(storedContext))
        : undefined;
      const baseRef = config.get<string>('baseRef', '').trim() || undefined;

      const prepared = prepareAssessment({ repoRoot, rawConfig, baseRef });
      this.prepared = prepared;

      prepared.input.config.accepted = [
        ...prepared.input.config.accepted,
        ...this.options.acceptedIds(),
      ];

      if (prepared.input.change.files.length === 0) {
        const empty = assess(prepared.input, {
          maxDepth: config.get<number>('blastRadiusDepth', 3),
          loadIssues: prepared.loadIssues,
          adrFiles: prepared.adrFiles,
          testExpectations: prepared.testExpectations,
          modelPass: { ran: false, skippedBecause: 'there is nothing to assess' },
        });
        this.publish(empty);
        status.setIdle('no changes against the base ref');
        return;
      }

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
        .flatMap((dimension) => dimension.observations)
        .some((observation) => observation.status === 'conflict' || observation.status === 'unknown');
      const hasActiveAdr = prepared.input.adrs.some((adr) =>
        ['accepted', 'approved', 'adopted'].includes(adr.status),
      );

      const wantModel =
        llmEnabled &&
        (request.withModel ||
          trigger === 'everyAssessment' ||
          (trigger === 'onConflict' && (hasSomethingToJudge || hasActiveAdr)));

      if (wantModel) {
        this.publish(card);
        status.setWorking('model pass');
        ScorecardPanel.existing?.update({ busy: 'Running the model pass…' });

        try {
          const client = await this.modelClient();
          const manualRun = ['requested', 'requested with model pass', 'scorecard opened'].includes(
            request.reason,
          );
          const external = await collectExternalContext(
            prepared.input.change,
            context,
            manualRun,
          );
          const pass = await runImpactPass({
            client,
            change: prepared.input.change,
            adrs: prepared.input.adrs,
            config: prepared.input.config,
            staticObservations: card.dimensions.flatMap((dimension) => dimension.observations),
            maxFiles: config.get<number>('llm.maxFilesPerReview', 8),
            externalContext: external.context,
          });

          card = assess(prepared.input, {
            maxDepth: config.get<number>('blastRadiusDepth', 3),
            loadIssues: [...prepared.loadIssues, ...external.notes, ...pass.notes],
            adrFiles: prepared.adrFiles,
            testExpectations: prepared.testExpectations,
            modelObservations: pass.observations.map((observation) => ({
              ...observation,
              override: observation.inferred
                ? this.options.inferredOverrides()[observation.id]
                : undefined,
            })),
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

      this.publish(card);
      log.timing('Assessment', started);
    } catch (error) {
      log.error('Assessment failed', error);
      status.setError('assessment failed');
      ScorecardPanel.existing?.update({
        busy: undefined,
        error: (error as Error).message,
      });
    } finally {
      this.running = false;
    }
  }

  private publish(card: Scorecard): void {
    this.card = card;
    this.options.publish(card);
  }

  private modelClient(): Promise<ModelClient> {
    return createModelClient(this.options.context);
  }
}

export async function createModelClient(context: vscode.ExtensionContext): Promise<ModelClient> {
  const config = vscode.workspace.getConfiguration('donna');
  const provider = config.get<string>('llm.provider', 'vscode');

  if (provider === 'anthropic') {
    const key = await context.secrets.get(ANTHROPIC_API_KEY_SECRET);
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