/**
 * Specifier resolution against the set of files we actually scanned.
 *
 * We resolve against a known file set rather than the filesystem, so the same
 * code works in the extension, in tests, and against an in-memory snapshot of
 * the agent's unsaved buffers.
 */

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_NAMES = EXTENSIONS.map((e) => `index${e}`);

export interface AliasRule {
  /** Prefix before the `*`, e.g. `@/`. Empty `*` alias means match everything. */
  prefix: string;
  /** Candidate target prefixes, e.g. [`src/`]. */
  targets: string[];
  /** True when the pattern had no `*` and must match exactly. */
  exact: boolean;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

function stripJsExt(p: string): string | null {
  const m = /^(.*)\.(js|jsx|mjs|cjs)$/.exec(p);
  return m ? m[1] : null;
}

export class Resolver {
  private readonly files: Set<string>;

  constructor(
    files: Iterable<string>,
    private readonly aliases: AliasRule[] = [],
  ) {
    this.files = new Set(files);
  }

  /** Returns the resolved workspace-relative path, or `null` for externals. */
  resolve(importerPath: string, specifier: string): string | null {
    if (specifier.startsWith('.')) {
      const base = normalizePath(`${dirname(importerPath)}/${specifier}`);
      return this.tryPath(base);
    }

    if (specifier.startsWith('/')) {
      return this.tryPath(normalizePath(specifier));
    }

    for (const alias of this.aliases) {
      if (alias.exact) {
        if (specifier !== alias.prefix) continue;
        for (const target of alias.targets) {
          const hit = this.tryPath(normalizePath(target));
          if (hit) return hit;
        }
        continue;
      }
      if (!specifier.startsWith(alias.prefix)) continue;
      const rest = specifier.slice(alias.prefix.length);
      for (const target of alias.targets) {
        const hit = this.tryPath(normalizePath(target + rest));
        if (hit) return hit;
      }
    }

    return null;
  }

  private tryPath(base: string): string | null {
    if (!base) return null;
    if (this.files.has(base)) return base;

    // `./foo.js` in ESM/NodeNext source actually means `./foo.ts`.
    const withoutJs = stripJsExt(base);
    if (withoutJs) {
      for (const ext of EXTENSIONS) {
        if (this.files.has(withoutJs + ext)) return withoutJs + ext;
      }
    }

    for (const ext of EXTENSIONS) {
      if (this.files.has(base + ext)) return base + ext;
    }
    for (const index of INDEX_NAMES) {
      const candidate = `${base}/${index}`;
      if (this.files.has(candidate)) return candidate;
    }
    return null;
  }
}

/** Turns a tsconfig `paths` map plus `baseUrl` into alias rules. */
export function aliasesFromTsconfig(
  paths: Record<string, string[]> | undefined,
  baseUrl: string | undefined,
  tsconfigDir: string,
): AliasRule[] {
  if (!paths) return [];
  const root = normalizePath(`${tsconfigDir}/${baseUrl ?? '.'}`);
  const rules: AliasRule[] = [];

  for (const [pattern, targets] of Object.entries(paths)) {
    const starIndex = pattern.indexOf('*');
    const resolvedTargets = targets.map((t) => {
      const cleaned = t.replace('*', '');
      return normalizePath(`${root}/${cleaned}`) + (cleaned.endsWith('/') ? '' : '');
    });

    if (starIndex === -1) {
      rules.push({ prefix: pattern, targets: resolvedTargets, exact: true });
    } else {
      rules.push({ prefix: pattern.slice(0, starIndex), targets: resolvedTargets, exact: false });
    }
  }

  // Longest prefix first, so `@app/ui/*` wins over `@app/*`.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  return rules;
}
