"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_LIMITS = exports.DEFAULT_TEST_MATCH = exports.DEFAULT_IGNORE = void 0;
exports.resolveConfig = resolveConfig;
exports.scaffoldConfig = scaffoldConfig;
exports.DEFAULT_IGNORE = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.venv/**',
    '**/venv/**',
    '**/__pycache__/**',
    '**/*.egg-info/**',
    '**/site-packages/**',
];
exports.DEFAULT_TEST_MATCH = [
    'tests/**',
    'test/**',
    '**/test_*.py',
    '**/*_test.py',
    '**/*.{test,spec}.{ts,tsx,js,jsx}',
];
function resolveConfig(raw, repoRoot) {
    return {
        repoRoot,
        services: raw?.services ?? [],
        adrDir: raw?.adrDir !== undefined ? raw.adrDir : 'docs/adr',
        designDocs: raw?.designDocs ?? [],
        ownership: {
            codeowners: raw?.ownership?.codeowners !== undefined ? raw.ownership.codeowners : '.github/CODEOWNERS',
            records: raw?.ownership?.records ?? [],
        },
        tests: {
            match: raw?.tests?.match ?? exports.DEFAULT_TEST_MATCH,
            integration: raw?.tests?.integration ?? ['tests/**/integration/**', '**/test_*_e2e.py'],
            expectations: raw?.tests?.expectations ?? null,
        },
        compat: raw?.compat ?? [],
        include: raw?.include ?? ['**/*.{py,pyi,ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
        ignore: raw?.ignore ?? exports.DEFAULT_IGNORE,
        accepted: raw?.accepted ?? [],
        contextPack: raw?.contextPack ?? null,
    };
}
/**
 * What the agent cannot do, rendered verbatim in the scorecard.
 *
 * This is kept in code rather than in docs because it is load-bearing: the
 * guardrail module asserts against this same list, and the panel shows it so a
 * reader never has to infer the agent's authority from its tone.
 */
exports.AGENT_LIMITS = [
    'Does not modify code. Every suggested change is a proposal for you to review.',
    'Does not create, edit or supersede architecture decision records or design docs.',
    'Does not assign or change ownership. Owners shown are read from ownership records.',
    'Does not approve, open, or merge a pull request, and does not deploy.',
    'Does not override required tests or review policy.',
    'Escalates to human design review instead of resolving a design conflict itself.',
];
/** Config the extension writes with `Donna: Create Config`. */
function scaffoldConfig() {
    const template = {
        contextPack: {
            name: 'My team context pack',
            synthetic: false,
        },
        services: [
            {
                name: 'api-gateway',
                match: ['src/api/**'],
                description: 'Public HTTP surface.',
                owners: ['@api-team'],
                dependsOn: ['orchestration', 'shared'],
            },
            {
                name: 'orchestration',
                match: ['src/orchestration/**'],
                owners: ['@platform-team'],
                dependsOn: ['shared'],
            },
            { name: 'shared', match: ['src/shared/**'], owners: ['@platform-team'], dependsOn: [] },
        ],
        adrDir: 'docs/adr',
        designDocs: ['docs/architecture.md'],
        ownership: { codeowners: '.github/CODEOWNERS', records: [] },
        tests: {
            match: exports.DEFAULT_TEST_MATCH,
            integration: ['tests/integration/**'],
            expectations: null,
        },
        compat: [
            {
                id: 'public-api-surface',
                surface: ['src/api/**/schema.*'],
                policy: 'Request and response schemas are public contracts; removals and renames are breaking.',
                versionRegistry: ['src/api/versions.*'],
                severity: 'blocker',
            },
        ],
        accepted: [],
    };
    return `${JSON.stringify(template, null, 2)}\n`;
}
//# sourceMappingURL=config.js.map