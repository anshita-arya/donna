"use strict";
/**
 * Backward compatibility.
 *
 * Compatibility is the dimension where a confident wrong answer is most
 * expensive, so the rule here is that anything unverifiable returns `unknown`
 * and escalates. In particular: if the base revision of a file cannot be read,
 * we do not fall back to "looks additive" — we say we could not tell.
 *
 * Three classes of break are detected:
 *   - a public symbol disappeared from a module other modules import;
 *   - a field was removed from, or renamed in, a declared contract surface;
 *   - a *required* field was added to a request contract, which breaks every
 *     existing caller even though the diff reads as pure addition.
 *
 * The third is the one humans miss in review, because adding a line looks safe.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeCompat = analyzeCompat;
const glob_1 = require("../core/glob");
const id_1 = require("../core/id");
const graph_1 = require("../core/graph");
const scan_python_1 = require("../core/scan-python");
const scan_1 = require("../core/scan");
function publicSymbols(path, text) {
    const language = (0, graph_1.languageOf)(path);
    if (language === 'python')
        return new Set((0, scan_python_1.scanPython)(text).exports);
    if (language === 'typescript') {
        // The TS scanner reports a count, not names; fall back to a direct match so
        // compatibility still works for TS surfaces.
        const names = new Set();
        const re = /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\s*\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
        let m;
        while ((m = re.exec(text)))
            names.add(m[1]);
        for (const block of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
            for (const part of block[1].split(',')) {
                const name = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
                if (name)
                    names.add(name[2] ?? name[1]);
            }
        }
        // Touch scanSource so a TS file with only re-exports still counts as having
        // a surface, keeping behaviour consistent with the graph's export count.
        if (names.size === 0 && (0, scan_1.scanSource)(text).exportCount > 0)
            names.add('export#unnamed');
        return names;
    }
    return new Set();
}
const FIELD_DECL = /^\s{2,}([a-z_][\w]*)\s*:\s*([^=\n]+?)\s*(?:=\s*(.+))?$/;
const ROUTE_DECL = /@\w+\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/;
function fieldMoves(file) {
    const added = [];
    const removed = [];
    const toMove = (text, line) => {
        const m = FIELD_DECL.exec(text);
        if (!m)
            return null;
        const type = m[2].trim();
        return {
            field: m[1],
            type,
            hasDefault: m[3] !== undefined,
            optionalType: /\bNone\b|\bOptional\b|\|\s*None|NotRequired/.test(type),
            line,
        };
    };
    for (const hunk of file.hunks) {
        for (const entry of hunk.addedLines) {
            const move = toMove(entry.text, entry.line);
            if (move)
                added.push(move);
        }
        for (const entry of hunk.removedLines) {
            const move = toMove(entry.text, Math.max(1, hunk.newStart));
            if (move)
                removed.push(move);
        }
    }
    return { added, removed };
}
function ruleFor(path, rules) {
    return rules.find((rule) => (0, glob_1.matchAny)(path, rule.surface));
}
function analyzeCompat(input) {
    const { change, graph, config, readFile, readBaseFile, ownersOf } = input;
    const observations = [];
    let incomplete = false;
    for (const file of change.files) {
        if (file.kind === 'deleted') {
            const dependents = graph.dependents.get(file.path);
            if (dependents && dependents.size > 0) {
                observations.push({
                    id: (0, id_1.findingId)('compat-module-deleted', [file.path]),
                    dimension: 'backward-compatibility',
                    checkId: 'compat/module-deleted',
                    status: 'conflict',
                    confidence: 'high',
                    title: `deleted module still has ${dependents.size} importer${dependents.size === 1 ? '' : 's'}`,
                    detail: `\`${file.path}\` was deleted but ${[...dependents].slice(0, 4).map((d) => `\`${d}\``).join(', ')}${dependents.size > 4 ? ` and ${dependents.size - 4} more` : ''} still import it.`,
                    evidence: [
                        { kind: 'diff', ref: file.path, note: 'deleted' },
                        ...[...dependents].slice(0, 4).map((d) => ({
                            kind: 'graph',
                            ref: d,
                            note: 'imports the deleted module',
                        })),
                    ],
                    source: 'static',
                    requiredActions: ['Update or remove the importers in the same change.'],
                    escalate: 'production-behavior-change',
                    owners: [...new Set([...dependents].flatMap((d) => ownersOf(d).owners))],
                    location: { file: file.path, line: 1 },
                });
            }
            continue;
        }
        const language = (0, graph_1.languageOf)(file.path);
        if (!language)
            continue;
        const head = readFile(file.path);
        const baseText = file.kind === 'added' ? '' : readBaseFile(file.path);
        const rule = ruleFor(file.path, config.compat);
        // --- Public symbol removals -------------------------------------------
        if (head === undefined) {
            incomplete = true;
            observations.push(unknownObservation(file.path, 'the current file could not be read'));
            continue;
        }
        if (baseText === undefined) {
            incomplete = true;
            observations.push(unknownObservation(file.path, 'the base revision could not be read, so removed or renamed symbols could not be compared'));
        }
        else {
            const before = publicSymbols(file.path, baseText);
            const after = publicSymbols(file.path, head);
            const removedSymbols = [...before].filter((s) => !after.has(s) && s !== 'export#unnamed');
            if (removedSymbols.length > 0) {
                const dependents = graph.dependents.get(file.path) ?? new Set();
                const governed = !!rule;
                const status = governed || dependents.size > 0 ? 'conflict' : 'attention';
                observations.push({
                    id: (0, id_1.findingId)('compat-symbol-removed', [file.path, ...removedSymbols.sort()]),
                    dimension: 'backward-compatibility',
                    checkId: 'compat/public-symbol-removed',
                    status,
                    confidence: 'high',
                    title: `${removedSymbols.length} public symbol${removedSymbols.length === 1 ? '' : 's'} removed from ${file.path.split('/').pop()}`,
                    detail: `${removedSymbols.slice(0, 6).map((s) => `\`${s}\``).join(', ')}${removedSymbols.length > 6 ? `, +${removedSymbols.length - 6} more` : ''} ` +
                        `no longer exist in \`${file.path}\`. ` +
                        (dependents.size > 0
                            ? `${dependents.size} module${dependents.size === 1 ? '' : 's'} import this file, so any that referenced a removed name will fail. `
                            : 'No module in this repo imports it, but an external caller might. ') +
                        (governed
                            ? `${rule.id} marks this path as a public contract: ${rule.policy}`
                            : 'This path is not covered by a compatibility rule, so the judgement is based on the dependency graph alone.'),
                    evidence: [
                        { kind: 'diff', ref: file.path, note: `removed: ${removedSymbols.slice(0, 4).join(', ')}` },
                        ...(governed
                            ? [{ kind: 'compat-policy', ref: rule.id, excerpt: rule.policy }]
                            : []),
                        ...[...dependents].slice(0, 3).map((d) => ({
                            kind: 'graph',
                            ref: d,
                            note: 'importer',
                        })),
                    ],
                    source: 'static',
                    requiredActions: [
                        dependents.size > 0
                            ? `Check each importer for references to the removed names: ${[...dependents].slice(0, 3).join(', ')}.`
                            : 'Confirm no out-of-repo caller depends on the removed names.',
                        governed
                            ? `Follow ${rule.id}: ${rule.versionRegistry?.length ? `record the removal in ${rule.versionRegistry.join(' or ')}` : 'get sign-off from the contract owner'}.`
                            : 'Consider keeping a deprecated alias for one release instead of removing outright.',
                    ],
                    escalate: 'compat-uncertain',
                    owners: ownersOf(file.path).owners,
                    location: { file: file.path, line: 1 },
                });
            }
        }
        // --- Contract field movement ------------------------------------------
        if (!rule)
            continue;
        const { added, removed } = fieldMoves(file);
        const breakingRemovals = removed.filter((r) => !added.some((a) => a.field === r.field));
        if (breakingRemovals.length > 0) {
            observations.push({
                id: (0, id_1.findingId)('compat-field-removed', [file.path, ...breakingRemovals.map((f) => f.field).sort()]),
                dimension: 'backward-compatibility',
                checkId: 'compat/contract-field-removed',
                status: 'conflict',
                confidence: 'medium',
                title: `${breakingRemovals.length} contract field${breakingRemovals.length === 1 ? '' : 's'} removed`,
                detail: `${breakingRemovals.map((f) => `\`${f.field}\``).join(', ')} ${breakingRemovals.length === 1 ? 'was' : 'were'} removed from the contract surface \`${file.path}\`. ` +
                    `Clients that read ${breakingRemovals.length === 1 ? 'this field' : 'these fields'} will break. ` +
                    `${rule.id}: ${rule.policy}`,
                evidence: [
                    {
                        kind: 'diff',
                        ref: file.path,
                        line: breakingRemovals[0].line,
                        excerpt: `- ${breakingRemovals[0].field}: ${breakingRemovals[0].type}`,
                    },
                    { kind: 'compat-policy', ref: rule.id, excerpt: rule.policy },
                ],
                source: 'static',
                requiredActions: [
                    'Keep the field and mark it deprecated instead of removing it, or ship the removal behind a new contract version.',
                    rule.versionRegistry?.length
                        ? `Record the change in ${rule.versionRegistry.join(' or ')}.`
                        : 'Get the contract owner to sign off on the removal.',
                ],
                escalate: 'compat-uncertain',
                owners: ownersOf(file.path).owners,
                location: { file: file.path, line: breakingRemovals[0].line },
            });
        }
        const requiredAdditions = added.filter((a) => !a.hasDefault && !a.optionalType && !removed.some((r) => r.field === a.field));
        if (requiredAdditions.length > 0) {
            observations.push({
                id: (0, id_1.findingId)('compat-required-field-added', [file.path, ...requiredAdditions.map((f) => f.field).sort()]),
                dimension: 'backward-compatibility',
                checkId: 'compat/required-field-added',
                status: 'conflict',
                confidence: 'medium',
                title: `required field${requiredAdditions.length === 1 ? '' : 's'} added to a contract`,
                detail: `${requiredAdditions.map((f) => `\`${f.field}: ${f.type}\``).join(', ')} ${requiredAdditions.length === 1 ? 'was' : 'were'} added to \`${file.path}\` with no default and a non-optional type. ` +
                    `In the diff this reads as a pure addition, but every existing caller that does not send ${requiredAdditions.length === 1 ? 'it' : 'them'} now fails validation. ` +
                    `${rule.id}: ${rule.policy}`,
                evidence: [
                    {
                        kind: 'diff',
                        ref: file.path,
                        line: requiredAdditions[0].line,
                        excerpt: `+ ${requiredAdditions[0].field}: ${requiredAdditions[0].type}`,
                    },
                    { kind: 'compat-policy', ref: rule.id, excerpt: rule.policy },
                ],
                source: 'static',
                requiredActions: [
                    `Give ${requiredAdditions.map((f) => `\`${f.field}\``).join(', ')} a default, or make the type optional, so existing callers keep working.`,
                    'If the field genuinely must be required, it needs a new contract version rather than an in-place change.',
                ],
                escalate: 'compat-uncertain',
                owners: ownersOf(file.path).owners,
                location: { file: file.path, line: requiredAdditions[0].line },
            });
        }
        const optionalAdditions = added.filter((a) => a.hasDefault || a.optionalType);
        if (optionalAdditions.length > 0 && requiredAdditions.length === 0 && breakingRemovals.length === 0) {
            observations.push({
                id: (0, id_1.findingId)('compat-additive', [file.path, ...optionalAdditions.map((f) => f.field).sort()]),
                dimension: 'backward-compatibility',
                checkId: 'compat/additive-field',
                status: 'pass',
                confidence: 'medium',
                title: `${optionalAdditions.length} optional field${optionalAdditions.length === 1 ? '' : 's'} added — additive`,
                detail: `${optionalAdditions.map((f) => `\`${f.field}\``).join(', ')} ${optionalAdditions.length === 1 ? 'has a default or an optional type' : 'have defaults or optional types'}, so existing callers are unaffected.`,
                evidence: [
                    {
                        kind: 'diff',
                        ref: file.path,
                        line: optionalAdditions[0].line,
                        excerpt: `+ ${optionalAdditions[0].field}: ${optionalAdditions[0].type}`,
                    },
                ],
                source: 'static',
                requiredActions: [],
                owners: ownersOf(file.path).owners,
            });
        }
        // --- Route path changes ------------------------------------------------
        const routeChanges = [];
        for (const hunk of file.hunks) {
            for (const entry of hunk.addedLines) {
                const m = ROUTE_DECL.exec(entry.text);
                if (m)
                    routeChanges.push({ from: 'added', method: m[1], path: m[2], line: entry.line });
            }
            for (const entry of hunk.removedLines) {
                const m = ROUTE_DECL.exec(entry.text);
                if (m) {
                    routeChanges.push({
                        from: 'removed',
                        method: m[1],
                        path: m[2],
                        line: Math.max(1, hunk.newStart),
                    });
                }
            }
        }
        const removedRoutes = routeChanges.filter((r) => r.from === 'removed' && !routeChanges.some((a) => a.from === 'added' && a.path === r.path));
        if (removedRoutes.length > 0) {
            observations.push({
                id: (0, id_1.findingId)('compat-route-removed', [file.path, ...removedRoutes.map((r) => `${r.method} ${r.path}`).sort()]),
                dimension: 'backward-compatibility',
                checkId: 'compat/route-removed',
                status: 'conflict',
                confidence: 'high',
                title: `${removedRoutes.length} route${removedRoutes.length === 1 ? '' : 's'} removed or renamed`,
                detail: `${removedRoutes.map((r) => `\`${r.method.toUpperCase()} ${r.path}\``).join(', ')} no longer ${removedRoutes.length === 1 ? 'appears' : 'appear'} in \`${file.path}\`. Any client calling ${removedRoutes.length === 1 ? 'it' : 'them'} gets a 404 after deploy.`,
                evidence: [
                    {
                        kind: 'diff',
                        ref: file.path,
                        line: removedRoutes[0].line,
                        excerpt: `- ${removedRoutes[0].method} ${removedRoutes[0].path}`,
                    },
                    { kind: 'compat-policy', ref: rule.id, excerpt: rule.policy },
                ],
                source: 'static',
                requiredActions: [
                    'Keep the old route as an alias, or stage the removal behind a deprecation window.',
                ],
                escalate: 'production-behavior-change',
                owners: ownersOf(file.path).owners,
                location: { file: file.path, line: removedRoutes[0].line },
            });
        }
    }
    if (observations.length === 0) {
        observations.push({
            id: (0, id_1.findingId)('compat-none', [...change.paths].sort()),
            dimension: 'backward-compatibility',
            checkId: 'compat/no-surface-touched',
            status: 'pass',
            confidence: config.compat.length > 0 ? 'medium' : 'low',
            title: config.compat.length > 0
                ? 'no declared contract surface was changed'
                : 'no compatibility rules are configured',
            detail: config.compat.length > 0
                ? `None of the changed files match a declared contract surface, and no public symbol was removed from a module that others import.`
                : `No compatibility rules exist in donna.json, so this dimension checked only public-symbol removals from the dependency graph. Declaring contract surfaces would make this meaningful.`,
            evidence: [{ kind: 'compat-policy', ref: 'donna.json', note: `${config.compat.length} rules configured` }],
            source: 'static',
            requiredActions: config.compat.length > 0 ? [] : ['Declare your public contract surfaces so this check can do real work.'],
            owners: [],
        });
        if (config.compat.length === 0)
            incomplete = true;
    }
    return { observations, incomplete };
}
function unknownObservation(path, why) {
    return {
        id: (0, id_1.findingId)('compat-unknown', [path, why]),
        dimension: 'backward-compatibility',
        checkId: 'compat/unverifiable',
        status: 'unknown',
        confidence: 'low',
        title: `compatibility of ${path.split('/').pop()} could not be verified`,
        detail: `Donna could not assess \`${path}\` because ${why}. This is not a pass — the change may or may not be compatible.`,
        evidence: [{ kind: 'diff', ref: path, note: why }],
        source: 'static',
        requiredActions: [`Review \`${path}\` by hand for removed or renamed public symbols.`],
        escalate: 'compat-uncertain',
        owners: [],
        location: { file: path, line: 1 },
    };
}
//# sourceMappingURL=compat.js.map