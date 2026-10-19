/**
 * Disk and git access.
 *
 * This is the only place in the analysis pipeline that performs I/O, which is
 * what lets `assess()` be a pure function of its inputs — the same scorecard
 * comes out in the extension, in the eval harness and in CI. It uses Node's
 * `fs` and `git` directly rather than the editor API so the harness can import
 * it without a VS Code runtime.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { matchAny } from './glob';
import { buildChangeSet } from './diff';
import { buildGraph, type SourceFile } from './graph';
import { resolveConfig, type RawConfig } from './config';
import { aliasesFromTsconfig, type AliasRule } from './resolve';
import { indexAdrs } from '../evidence/adr';
import { OwnershipIndex } from '../evidence/owners';
import { parseTestExpectations, type TestExpectation } from '../evidence/tests';
import type { AdrDocument, AssessmentInput, ChangeSet, DonnaConfig } from './types';

const MAX_FILE_BYTES = 2_000_000;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function walkFiles(root: string, config: DonnaConfig): string[] {
  const out: string[] = [];

  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (!rel || rel.startsWith('..')) continue;

      if (entry.isDirectory()) {
        // Prune early: checking the directory against the ignore list avoids
        // walking node_modules and .venv at all, which dominates scan time.
        if (matchAny(`${rel}/x`, config.ignore) || matchAny(rel, config.ignore)) continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (matchAny(rel, config.ignore)) continue;
      if (!matchAny(rel, config.include)) continue;
      out.push(rel);
    }
  };

  visit(root);
  return out.sort();
}

export function readTextFile(root: string, rel: string): string | undefined {
  try {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

export function loadSourceFiles(root: string, config: DonnaConfig): SourceFile[] {
  const files: SourceFile[] = [];
  for (const rel of walkFiles(root, config)) {
    const text = readTextFile(root, rel);
    if (text === undefined) continue;
    files.push({ path: rel, text });
  }
  return files;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--git-dir']) !== null;
}

export function currentBranch(root: string): string {
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
export function resolveBaseRef(root: string, preferred?: string): string | null {
  const candidates = [preferred, 'origin/main', 'main', 'origin/master', 'master'].filter(
    (c): c is string => !!c,
  );

  for (const candidate of candidates) {
    if (git(root, ['rev-parse', '--verify', '--quiet', candidate]) === null) continue;
    const mergeBase = git(root, ['merge-base', 'HEAD', candidate])?.trim();
    if (mergeBase) return mergeBase;
  }
  return null;
}

/**
 * The diff under assessment: committed work on the branch *plus* uncommitted
 * edits. An agent that has just written files has not committed them, so a
 * committed-only diff would assess nothing.
 */
export function collectDiff(root: string, baseRef: string): string {
  const parts: string[] = [];
  const committed = git(root, ['diff', '--no-color', '--find-renames', `${baseRef}...HEAD`]);
  if (committed) parts.push(committed);
  const working = git(root, ['diff', '--no-color', '--find-renames', 'HEAD']);
  if (working) parts.push(working);
  const staged = git(root, ['diff', '--no-color', '--find-renames', '--cached']);
  if (staged) parts.push(staged);

  // Untracked files are part of the change too — a new module the agent created
  // would otherwise be invisible.
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])?.trim();
  if (untracked) {
    for (const rel of untracked.split('\n').filter(Boolean)) {
      const synthetic = git(root, ['diff', '--no-color', '--no-index', '/dev/null', rel]);
      if (synthetic) parts.push(synthetic.replace('/dev/null', `a/${rel}`));
    }
  }

  return parts.join('\n');
}

export function readFileAtRef(root: string, ref: string, rel: string): string | undefined {
  const out = git(root, ['show', `${ref}:${rel}`]);
  return out ?? undefined;
}

// ---------------------------------------------------------------------------
// Config and context pack
// ---------------------------------------------------------------------------

export const CONFIG_NAMES = ['donna.json', '.donna.json'];

export function findConfigPath(root: string, extraDir?: string): string | null {
  const dirs = [extraDir, root].filter((d): d is string => !!d);
  for (const dir of dirs) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface LoadedConfig {
  config: DonnaConfig;
  configPath: string | null;
  /** Directory the config was found in — context-pack paths resolve against it. */
  packDir: string;
  issues: string[];
}

export function loadConfig(root: string, extraDir?: string): LoadedConfig {
  const issues: string[] = [];
  const configPath = findConfigPath(root, extraDir);

  let raw: RawConfig | undefined;
  if (configPath) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RawConfig;
    } catch (error) {
      issues.push(
        `${toPosix(path.relative(root, configPath)) || configPath}: not valid JSON (${(error as Error).message}). Running with defaults, which means no services, no ADRs and no compatibility rules.`,
      );
    }
  } else {
    issues.push(
      'No donna.json found. Without a service map, ADRs and ownership records, only the dependency graph and risk heuristics can contribute.',
    );
  }

  return {
    config: resolveConfig(raw, root),
    configPath,
    packDir: configPath ? path.dirname(configPath) : root,
    issues,
  };
}

export interface ContextPack {
  adrFiles: { path: string; text: string }[];
  adrs: AdrDocument[];
  adrIssues: string[];
  codeownersText: string | undefined;
  testExpectations: TestExpectation[];
  issues: string[];
}

