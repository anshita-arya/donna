"use strict";
/**
 * The eval harness.
 *
 * For each prepared scenario it stands up a real git repository, plays the role
 * of the coding agent by applying the scenario's edits, and then runs the same
 * `assess()` the extension runs against a real `git diff`. Nothing is
 * synthesised: if this passes, the extension is exercising the same code path.
 *
 * It answers the prototype's version of the product metric — of the scenarios
 * that contain a genuine design conflict, how many were caught *before* a PR
 * was opened, and of the ones that do not, how many were left alone.
 *
 * Usage:
 *   node out-eval/test/run-eval.js            # all scenarios, summary table
 *   node out-eval/test/run-eval.js 01         # one scenario, full scorecard
 *   node out-eval/test/run-eval.js --verbose  # all scenarios, full scorecards
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const scorecard_1 = require("../src/assess/scorecard");
const markdown_1 = require("../src/assess/markdown");
const workspace_1 = require("../src/core/workspace");
/**
 * Walks up for the project root rather than assuming a depth, so the harness
 * works whether it is run from source or from the compiled output directory.
 */
function findProjectRoot(start) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'scenarios'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new Error(`Could not locate the project root from ${start}.`);
}
const ROOT = findProjectRoot(__dirname);
const SANDBOX = path.join(ROOT, 'demo', 'sandbox');
const PACK = path.join(ROOT, 'context-pack');
const SCENARIO_DIR = path.join(ROOT, 'scenarios');
// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------
function run(cwd, file, args) {
    (0, node_child_process_1.execFileSync)(file, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}
function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.name === '__pycache__' || entry.name === '.git')
            continue;
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory())
            copyDir(src, dst);
        else if (entry.isFile())
            fs.copyFileSync(src, dst);
    }
}
/**
 * Stands up a git repo with the sandbox committed on `main`, then branches.
 * The branch matters: the base ref resolution looks for a merge base with the
 * default branch, which is what it will do in a real repository.
 */
