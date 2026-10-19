/**
 * Test coverage mapping.
 *
 * "Which tests are relevant to this change" is answered from the dependency
 * graph rather than from a coverage report: a test file that imports (directly
 * or transitively) a changed module is a test that exercises it. That is
 * weaker than line coverage and stronger than nothing — crucially, it works
 * without running anything, which is the point when the developer has not even
 * opened a PR yet.
 *
 * The limitation is stated in the scorecard's blind spots rather than hidden:
 * an import-reachable test is not proof the changed lines are executed.
 */

import { matchAny, matchGlob } from '../core/glob';
import type { Evidence, GraphSnapshot, DonnaConfig, TestRequirement } from '../core/types';

export interface TestExpectation {
  id: string;
  /** Globs: when a changed path matches, the expectation applies. */
  when: string[];
  /** Globs describing tests that must exist and should be run. */
  requireTests: string[];
  reason: string;
  integration?: boolean;
}

export interface TestExpectationsFile {
  expectations?: TestExpectation[];
}

export function parseTestExpectations(
  path: string,
  text: string,
): { expectations: TestExpectation[]; issues: string[] } {
  const issues: string[] = [];
  try {
    const parsed = JSON.parse(text) as TestExpectationsFile;
    const expectations = (parsed.expectations ?? []).filter((e) => {
      const ok =
        e &&
        typeof e.id === 'string' &&
        Array.isArray(e.when) &&
        Array.isArray(e.requireTests);
      if (!ok) issues.push(`${path}: skipped a malformed expectation entry.`);
      return ok;
    });
    return { expectations, issues };
  } catch (error) {
    issues.push(`${path}: not valid JSON (${(error as Error).message}).`);
    return { expectations: [], issues };
  }
}

export interface TestCoverage {
  /** Test file -> modules it can reach by imports, within the depth cap. */
  reach: Map<string, Set<string>>;
  /** Module -> test files that can reach it. */
  coveredBy: Map<string, Set<string>>;
}

/**
 * Builds the test→module reachability map once per scan.
 *
 * Depth is capped: a test that reaches a module through eight hops is not
 * meaningfully testing it, and in a repo the size of a production monorepo the
 * uncapped closure of any test is most of the codebase.
 */
export function buildTestCoverage(
  graph: GraphSnapshot,
  config: DonnaConfig,
  maxDepth = 4,
): TestCoverage {
  const reach = new Map<string, Set<string>>();
  const coveredBy = new Map<string, Set<string>>();

  for (const node of graph.nodes.values()) {
    if (!node.isTest && !matchAny(node.path, config.tests.match)) continue;

    const seen = new Set<string>();
    let frontier = new Set<string>([node.path]);

    for (let depth = 0; depth < maxDepth; depth++) {
      const next = new Set<string>();
      for (const current of frontier) {
        for (const dep of graph.dependencies.get(current) ?? []) {
          if (seen.has(dep)) continue;
          const depNode = graph.nodes.get(dep);
          if (depNode?.isTest) continue; // test helpers are not the thing under test
          seen.add(dep);
          next.add(dep);
        }
      }
      if (next.size === 0) break;
      frontier = next;
    }

    reach.set(node.path, seen);
    for (const module of seen) {
      let set = coveredBy.get(module);
      if (!set) {
        set = new Set();
        coveredBy.set(module, set);
      }
      set.add(node.path);
    }
  }

  return { reach, coveredBy };
}

export interface TestAnalysis {
  requirements: TestRequirement[];
  /** Affected modules no test reaches. */
  uncovered: string[];
  /** Tests that were themselves changed by this diff. */
  changedTests: string[];
  /** Expectations that apply but whose required tests do not exist. */
  missingExpected: { expectation: TestExpectation; pattern: string }[];
}

export function analyzeTests(args: {
  graph: GraphSnapshot;
  config: DonnaConfig;
  coverage: TestCoverage;
  changedPaths: Set<string>;
  /** Changed files plus their dependents. */
  affected: Set<string>;
  expectations: TestExpectation[];
}): TestAnalysis {
  const { graph, config, coverage, changedPaths, affected, expectations } = args;

  const requirements: TestRequirement[] = [];
  const uncovered: string[] = [];
  const changedTests: string[] = [];
  const missingExpected: { expectation: TestExpectation; pattern: string }[] = [];

  for (const path of changedPaths) {
    if (matchAny(path, config.tests.match)) changedTests.push(path);
  }

  // 1. Existing tests that reach a changed module: these should be run.
  const relevantTests = new Map<string, Set<string>>();
  for (const path of changedPaths) {
    const tests = coverage.coveredBy.get(path);
    if (!tests || tests.size === 0) {
      if (graph.nodes.has(path) && !matchAny(path, config.tests.match)) uncovered.push(path);
      continue;
    }
    for (const test of tests) {
      let covers = relevantTests.get(test);
      if (!covers) {
        covers = new Set();
        relevantTests.set(test, covers);
      }
      covers.add(path);
    }
  }

  for (const [test, covers] of [...relevantTests].sort(
    (a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]),
  )) {
    const isIntegration = matchAny(test, config.tests.integration);
    requirements.push({
      target: test,
      exists: true,
      reason: isIntegration
        ? `Integration test that imports ${covers.size} changed module${covers.size === 1 ? '' : 's'}.`
        : `Imports ${covers.size} changed module${covers.size === 1 ? '' : 's'}, so it exercises this change.`,
      covers: [...covers].sort(),
      source: 'graph',
    });
  }

  // 2. Declared expectations for the areas this change touches.
  const testPaths = [...graph.nodes.keys()].filter((p) => matchAny(p, config.tests.match));
  for (const expectation of expectations) {
    const triggers = [...changedPaths].filter((p) => matchAny(p, expectation.when));
    if (triggers.length === 0) continue;

    for (const pattern of expectation.requireTests) {
      const matches = testPaths.filter((p) => matchGlob(p, pattern));
      if (matches.length === 0) {
        missingExpected.push({ expectation, pattern });
        requirements.push({
          target: pattern,
          exists: false,
          reason: `${expectation.reason} (required by test expectation ${expectation.id}, and no test matches this pattern yet)`,
          covers: triggers.sort(),
          source: 'test-expectations',
        });
        continue;
      }
      for (const match of matches) {
        if (requirements.some((r) => r.target === match)) continue;
        requirements.push({
          target: match,
          exists: true,
          reason: `${expectation.reason} (required by test expectation ${expectation.id})`,
          covers: triggers.sort(),
          source: 'test-expectations',
        });
      }
    }
  }

  // 3. Affected-but-unchanged modules with no test reaching them at all. These
  //    are where a regression would land silently.
  for (const path of affected) {
    if (changedPaths.has(path)) continue;
    if (matchAny(path, config.tests.match)) continue;
    const tests = coverage.coveredBy.get(path);
    if (!tests || tests.size === 0) uncovered.push(path);
  }

  return {
    requirements,
    uncovered: [...new Set(uncovered)].sort(),
    changedTests: changedTests.sort(),
    missingExpected,
  };
}

export function testEvidence(path: string, note: string): Evidence {
  return { kind: 'tests', ref: path, note };
}
