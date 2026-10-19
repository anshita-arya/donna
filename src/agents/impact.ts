/**
 * The impact agent's model pass.
 *
 * Model output is treated as untrusted input, not as findings. Everything is
 * validated against the enums the scorecard uses, and an observation with no
 * citation is dropped rather than shown — because an uncited model claim in a
 * scorecard full of cited deterministic ones is indistinguishable from the
 * real thing at a glance, which is the worst possible mix.
 *
 * Drops are counted and surfaced, so a model that produces mostly unusable
 * output shows up as a visible quality problem rather than a quiet absence.
 */

import { findingId } from '../core/id';
import type {
  AdrDocument,
  ChangeSet,
  Confidence,
  Dimension,
  EscalationReason,
  Evidence,
  EvidenceKind,
  DonnaConfig,
  Observation,
  ObservationStatus,
  Scorecard,
} from '../core/types';
import { extractJson, ModelUnavailableError, type ModelClient } from './model';
import { buildImpactPrompt, IMPACT_SYSTEM } from './prompts';
import type { ExternalContext } from '../integrations/mcp';

const DIMENSIONS: Dimension[] = [
  'design-conformance',
  'backward-compatibility',
  'production-risk',
  'test-coverage',
  'blast-radius',
  'review-routing',
];
const STATUSES: ObservationStatus[] = ['conflict', 'attention', 'unknown', 'pass'];
const CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];
const ESCALATIONS: EscalationReason[] = [
  'design-conflict',
  'missing-documentation',
  'missing-ownership',
  'compat-uncertain',
  'production-behavior-change',
];
const EVIDENCE_KINDS: EvidenceKind[] = [
  'diff',
  'graph',
  'adr',
  'service-map',
  'ownership',
  'tests',
  'compat-policy',
  'external-context',
  'model',
];

const MAX_OBSERVATIONS = 6;

interface RawObservation {
  dimension?: unknown;
  status?: unknown;
  confidence?: unknown;
  title?: unknown;
  detail?: unknown;
  citations?: unknown;
  requiredActions?: unknown;
  escalate?: unknown;
  file?: unknown;
  line?: unknown;
}

export interface ImpactPassResult {
  observations: Observation[];
  modelPass: Scorecard['modelPass'];
  /** Diagnostics about the model's output quality, folded into blind spots. */
  notes: string[];
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function asString(value: unknown, max = 400): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function asStringArray(value: unknown, max = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => asString(v, 300))
    .filter((v): v is string => !!v)
    .slice(0, max);
}

function parseCitations(
  value: unknown,
  knownPaths: Set<string>,
  knownAdrs: Set<string>,
  knownExternalRefs: Set<string>,
): { evidence: Evidence[]; verified: number } {
  if (!Array.isArray(value)) return { evidence: [], verified: 0 };

  const evidence: Evidence[] = [];
  let verified = 0;

  for (const entry of value.slice(0, 5)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const ref = asString(row.ref, 200);
    if (!ref) continue;

    const kind = oneOf(row.kind, EVIDENCE_KINDS, 'model');

    // A citation counts as verified when it names something we actually gave
    // the model: a changed path, or an ADR id that exists.
    const isKnownPath = knownPaths.has(ref) || [...knownPaths].some((p) => ref.includes(p));
    const isKnownAdr = [...knownAdrs].some((id) => ref.toUpperCase().includes(id.toUpperCase()));
    const isKnownExternal = knownExternalRefs.has(ref);
    if (isKnownPath || isKnownAdr || isKnownExternal) verified++;

    evidence.push({
      kind,
      ref,
      note: asString(row.note, 200) ?? undefined,
    });
  }

  return { evidence, verified };
}

