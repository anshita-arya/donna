"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTestExpectations = parseTestExpectations;
exports.buildTestCoverage = buildTestCoverage;
exports.analyzeTests = analyzeTests;
exports.testEvidence = testEvidence;
const glob_1 = require("../core/glob");
function parseTestExpectations(path, text) {
    const issues = [];
    try {
        const parsed = JSON.parse(text);
        const expectations = (parsed.expectations ?? []).filter((e) => {
            const ok = e &&
                typeof e.id === 'string' &&
                Array.isArray(e.when) &&
                Array.isArray(e.requireTests);
            if (!ok)
                issues.push(`${path}: skipped a malformed expectation entry.`);
            return ok;
        });
        return { expectations, issues };
    }
    catch (error) {
        issues.push(`${path}: not valid JSON (${error.message}).`);
        return { expectations: [], issues };
    }
}
/**
 * Builds the test→module reachability map once per scan.
 *
 * Depth is capped: a test that reaches a module through eight hops is not
 * meaningfully testing it, and in a repo the size of a production monorepo the
 * uncapped closure of any test is most of the codebase.
 */
function buildTestCoverage(graph, config, maxDepth = 4) {
    const reach = new Map();
    const coveredBy = new Map();
    for (const node of graph.nodes.values()) {
        if (!node.isTest && !(0, glob_1.matchAny)(node.path, config.tests.match))
            continue;
        const seen = new Set();
        let frontier = new Set([node.path]);
        for (let depth = 0; depth < maxDepth; depth++) {
            const next = new Set();
            for (const current of frontier) {
                for (const dep of graph.dependencies.get(current) ?? []) {
                    if (seen.has(dep))
                        continue;
                    const depNode = graph.nodes.get(dep);
                    if (depNode?.isTest)
                        continue; // test helpers are not the thing under test
                    seen.add(dep);
                    next.add(dep);
                }
            }
            if (next.size === 0)
                break;
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
function analyzeTests(args) {
    const { graph, config, coverage, changedPaths, affected, expectations } = args;
    const requirements = [];
    const uncovered = [];
    const changedTests = [];
    const missingExpected = [];
    for (const path of changedPaths) {
        if ((0, glob_1.matchAny)(path, config.tests.match))
            changedTests.push(path);
    }
    // 1. Existing tests that reach a changed module: these should be run.
    const relevantTests = new Map();
    for (const path of changedPaths) {
        const tests = coverage.coveredBy.get(path);
        if (!tests || tests.size === 0) {
            if (graph.nodes.has(path) && !(0, glob_1.matchAny)(path, config.tests.match))
                uncovered.push(path);
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
    for (const [test, covers] of [...relevantTests].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))) {
        const isIntegration = (0, glob_1.matchAny)(test, config.tests.integration);
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
    const testPaths = [...graph.nodes.keys()].filter((p) => (0, glob_1.matchAny)(p, config.tests.match));
    for (const expectation of expectations) {
        const triggers = [...changedPaths].filter((p) => (0, glob_1.matchAny)(p, expectation.when));
        if (triggers.length === 0)
            continue;
        for (const pattern of expectation.requireTests) {
            const matches = testPaths.filter((p) => (0, glob_1.matchGlob)(p, pattern));
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
                if (requirements.some((r) => r.target === match))
                    continue;
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
        if (changedPaths.has(path))
            continue;
        if ((0, glob_1.matchAny)(path, config.tests.match))
            continue;
        const tests = coverage.coveredBy.get(path);
        if (!tests || tests.size === 0)
            uncovered.push(path);
    }
    return {
        requirements,
        uncovered: [...new Set(uncovered)].sort(),
        changedTests: changedTests.sort(),
        missingExpected,
    };
}
function testEvidence(path, note) {
    return { kind: 'tests', ref: path, note };
}
//# sourceMappingURL=tests.js.map