"use strict";
/**
 * Unit tests for the primitives everything else rests on.
 *
 * The scenario harness proves the pipeline produces the right verdicts; this
 * proves the pieces underneath behave on the cases that are easy to get wrong
 * and hard to notice: a `#` inside a Python string, a docstring containing an
 * import example, dependency direction, CODEOWNERS precedence, and a superseded
 * ADR still carrying constraints.
 *
 * No test framework — a few hundred lines of assertions with no dependency is
 * the right trade for a prototype, and it runs anywhere Node does.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const glob_1 = require("../src/core/glob");
const scan_python_1 = require("../src/core/scan-python");
const resolve_python_1 = require("../src/core/resolve-python");
const scan_1 = require("../src/core/scan");
const diff_1 = require("../src/core/diff");
const graph_1 = require("../src/core/graph");
const owners_1 = require("../src/evidence/owners");
const adr_1 = require("../src/evidence/adr");
const model_1 = require("../src/agents/model");
const guardrails_1 = require("../src/agents/guardrails");
const config_1 = require("../src/core/config");
const id_1 = require("../src/core/id");
const tools_1 = require("../src/integrations/tools");
let passed = 0;
const failures = [];
function check(name, condition, detail) {
    if (condition) {
        passed++;
    }
    else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    }
}
function eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    check(name, a === b, `expected ${b}, got ${a}`);
}
function group(label) {
    console.log(`\n${label}`);
}
// ---------------------------------------------------------------------------
group('glob');
// ---------------------------------------------------------------------------
check('exact match', (0, glob_1.matchGlob)('src/a.ts', 'src/a.ts'));
check('single star stays within a segment', (0, glob_1.matchGlob)('src/a.ts', 'src/*.ts'));
check('single star does not cross a slash', !(0, glob_1.matchGlob)('src/x/a.ts', 'src/*.ts'));
check('double star crosses segments', (0, glob_1.matchGlob)('src/x/y/a.ts', 'src/**/a.ts'));
check('double star matches zero segments', (0, glob_1.matchGlob)('src/a.ts', 'src/**/a.ts'));
check('braces expand', (0, glob_1.matchGlob)('src/a.tsx', 'src/*.{ts,tsx}'));
check('nested braces expand', (0, glob_1.matchGlob)('a/b.pyi', '**/*.{py,pyi}'));
check('bare directory means its subtree', (0, glob_1.matchGlob)('vllm/v1/core/sched/x.py', 'vllm/v1/core'));
check('bare directory does not match a sibling prefix', !(0, glob_1.matchGlob)('vllm/v1/corex/x.py', 'vllm/v1/core'));
check('matchAny is an or', (0, glob_1.matchAny)('tests/a_test.py', ['src/**', 'tests/**']));
check('dot-slash prefix is tolerated', (0, glob_1.matchGlob)('./src/a.ts', 'src/a.ts'));
check('real vLLM-shaped glob', (0, glob_1.matchGlob)('vllm/entrypoints/openai/chat_completion/protocol.py', 'vllm/entrypoints/openai/**/protocol.py'));
// ---------------------------------------------------------------------------
group('python masking and scanning');
// ---------------------------------------------------------------------------
{
    const src = [
        '"""Module docstring.',
        '',
        'Example:',
        '    from vllm.not_real import Thing   # this is documentation, not an import',
        '"""',
        'import os',
        'from vllm.v1.engine.async_llm import AsyncLLM',
        'from vllm.entrypoints.validation.guards import (',
        '    enforce_request_guards,',
        '    MAX_PROMPT_TOKENS,',
        ')',
        'URL = "http://example.com/#not-a-comment"',
        'MESSAGE = "she said: import antigravity"',
        '',
        '',
        'def handler():',
        '    from vllm.v1.metrics.loggers import MetricsLogger  # deferred import',
        '    return MetricsLogger',
        '',
        '',
        'class Server:',
        '    pass',
        '',
        '',
        '_PRIVATE = 1',
        'MAX_RETRIES = 3',
    ].join('\n');
    const masked = (0, scan_python_1.maskPython)(src);
    check('masking preserves line count', masked.split('\n').length === src.split('\n').length);
    check('masking blanks string bodies', !masked.includes('not-a-comment'));
    check('masking keeps code intact', masked.includes('from vllm.v1.engine.async_llm import AsyncLLM'));
    const scan = (0, scan_python_1.scanPython)(src);
    const modules = scan.imports.map((i) => i.module);
    check('docstring import example is not an import', !modules.includes('vllm.not_real'));
    check('string containing "import" is not an import', !modules.some((m) => m === 'antigravity'));
    check('absolute import found', modules.includes('vllm.v1.engine.async_llm'));
    check('stdlib import found', modules.includes('os'));
    check('parenthesized from-import found', modules.includes('vllm.entrypoints.validation.guards'));
    const parenthesized = scan.imports.find((i) => i.module === 'vllm.entrypoints.validation.guards');
    eq('parenthesized names parsed', parenthesized?.names, ['enforce_request_guards', 'MAX_PROMPT_TOKENS']);
    const deferred = scan.imports.find((i) => i.module === 'vllm.v1.metrics.loggers');
    check('indented import marked deferred', deferred?.deferred === true);
    check('top-level import not marked deferred', scan.imports.find((i) => i.module === 'os')?.deferred === false);
    check('public function exported', scan.exports.includes('handler'));
    check('public class exported', scan.exports.includes('Server'));
    check('uppercase constant exported', scan.exports.includes('MAX_RETRIES'));
    check('underscore-prefixed name not exported', !scan.exports.includes('_PRIVATE'));
}
{
    const withAll = ['__all__ = ["public_one", "public_two"]', 'def public_one(): pass', 'def hidden(): pass'].join('\n');
    const scan = (0, scan_python_1.scanPython)(withAll);
    eq('__all__ overrides inferred exports', scan.exports.sort(), ['public_one', 'public_two']);
    eq('__all__ is reported', scan.dunderAll?.sort(), ['public_one', 'public_two']);
}
{
    const relative = ['from . import sibling', 'from .mod import Thing', 'from ..pkg.deep import Other'].join('\n');
    const scan = (0, scan_python_1.scanPython)(relative);
    eq('relative levels counted', scan.imports.map((i) => i.level), [1, 1, 2]);
}
{
    const decorated = ['@router.post("/v1/chat")', '@with_cancellation', 'async def create_chat(): pass'].join('\n');
    const scan = (0, scan_python_1.scanPython)(decorated);
    eq('decorators captured', scan.decorators.map((d) => d.name), ['router.post', 'with_cancellation']);
    eq('decorator lines captured', scan.decorators.map((d) => d.line), [1, 2]);
}
// ---------------------------------------------------------------------------
group('python resolution');
// ---------------------------------------------------------------------------
{
    const files = [
        'vllm/__init__.py',
        'vllm/v1/__init__.py',
        'vllm/v1/engine/__init__.py',
        'vllm/v1/engine/async_llm.py',
        'vllm/v1/core/sched/__init__.py',
        'vllm/v1/core/sched/scheduler.py',
        'vllm/entrypoints/openai/chat_completion/serving.py',
    ];
    const resolver = new resolve_python_1.PythonResolver(files);
    eq('absolute module resolves to a file', resolver.resolve('vllm/entrypoints/openai/chat_completion/serving.py', {
        module: 'vllm.v1.engine.async_llm',
        names: ['AsyncLLM'],
        level: 0,
        line: 1,
        form: 'from',
        deferred: false,
    }), ['vllm/v1/engine/async_llm.py']);
    eq('package resolves to its __init__', resolver.resolve('vllm/v1/engine/async_llm.py', {
        module: 'vllm.v1.core.sched',
        names: ['build_scheduler'],
        level: 0,
        line: 1,
        form: 'from',
        deferred: false,
    }), ['vllm/v1/core/sched/__init__.py']);
    // `from pkg import submodule` is a dependency on the submodule, and missing
    // this is how Python dependency graphs under-report coupling.
    const viaName = resolver.resolve('vllm/v1/engine/async_llm.py', {
        module: 'vllm.v1.core',
        names: ['sched'],
        level: 0,
        line: 1,
        form: 'from',
        deferred: false,
    });
    check('from-package-import-submodule yields the submodule', viaName.includes('vllm/v1/core/sched/__init__.py'));
    eq('relative import resolves against the importer package', resolver.resolve('vllm/v1/core/sched/scheduler.py', {
        module: '.',
        names: ['SchedulerOutput'],
        level: 1,
        line: 1,
        form: 'from',
        deferred: false,
    }), ['vllm/v1/core/sched/__init__.py']);
    eq('third-party import resolves to nothing', resolver.resolve('vllm/v1/engine/async_llm.py', {
        module: 'torch.nn',
        names: ['Module'],
        level: 0,
        line: 1,
        form: 'from',
        deferred: false,
    }), []);
    eq('fileToModule strips __init__', (0, resolve_python_1.fileToModule)('vllm/v1/core/sched/__init__.py'), 'vllm.v1.core.sched');
    eq('fileToModule strips the extension', (0, resolve_python_1.fileToModule)('vllm/v1/engine/async_llm.py'), 'vllm.v1.engine.async_llm');
    eq('fileToModule strips a src root', (0, resolve_python_1.fileToModule)('src/pkg/mod.py'), 'pkg.mod');
}
// ---------------------------------------------------------------------------
group('typescript scanning');
// ---------------------------------------------------------------------------
{
    const src = [
        '// import "./commented-out";',
        '/* import "./block-commented"; */',
        'import { A } from "./a";',
        'import type { B } from "../b";',
        'import "./side-effect";',
        'const url = "import from nowhere";',
        'const lazy = await import("./lazy");',
        'const cjs = require("./cjs");',
        'const from = "not an import";',
        'const items = Array.from("abc");',
        'export const x = 1;',
        'export { y, z as w };',
        'export default class {}',
    ].join('\n');
    const scan = (0, scan_1.scanSource)(src);
    const specifiers = scan.imports.map((i) => i.specifier).sort();
    eq('ts specifiers', specifiers, ['../b', './a', './cjs', './lazy', './side-effect']);
    check('commented import ignored', !specifiers.includes('./commented-out'));
    check('block-commented import ignored', !specifiers.includes('./block-commented'));
    check('string containing "import" ignored', !specifiers.includes('import from nowhere'));
    check('variable named from ignored', !specifiers.includes('not an import'));
    check('Array.from ignored', !specifiers.includes('abc'));
    check('export count is non-zero', scan.exportCount >= 4, `got ${scan.exportCount}`);
}
// ---------------------------------------------------------------------------
group('diff parsing');
// ---------------------------------------------------------------------------
{
    const diff = [
        'diff --git a/vllm/entrypoints/openai/chat_completion/protocol.py b/vllm/entrypoints/openai/chat_completion/protocol.py',
        'index 1111111..2222222 100644',
        '--- a/vllm/entrypoints/openai/chat_completion/protocol.py',
        '+++ b/vllm/entrypoints/openai/chat_completion/protocol.py',
        '@@ -24,6 +24,7 @@ class ChatCompletionRequest:',
        '     model: str',
        '     messages: list[ChatMessage]',
        '+    routing_policy: str',
        '     max_tokens: int | None = None',
        'diff --git a/new_module.py b/new_module.py',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new_module.py',
        '@@ -0,0 +1,2 @@',
        '+def thing():',
        '+    return 1',
        'diff --git a/gone.py b/gone.py',
        'deleted file mode 100644',
        '--- a/gone.py',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-was here',
    ].join('\n');
    const files = (0, diff_1.parseUnifiedDiff)(diff);
    eq('three files parsed', files.length, 3);
    eq('modified file kind', files[0].kind, 'modified');
    eq('added file kind', files[1].kind, 'added');
    eq('deleted file kind', files[2].kind, 'deleted');
    eq('added line count', files[0].added, 1);
    eq('removed line count', files[0].removed, 0);
    eq('added line text', files[0].hunks[0].addedLines[0].text, '    routing_policy: str');
    // Line numbering is what anchors a finding to the right place in the file.
    eq('added line number accounts for context', files[0].hunks[0].addedLines[0].line, 26);
    eq('new file added lines', files[1].added, 2);
    eq('deleted file removed lines', files[2].removed, 1);
}
// ---------------------------------------------------------------------------
group('graph');
// ---------------------------------------------------------------------------
{
    const config = (0, config_1.resolveConfig)({
        services: [
            { name: 'api', match: ['api/**'] },
            { name: 'engine', match: ['engine/**'] },
        ],
        adrDir: null,
        ownership: { codeowners: null },
        tests: { match: ['tests/**'] },
    }, '/repo');
    const graph = (0, graph_1.buildGraph)([
        { path: 'api/handler.py', text: 'from engine.facade import run\n' },
        { path: 'engine/facade.py', text: 'from engine.core import step\n' },
        { path: 'engine/core.py', text: 'VALUE = 1\n' },
        { path: 'tests/test_handler.py', text: 'from api.handler import run\n' },
    ], config);
    eq('four nodes', graph.nodes.size, 4);
    eq('service assigned from the map', graph.nodes.get('api/handler.py')?.service, 'api');
    check('test file flagged', graph.nodes.get('tests/test_handler.py')?.isTest === true);
    check('non-test not flagged', graph.nodes.get('api/handler.py')?.isTest === false);
    check('transitive reachability follows dependencies', (0, graph_1.reaches)(graph, 'api/handler.py', 'engine/core.py'));
    check('reachability is directional', !(0, graph_1.reaches)(graph, 'engine/core.py', 'api/handler.py'));
    // Impact flows to *dependents*. Getting this backwards is the single easiest
    // way to produce a confidently wrong blast radius.
    const radius = (0, graph_1.blastRadius)(graph, ['engine/core.py'], 3);
    check('blast radius includes a direct dependent', radius.all.has('engine/facade.py'));
    check('blast radius includes a transitive dependent', radius.all.has('api/handler.py'));
    check('blast radius reaches the test', radius.all.has('tests/test_handler.py'));
    eq('depth 1 is the direct dependent', [...(radius.byDepth.get(1) ?? [])], ['engine/facade.py']);
    const narrow = (0, graph_1.blastRadius)(graph, ['engine/core.py'], 1);
    check('depth cap is honoured', !narrow.all.has('api/handler.py'));
    check('truncation is reported', narrow.truncated === true);
    const downward = (0, graph_1.blastRadius)(graph, ['api/handler.py'], 3);
    check('changing a leaf consumer affects nothing downstream', !downward.all.has('engine/core.py'));
}
{
    const config = (0, config_1.resolveConfig)({ adrDir: null, ownership: { codeowners: null } }, '/repo');
    const cyclic = (0, graph_1.buildGraph)([
        { path: 'a.py', text: 'from b import thing\n' },
        { path: 'b.py', text: 'from c import thing\n' },
        { path: 'c.py', text: 'from a import thing\n' },
        { path: 'standalone.py', text: 'VALUE = 1\n' },
    ], config);
    const cycles = (0, graph_1.findCycles)(cyclic);
    eq('one cycle found', cycles.length, 1);
    eq('cycle members', cycles[0], ['a.py', 'b.py', 'c.py']);
    const acyclic = (0, graph_1.buildGraph)([
        { path: 'a.py', text: 'from b import thing\n' },
        { path: 'b.py', text: 'VALUE = 1\n' },
    ], config);
    eq('no false cycle', (0, graph_1.findCycles)(acyclic).length, 0);
}
// ---------------------------------------------------------------------------
group('ownership');
// ---------------------------------------------------------------------------
eq('star becomes a full wildcard', (0, owners_1.codeownersPatternToGlob)('*'), '**');
eq('bare filename matches at any depth', (0, owners_1.codeownersPatternToGlob)('*.py'), '**/*.py');
eq('anchored directory', (0, owners_1.codeownersPatternToGlob)('/vllm/'), 'vllm/**');
eq('unanchored directory with a slash stays anchored', (0, owners_1.codeownersPatternToGlob)('vllm/v1/'), 'vllm/v1/**');
{
    const text = [
        '# comment',
        '*                       @platform-eng',
        'vllm/entrypoints/       @svc-api-gateway',
        'vllm/entrypoints/openai/**/protocol.py  @svc-api-gateway @contract-council',
        '',
        'bad-line-without-owner',
    ].join('\n');
    const rules = (0, owners_1.parseCodeowners)('.github/CODEOWNERS', text);
    eq('ownerless line skipped', rules.length, 3);
    eq('line numbers recorded', rules[0].line, 2);
    const config = (0, config_1.resolveConfig)({ adrDir: null, ownership: { codeowners: '.github/CODEOWNERS', records: [] }, services: [] }, '/repo');
    const index = new owners_1.OwnershipIndex(config, text);
    // Last matching rule wins, which is the CODEOWNERS convention.
    eq('most specific (last) rule wins', index.lookup('vllm/entrypoints/openai/chat_completion/protocol.py').owners, ['@svc-api-gateway', '@contract-council']);
    eq('directory rule applies', index.lookup('vllm/entrypoints/openai/serving.py').owners, ['@svc-api-gateway']);
    eq('fallback applies', index.lookup('README.md').owners, ['@platform-eng']);
}
{
    // Explicit records beat CODEOWNERS, because a record answers "who owns this
    // component" while CODEOWNERS answers "who must approve this file".
    const config = (0, config_1.resolveConfig)({
        adrDir: null,
        services: [],
        ownership: {
            codeowners: '.github/CODEOWNERS',
            records: [{ match: ['vllm/entrypoints/**'], owners: ['@record-owner'], team: 'Records' }],
        },
    }, '/repo');
    const index = new owners_1.OwnershipIndex(config, '*  @codeowners-fallback');
    eq('records take precedence', index.lookup('vllm/entrypoints/x.py').owners, ['@record-owner']);
    eq('team is carried through', index.lookup('vllm/entrypoints/x.py').team, 'Records');
    eq('codeowners still used elsewhere', index.lookup('other/x.py').owners, ['@codeowners-fallback']);
    check('no-owner path reports nothing rather than guessing', index.unowned(['x.py']).length === 0);
}
// ---------------------------------------------------------------------------
group('ADR parsing');
// ---------------------------------------------------------------------------
{
    const adr = [
        '# ADR-0002: Contracts are versioned',
        '',
        '- **Status:** Accepted',
        '- **Owners:** @contract-council, @svc-api-gateway',
        '',
        '## Decision',
        '',
        'Prose that a machine cannot check.',
        '',
        '## Enforcement',
        '',
        '```donna',
        JSON.stringify({
            id: 'ADR-0002',
            status: 'accepted',
            owners: ['@contract-council'],
            appliesTo: ['vllm/entrypoints/**'],
            constraints: [
                {
                    id: 'needs-version',
                    kind: 'contract-change-requires-version',
                    severity: 'blocker',
                    rationale: 'because',
                    params: { surface: ['x/**'], versionRegistry: ['v.py'] },
                },
            ],
        }, null, 2),
        '```',
    ].join('\n');
    const { doc, issues } = (0, adr_1.parseAdr)('adr/ADR-0002.md', adr);
    eq('no parse issues', issues.length, 0);
    eq('id normalized', doc?.id, 'ADR-0002');
    eq('title strips the id prefix', doc?.title, 'Contracts are versioned');
    eq('status read', doc?.status, 'accepted');
    eq('one constraint', doc?.constraints.length, 1);
    eq('constraint kind', doc?.constraints[0].kind, 'contract-change-requires-version');
    check('owners merge block and prose', (doc?.owners ?? []).includes('@svc-api-gateway'));
    check('prose body retained for the model pass', (doc?.body ?? '').includes('Prose that a machine cannot check'));
    check('fenced block stripped from the body', !(doc?.body ?? '').includes('donna'));
    check('accepted ADR is active', doc ? (0, adr_1.isActive)(doc) : false);
}
{
    const superseded = [
        '# ADR-0000: Old decision',
        '- **Status:** Superseded',
        '```donna',
        JSON.stringify({
            id: 'ADR-0000',
            status: 'superseded',
            appliesTo: ['**'],
            constraints: [
                { id: 'retired', kind: 'forbidden-dependency', severity: 'blocker', rationale: '', params: { from: ['a/**'], to: ['b/**'] } },
            ],
        }),
        '```',
    ].join('\n');
    const { doc } = (0, adr_1.parseAdr)('adr/ADR-0000.md', superseded);
    check('superseded ADR is not active', doc ? !(0, adr_1.isActive)(doc) : false);
    eq('superseded ADR is excluded from relevance', (0, adr_1.relevantAdrs)(doc ? [doc] : [], ['a/x.py']).length, 0);
}
{
    const broken = ['# ADR-0009: Broken', '```donna', '{ not json at all', '```'].join('\n');
    const { doc, issues } = (0, adr_1.parseAdr)('adr/ADR-0009.md', broken);
    check('malformed block is reported', issues.some((i) => i.message.includes('not valid JSON')));
    check('document still parses so it can be cited', doc?.id === 'ADR-0009');
    eq('no constraints from a broken block', doc?.constraints.length, 0);
}
{
    const noBlock = ['# ADR-0008: Prose only', '- **Status:** Accepted', '', 'Design intent in English.'].join('\n');
    const { doc, issues } = (0, adr_1.parseAdr)('adr/ADR-0008.md', noBlock);
    check('prose-only ADR is reported as unchecked', issues.some((i) => i.message.includes('nothing in this ADR can be checked')));
    eq('prose-only ADR has no constraints', doc?.constraints.length, 0);
    check('prose-only ADR with no scope is treated as repo-wide', (0, adr_1.relevantAdrs)(doc ? [doc] : [], ['anything.py']).length === 1);
}
// ---------------------------------------------------------------------------
group('model output handling');
// ---------------------------------------------------------------------------
{
    eq('plain json parses', (0, model_1.extractJson)('{"a":1}').ok, true);
    const fenced = (0, model_1.extractJson)('Here you go:\n```json\n{"a": 2}\n```\nHope that helps.');
    check('fenced json parses', fenced.ok && fenced.value.a === 2);
    const prefixed = (0, model_1.extractJson)('Sure. {"a": 3} Done.');
    check('json embedded in prose parses', prefixed.ok && prefixed.value.a === 3);
    const braceInString = (0, model_1.extractJson)('{"a": "a } brace in a string"}');
    check('brace inside a string does not end the object', braceInString.ok && braceInString.value.a === 'a } brace in a string');
    const escaped = (0, model_1.extractJson)('{"a": "quote \\" then } brace"}');
    check('escaped quote handled', escaped.ok && escaped.value.a === 'quote " then } brace');
    check('empty response fails cleanly', !(0, model_1.extractJson)('   ').ok);
    check('non-json fails cleanly', !(0, model_1.extractJson)('I cannot help with that.').ok);
    const array = (0, model_1.extractJson)('```\n[1,2,3]\n```');
    check('array parses', array.ok && array.value.length === 3);
}
// ---------------------------------------------------------------------------
group('guardrails');
// ---------------------------------------------------------------------------
{
    const config = (0, config_1.resolveConfig)({
        adrDir: 'docs/adr',
        designDocs: ['docs/architecture.md'],
        ownership: { codeowners: '.github/CODEOWNERS', records: [] },
        tests: { expectations: 'test-expectations.json' },
        services: [],
    }, '/repo');
    const request = {
        summary: 's',
        rationale: 'r',
        addresses: [],
        suggestedTests: [],
        openQuestions: [],
        routeTo: [],
        edits: [
            { file: 'vllm/entrypoints/openai/chat_completion/protocol.py', find: 'a', replace: 'b' },
            { file: 'docs/adr/ADR-0002-contract-versioning.md', find: 'a', replace: 'b' },
            { file: '.github/CODEOWNERS', find: 'a', replace: 'b' },
            { file: 'donna.json', find: 'a', replace: 'b' },
            { file: 'test-expectations.json', find: 'a', replace: 'b' },
            { file: '.github/workflows/ci.yml', find: 'a', replace: 'b' },
            { file: 'docs/architecture.md', find: 'a', replace: 'b' },
            { file: '../outside.py', find: 'a', replace: 'b' },
            { file: 'src/ok.py', find: 'same', replace: 'same' },
        ],
    };
    const { allowed, violations } = (0, guardrails_1.checkChangeRequest)(request, config);
    eq('only the source edit is allowed', allowed.map((e) => e.file), [
        'vllm/entrypoints/openai/chat_completion/protocol.py',
    ]);
    check('ADR edit rejected', violations.some((v) => v.path.includes('ADR-0002')));
    check('CODEOWNERS edit rejected', violations.some((v) => v.path.includes('CODEOWNERS')));
    check('own config edit rejected', violations.some((v) => v.path === 'donna.json'));
    check('test expectations edit rejected', violations.some((v) => v.path === 'test-expectations.json'));
    check('CI config edit rejected', violations.some((v) => v.path.includes('workflows')));
    check('design doc edit rejected', violations.some((v) => v.path === 'docs/architecture.md'));
    check('path escape rejected', violations.some((v) => v.rule === 'path-escape'));
    check('no-op edit rejected', violations.some((v) => v.rule === 'empty-edit'));
    const adrViolation = violations.find((v) => v.path.includes('ADR-0002'));
    check('ADR rejection explains why rather than just refusing', (adrViolation?.detail ?? '').includes('measuring the change against'));
}
{
    const edit = { file: 'x.py', find: 'needle', replace: 'thread' };
    check('exact single match applies', (0, guardrails_1.validateEditAgainstFile)(edit, 'a needle b').ok);
    const absent = (0, guardrails_1.validateEditAgainstFile)(edit, 'nothing here');
    check('absent text is rejected', !absent.ok);
    check('absent text explains staleness', !absent.ok && absent.reason.includes('probably changed since the review ran'));
    const ambiguous = (0, guardrails_1.validateEditAgainstFile)(edit, 'needle and needle');
    check('ambiguous text is rejected', !ambiguous.ok);
    check('ambiguous text says how many times', !ambiguous.ok && ambiguous.reason.includes('2 times'));
    check('unreadable file is rejected', !(0, guardrails_1.validateEditAgainstFile)(edit, undefined).ok);
}
// ---------------------------------------------------------------------------
group('finding identity');
// ---------------------------------------------------------------------------
group('MCP read-only tool selection');
check('read-only search tool is allowed', (0, tools_1.isReadOnlySearchTool)('notion-search', 'Search Notion pages and databases.'));
check('GitHub code search is allowed', (0, tools_1.isReadOnlySearchTool)('search_code', 'Search repository code.', 'github'));
check('Notion does not accept a GitHub search tool', !(0, tools_1.isReadOnlySearchTool)('search_issues', 'Search issues.', 'notion'));
check('Atlassian Rovo search is allowed', (0, tools_1.isReadOnlySearchTool)('search', 'Natural language search across Jira and Confluence.', 'atlassian'));
check('Aha record lookup is not enabled as a search operation', !(0, tools_1.isReadOnlySearchTool)('get_record', 'Get an Aha! record.', 'aha'));
check('write-capable search tool is rejected', !(0, tools_1.isReadOnlySearchTool)('searchAndUpdate', 'Search records and update matching records.'));
eq('search arguments use declared fields only', (0, tools_1.buildSearchArguments)({
    properties: { query: { type: 'string' }, limit: { type: 'number' } },
    required: ['query'],
}, 'related issue'), { query: 'related issue', limit: 5 });
eq('unsupported required argument is not guessed', (0, tools_1.buildSearchArguments)({ properties: { query: { type: 'string' }, project: { type: 'string' } }, required: ['project'] }, 'related issue'), undefined);
// ---------------------------------------------------------------------------
{
    // Ids must be stable across reformatting, or the before/after comparison that
    // the whole tool depends on would treat every shifted line as a new problem.
    const a = (0, id_1.findingId)('rule', ['file.py', 'ADR-0002', 'needs-version']);
    const b = (0, id_1.findingId)('rule', ['file.py', 'ADR-0002', 'needs-version']);
    const c = (0, id_1.findingId)('rule', ['other.py', 'ADR-0002', 'needs-version']);
    eq('same inputs give the same id', a, b);
    check('different inputs give different ids', a !== c);
    check('id is prefixed by the rule', a.startsWith('rule:'));
    eq('null parts are tolerated', (0, id_1.findingId)('r', [null, undefined, 1]), (0, id_1.findingId)('r', ['', '', '1']));
}
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
    console.log(`All ${passed} assertions passed.`);
}
else {
    console.log(`${passed} passed, ${failures.length} FAILED:\n`);
    for (const failure of failures)
        console.log(`  - ${failure}`);
    process.exitCode = 1;
}
//# sourceMappingURL=run-unit.js.map