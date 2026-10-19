"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.languageOf = languageOf;
exports.serviceOf = serviceOf;
exports.buildGraph = buildGraph;
exports.findCycles = findCycles;
exports.shortestPath = shortestPath;
exports.reaches = reaches;
exports.blastRadius = blastRadius;
const glob_1 = require("./glob");
const resolve_1 = require("./resolve");
const resolve_python_1 = require("./resolve-python");
const scan_1 = require("./scan");
const scan_python_1 = require("./scan-python");
const PY_EXT = /\.pyi?$/;
const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function languageOf(path) {
    if (PY_EXT.test(path))
        return 'python';
    if (TS_EXT.test(path))
        return 'typescript';
    return null;
}
function serviceOf(path, config) {
    for (const service of config.services) {
        if ((0, glob_1.matchAny)(path, service.match))
            return service.name;
    }
    return null;
}
function buildGraph(files, config, aliases = []) {
    const kept = files.filter((f) => languageOf(f.path) !== null && !(0, glob_1.matchAny)(f.path, config.ignore));
    const paths = kept.map((f) => f.path);
    const tsResolver = new resolve_1.Resolver(paths, aliases);
    const pyResolver = new resolve_python_1.PythonResolver(paths);
    const nodes = new Map();
    for (const file of kept) {
        const language = languageOf(file.path);
        const importLines = {};
        const externals = [];
        let exports = [];
        let loc = 0;
        if (language === 'python') {
            const scan = (0, scan_python_1.scanPython)(file.text);
            loc = scan.loc;
            exports = scan.exports;
            for (const imp of scan.imports) {
                const targets = pyResolver.resolve(file.path, imp);
                if (targets.length === 0) {
                    if (imp.level === 0)
                        externals.push(imp.module);
                    continue;
                }
                for (const target of targets) {
                    if (importLines[target] === undefined)
                        importLines[target] = imp.line;
                }
            }
        }
        else {
            const scan = (0, scan_1.scanSource)(file.text);
            loc = scan.loc;
            exports = [];
            for (const imp of scan.imports) {
                const target = tsResolver.resolve(file.path, imp.specifier);
                if (!target) {
                    externals.push(imp.specifier);
                    continue;
                }
                if (target === file.path)
                    continue;
                if (importLines[target] === undefined)
                    importLines[target] = imp.line;
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
            isTest: (0, glob_1.matchAny)(file.path, config.tests.match),
        });
    }
    const edges = [];
    const dependents = new Map();
    const dependencies = new Map();
    for (const node of nodes.values()) {
        const deps = new Set();
        for (const [target, line] of Object.entries(node.importLines)) {
            if (!nodes.has(target))
                continue;
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
        if (!dependents.has(path))
            dependents.set(path, new Set());
    }
    return { nodes, edges, dependents, dependencies };
}
/** Tarjan SCC, iterative. Components of size > 1 are import cycles. */
function findCycles(graph) {
    let index = 0;
    const stack = [];
    const onStack = new Set();
    const indices = new Map();
    const low = new Map();
    const components = [];
    for (const root of graph.nodes.keys()) {
        if (indices.has(root))
            continue;
        const frames = [];
        const push = (node) => {
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
                if (!graph.nodes.has(next))
                    continue;
                if (!indices.has(next))
                    push(next);
                else if (onStack.has(next)) {
                    low.set(frame.node, Math.min(low.get(frame.node), indices.get(next)));
                }
                continue;
            }
            frames.pop();
            if (low.get(frame.node) === indices.get(frame.node)) {
                const component = [];
                let popped;
                do {
                    popped = stack.pop();
                    onStack.delete(popped);
                    component.push(popped);
                } while (popped !== frame.node);
                if (component.length > 1)
                    components.push(component.sort());
            }
            const parent = frames[frames.length - 1];
            if (parent)
                low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
        }
    }
    return components;
}
/** Shortest dependency path from `from` to `to`, or `null`. */
function shortestPath(graph, from, to) {
    if (from === to)
        return [from];
    const queue = [from];
    const prev = new Map();
    const seen = new Set([from]);
    while (queue.length) {
        const current = queue.shift();
        for (const next of graph.dependencies.get(current) ?? []) {
            if (seen.has(next))
                continue;
            seen.add(next);
            prev.set(next, current);
            if (next === to) {
                const path = [to];
                let cursor = to;
                while (prev.has(cursor)) {
                    cursor = prev.get(cursor);
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
function reaches(graph, from, to) {
    return shortestPath(graph, from, to) !== null;
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
function blastRadius(graph, changed, maxDepth = 3) {
    const seed = new Set();
    for (const path of changed) {
        if (graph.nodes.has(path))
            seed.add(path);
    }
    const all = new Set(seed);
    const byDepth = new Map();
    let frontier = new Set(seed);
    let truncated = false;
    for (let depth = 1; depth <= maxDepth; depth++) {
        const next = new Set();
        for (const path of frontier) {
            for (const dependent of graph.dependents.get(path) ?? []) {
                if (all.has(dependent))
                    continue;
                all.add(dependent);
                next.add(dependent);
            }
        }
        if (next.size === 0)
            break;
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
                if (truncated)
                    break;
            }
        }
    }
    return { seed, byDepth, all, truncated };
}
//# sourceMappingURL=graph.js.map