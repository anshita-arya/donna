"use strict";
/**
 * Disk and git access.
 *
 * This is the only place in the analysis pipeline that performs I/O, which is
 * what lets `assess()` be a pure function of its inputs — the same scorecard
 * comes out in the extension, in the eval harness and in CI. It uses Node's
 * `fs` and `git` directly rather than the editor API so the harness can import
 * it without a VS Code runtime.
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
exports.CONFIG_NAMES = void 0;
exports.walkFiles = walkFiles;
exports.readTextFile = readTextFile;
exports.loadSourceFiles = loadSourceFiles;
exports.isGitRepo = isGitRepo;
exports.currentBranch = currentBranch;
exports.resolveBaseRef = resolveBaseRef;
exports.collectDiff = collectDiff;
exports.readFileAtRef = readFileAtRef;
exports.findConfigPath = findConfigPath;
exports.loadConfig = loadConfig;
exports.loadContextPack = loadContextPack;
exports.prepareAssessment = prepareAssessment;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const glob_1 = require("./glob");
const diff_1 = require("./diff");
const graph_1 = require("./graph");
const config_1 = require("./config");
const resolve_1 = require("./resolve");
const adr_1 = require("../evidence/adr");
const owners_1 = require("../evidence/owners");
const tests_1 = require("../evidence/tests");
const MAX_FILE_BYTES = 2_000_000;
function toPosix(p) {
    return p.split(path.sep).join('/');
}
function walkFiles(root, config) {
    const out = [];
    const visit = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            const rel = toPosix(path.relative(root, abs));
            if (!rel || rel.startsWith('..'))
                continue;
            if (entry.isDirectory()) {
                // Prune early: checking the directory against the ignore list avoids
                // walking node_modules and .venv at all, which dominates scan time.
                if ((0, glob_1.matchAny)(`${rel}/x`, config.ignore) || (0, glob_1.matchAny)(rel, config.ignore))
                    continue;
                visit(abs);
                continue;
            }
            if (!entry.isFile())
                continue;
            if ((0, glob_1.matchAny)(rel, config.ignore))
                continue;
            if (!(0, glob_1.matchAny)(rel, config.include))
                continue;
            out.push(rel);
        }
    };
    visit(root);
    return out.sort();
}
function readTextFile(root, rel) {
    try {
        const abs = path.join(root, rel);
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
            return undefined;
        return fs.readFileSync(abs, 'utf8');
    }
    catch {
        return undefined;
    }
}
function loadSourceFiles(root, config) {
    const files = [];
    for (const rel of walkFiles(root, config)) {
        const text = readTextFile(root, rel);
        if (text === undefined)
            continue;
        files.push({ path: rel, text });
    }
    return files;
}
// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------
function git(root, args) {
    try {
        return (0, node_child_process_1.execFileSync)('git', ['-C', root, ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    }
    catch {
        return null;
    }
}
function isGitRepo(root) {
    return git(root, ['rev-parse', '--git-dir']) !== null;
}
function currentBranch(root) {
    return git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || 'HEAD';
}
/**
 * Picks the ref to compare against.
 *
 * The merge base with the default branch is the right baseline: comparing with
 * the tip would attribute everyone else's commits to this developer's change,
 * and comparing with HEAD would miss everything they have already committed on
 * the branch. We try the configured base, then common default-branch names.
 */
function resolveBaseRef(root, preferred) {
    const candidates = [preferred, 'origin/main', 'main', 'origin/master', 'master'].filter((c) => !!c);
    for (const candidate of candidates) {
        if (git(root, ['rev-parse', '--verify', '--quiet', candidate]) === null)
            continue;
        const mergeBase = git(root, ['merge-base', 'HEAD', candidate])?.trim();
        if (mergeBase)
            return mergeBase;
    }
    return null;
}
/**
 * The diff under assessment: committed work on the branch *plus* uncommitted
 * edits. An agent that has just written files has not committed them, so a
 * committed-only diff would assess nothing.
 */