export async function runImpactPass(args: {
  client: ModelClient;
  change: ChangeSet;
  adrs: AdrDocument[];
  config: DonnaConfig;
  staticObservations: Observation[];
  maxFiles: number;
  externalContext?: ExternalContext[];
  signal?: { isCancellationRequested: boolean };
}): Promise<ImpactPassResult> {
  const { client, change, adrs, config, staticObservations, maxFiles, externalContext = [] } = args;
  const notes: string[] = [];

  if (change.files.length === 0) {
    return {
      observations: [],
      modelPass: { ran: false, skippedBecause: 'the change set is empty' },
      notes,
    };
  }

  const prompt = buildImpactPrompt({
    change,
    adrs,
    config,
    staticObservations,
    maxFiles,
    externalContext,
  });

  let raw: string;
  try {
    raw = await client.complete({
      system: IMPACT_SYSTEM,
      user: prompt,
      maxTokens: 4096,
      signal: args.signal,
    });
  } catch (error) {
    const message =
      error instanceof ModelUnavailableError
        ? `${error.message}${error.hint ? ` ${error.hint}` : ''}`
        : (error as Error).message;
    return {
      observations: [],
      modelPass: {
        ran: false,
        provider: client.provider,
        model: client.model,
        skippedBecause: `the model call failed: ${message}`,
      },
      notes,
    };
  }

  const parsed = extractJson<{ observations?: RawObservation[] }>(raw);
  if (!parsed.ok) {
    return {
      observations: [],
      modelPass: {
        ran: false,
        provider: client.provider,
        model: client.model,
        skippedBecause: parsed.reason,
      },
      notes,
    };
  }

  const rows = Array.isArray(parsed.value.observations) ? parsed.value.observations : [];
  const knownPaths = new Set(change.paths);
  const knownAdrs = new Set(adrs.map((a) => a.id));
  const knownExternalRefs = new Set(externalContext.map((item) => item.ref));

  const observations: Observation[] = [];
  let droppedNoCitation = 0;
  let droppedNoContent = 0;
  let droppedUnverified = 0;

  for (const row of rows.slice(0, MAX_OBSERVATIONS * 2)) {
    const title = asString(row.title, 120);
    const detail = asString(row.detail, 1200);
    if (!title || !detail) {
      droppedNoContent++;
      continue;
    }

    const { evidence, verified } = parseCitations(
      row.citations,
      knownPaths,
      knownAdrs,
      knownExternalRefs,
    );
    if (evidence.length === 0) {
      droppedNoCitation++;
      continue;
    }

    const status = oneOf(row.status, STATUSES, 'attention');

    // A conflict is the strongest claim the scorecard can carry and it drives
    // the verdict to design review, so it has to rest on a citation that names
    // something real. An unverifiable conflict is downgraded, not dropped —
    // the developer still sees it, but it does not reroute their workflow.
    let finalStatus = status;
    if (status === 'conflict' && verified === 0) {
      finalStatus = 'attention';
      droppedUnverified++;
    }

    const file = asString(row.file, 300);
    const lineValue = typeof row.line === 'number' && Number.isFinite(row.line) ? row.line : 1;

    observations.push({
      id: findingId('model', [title, file ?? '', row.dimension as string]),
      dimension: oneOf(row.dimension, DIMENSIONS, 'design-conformance'),
      checkId: `model/${oneOf(row.dimension, DIMENSIONS, 'design-conformance')}`,
      status: finalStatus,
      confidence: oneOf(row.confidence, CONFIDENCES, 'low'),
      title,
      detail:
        finalStatus !== status
          ? `${detail} (Reported as a conflict by the model, but none of its citations matched a changed file, known ADR, or retrieved MCP result, so it is shown as something to check rather than a blocking conflict.)`
          : detail,
      evidence,
      source: 'model',
      requiredActions: asStringArray(row.requiredActions),
      escalate:
        typeof row.escalate === 'string' && (ESCALATIONS as string[]).includes(row.escalate)
          ? (row.escalate as EscalationReason)
          : undefined,
      owners: [],
      location: file ? { file, line: lineValue } : undefined,
    });

    if (observations.length >= MAX_OBSERVATIONS) break;
  }

  if (droppedNoCitation > 0) {
    notes.push(
      `The model pass produced ${droppedNoCitation} observation${droppedNoCitation === 1 ? '' : 's'} with no citation; ${droppedNoCitation === 1 ? 'it was' : 'they were'} dropped rather than shown uncited.`,
    );
  }
  if (droppedNoContent > 0) {
    notes.push(`${droppedNoContent} model observation${droppedNoContent === 1 ? '' : 's'} were malformed and dropped.`);
  }
  if (droppedUnverified > 0) {
    notes.push(
      `${droppedUnverified} model-reported conflict${droppedUnverified === 1 ? '' : 's'} cited nothing verifiable and ${droppedUnverified === 1 ? 'was' : 'were'} downgraded to "to check".`,
    );
  }

  return {
    observations,
    modelPass: { ran: true, provider: client.provider, model: client.model },
    notes,
  };
}
