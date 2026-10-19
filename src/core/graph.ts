import { matchAny } from './glob';
import { Resolver, type AliasRule } from './resolve';
import { PythonResolver } from './resolve-python';
import { scanSource } from './scan';
import { scanPython } from './scan-python';
import type { Edge, GraphSnapshot, Language, DonnaConfig, ModuleNode } from './types';

export interface SourceFile {
  /** Repo-relative, POSIX separators. */
  path: string;
  text: string;
}

const PY_EXT = /\.pyi?$/;
const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function languageOf(path: string): Language | null {
  if (PY_EXT.test(path)) return 'python';
  if (TS_EXT.test(path)) return 'typescript';
  return null;
}

export function serviceOf(path: string, config: DonnaConfig): string | null {
  for (const service of config.services) {
    if (matchAny(path, service.match)) return service.name;
  }
  return null;
}

export function buildGraph(
  files: SourceFile[],
  config: DonnaConfig,
  aliases: AliasRule[] = [],
): GraphSnapshot {
  const kept = files.filter(
    (f) => languageOf(f.path) !== null && !matchAny(f.path, config.ignore),
  );
  const paths = kept.map((f) => f.path);

  const tsResolver = new Resolver(paths, aliases);
  const pyResolver = new PythonResolver(paths);

  const nodes = new Map<string, ModuleNode>();

  for (const file of kept) {
    const language = languageOf(file.path)!;
    const importLines: Record<string, number> = {};
    const externals: string[] = [];
    let exports: string[] = [];
    let loc = 0;

    if (language === 'python') {
      const scan = scanPython(file.text);
      loc = scan.loc;
      exports = scan.exports;
      for (const imp of scan.imports) {
        const targets = pyResolver.resolve(file.path, imp);
        if (targets.length === 0) {
          if (imp.level === 0) externals.push(imp.module);
          continue;
        }
        for (const target of targets) {
          if (importLines[target] === undefined) importLines[target] = imp.line;
        }
      }
    } else {
      const scan = scanSource(file.text);
      loc = scan.loc;
      exports = [];
      for (const imp of scan.imports) {
        const target = tsResolver.resolve(file.path, imp.specifier);
        if (!target) {
          externals.push(imp.specifier);
          continue;
        }
        if (target === file.path) continue;
        if (importLines[target] === undefined) importLines[target] = imp.line;
      }
      // The TS scanner reports a count rather than names; synthesize a stable
      // placeholder list so downstream code can treat `exports` uniformly.
      exports = Array.from({ length: scan.exportCount }, (_, i) => `export#${i + 1}`);
    }

    nodes.set(file.path, {
      path: file.path,
      language,
      service: serviceOf(file.path, config),
      loc,
      exports,
      importLines,
      externals: [...new Set(externals)],
      isTest: matchAny(file.path, config.tests.match),
    });
  }

  const edges: Edge[] = [];
  const dependents = new Map<string, Set<string>>();
  const dependencies = new Map<string, Set<string>>();

  for (const node of nodes.values()) {
    const deps = new Set<string>();
    for (const [target, line] of Object.entries(node.importLines)) {
      if (!nodes.has(target)) continue;
      edges.push({ from: node.path, to: target, line });
      deps.add(target);
      let back = dependents.get(target);
      if (!back) {
        back = new Set();
        dependents.set(target, back);
      }
      back.add(node.path);
    }
    dependencies.set(node.path, deps);
  }

  for (const path of nodes.keys()) {
    if (!dependents.has(path)) dependents.set(path, new Set());
  }

  return { nodes, edges, dependents, dependencies };
}

/** Tarjan SCC, iterative. Components of size > 1 are import cycles. */
export function findCycles(graph: GraphSnapshot): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const components: string[][] = [];

  for (const root of graph.nodes.keys()) {
    if (indices.has(root)) continue;

    type Frame = { node: string; iter: Iterator<string> };
    const frames: Frame[] = [];

    const push = (node: string) => {
      indices.set(node, index);
      low.set(node, index);
      index++;
      stack.push(node);
      onStack.add(node);
      frames.push({ node, iter: (graph.dependencies.get(node) ?? new Set()).values() });
    };

    push(root);

    while (frames.length) {
      const frame = frames[frames.length - 1];
      const step = frame.iter.next();

      if (!step.done) {
        const next = step.value;
        if (!graph.nodes.has(next)) continue;
        if (!indices.has(next)) push(next);
        else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, indices.get(next)!));
        }
        continue;
      }

      frames.pop();

      if (low.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.node);
        if (component.length > 1) components.push(component.sort());
      }

      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
    }
  }

  return components;
}

/** Shortest dependency path from `from` to `to`, or `null`. */
export function shortestPath(graph: GraphSnapshot, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const queue: string[] = [from];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);

  while (queue.length) {
    const current = queue.shift()!;
    for (const next of graph.dependencies.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, current);
      if (next === to) {
        const path = [to];
        let cursor = to;
        while (prev.has(cursor)) {
          cursor = prev.get(cursor)!;
          path.push(cursor);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/** True when `from` can reach `to` through any chain of imports. */
export function reaches(graph: GraphSnapshot, from: string, to: string): boolean {
  return shortestPath(graph, from, to) !== null;
}

export interface BlastRadius {
  /** The changed files themselves, restricted to ones in the graph. */
  seed: Set<string>;
  /** Modules that depend on a seed module, by hop distance (1 = direct). */
  byDepth: Map<number, Set<string>>;
  /** Everything reachable upward from the seed, within `maxDepth`. */
  all: Set<string>;
  /** True when the traversal stopped at `maxDepth` with frontier remaining. */
  truncated: boolean;
}

/**
 * Who is affected by a change: dependents, transitively.
 *
 * Direction matters and is easy to get backwards. A change to module M can
 * break whatever *imports* M, so the traversal follows `dependents`, not
 * `dependencies`. Depth is capped because in a large repo the transitive
 * dependent set of a core module is "everything", which is true but useless —
 * the hop distance is what tells the developer how far to actually look.
 */
export function blastRadius(
  graph: GraphSnapshot,
  changed: Iterable<string>,
  maxDepth = 3,
): BlastRadius {
  const seed = new Set<string>();
  for (const path of changed) {
    if (graph.nodes.has(path)) seed.add(path);
  }

  const all = new Set(seed);
  const byDepth = new Map<number, Set<string>>();
  let frontier = new Set(seed);
  let truncated = false;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = new Set<string>();
    for (const path of frontier) {
      for (const dependent of graph.dependents.get(path) ?? []) {
        if (all.has(dependent)) continue;
        all.add(dependent);
        next.add(dependent);
      }
    }
    if (next.size === 0) break;
    byDepth.set(depth, next);
    frontier = next;
    if (depth === maxDepth && next.size > 0) {
      // Check whether anything would have been added at depth+1.
      for (const path of next) {
        for (const dependent of graph.dependents.get(path) ?? []) {
          if (!all.has(dependent)) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
    }
  }

  return { seed, byDepth, all, truncated };
}
