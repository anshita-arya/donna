/**
 * Production risk.
 *
 * These are heuristics, and they are labelled as such — a risk signal is an
 * `attention`, never a `conflict`, because "this touches concurrency" is a
 * reason to look harder, not a verdict. What makes them worth having is that
 * each one cites the specific changed line that triggered it, so the developer
 * is reading their own diff rather than a generic warning.
 *
 * The signals are deliberately about *classes of production failure that do not
 * show up in tests*: concurrency, removed error handling, changed limits,
 * dropped observability, and resource allocation. A unit test suite passes
 * happily through all five.
 */

import { matchAny } from '../core/glob';
import { findingId } from '../core/id';
import type { AssessmentInput, ChangedFile, Evidence, Observation } from '../core/types';

interface RiskSignal {
  id: string;
  title: string;
  /** Matched against added lines. */
  added?: RegExp;
  /** Matched against removed lines — for things whose *absence* is the risk. */
  removed?: RegExp;
  /** Only consider files matching these globs. Empty = all files. */
  files?: string[];
  why: string;
  actions: string[];
  escalate: boolean;
}

const SIGNALS: RiskSignal[] = [
  {
    id: 'concurrency',
    title: 'concurrency or async control flow changed',
    added: /\b(asyncio\.|await\s+|threading\.|multiprocessing\.|Lock\(|Semaphore\(|Event\(|\.acquire\(|\.release\(|spawn|fork|ThreadPool|ProcessPool|create_task|gather\()/,
    why: 'Concurrency defects are the classic case of code that passes every test and fails under production load. Ordering, cancellation and shared-state bugs here surface as intermittent errors, not as red CI.',
    actions: [
      'Walk through what happens when two requests hit this path at once, and when one is cancelled mid-flight.',
      'Ask for a reviewer who has debugged this path under load, not only a correctness reviewer.',
    ],
    escalate: true,
  },
  {
    id: 'error-handling-removed',
    title: 'error handling removed',
    removed: /^\s*(try:|except\b|finally:|raise\b|\}\s*catch\b|\.catch\(|except\s+\w+)/,
    why: 'A removed try/except or raise changes what reaches the caller. If this path previously converted an internal failure into a clean error response, removing it can turn a handled 4xx into an unhandled 5xx.',
    actions: [
      'Confirm the failure the removed handler covered is now impossible, rather than merely unhandled.',
      'Check whether any caller relied on the exception type that is no longer raised.',
    ],
    escalate: true,
  },
  {
    id: 'limits-and-timeouts',
    title: 'a limit, timeout or retry value changed',
    added: /\b(timeout|deadline|retries|retry|backoff|max_(?:tokens|len|length|batch|size|concurrent|num|requests)|limit|ttl|expire)\b\s*[=:]/i,
    why: 'Limits are the levers that decide how the system degrades. Raising one can exhaust memory under a load pattern nobody tested; lowering one can start rejecting traffic that used to succeed.',
    actions: [
      'State the new value and the reasoning in the PR description so a reviewer can sanity-check the units and the blast radius.',
      'Check whether the value is also set in deployment config, where it may override this default.',
    ],
    escalate: true,
  },
  {
    id: 'observability-removed',
    title: 'logging, metrics or tracing removed',
    removed: /\b(logger\.|logging\.|log\.(?:info|warn|warning|error|debug)|\.observe\(|\.inc\(|\.record\(|counter|histogram|start_span|add_event|console\.(?:log|warn|error))/,
    why: 'Removing an emission point is invisible in tests and permanent in production: the signal is simply gone next time this path misbehaves, and whoever is on call will not know it used to exist.',
    actions: [
      'Confirm the removed signal is genuinely redundant, and that no dashboard or alert queries it.',
      'If a dashboard or alert does query it, the observability owners need to know before this merges.',
    ],
    escalate: false,
  },
  {
    id: 'resource-allocation',
    title: 'memory or resource allocation changed',
    added: /\b(kv_cache|block_size|num_blocks|num_gpu_blocks|allocate|malloc|preallocat|cache_size|buffer_size|pool_size|device_map|torch\.(?:empty|zeros|ones|cat)|pin_memory)\b/i,
    why: 'Allocation changes shift the memory ceiling. A model that fits today may OOM on the largest request shape in production, and OOM in a serving path takes down in-flight requests, not just the new one.',
    actions: [
      'Work out the worst-case shape this allocation can be asked for, not the typical one.',
      'Ask for a load or memory-profile run before merge if the ceiling moved.',
    ],
    escalate: true,
  },
  {
    id: 'config-default-changed',
    title: 'a default or environment-derived value changed',
    added: /\b(os\.environ|os\.getenv|getenv\(|process\.env|default\s*[=:]|Field\(\s*default)/,
    why: 'A changed default silently changes behaviour for every deployment that did not set the value explicitly — which is usually most of them.',
    actions: [
      'List which deployments rely on the old default and whether any of them must be updated in lockstep.',
    ],
    escalate: true,
  },
  {
    id: 'auth-and-validation',
    title: 'authentication, authorization or validation logic changed',
    added: /\b(api_key|apikey|token|auth|permission|verify|validate|sanitiz|allowlist|whitelist|denylist|Depends\()/i,
    removed: /\b(api_key|apikey|auth|permission|verify|validate|Depends\()/i,
    why: 'Changes in this area fail in the direction of letting something through. A test suite checks the cases it knows about; it does not check the case the change newly admits.',
    actions: [
      'Name explicitly what is now accepted that was previously rejected, and confirm that is intended.',
      'This area normally needs a security or platform reviewer regardless of how small the diff is.',
    ],
    escalate: true,
  },
];

export interface RiskAnalysis {
  observations: Observation[];
}

function sampleLines(
  file: ChangedFile,
  re: RegExp,
  direction: 'added' | 'removed',
  max = 3,
): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const hunk of file.hunks) {
    const entries = direction === 'added' ? hunk.addedLines : hunk.removedLines;
    for (const entry of entries) {
      if (!re.test(entry.text)) continue;
      out.push({
        line: direction === 'added' ? entry.line : Math.max(1, hunk.newStart),
        text: entry.text.trim().slice(0, 120),
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function analyzeRisk(input: AssessmentInput, affected: Set<string>): RiskAnalysis {
  const { change, graph, ownersOf } = input;
  const observations: Observation[] = [];

  for (const signal of SIGNALS) {
    const hits: {
      file: string;
      direction: 'added' | 'removed';
      lines: { line: number; text: string }[];
    }[] = [];

    for (const file of change.files) {
      if (file.kind === 'deleted') continue;
      if (signal.files?.length && !matchAny(file.path, signal.files)) continue;

      if (signal.added) {
        const lines = sampleLines(file, signal.added, 'added');
        if (lines.length) hits.push({ file: file.path, direction: 'added', lines });
      }
      if (signal.removed) {
        const lines = sampleLines(file, signal.removed, 'removed');
        if (lines.length) hits.push({ file: file.path, direction: 'removed', lines });
      }
    }

    if (hits.length === 0) continue;

    const evidence: Evidence[] = [];
    for (const hit of hits.slice(0, 4)) {
      for (const line of hit.lines.slice(0, 2)) {
        evidence.push({
          kind: 'diff',
          ref: hit.file,
          line: line.line,
          excerpt: `${hit.direction === 'added' ? '+' : '-'} ${line.text}`,
        });
      }
    }

    const files = [...new Set(hits.map((h) => h.file))];
    observations.push({
      id: findingId(`risk-${signal.id}`, files.sort()),
      dimension: 'production-risk',
      checkId: `risk/${signal.id}`,
      status: 'attention',
      confidence: 'medium',
      title: signal.title,
      detail: `${signal.why} Triggered by ${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 3).map((f) => `\`${f}\``).join(', ')}${files.length > 3 ? `, +${files.length - 3} more` : ''}.`,
      evidence,
      source: 'static',
      requiredActions: signal.actions,
      escalate: signal.escalate ? 'production-behavior-change' : undefined,
      owners: [...new Set(files.flatMap((f) => ownersOf(f).owners))],
      location: { file: hits[0].file, line: hits[0].lines[0].line },
    });
  }

  // --- Structural risk: changing something a lot of code depends on --------
  const amplifiers: { path: string; dependents: number }[] = [];
  for (const path of change.paths) {
    const count = graph.dependents.get(path)?.size ?? 0;
    if (count >= 10) amplifiers.push({ path, dependents: count });
  }
  amplifiers.sort((a, b) => b.dependents - a.dependents);

  if (amplifiers.length > 0) {
    const top = amplifiers[0];
    observations.push({
      id: findingId('risk-change-amplifier', amplifiers.map((a) => a.path).sort()),
      dimension: 'production-risk',
      checkId: 'risk/change-amplifier',
      status: 'attention',
      confidence: 'high',
      title: `changes a module ${top.dependents} others depend on`,
      detail:
        `\`${top.path}\` is imported by ${top.dependents} modules` +
        (amplifiers.length > 1
          ? `, and ${amplifiers.length - 1} other changed file${amplifiers.length === 2 ? ' is' : 's are'} similarly central. `
          : '. ') +
        `A defect here does not stay local — it reaches every one of them, and a rollback has to be all-or-nothing.`,
      evidence: amplifiers.slice(0, 3).map<Evidence>((a) => ({
        kind: 'graph',
        ref: a.path,
        note: `${a.dependents} importers`,
      })),
      source: 'static',
      requiredActions: [
        'Consider whether this can ship behind a flag, so a rollback does not require reverting the whole change.',
        `Request review from owners of the heaviest consumers, not only of \`${top.path}\` itself.`,
      ],
      owners: [...new Set(amplifiers.flatMap((a) => ownersOf(a.path).owners))],
      location: { file: top.path, line: 1 },
    });
  }

  if (observations.length === 0) {
    observations.push({
      id: findingId('risk-none', [...change.paths].sort()),
      dimension: 'production-risk',
      checkId: 'risk/no-signals',
      status: 'pass',
      confidence: 'low',
      title: 'no production-risk signals matched',
      detail:
        `None of the heuristic signals (concurrency, removed error handling, changed limits, dropped observability, ` +
        `resource allocation, changed defaults, auth/validation) matched this diff, and no changed module has 10+ importers. ` +
        `Low confidence by design: these are pattern heuristics, so a clean result means "nothing obvious", not "no risk".`,
      evidence: [{ kind: 'diff', ref: `${change.files.length} files`, note: 'scanned for risk signals' }],
      source: 'static',
      requiredActions: [],
      owners: [],
    });
  }

  // Modules in the blast radius that are themselves central: a reviewer should
  // know the change reaches load-bearing code even if it does not touch it.
  const reachedCentral = [...affected]
    .filter((p) => !change.paths.has(p))
    .map((p) => ({ path: p, dependents: graph.dependents.get(p)?.size ?? 0 }))
    .filter((x) => x.dependents >= 15)
    .sort((a, b) => b.dependents - a.dependents)
    .slice(0, 3);

  if (reachedCentral.length > 0) {
    observations.push({
      id: findingId('risk-reaches-central', reachedCentral.map((x) => x.path).sort()),
      dimension: 'production-risk',
      checkId: 'risk/reaches-central-module',
      status: 'attention',
      confidence: 'low',
      title: `blast radius includes ${reachedCentral.length} heavily-depended-on module${reachedCentral.length === 1 ? '' : 's'}`,
      detail: `${reachedCentral.map((x) => `\`${x.path}\` (${x.dependents} importers)`).join(', ')} sit downstream of this change without being modified. They are not broken by it, but they are where a behavioural regression would spread from.`,
      evidence: reachedCentral.map<Evidence>((x) => ({
        kind: 'graph',
        ref: x.path,
        note: `${x.dependents} importers, downstream of the change`,
      })),
      source: 'static',
      requiredActions: [],
      owners: [],
    });
  }

  return { observations };
}
