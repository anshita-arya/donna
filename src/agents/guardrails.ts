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
 *  - **Test expectations and CI config.** Overriding a required test is
 *    indistinguishable from passing it.
 *  - **Applying anything at all.** Even for ordinary source files, the agent
 *    produces a change *request*. The developer applies it.
 */

import * as fs from 'fs';
import * as path from 'path';

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
    const target = resolveEditTarget(edit.file, config, forbidden);
    if (!target.ok) {
      violations.push({ path: edit.file, rule: target.rule, detail: target.detail });
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

    // Carry the canonical path forward, so the file that is read, verified and
    // written is exactly the one that was checked.
    allowed.push({ ...edit, file: target.rel });
  }

  return { allowed, violations };
}

export type EditTarget =
  | { ok: true; rel: string; abs: string }
  | { ok: false; rule: 'path-escape' | 'protected-path'; detail: string };

/**
 * Resolves a model-supplied path to the file an edit would actually write.
 *
 * The protected-path check is only as good as the path it is given. Matching
 * the raw string lets `docs//adr/x.md`, `./docs/./adr/x.md`, `Docs/ADR/x.md`
 * on a case-insensitive file system, or a symlink into `docs/adr` all reach an
 * ADR, because the file system normalizes what the glob did not. So the path
 * is normalized first, protection is checked case-insensitively, and the check
 * is repeated on the path after symlinks are followed.
 */
export function resolveEditTarget(
  file: string,
  config: DonnaConfig,
  forbidden: string[] = forbiddenWritePatterns(config),
): EditTarget {
  const escape = (detail: string): EditTarget => ({ ok: false, rule: 'path-escape', detail });

  const posix = file.replace(/\\/g, '/');
  if (!posix.trim() || posix.includes('\0')) return escape('The path is empty or malformed, so it was rejected outright.');
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) {
    return escape('The path is absolute rather than relative to the repository, so it was rejected outright.');
  }

  const rel = path.posix.normalize(posix).replace(/\/$/, '');
  if (rel === '.' || rel === '..' || rel.startsWith('../')) {
    return escape('The path escapes the repository root, so it was rejected outright.');
  }
  if (isProtected(rel, forbidden)) {
    return { ok: false, rule: 'protected-path', detail: describeProtection(rel, config) };
  }

  const abs = path.resolve(config.repoRoot, rel);
  const realRel = path.relative(realPathOf(config.repoRoot), realPathOf(abs)).split(path.sep).join('/');
  if (realRel === '..' || realRel.startsWith('../') || path.isAbsolute(realRel)) {
    return escape('The path leads outside the repository through a symbolic link, so it was rejected outright.');
  }
  if (isProtected(realRel, forbidden)) {
    return { ok: false, rule: 'protected-path', detail: describeProtection(realRel, config) };
  }

  return { ok: true, rel, abs };
}

/** Case-insensitive, because macOS and Windows treat `Docs/ADR` as `docs/adr`. */
function isProtected(rel: string, patterns: string[]): boolean {
  return matchAny(rel.toLowerCase(), patterns.map((p) => p.toLowerCase()));
}

/**
 * Follows symlinks on the longest prefix that exists. The edited file itself
 * may not exist yet, but a symlinked directory above it still decides where
 * the write lands.
 */
function realPathOf(abs: string): string {
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function describeProtection(rel: string, config: DonnaConfig): string {
  const matches = (patterns: string[]) => isProtected(rel, patterns);
  if (config.adrDir && matches([`${config.adrDir.replace(/\/$/, '')}/**`])) {
    return 'This is an architecture decision record. The agent is not allowed to change the decisions it is measuring the change against — that has to go through the ADR owners.';
  }
  if (matches(['**/CODEOWNERS'])) {
    return 'This is an ownership record. The agent does not assign or change ownership.';
  }
  if (config.tests.expectations && matches([config.tests.expectations])) {
    return 'This declares required tests. The agent does not override test requirements.';
  }
  if (matches(['.github/workflows/**', '.circleci/**', '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml'])) {
    return 'This is CI configuration. Changing what CI enforces is equivalent to overriding it.';
  }
  if (matches(config.designDocs)) {
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
