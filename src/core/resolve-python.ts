/**
 * Python import resolution against the set of files we scanned.
 *
 * Resolving against a known file set rather than `sys.path` keeps this
 * deterministic and side-effect free — we never import the target module, so a
 * repo that cannot be installed is still analyzable.
 */

import type { PyImport } from './scan-python';

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function parentDir(p: string, times: number): string {
  let cursor = p;
  for (let i = 0; i < times; i++) cursor = dirname(cursor);
  return cursor;
}

export class PythonResolver {
  private readonly files: Set<string>;

  constructor(
    files: Iterable<string>,
    /** Directories a top-level package may live under, e.g. `['', 'src']`. */
    private readonly sourceRoots: string[] = ['', 'src'],
  ) {
    this.files = new Set(files);
  }

  /**
   * Resolves one import statement to zero or more repo files.
   *
   * `from pkg import mod` yields an edge to `pkg/mod.py` when that submodule
   * exists, because importing a name out of a package is a dependency on
   * whatever defines it — missing this is how dependency graphs under-report
   * coupling in Python repos.
   */
  resolve(importerPath: string, imp: PyImport): string[] {
    const bases = this.baseCandidates(importerPath, imp);
    const hits = new Set<string>();

    for (const base of bases) {
      const direct = this.moduleToFile(base);
      if (direct) hits.add(direct);

      if (imp.form === 'from') {
        for (const name of imp.names) {
          if (name === '*') continue;
          const submodule = this.moduleToFile(base ? `${base}.${name}` : name);
          if (submodule) hits.add(submodule);
        }
      }
    }

    hits.delete(importerPath);
    return [...hits];
  }

  /** Dotted module candidates this import could refer to. */
  private baseCandidates(importerPath: string, imp: PyImport): string[] {
    const stripped = imp.module.replace(/^\.+/, '');

    if (imp.level === 0) {
      return [stripped];
    }

    // `from . import x` inside `a/b/c.py`: level 1 means package `a/b`.
    const pkgDir = parentDir(dirname(importerPath), imp.level - 1);
    const asDots = pkgDir ? pkgDir.split('/').join('.') : '';
    const combined = stripped ? (asDots ? `${asDots}.${stripped}` : stripped) : asDots;
    return combined ? [combined] : [];
  }

  /** Dotted path -> repo file, trying each source root and both module shapes. */
  private moduleToFile(dotted: string): string | null {
    if (!dotted) return null;
    const rel = dotted.split('.').join('/');

    for (const root of this.sourceRoots) {
      const prefix = root ? `${root}/` : '';
      const asModule = `${prefix}${rel}.py`;
      if (this.files.has(asModule)) return asModule;
      const asPackage = `${prefix}${rel}/__init__.py`;
      if (this.files.has(asPackage)) return asPackage;
      const asStub = `${prefix}${rel}.pyi`;
      if (this.files.has(asStub)) return asStub;
    }
    return null;
  }

  /** True when the dotted path resolves nowhere in the repo — a third party. */
  isExternal(importerPath: string, imp: PyImport): boolean {
    return this.resolve(importerPath, imp).length === 0;
  }
}

/** Derives the dotted module name a repo file would be imported as. */
export function fileToModule(path: string, sourceRoots: string[] = ['', 'src']): string {
  let rel = path;
  for (const root of sourceRoots) {
    if (!root) continue;
    const prefix = `${root}/`;
    if (rel.startsWith(prefix)) {
      rel = rel.slice(prefix.length);
      break;
    }
  }
  rel = rel.replace(/\.pyi?$/, '');
  if (rel.endsWith('/__init__')) rel = rel.slice(0, -'/__init__'.length);
  return rel.split('/').join('.');
}
