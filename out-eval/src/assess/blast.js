"use strict";
/**
 * Blast radius: which modules and services this change can reach.
 *
 * The direction is the thing people get wrong. A change to module M breaks
 * whatever *imports* M, so impact follows dependents upward, not dependencies
 * downward. Hop distance is reported rather than collapsed, because in a large
 * repo the transitive dependent set of a core module is "most of the codebase",
 * which is true and useless — what the developer needs to know is how far out
 * they actually have to look.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeBlast = analyzeBlast;
const graph_1 = require("../core/graph");
const id_1 = require("../core/id");
function serviceSpecOf(name, specs) {
    return specs.find((s) => s.name === name);
}
function analyzeBlast(input, maxDepth = 3) {
    const { graph, change, config, ownersOf } = input;
    const changedInGraph = [...change.paths].filter((p) => graph.nodes.has(p));
    const nonCodeChanges = [...change.paths].filter((p) => !graph.nodes.has(p));
    const radius = (0, graph_1.blastRadius)(graph, changedInGraph, maxDepth);
    // --- Service impact ------------------------------------------------------
    const direct = new Map();
    const downstream = new Map();
    for (const path of radius.seed) {
        const service = graph.nodes.get(path)?.service;
        if (!service)
            continue;
        let set = direct.get(service);
        if (!set) {
            set = new Set();
            direct.set(service, set);
        }
        set.add(path);
    }
    for (const path of radius.all) {
        if (radius.seed.has(path))
            continue;
        const service = graph.nodes.get(path)?.service;
        if (!service)
            continue;
        if (direct.has(service))
            continue; // already reported as direct
        let set = downstream.get(service);
        if (!set) {
            set = new Set();
            downstream.set(service, set);
        }
        set.add(path);
    }
    const services = [];
    for (const [service, modules] of direct) {
        const spec = serviceSpecOf(service, config.services);
        services.push({
            service,
            reach: 'direct',
            modules: [...modules].sort(),
            owners: spec?.owners ?? [...new Set([...modules].flatMap((m) => ownersOf(m).owners))],
            via: 'a changed file is in this service',
        });
    }
    for (const [service, modules] of downstream) {
        const spec = serviceSpecOf(service, config.services);
        const sample = [...modules].sort();
        services.push({
            service,
            reach: 'downstream',
            modules: sample,
            owners: spec?.owners ?? [...new Set(sample.flatMap((m) => ownersOf(m).owners))],
            via: `${sample.length} module${sample.length === 1 ? '' : 's'} import something this change touches`,
        });
    }
    services.sort((a, b) => (a.reach === b.reach ? 0 : a.reach === 'direct' ? -1 : 1) ||
        b.modules.length - a.modules.length ||
        a.service.localeCompare(b.service));
    // --- Cross-service edges the diff introduced -----------------------------
    const newCrossServiceEdges = [];
    for (const file of change.files) {
        if (file.kind === 'deleted')
            continue;
        const node = graph.nodes.get(file.path);
        if (!node?.service)
            continue;
        const addedImportLines = new Set();
        for (const hunk of file.hunks) {
            for (const entry of hunk.addedLines) {
                if (/^\s*(from|import)\s/.test(entry.text) || /\b(require|import)\s*\(/.test(entry.text)) {
                    addedImportLines.add(entry.line);
                }
            }
        }
        if (addedImportLines.size === 0)
            continue;
        for (const [target, line] of Object.entries(node.importLines)) {
            if (!addedImportLines.has(line))
                continue;
            const targetService = graph.nodes.get(target)?.service;
            if (!targetService || targetService === node.service)
                continue;
            newCrossServiceEdges.push({
                from: file.path,
                to: target,
                fromService: node.service,
                toService: targetService,
                line,
            });
        }
    }
    // --- Observations --------------------------------------------------------
    const observations = [];
    const directServices = services.filter((s) => s.reach === 'direct');
    const downstreamServices = services.filter((s) => s.reach === 'downstream');
    const depthCounts = [...radius.byDepth.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([depth, set]) => `${set.size} at ${depth} hop${depth === 1 ? '' : 's'}`);
    observations.push({
        id: (0, id_1.findingId)('blast-summary', [...change.paths].sort()),
        dimension: 'blast-radius',
        checkId: 'blast-radius/summary',
        status: downstreamServices.length > 0 ? 'attention' : 'pass',
        confidence: radius.truncated ? 'medium' : 'high',
        title: downstreamServices.length > 0
            ? `${directServices.length} service${directServices.length === 1 ? '' : 's'} changed, ${downstreamServices.length} downstream`
            : `${directServices.length || 'no'} service${directServices.length === 1 ? '' : 's'} changed, nothing downstream`,
        detail: `${radius.seed.size} changed module${radius.seed.size === 1 ? '' : 's'} in the dependency graph` +
            (depthCounts.length ? `; dependents: ${depthCounts.join(', ')}` : '; no modules import them') +
            (radius.truncated
                ? `. The traversal stopped at ${maxDepth} hops and more modules lie beyond, so treat the downstream list as a floor, not a total.`
                : '.') +
            (nonCodeChanges.length
                ? ` ${nonCodeChanges.length} changed file${nonCodeChanges.length === 1 ? ' is' : 's are'} outside the analyzed languages and were not traced.`
                : ''),
        evidence: [
            { kind: 'graph', ref: 'dependency graph', note: `${radius.all.size} modules in the blast radius` },
            ...[...change.paths]
                .slice(0, 5)
                .map((p) => ({ kind: 'diff', ref: p, note: 'changed' })),
        ],
        source: 'static',
        requiredActions: downstreamServices.length
            ? [
                `Skim the downstream modules in ${downstreamServices.map((s) => s.service).join(', ')} for assumptions this change breaks.`,
            ]
            : [],
        owners: [...new Set(services.flatMap((s) => s.owners))],
    });
    for (const edge of newCrossServiceEdges) {
        const spec = serviceSpecOf(edge.fromService, config.services);
        const allowed = spec?.dependsOn;
        const permitted = allowed === undefined || allowed.includes(edge.toService);
        observations.push({
            id: (0, id_1.findingId)('new-cross-service-edge', [edge.from, edge.to]),
            dimension: 'blast-radius',
            checkId: 'blast-radius/new-cross-service-edge',
            status: permitted ? 'attention' : 'conflict',
            confidence: 'high',
            title: permitted
                ? `new dependency: ${edge.fromService} → ${edge.toService}`
                : `${edge.fromService} → ${edge.toService} is not a declared dependency`,
            detail: permitted
                ? `This change adds an import from \`${edge.from}\` (${edge.fromService}) to \`${edge.to}\` (${edge.toService}). The service map allows it, but a new edge between services is a new coupling that someone should agree to on purpose.`
                : `This change adds an import from \`${edge.from}\` (${edge.fromService}) to \`${edge.to}\` (${edge.toService}). The service map says ${edge.fromService} may depend on ${allowed && allowed.length ? allowed.join(', ') : 'nothing'} — ${edge.toService} is not on that list.`,
            evidence: [
                { kind: 'diff', ref: edge.from, line: edge.line, note: 'import added here' },
                {
                    kind: 'service-map',
                    ref: `${edge.fromService}.dependsOn`,
                    excerpt: allowed?.join(', ') || '(none declared)',
                    note: 'from donna.json',
                },
            ],
            source: 'static',
            requiredActions: permitted
                ? [`Mention the new ${edge.fromService} → ${edge.toService} dependency in the PR description so reviewers see it.`]
                : [
                    `Either remove the dependency, or get the service map amended by the ${edge.toService} owners before proposing this.`,
                ],
            escalate: permitted ? undefined : 'design-conflict',
            owners: [
                ...new Set([
                    ...(serviceSpecOf(edge.toService, config.services)?.owners ?? []),
                    ...(spec?.owners ?? []),
                ]),
            ],
            location: { file: edge.from, line: edge.line },
        });
    }
    // Changed modules with no service mapping: invisible to every service-level
    // rule, which is worth saying out loud.
    //
    // Test files are excluded. A service map describes production components, so
    // tests sitting outside it is correct rather than a gap — and reporting it as
    // an unknown would make almost every change incomplete, which devalues the
    // unknown status everywhere else.
    const unmapped = [...radius.seed].filter((p) => {
        const node = graph.nodes.get(p);
        return node && !node.service && !node.isTest;
    });
    if (unmapped.length > 0 && config.services.length > 0) {
        observations.push({
            id: (0, id_1.findingId)('unmapped-modules', unmapped.sort()),
            dimension: 'blast-radius',
            checkId: 'blast-radius/unmapped-module',
            status: 'unknown',
            confidence: 'high',
            title: `${unmapped.length} changed module${unmapped.length === 1 ? '' : 's'} belong to no service`,
            detail: `${unmapped.slice(0, 5).map((p) => `\`${p}\``).join(', ')}${unmapped.length > 5 ? `, +${unmapped.length - 5} more` : ''} ` +
                `do not match any entry in the service map, so no service-level constraint, owner or dependency rule applied to them. ` +
                `This is a gap in the analysis, not a clean result.`,
            evidence: unmapped.slice(0, 5).map((p) => ({ kind: 'diff', ref: p, note: 'unmapped' })),
            source: 'static',
            requiredActions: [
                'Add these paths to the service map, or confirm by hand that no service owns them.',
            ],
            owners: [],
        });
    }
    return { radius, services, observations, nonCodeChanges, newCrossServiceEdges };
}
//# sourceMappingURL=blast.js.map