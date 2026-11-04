/**
 * Ownership resolution.
 *
 * CODEOWNERS is the single source of truth for file ownership. Donna reads it
 * without changing it and never guesses ownership from git history.
 */

import { matchGlob } from '../core/glob';
import type { Evidence } from '../core/types';

export interface OwnerRule {
  /** The original pattern, for evidence. */
  pattern: string;
  glob: string;
  owners: string[];
  team?: string;
  source: 'codeowners';
  /** 1-based line in the source file, when known. */
  line?: number;
  sourcePath: string;
}

/**
 * Converts a CODEOWNERS pattern to a glob.
 *
 * CODEOWNERS uses gitignore-style matching: a pattern with no slash matches at
 * any depth, a leading slash anchors to the repo root, and a trailing slash
 * means "everything under this directory".
 */
export function codeownersPatternToGlob(pattern: string): string {
  let p = pattern.trim();
  if (p === '*') return '**';

  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);

  const isDir = p.endsWith('/');
  if (isDir) p = p.slice(0, -1);

  const hasInnerSlash = p.includes('/');

  if (isDir) p = `${p}/**`;
  if (!anchored && !hasInnerSlash) p = `**/${p}`;

  return p;
}

export function parseCodeowners(path: string, text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const withoutComment = line.replace(/#.*$/, '').trim();
    if (!withoutComment) continue;

    const parts = withoutComment.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1).filter((p) => p.startsWith('@') || p.includes('@'));
    if (!pattern || owners.length === 0) continue;

    rules.push({
      pattern,
      glob: codeownersPatternToGlob(pattern),
      owners,
      source: 'codeowners',
      line: i + 1,
      sourcePath: path,
    });
  }

  return rules;
}

export interface OwnerLookup {
  owners: string[];
  team?: string;
  source: Evidence | null;
}

export class OwnershipIndex {
  private readonly codeownerRules: OwnerRule[] = [];
  private readonly cache = new Map<string, OwnerLookup>();

  constructor(codeownersText: string | undefined, codeownersPath = 'CODEOWNERS') {
    if (codeownersText) {
      this.codeownerRules.push(...parseCodeowners(codeownersPath, codeownersText));
    }
  }

  /**
   * Resolves one path. Within a source, the last matching rule wins, which is
   * the CODEOWNERS convention and the least surprising for records too.
   */
  lookup(path: string): OwnerLookup {
    const cached = this.cache.get(path);
    if (cached) return cached;

    const result = this.resolve(path);
    this.cache.set(path, result);
    return result;
  }

  private resolve(path: string): OwnerLookup {
    let hit: OwnerRule | null = null;
    for (const rule of this.codeownerRules) {
      if (matchGlob(path, rule.glob)) hit = rule;
    }
    if (hit) {
      return {
        owners: hit.owners,
        source: {
          kind: 'ownership',
          ref: hit.sourcePath,
          line: hit.line,
          excerpt: `${hit.pattern} ${hit.owners.join(' ')}`,
          note: 'from CODEOWNERS',
        },
      };
    }

    return { owners: [], source: null };
  }

  /** True when no source names an owner for any of these paths. */
  unowned(paths: Iterable<string>): string[] {
    const out: string[] = [];
    for (const path of paths) {
      if (this.lookup(path).owners.length === 0) out.push(path);
    }
    return out;
  }

  get hasAnyRules(): boolean {
    return this.codeownerRules.length > 0;
  }
}
