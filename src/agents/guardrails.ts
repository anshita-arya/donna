/**
 * Guardrails.
 *
 * The agent is an investigation and recommendation tool. It is not an
 * authority for engineering decisions. That is not a tone instruction — it is
 * enforced here, and the enforcement is deliberately mechanical rather than
 * left to the model's judgement, because a prompt that says "do not edit the
 * ADRs" is a request, while a function that rejects edits to the ADR directory
 * is a constraint.
 *
 * What is blocked, and why each one matters:
 *
 *  - **Design records.** If the agent could edit an ADR, the cheapest way to
 *    resolve a design conflict would be to rewrite the decision. That inverts
 *    the entire point: the decision is the authority the change is measured
 *    against.
 *  - **Ownership records.** An agent that can edit CODEOWNERS can route its own
 *    work to a reviewer who will not object.
 *  - **Its own config.** Editing `donna.json` lets the agent widen a
 *    service boundary, drop a compatibility rule, or mark a finding accepted,
 *    and so make its own report green.
 *  - **Test expectations and CI config.** Overriding a required test is
 *    indistinguishable from passing it.
 *  - **Applying anything at all.** Even for ordinary source files, the agent
 *    produces a change *request*. The developer applies it.
 */

import { matchAny } from '../core/glob';
import type { DonnaConfig } from '../core/types';

/** Actions this agent must never take, listed for the record. */
export const FORBIDDEN_ACTIONS = [
  'modify code directly',
  'create, edit or supersede an architecture decision record',
  'edit architecture or design documentation',
  'assign or change ownership',
  'approve, open or merge a pull request',
  'deploy',
  'override a required test or a review policy',
] as const;

export interface SuggestedEdit {
  file: string;
  /** Exact existing text to replace. Must occur exactly once in the file. */
  find: string;
  replace: string;
  note?: string;
}

/**
 * The design-review agent's output: a proposal, never an applied change.
 *
 * `edits` is a patch the developer reads and chooses to apply. Nothing in this
 * extension applies it without an explicit user action and a visible diff.
 */
export interface ChangeRequest {
  summary: string;
  rationale: string;
  /** Observation ids from the scorecard that this request is responding to. */
  addresses: string[];
  edits: SuggestedEdit[];
  /** Tests the developer should add, described rather than written. */
  suggestedTests: { target: string; asserts: string }[];
  /** Things the agent could not decide and is handing back. */
  openQuestions: string[];
  /** Who should look at this, copied from the scorecard. */
  routeTo: string[];
}

export interface GuardrailViolation {
  path: string;
  rule: string;
  detail: string;
}

/** Paths that are off-limits regardless of configuration. */
const ALWAYS_FORBIDDEN = [
  '**/CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  'donna.json',
  '.donna.json',
  '**/donna.json',
  '.github/workflows/**',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  '.circleci/**',
  'azure-pipelines.yml',
  '**/.git/**',
];

export function forbiddenWritePatterns(config: DonnaConfig): string[] {
  const patterns = [...ALWAYS_FORBIDDEN];

  if (config.adrDir) {
    patterns.push(`${config.adrDir.replace(/\/$/, '')}/**`);
  }
  for (const doc of config.designDocs) patterns.push(doc);
  if (config.tests.expectations) patterns.push(config.tests.expectations);
  if (config.ownership.codeowners) patterns.push(config.ownership.codeowners);

  return patterns;
}

/**
 * Validates a change request before it is ever shown as applyable.
 *
 * Returns the violations rather than throwing, so a request that is mostly
 * fine can be shown with the offending edits stripped and the reason stated —
 * silently dropping them would hide that the agent tried.
 */
export function checkChangeRequest(
  request: ChangeRequest,
  config: DonnaConfig,
): { allowed: SuggestedEdit[]; violations: GuardrailViolation[] } {
  const forbidden = forbiddenWritePatterns(config);
  const allowed: SuggestedEdit[] = [];
  const violations: GuardrailViolation[] = [];

  for (const edit of request.edits) {
    const normalized = edit.file.replace(/^\.?\//, '');

    if (matchAny(normalized, forbidden)) {
      violations.push({
        path: edit.file,
        rule: 'protected-path',
        detail: describeProtection(normalized, config),
      });
      continue;
    }

    if (normalized.includes('..')) {
      violations.push({
        path: edit.file,
        rule: 'path-escape',
        detail: 'The path escapes the repository root, so it was rejected outright.',
      });
      continue;
    }

    if (!edit.find || edit.find === edit.replace) {
      violations.push({
        path: edit.file,
        rule: 'empty-edit',
        detail: 'The edit has nothing to find, or replaces text with itself, so it cannot be applied safely.',
      });
      continue;
    }

    allowed.push(edit);
  }

  return { allowed, violations };
}

function describeProtection(path: string, config: DonnaConfig): string {
  if (config.adrDir && matchAny(path, [`${config.adrDir.replace(/\/$/, '')}/**`])) {
    return 'This is an architecture decision record. The agent is not allowed to change the decisions it is measuring the change against — that has to go through the ADR owners.';
  }
  if (matchAny(path, ['**/CODEOWNERS'])) {
    return 'This is an ownership record. The agent does not assign or change ownership.';
  }
  if (matchAny(path, ['**/donna.json', 'donna.json', '.donna.json'])) {
    return 'This is the agent\'s own configuration. Letting it edit this would let it widen a boundary or mute a finding to make its own report green.';
  }
  if (config.tests.expectations && matchAny(path, [config.tests.expectations])) {
    return 'This declares required tests. The agent does not override test requirements.';
  }
  if (matchAny(path, ['.github/workflows/**', '.circleci/**', '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml'])) {
    return 'This is CI configuration. Changing what CI enforces is equivalent to overriding it.';
  }
  if (matchAny(path, config.designDocs)) {
    return 'This is design documentation. The agent cites it; it does not edit it.';
  }
  return 'This path is protected from agent edits.';
}

/**
 * Verifies an edit can be applied deterministically before offering it.
 * An edit whose `find` text is absent or ambiguous is not applyable, and
 * saying so is better than a partial application the developer has to unpick.
 */
export function validateEditAgainstFile(
  edit: SuggestedEdit,
  fileText: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (fileText === undefined) {
    return { ok: false, reason: `\`${edit.file}\` could not be read, so the edit cannot be verified.` };
  }
  const occurrences = fileText.split(edit.find).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      reason: `The text to replace was not found in \`${edit.file}\`. The file has probably changed since the review ran.`,
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      reason: `The text to replace appears ${occurrences} times in \`${edit.file}\`, so applying it would be ambiguous.`,
    };
  }
  return { ok: true };
}
