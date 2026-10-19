/**
 * Donna core types.
 *
 * Nothing in `src/core`, `src/evidence`, `src/constraints` or `src/assess`
 * imports `vscode`, so the whole assessment pipeline runs headlessly — in the
 * eval harness, in CI, and in tests. Only `src/ui`, `src/agents/llm.ts` and
 * `extension.ts` touch the editor API.
 */

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

export type Language = 'python' | 'typescript';

/** One module in the dependency graph. Paths are repo-relative, POSIX. */
export interface ModuleNode {
  path: string;
  language: Language;
  /** Service this module belongs to, from the service map. `null` if unmapped. */
  service: string | null;
  loc: number;
  /** Public symbols this module exports (Python: module-level defs/classes). */
  exports: string[];
  /** Resolved import target -> line number of the import. */
  importLines: Record<string, number>;
  /** Specifiers we could not resolve to a repo file: third-party packages. */
  externals: string[];
  /** True when the path matches the configured test globs. */
  isTest: boolean;
}

export interface Edge {
  from: string;
  to: string;
  line: number;
}

export interface GraphSnapshot {
  nodes: Map<string, ModuleNode>;
  edges: Edge[];
  /** path -> modules that import it */
  dependents: Map<string, Set<string>>;
  /** path -> modules it imports */
  dependencies: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// The change under assessment
// ---------------------------------------------------------------------------

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface Hunk {
  /** 1-based line range in the new file. */
  newStart: number;
  newLines: number;
  oldStart: number;
  oldLines: number;
  addedLines: { line: number; text: string }[];
  removedLines: { line: number; text: string }[];
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  hunks: Hunk[];
  added: number;
  removed: number;
}

export interface ChangeSet {
  baseRef: string;
  headRef: string;
  branch: string;
  files: ChangedFile[];
  /** Convenience: every changed path, including deletions. */
  paths: Set<string>;
}

// ---------------------------------------------------------------------------
// Evidence — every claim the agent makes has to point at something
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | 'diff'
  | 'graph'
  | 'adr'
  | 'service-map'
  | 'ownership'
  | 'tests'
  | 'compat-policy'
  | 'external-context'
  | 'model';

export interface Evidence {
  kind: EvidenceKind;
  /** What to cite: a repo path, an ADR id, a policy rule id. */
  ref: string;
  /** 1-based line, when the evidence is a specific place in a file. */
  line?: number;
  /** Short verbatim excerpt. Kept short so the scorecard stays readable. */
  excerpt?: string;
  note?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

/**
 * `pass` — checked, no problem found.
 * `attention` — not a violation, but the developer has to do something.
 * `conflict` — contradicts a documented design decision or policy.
 * `unknown` — the agent could not determine this. Never silently a pass.
 */
export type ObservationStatus = 'pass' | 'attention' | 'conflict' | 'unknown';

export type Dimension =
  | 'blast-radius'
  | 'design-conformance'
  | 'backward-compatibility'
  | 'test-coverage'
  | 'production-risk'
  | 'review-routing';

export const DIMENSION_LABELS: Record<Dimension, string> = {
  'blast-radius': 'Blast radius',
  'design-conformance': 'Design conformance',
  'backward-compatibility': 'Backward compatibility',
  'test-coverage': 'Test coverage',
  'production-risk': 'Production risk',
  'review-routing': 'Review routing',
};

/**
 * Reasons the agent must hand the decision back rather than conclude.
 * Mirrors the escalation policy: conflict with a design decision, missing
 * documentation or ownership, uncertain backward compatibility, or a possible
 * change to production behavior.
 */
export type EscalationReason =
  | 'design-conflict'
  | 'missing-documentation'
  | 'missing-ownership'
  | 'compat-uncertain'
  | 'production-behavior-change';

export const ESCALATION_LABELS: Record<EscalationReason, string> = {
  'design-conflict': 'Conflicts with a documented design decision',
  'missing-documentation': 'No design documentation covers this area',
  'missing-ownership': 'No owner recorded for an affected component',
  'compat-uncertain': 'Backward compatibility could not be established',
  'production-behavior-change': 'May change production behavior',
};

export interface Observation {
  /** Stable across edits: derived from the rule and a semantic key, never lines. */
  id: string;
  dimension: Dimension;
  /** Which check produced this, e.g. `adr-constraint:ADR-0002/api-version-required`. */
  checkId: string;
  status: ObservationStatus;
  confidence: Confidence;
  title: string;
  detail: string;
  evidence: Evidence[];
  source: 'static' | 'model';
  /** What the developer or another stakeholder must do. Empty for a pass. */
  requiredActions: string[];
  escalate?: EscalationReason;
  /** Owner handles relevant to this observation, e.g. `@platform-api`. */
  owners: string[];
  location?: { file: string; line: number };
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export interface ServiceImpact {
  service: string;
  /** `direct` — a changed file is in this service. `downstream` — it depends on one. */
  reach: 'direct' | 'downstream';
  modules: string[];
  owners: string[];
  /** Why we think it is affected. */
  via?: string;
}

export interface TestRequirement {
  /** Existing test file, or a glob describing a test that does not exist yet. */
  target: string;
  exists: boolean;
  reason: string;
  /** Which changed or affected modules this test covers. */
  covers: string[];
  source: 'graph' | 'test-expectations' | 'adr' | 'model';
}

export interface ReviewerSuggestion {
  handle: string;
  /** Team or role label, from ownership records. */
  team?: string;
  reason: string;
  /** `required` when an ownership record or ADR mandates the review. */
  weight: 'required' | 'suggested';
  evidence: Evidence[];
}

export interface ChecklistItem {
  id: string;
  text: string;
  /** Blocking items must be resolved before a PR is reasonable to open. */
  blocking: boolean;
  dimension: Dimension;
  owners: string[];
}

export interface DimensionScore {
  dimension: Dimension;
  status: ObservationStatus;
  summary: string;
  observations: Observation[];
}

/**
 * Deliberately not `approved` / `rejected`. The agent assesses readiness to
 * *propose*; a human owner approves.
 */
export type Verdict = 'ready-to-propose' | 'needs-revision' | 'escalate-to-design-review';

export const VERDICT_LABELS: Record<Verdict, string> = {
  'ready-to-propose': 'Looks ready to propose',
  'needs-revision': 'Needs revision before PR',
  'escalate-to-design-review': 'Send to design review',
};

export interface Escalation {
  reason: EscalationReason;
  detail: string;
  observationIds: string[];
  owners: string[];
}

export interface Scorecard {
  schemaVersion: 1;
  generatedAt: string;
  repo: string;
  branch: string;
  baseRef: string;
  /** Counts only; the diff itself is not copied into the scorecard. */
  change: { files: number; added: number; removed: number; paths: string[] };
  dimensions: DimensionScore[];
  affectedServices: ServiceImpact[];
  requiredTests: TestRequirement[];
  reviewers: ReviewerSuggestion[];
  checklist: ChecklistItem[];
  verdict: { value: Verdict; rationale: string };
  escalations: Escalation[];
  /** Model pass provenance, so a reader knows which parts are judgment. */
  modelPass: { ran: boolean; provider?: string; model?: string; skippedBecause?: string };
  /** Context-pack provenance and the fiction disclaimer. */
  contextPack: { name: string; synthetic: boolean; disclaimer?: string } | null;
  /** What the agent is not permitted to do. Rendered in the panel verbatim. */
  limits: string[];
  /** Coverage gaps in the agent's own investigation. */
  blindSpots: string[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ServiceSpec {
  name: string;
  match: string[];
  description?: string;
  /** Owner handles. Empty array is meaningful: it triggers missing-ownership. */
  owners?: string[];
  /** Other services this one is allowed to depend on. Absent = unconstrained. */
  dependsOn?: string[];
}

export interface CompatRule {
  id: string;
  /** Files whose public contract is governed by this rule. */
  surface: string[];
  /** Human description, cited as evidence. */
  policy: string;
  /** Changing a declared symbol requires one of these files to change too. */
  versionRegistry?: string[];
  severity: 'blocker' | 'concern';
}

export interface DonnaConfig {
  repoRoot: string;
  services: ServiceSpec[];
  /** Directory holding ADR markdown files. */
  adrDir: string | null;
  /** Additional architecture/design docs the model pass may cite. */
  designDocs: string[];
  ownership: {
    /** CODEOWNERS-format file. */
    codeowners: string | null;
    /** Extra ownership records keyed by glob. */
    records: { match: string[]; owners: string[]; team?: string }[];
  };
  tests: {
    /** Globs identifying test files. */
    match: string[];
    /** Globs identifying integration/e2e tests, which carry extra weight. */
    integration: string[];
    /** Optional declarative expectations file. */
    expectations: string | null;
  };
  compat: CompatRule[];
  include: string[];
  ignore: string[];
  /** Observation ids the team has accepted and does not want re-raised. */
  accepted: string[];
  contextPack: { name: string; synthetic: boolean; disclaimer?: string } | null;
}

// ---------------------------------------------------------------------------
// ADR constraints
// ---------------------------------------------------------------------------

export type ConstraintKind =
  | 'forbidden-dependency'
  | 'required-reachability'
  | 'contract-change-requires-version'
  | 'service-public-entry'
  | 'change-requires-test'
  | 'required-decorator';

export interface Constraint {
  /** Unique within its ADR. */
  id: string;
  kind: ConstraintKind;
  severity: 'blocker' | 'concern';
  rationale: string;
  /** Free-form per-kind parameters, validated by the engine. */
  params: Record<string, unknown>;
}

export interface AdrDocument {
  /** e.g. `ADR-0002`. */
  id: string;
  title: string;
  status: 'proposed' | 'accepted' | 'superseded' | 'deprecated' | string;
  path: string;
  owners: string[];
  /** Globs this ADR governs, used to decide relevance to a change. */
  appliesTo: string[];
  constraints: Constraint[];
  /** Prose body, handed to the model pass for the non-checkable parts. */
  body: string;
  supersededBy?: string;
}

export interface ConstraintResult {
  adrId: string;
  adrTitle: string;
  adrPath: string;
  constraint: Constraint;
  status: Extract<ObservationStatus, 'pass' | 'conflict' | 'unknown'>;
  message: string;
  evidence: Evidence[];
  owners: string[];
  location?: { file: string; line: number };
  requiredActions: string[];
}

// ---------------------------------------------------------------------------
// Assessment input bundle
// ---------------------------------------------------------------------------

export interface AssessmentInput {
  config: DonnaConfig;
  graph: GraphSnapshot;
  change: ChangeSet;
  adrs: AdrDocument[];
  /** Resolved owners by module path. */
  ownersOf: (path: string) => { owners: string[]; team?: string; source: Evidence | null };
  readFile(path: string): string | undefined;
  /** File contents at the base ref, for contract comparison. `undefined` if unavailable. */
  readBaseFile(path: string): string | undefined;
}