function collectDiff(root, baseRef) {
    const parts = [];
    const committed = git(root, ['diff', '--no-color', '--find-renames', `${baseRef}...HEAD`]);
    if (committed)
        parts.push(committed);
    const working = git(root, ['diff', '--no-color', '--find-renames', 'HEAD']);
    if (working)
        parts.push(working);
    const staged = git(root, ['diff', '--no-color', '--find-renames', '--cached']);
    if (staged)
        parts.push(staged);
    // Untracked files are part of the change too — a new module the agent created
    // would otherwise be invisible.
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])?.trim();
    if (untracked) {
        for (const rel of untracked.split('\n').filter(Boolean)) {
            const synthetic = git(root, ['diff', '--no-color', '--no-index', '/dev/null', rel]);
            if (synthetic)
                parts.push(synthetic.replace('/dev/null', `a/${rel}`));
        }
    }
    return parts.join('\n');
}
function readFileAtRef(root, ref, rel) {
    const out = git(root, ['show', `${ref}:${rel}`]);
    return out ?? undefined;
}
// ---------------------------------------------------------------------------
// Config and context pack
// ---------------------------------------------------------------------------
exports.CONFIG_NAMES = ['donna.json', '.donna.json'];
function findConfigPath(root, extraDir) {
    const dirs = [extraDir, root].filter((d) => !!d);
    for (const dir of dirs) {
        for (const name of exports.CONFIG_NAMES) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate))
                return candidate;
        }
    }
    return null;
}
function loadConfig(root, extraDir) {
    const issues = [];
    const configPath = findConfigPath(root, extraDir);
    let raw;
    if (configPath) {
        try {
            raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        catch (error) {
            issues.push(`${toPosix(path.relative(root, configPath)) || configPath}: not valid JSON (${error.message}). Running with defaults, which means no services, no ADRs and no compatibility rules.`);
        }
    }
    else {
        issues.push('No donna.json found. Without a service map, ADRs and ownership records, only the dependency graph and risk heuristics can contribute.');
    }
    return {
        config: (0, config_1.resolveConfig)(raw, root),
        configPath,
        packDir: configPath ? path.dirname(configPath) : root,
        issues,
    };
}
/** Resolves a context-pack path against the pack directory, then the repo root. */
function resolvePackPath(repoRoot, packDir, rel) {
    for (const base of [packDir, repoRoot]) {
        const candidate = path.resolve(base, rel);
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
function loadContextPack(repoRoot, packDir, config) {
    const issues = [];
    const adrFiles = [];
    if (config.adrDir) {
        const dir = resolvePackPath(repoRoot, packDir, config.adrDir);
        if (!dir) {
            issues.push(`adrDir \`${config.adrDir}\` does not exist, so design conformance could not be assessed.`);
        }
        else {
            const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
            const markdown = entries.filter((f) => f.endsWith('.md')).sort();
            if (markdown.length === 0) {
                issues.push(`adrDir \`${config.adrDir}\` contains no markdown files.`);
            }
            for (const name of markdown) {
                try {
                    adrFiles.push({
                        path: toPosix(path.join(config.adrDir, name)),
                        text: fs.readFileSync(path.join(dir, name), 'utf8'),
                    });
                }
                catch (error) {
                    issues.push(`${name}: could not be read (${error.message}).`);
                }
            }
        }
    }
    const { documents, issues: parseIssues } = (0, adr_1.indexAdrs)(adrFiles);
    let codeownersText;
    if (config.ownership.codeowners) {
        const file = resolvePackPath(repoRoot, packDir, config.ownership.codeowners);
        if (file) {
            try {
                codeownersText = fs.readFileSync(file, 'utf8');
            }
            catch {
                issues.push(`${config.ownership.codeowners}: could not be read.`);
            }
        }
        else if (config.ownership.records.length === 0) {
            issues.push(`No CODEOWNERS at \`${config.ownership.codeowners}\` and no ownership records configured, so reviewer routing has nothing to work from.`);
        }
    }
    let testExpectations = [];
    if (config.tests.expectations) {
        const file = resolvePackPath(repoRoot, packDir, config.tests.expectations);
        if (!file) {
            issues.push(`Test expectations file \`${config.tests.expectations}\` does not exist.`);
        }
        else {
            const parsed = (0, tests_1.parseTestExpectations)(config.tests.expectations, fs.readFileSync(file, 'utf8'));
            testExpectations = parsed.expectations;
            issues.push(...parsed.issues);
        }
    }
    return {
        adrFiles,
        adrs: documents,
        adrIssues: parseIssues.map((i) => `${i.path}: ${i.message}`),
        codeownersText,
        testExpectations,
        issues,
    };
}
function loadTsAliases(root) {
    const tsconfigPath = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath))
        return [];
    try {
        // Strip comments and trailing commas — tsconfig is JSON with extras.
        const text = fs
            .readFileSync(tsconfigPath, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1')
            .replace(/,(\s*[}\]])/g, '$1');
        const parsed = JSON.parse(text);
        return (0, resolve_1.aliasesFromTsconfig)(parsed.compilerOptions?.paths, parsed.compilerOptions?.baseUrl, '');
    }
    catch {
        return [];
    }
}
function prepareAssessment(options) {
    const repoRoot = options.repoRoot;
    const loaded = loadConfig(repoRoot, options.packDir);
    const config = loaded.config;
    const pack = loadContextPack(repoRoot, options.packDir ?? loaded.packDir, config);
    // Source files, with the overlay applied so a scenario's post-change state is
    // what gets analyzed.
    const diskFiles = loadSourceFiles(repoRoot, config);
    const byPath = new Map(diskFiles.map((f) => [f.path, f.text]));
    if (options.overlay) {
        for (const [rel, text] of options.overlay)
            byPath.set(rel, text);
    }
    const files = [...byPath].map(([p, text]) => ({ path: p, text }));
    const graph = (0, graph_1.buildGraph)(files, config, loadTsAliases(repoRoot));
    // Change set.
    const hasGit = isGitRepo(repoRoot);
    const baseRef = options.baseRef ?? (hasGit ? resolveBaseRef(repoRoot) : null);
    const branch = hasGit ? currentBranch(repoRoot) : 'working-tree';
    let diffText = options.diffText;
    if (diffText === undefined) {
        if (!hasGit) {
            loaded.issues.push('Not a git repository, so no diff could be read. Supply a diff explicitly to assess a change.');
            diffText = '';
        }
        else if (!baseRef) {
            loaded.issues.push('Could not resolve a base ref (tried origin/main, main, origin/master, master). The change set is empty, so nothing was assessed.');
            diffText = '';
        }
        else {
            diffText = collectDiff(repoRoot, baseRef);
        }
    }
    const change = (0, diff_1.buildChangeSet)(diffText, {
        baseRef: baseRef ?? '(none)',
        headRef: 'HEAD',
        branch,
    });
    const ownership = new owners_1.OwnershipIndex(config, pack.codeownersText);
    const input = {
        config,
        graph,
        change,
        adrs: pack.adrs,
        ownersOf: (p) => ownership.lookup(p),
        readFile: (p) => byPath.get(p) ?? readTextFile(repoRoot, p),
        readBaseFile: (p) => {
            if (options.baseOverlay?.has(p))
                return options.baseOverlay.get(p);
            if (!hasGit || !baseRef)
                return undefined;
            return readFileAtRef(repoRoot, baseRef, p);
        },
    };
    return {
        input,
        loadIssues: [...loaded.issues, ...pack.issues, ...pack.adrIssues],
        adrFiles: pack.adrFiles,
        testExpectations: pack.testExpectations,
    };
}
//# sourceMappingURL=workspace.js.map