/** Resolves a context-pack path against the pack directory, then the repo root. */
function resolvePackPath(repoRoot: string, packDir: string, rel: string): string | null {
  for (const base of [packDir, repoRoot]) {
    const candidate = path.resolve(base, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadContextPack(
  repoRoot: string,
  packDir: string,
  config: DonnaConfig,
): ContextPack {
  const issues: string[] = [];
  const adrFiles: { path: string; text: string }[] = [];

  if (config.adrDir) {
    const dir = resolvePackPath(repoRoot, packDir, config.adrDir);
    if (!dir) {
      issues.push(
        `adrDir \`${config.adrDir}\` does not exist, so design conformance could not be assessed.`,
      );
    } else {
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
        } catch (error) {
          issues.push(`${name}: could not be read (${(error as Error).message}).`);
        }
      }
    }
  }

  const { documents, issues: parseIssues } = indexAdrs(adrFiles);

  let codeownersText: string | undefined;
  if (config.ownership.codeowners) {
    const file = resolvePackPath(repoRoot, packDir, config.ownership.codeowners);
    if (file) {
      try {
        codeownersText = fs.readFileSync(file, 'utf8');
      } catch {
        issues.push(`${config.ownership.codeowners}: could not be read.`);
      }
    } else if (config.ownership.records.length === 0) {
      issues.push(
        `No CODEOWNERS at \`${config.ownership.codeowners}\` and no ownership records configured, so reviewer routing has nothing to work from.`,
      );
    }
  }

  let testExpectations: TestExpectation[] = [];
  if (config.tests.expectations) {
    const file = resolvePackPath(repoRoot, packDir, config.tests.expectations);
    if (!file) {
      issues.push(`Test expectations file \`${config.tests.expectations}\` does not exist.`);
    } else {
      const parsed = parseTestExpectations(
        config.tests.expectations,
        fs.readFileSync(file, 'utf8'),
      );
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

function loadTsAliases(root: string): AliasRule[] {
  const tsconfigPath = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return [];
  try {
    // Strip comments and trailing commas — tsconfig is JSON with extras.
    const text = fs
      .readFileSync(tsconfigPath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    const parsed = JSON.parse(text) as {
      compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string };
    };
    return aliasesFromTsconfig(
      parsed.compilerOptions?.paths,
      parsed.compilerOptions?.baseUrl,
      '',
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface PreparedAssessment {
  input: AssessmentInput;
  loadIssues: string[];
  adrFiles: { path: string; text: string }[];
  testExpectations: TestExpectation[];
}

export interface PrepareOptions {
  repoRoot: string;
  /** Directory holding donna.json, when the context pack lives outside the repo. */
  packDir?: string;
  /** Explicit base ref; otherwise the merge base with the default branch. */
  baseRef?: string;
  /**
   * A pre-built diff, for scenario replay and for assessing a change the
   * working tree does not contain. When given, git is not consulted for the
   * diff, but base-revision reads still go through git when available.
   */
  diffText?: string;
  /** Overlay of file contents, so a scenario can be assessed without writing to disk. */
  overlay?: Map<string, string>;
  /** Base-revision contents for the overlay case. */
  baseOverlay?: Map<string, string>;
}

export function prepareAssessment(options: PrepareOptions): PreparedAssessment {
  const repoRoot = options.repoRoot;
  const loaded = loadConfig(repoRoot, options.packDir);
  const config = loaded.config;

  const pack = loadContextPack(repoRoot, options.packDir ?? loaded.packDir, config);

  // Source files, with the overlay applied so a scenario's post-change state is
  // what gets analyzed.
  const diskFiles = loadSourceFiles(repoRoot, config);
  const byPath = new Map(diskFiles.map((f) => [f.path, f.text]));
  if (options.overlay) {
    for (const [rel, text] of options.overlay) byPath.set(rel, text);
  }
  const files: SourceFile[] = [...byPath].map(([p, text]) => ({ path: p, text }));

  const graph = buildGraph(files, config, loadTsAliases(repoRoot));

  // Change set.
  const hasGit = isGitRepo(repoRoot);
  const baseRef = options.baseRef ?? (hasGit ? resolveBaseRef(repoRoot) : null);
  const branch = hasGit ? currentBranch(repoRoot) : 'working-tree';

  let diffText = options.diffText;
  if (diffText === undefined) {
    if (!hasGit) {
      loaded.issues.push(
        'Not a git repository, so no diff could be read. Supply a diff explicitly to assess a change.',
      );
      diffText = '';
    } else if (!baseRef) {
      loaded.issues.push(
        'Could not resolve a base ref (tried origin/main, main, origin/master, master). The change set is empty, so nothing was assessed.',
      );
      diffText = '';
    } else {
      diffText = collectDiff(repoRoot, baseRef);
    }
  }

  const change: ChangeSet = buildChangeSet(diffText, {
    baseRef: baseRef ?? '(none)',
    headRef: 'HEAD',
    branch,
  });

  const ownership = new OwnershipIndex(config, pack.codeownersText);

  const input: AssessmentInput = {
    config,
    graph,
    change,
    adrs: pack.adrs,
    ownersOf: (p) => ownership.lookup(p),
    readFile: (p) => byPath.get(p) ?? readTextFile(repoRoot, p),
    readBaseFile: (p) => {
      if (options.baseOverlay?.has(p)) return options.baseOverlay.get(p);
      if (!hasGit || !baseRef) return undefined;
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