function createFixture(scenarioId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `donna-${scenarioId}-`));
    copyDir(SANDBOX, dir);
    run(dir, 'git', ['init', '-b', 'main']);
    run(dir, 'git', ['config', 'user.email', 'harness@example.invalid']);
    run(dir, 'git', ['config', 'user.name', 'Donna harness']);
    run(dir, 'git', ['config', 'commit.gpgsign', 'false']);
    run(dir, 'git', ['add', '-A']);
    run(dir, 'git', ['commit', '-m', 'baseline']);
    run(dir, 'git', ['checkout', '-b', `agent/${scenarioId}`]);
    return dir;
}
/** The coding-agent stand-in: applies the scenario's edits to the working tree. */
function applyAsCodingAgent(repo, scenario) {
    const touched = [];
    for (const [index, edit] of scenario.edits.entries()) {
        const abs = path.join(repo, edit.file);
        if (!fs.existsSync(abs)) {
            throw new Error(`${scenario.id} edit #${index + 1}: ${edit.file} does not exist in the sandbox.`);
        }
        const before = fs.readFileSync(abs, 'utf8');
        const occurrences = before.split(edit.find).length - 1;
        if (occurrences !== 1) {
            throw new Error(`${scenario.id} edit #${index + 1} on ${edit.file}: the \`find\` text occurs ${occurrences} times, expected exactly 1. The scenario needs updating against the current sandbox.`);
        }
        fs.writeFileSync(abs, before.replace(edit.find, edit.replace), 'utf8');
        if (!touched.includes(edit.file))
            touched.push(edit.file);
    }
    return touched;
}
function checkIds(card) {
    const ids = new Set();
    for (const dimension of card.dimensions) {
        for (const observation of dimension.observations) {
            if (observation.status === 'conflict')
                ids.add(observation.checkId);
        }
    }
    return ids;
}
function evaluate(scenario, card, touched) {
    const failures = [];
    const flagged = checkIds(card);
    if (card.verdict.value !== scenario.expect.verdict) {
        failures.push(`verdict: expected "${scenario.expect.verdict}", got "${card.verdict.value}" (${card.verdict.rationale})`);
    }
    for (const required of scenario.expect.mustFlag) {
        if (!flagged.has(required)) {
            failures.push(`missing expected conflict: ${required}`);
        }
    }
    for (const forbidden of scenario.expect.mustNotFlag) {
        if (flagged.has(forbidden)) {
            failures.push(`false positive: ${forbidden} was flagged as a conflict but should not be`);
        }
    }
    const caughtDesignConflict = card.escalations.some((e) => e.reason === 'design-conflict');
    return { scenario, card, failures, caughtDesignConflict, touched };
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function loadScenarios(filter) {
    const files = fs
        .readdirSync(SCENARIO_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort();
    const scenarios = [];
    for (const file of files) {
        const parsed = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, file), 'utf8'));
        if (filter && !parsed.id.startsWith(filter) && !parsed.id.includes(filter))
            continue;
        scenarios.push(parsed);
    }
    return scenarios;
}
function main() {
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose') || args.includes('-v');
    const filter = args.find((a) => !a.startsWith('-'));
    const keep = args.includes('--keep');
    const scenarios = loadScenarios(filter);
    if (scenarios.length === 0) {
        console.error(`No scenarios matched${filter ? ` "${filter}"` : ''}.`);
        process.exit(2);
    }
    const showFullCard = verbose || scenarios.length === 1;
    const outcomes = [];
    for (const scenario of scenarios) {
        console.log('='.repeat(78));
        console.log(`SCENARIO ${scenario.id}`);
        console.log(`  ${scenario.title}`);
        console.log('='.repeat(78));
        console.log();
        console.log(`  Developer asked the coding agent:`);
        console.log(`    "${scenario.agentPrompt}"`);
        console.log();
        const repo = createFixture(scenario.id);
        let touched;
        try {
            touched = applyAsCodingAgent(repo, scenario);
        }
        catch (error) {
            console.error(`  SETUP FAILED: ${error.message}`);
            console.log();
            process.exitCode = 1;
            continue;
        }
        console.log(`  Coding agent changed: ${touched.join(', ')}`);
        console.log();
        const prepared = (0, workspace_1.prepareAssessment)({ repoRoot: repo, packDir: PACK });
        const card = (0, scorecard_1.assess)(prepared.input, {
            loadIssues: prepared.loadIssues,
            adrFiles: prepared.adrFiles,
            testExpectations: prepared.testExpectations,
            modelPass: { ran: false, skippedBecause: 'the eval harness runs deterministic checks only' },
        });
        const outcome = evaluate(scenario, card, touched);
        outcomes.push(outcome);
        if (showFullCard) {
            console.log((0, markdown_1.renderScorecardMarkdown)(card, { title: `Impact assessment — ${scenario.id}` }));
            console.log();
        }
        else {
            console.log(`  Verdict: ${card.verdict.value}`);
            console.log(`  Conflicts: ${[...checkIds(card)].join(', ') || '(none)'}`);
            console.log();
        }
        if (outcome.failures.length === 0) {
            console.log(`  RESULT: PASS`);
        }
        else {
            console.log(`  RESULT: FAIL`);
            for (const failure of outcome.failures)
                console.log(`    - ${failure}`);
        }
        console.log();
        if (!keep)
            fs.rmSync(repo, { recursive: true, force: true });
        else
            console.log(`  fixture kept at ${repo}`);
    }
    // --- Summary -------------------------------------------------------------
    console.log('='.repeat(78));
    console.log('SUMMARY');
    console.log('='.repeat(78));
    console.log();
    const pad = (s, n) => s.padEnd(n).slice(0, n);
    console.log(`${pad('scenario', 30)} ${pad('expected', 28)} ${pad('got', 28)} result`);
    console.log('-'.repeat(100));
    for (const outcome of outcomes) {
        console.log(`${pad(outcome.scenario.id, 30)} ${pad(outcome.scenario.expect.verdict, 28)} ${pad(outcome.card.verdict.value, 28)} ${outcome.failures.length === 0 ? 'PASS' : 'FAIL'}`);
    }
    console.log();
    // --- The metric ----------------------------------------------------------
    const conflictScenarios = outcomes.filter((o) => o.scenario.expect.verdict === 'escalate-to-design-review');
    const cleanScenarios = outcomes.filter((o) => o.scenario.expect.verdict === 'ready-to-propose');
    const caught = conflictScenarios.filter((o) => o.caughtDesignConflict).length;
    const falsePositives = cleanScenarios.filter((o) => o.card.verdict.value !== 'ready-to-propose').length;
    console.log('Pre-PR conflict detection');
    console.log(`  Design conflicts caught before PR:  ${caught}/${conflictScenarios.length}`);
    console.log(`  Clean changes left alone:           ${cleanScenarios.length - falsePositives}/${cleanScenarios.length}`);
    console.log();
    console.log(`  Without the agent, each of those ${conflictScenarios.length} conflicts surfaces in PR review or in a`);
    console.log(`  lead's end-of-week read — i.e. after the PR exists. That is the delta the`);
    console.log(`  real metric measures.`);
    console.log();
    const failed = outcomes.filter((o) => o.failures.length > 0);
    if (failed.length > 0) {
        console.log(`${failed.length} of ${outcomes.length} scenarios failed.`);
        process.exitCode = 1;
    }
    else {
        console.log(`All ${outcomes.length} scenarios passed.`);
    }
}
main();
//# sourceMappingURL=run-eval.js.map