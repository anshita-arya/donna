"use strict";
/**
 * The constraint engine: checks a change against the machine-checkable parts
 * of the ADRs.
 *
 * Three principles run through all six kinds:
 *
 *  1. A constraint whose inputs do not exist returns `unknown`, never `pass`.
 *     A silent pass because an ADR pointed at a file that has since moved is
 *     exactly the failure mode this tool is supposed to remove.
 *  2. Findings are scoped to the change. A pre-existing violation in an
 *     untouched corner of the repo is not this developer's problem; one inside
 *     the blast radius is reported, but labelled as pre-existing.
 *  3. Every result carries the ADR that produced it, with a path and a line,
 *     so the developer can go read the decision rather than trust the tool.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runConstraints = runConstraints;
const glob_1 = require("../core/glob");
const graph_1 = require("../core/graph");
const adr_1 = require("../evidence/adr");
function adrEvidence(adr, note) {
    return {
        kind: 'adr',
        ref: `${adr.id} — ${adr.title}`,
        note: note ?? `declared in ${adr.path}`,
        excerpt: adr.path,
    };
}
function globs(params, key) {
    const value = params[key];
    if (Array.isArray(value))
        return value.filter((v) => typeof v === 'string');
    if (typeof value === 'string')
        return [value];
    return [];
}
function str(params, key) {
    const value = params[key];
    return typeof value === 'string' ? value : null;
}
function num(params, key, fallback) {
    const value = params[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function safeRegex(pattern, flags = '') {
    if (!pattern)
        return null;
    try {
        return new RegExp(pattern, flags);
    }
    catch {
        return null;
    }
}
function base(ctx, over) {
    return {
        adrId: ctx.adr.id,
        adrTitle: ctx.adr.title,
        adrPath: ctx.adr.path,
        constraint: ctx.constraint,
        status: 'unknown',
        message: '',
        evidence: [adrEvidence(ctx.adr)],
        owners: ctx.adr.owners,
        requiredActions: [],
        ...over,
    };
}
function unknown(ctx, why, actions = []) {
    return base(ctx, {
        status: 'unknown',
        message: why,
        requiredActions: actions.length
            ? actions
            : [
                `Confirm by hand whether ${ctx.adr.id} applies here — Donna could not check it automatically.`,
            ],
    });
}
function nodesMatching(graph, patterns) {
    if (patterns.length === 0)
        return [];
    return [...graph.nodes.keys()].filter((p) => (0, glob_1.matchAny)(p, patterns));
}
function relevance(scope, involved) {
    const touched = involved.some((p) => scope.changed.has(p));
    if (touched)
        return { relevant: true, preExisting: false };
    const nearby = involved.some((p) => scope.affected.has(p));
    return { relevant: nearby, preExisting: true };
}
// ---------------------------------------------------------------------------
// forbidden-dependency
// ---------------------------------------------------------------------------
function checkForbiddenDependency(ctx) {
    const { graph } = ctx.input;
    const from = globs(ctx.constraint.params, 'from');
    const to = globs(ctx.constraint.params, 'to');
    const allowFrom = globs(ctx.constraint.params, 'allowFrom');
    if (from.length === 0 || to.length === 0) {
        return [unknown(ctx, 'The constraint is missing `from` or `to` globs, so nothing was checked.')];
    }
    const fromNodes = nodesMatching(graph, from).filter((p) => allowFrom.length === 0 || !(0, glob_1.matchAny)(p, allowFrom));
    const toNodes = new Set(nodesMatching(graph, to));
    if (fromNodes.length === 0 || toNodes.size === 0) {
        return [
            unknown(ctx, `No modules matched ${fromNodes.length === 0 ? '`from`' : '`to`'} (${(fromNodes.length === 0 ? from : to).join(', ')}). The ADR may be pointing at paths that have moved.`, [`Update ${ctx.adr.id}'s globs, or confirm the rule no longer applies.`]),
        ];
    }
    const results = [];
    const transitive = ctx.constraint.params.transitive === true;
    for (const source of fromNodes) {
        if (transitive) {
            for (const target of toNodes) {
                const path = (0, graph_1.shortestPath)(graph, source, target);
                if (!path)
                    continue;
                const { relevant, preExisting } = relevance(ctx.scope, path);
                if (!relevant)
                    continue;
                results.push(base(ctx, {
                    status: 'conflict',
                    message: `\`${source}\` reaches \`${target}\` through ${path.length - 1} hop${path.length === 2 ? '' : 's'}, which ${ctx.adr.id} forbids${preExisting ? ' (pre-existing, inside this change\'s blast radius)' : ''}.`,
                    location: { file: source, line: graph.nodes.get(source)?.importLines[path[1]] ?? 1 },
                    evidence: [
                        adrEvidence(ctx.adr),
                        { kind: 'graph', ref: path.join(' → '), note: 'dependency chain' },
                    ],
                    requiredActions: preExisting
                        ? [
                            `This violation predates your change but sits in its blast radius. Flag it to ${ctx.adr.owners.join(', ') || 'the ADR owner'} rather than fixing it here.`,
                        ]
                        : [
                            `Break the chain \`${path.join(' → ')}\` — invert the dependency behind an interface, or move the shared piece somewhere both sides may depend on.`,
                        ],
                }));
            }
            continue;
        }
        const node = graph.nodes.get(source);
        if (!node)
            continue;
        for (const [target, line] of Object.entries(node.importLines)) {
            if (!toNodes.has(target))
                continue;
            const { relevant, preExisting } = relevance(ctx.scope, [source, target]);
            if (!relevant)
                continue;
            results.push(base(ctx, {
                status: 'conflict',
                message: `\`${source}\` imports \`${target}\`, which ${ctx.adr.id} forbids${preExisting ? ' (pre-existing, inside this change\'s blast radius)' : ''}.`,
                location: { file: source, line },
                evidence: [
                    adrEvidence(ctx.adr),
                    { kind: 'graph', ref: source, line, excerpt: `imports ${target}` },
                ],
                requiredActions: preExisting
                    ? [
                        `Pre-existing violation in the blast radius — raise it with ${ctx.adr.owners.join(', ') || 'the ADR owner'}; do not quietly fix it inside this change.`,
                    ]
                    : [
                        `Remove the import of \`${target}\` from \`${source}\`, or get ${ctx.adr.id} amended by its owners before proposing this.`,
                    ],
            }));
        }
    }
    if (results.length === 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: `No module in \`${from.join(', ')}\` depends on \`${to.join(', ')}\` within this change's blast radius.`,
            }),
        ];
    }
    return results;
}
// ---------------------------------------------------------------------------
// required-reachability — "every serving handler must go through validation"
// ---------------------------------------------------------------------------
function checkRequiredReachability(ctx) {
    const { graph } = ctx.input;
    const from = globs(ctx.constraint.params, 'from');
    const mustReach = globs(ctx.constraint.params, 'mustReach');
    if (from.length === 0 || mustReach.length === 0) {
        return [unknown(ctx, 'The constraint is missing `from` or `mustReach` globs.')];
    }
    const allowFrom = globs(ctx.constraint.params, 'allowFrom');
    const fromNodes = nodesMatching(graph, from).filter((p) => allowFrom.length === 0 || !(0, glob_1.matchAny)(p, allowFrom));
    const targets = nodesMatching(graph, mustReach);
    if (targets.length === 0) {
        return [
            unknown(ctx, `The required target (${mustReach.join(', ')}) does not exist in the repo, so reachability could not be checked.`, [
                `Either the module ${ctx.adr.id} requires has been removed or renamed, or the ADR is stale. Check with ${ctx.adr.owners.join(', ') || 'the ADR owner'} before merging.`,
            ]),
        ];
    }
    if (fromNodes.length === 0) {
        return [unknown(ctx, `No modules matched \`from\` (${from.join(', ')}).`)];
    }
    const results = [];
    let checked = 0;
    for (const source of fromNodes) {
        // Only assess handlers this change actually touches or affects.
        if (!ctx.scope.changed.has(source) && !ctx.scope.affected.has(source))
            continue;
        checked++;
        const hit = targets.find((target) => (0, graph_1.shortestPath)(graph, source, target) !== null);
        if (hit)
            continue;
        const preExisting = !ctx.scope.changed.has(source);
        results.push(base(ctx, {
            status: 'conflict',
            message: `\`${source}\` does not reach any of ${mustReach.join(', ')}, which ${ctx.adr.id} requires${preExisting ? ' (pre-existing, inside the blast radius)' : ''}.`,
            location: { file: source, line: 1 },
            evidence: [
                adrEvidence(ctx.adr),
                {
                    kind: 'graph',
                    ref: source,
                    note: `no import path to ${targets.slice(0, 3).join(' | ')}`,
                },
            ],
            requiredActions: [
                `Route \`${source}\` through ${targets[0]} before the request reaches the engine, or obtain an explicit exemption from ${ctx.adr.owners.join(', ') || 'the ADR owner'}.`,
            ],
        }));
    }
    if (checked === 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: `No module governed by this constraint is inside the change's blast radius.`,
            }),
        ];
    }
    if (results.length === 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: `All ${checked} affected module${checked === 1 ? '' : 's'} under \`${from.join(', ')}\` still reach ${mustReach.join(', ')}.`,
            }),
        ];
    }
    return results;
}
// ---------------------------------------------------------------------------
// contract-change-requires-version
// ---------------------------------------------------------------------------
function checkContractVersion(ctx) {
    const surface = globs(ctx.constraint.params, 'surface');
    const registry = globs(ctx.constraint.params, 'versionRegistry');
    const symbolPattern = str(ctx.constraint.params, 'symbolPattern');
    if (surface.length === 0 || registry.length === 0) {
        return [
            unknown(ctx, 'The constraint is missing `surface` or `versionRegistry` globs.'),
        ];
    }
    const touchedSurface = ctx.input.change.files.filter((f) => f.kind !== 'deleted' && (0, glob_1.matchAny)(f.path, surface));
    if (touchedSurface.length === 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: `This change does not touch the contract surface (${surface.join(', ')}).`,
            }),
        ];
    }
    const re = safeRegex(symbolPattern, 'g');
    if (symbolPattern && !re) {
        return [unknown(ctx, `\`symbolPattern\` is not a valid regular expression: ${symbolPattern}`)];
    }
    // Which declared symbols did the diff actually move?
    const touchedSymbols = [];
    for (const file of touchedSurface) {
        for (const hunk of file.hunks) {
            for (const entry of hunk.addedLines) {
                const names = extractSymbols(entry.text, re);
                for (const name of names) {
                    touchedSymbols.push({ file: file.path, symbol: name, line: entry.line, direction: 'added' });
                }
            }
            for (const entry of hunk.removedLines) {
                const names = extractSymbols(entry.text, re);
                for (const name of names) {
                    touchedSymbols.push({
                        file: file.path,
                        symbol: name,
                        line: Math.max(1, hunk.newStart),
                        direction: 'removed',
                    });
                }
            }
        }
    }
    // Field-level movement inside a contract file counts too: adding a required
    // field to a response model is a contract change even when no class name
    // appears on a changed line.
    const fieldMoves = surfaceFieldMoves(touchedSurface);
    if (touchedSymbols.length === 0 && fieldMoves.length === 0) {
        return [
            base(ctx, {
                status: 'attention',
                message: `The contract surface was edited but no declared symbol or field changed. Worth a glance, but nothing to version.`,
            }),
        ];
    }
    const registryTouched = ctx.input.change.files.filter((f) => (0, glob_1.matchAny)(f.path, registry));
    if (registryTouched.length > 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: `Contract changed and the version registry (${registryTouched.map((f) => f.path).join(', ')}) was updated in the same change.`,
                evidence: [
                    adrEvidence(ctx.adr),
                    { kind: 'diff', ref: registryTouched[0].path, note: 'version registry updated' },
                ],
            }),
        ];
    }
    const registryExists = registry.some((pattern) => [...ctx.input.graph.nodes.keys()].some((p) => (0, glob_1.matchGlob)(p, pattern)));
    const examples = [...new Set(touchedSymbols.map((s) => s.symbol))].slice(0, 6);
    const anchorSymbol = touchedSymbols[0];
    const anchorField = fieldMoves[0];
    const anchor = anchorSymbol ?? anchorField;
    const detailBits = [];
    if (examples.length) {
        detailBits.push(`declared type${examples.length === 1 ? '' : 's'} ${examples.map((e) => `\`${e}\``).join(', ')}`);
    }
    if (fieldMoves.length) {
        const fieldNames = [...new Set(fieldMoves.map((f) => f.field))].slice(0, 6);
        detailBits.push(`field${fieldNames.length === 1 ? '' : 's'} ${fieldNames.map((f) => `\`${f}\``).join(', ')}`);
    }
    return [
        base(ctx, {
            status: 'conflict',
            message: `This change modifies the request/response contract in \`${anchor.file}\` (${detailBits.join(' and ')}) ` +
                `without touching the version registry ${registry.map((r) => `\`${r}\``).join(' or ')}. ` +
                `${ctx.adr.id} requires a contract change and its version record to land together.` +
                (registryExists ? '' : ' The registry file does not exist in this repo, which is itself worth raising.'),
            location: { file: anchor.file, line: anchor.line },
            evidence: [
                adrEvidence(ctx.adr),
                {
                    kind: 'diff',
                    ref: anchor.file,
                    line: anchor.line,
                    excerpt: anchorSymbol
                        ? `${anchorSymbol.direction === 'added' ? '+' : '-'} ${anchorSymbol.symbol}`
                        : `${anchorField.direction === 'added' ? '+' : '-'} ${anchorField.field}`,
                    note: 'contract surface edited',
                },
                {
                    kind: 'compat-policy',
                    ref: registry.join(', '),
                    note: registryExists ? 'version registry not updated' : 'version registry missing from repo',
                },
            ],
            requiredActions: [
                `Add a version entry in ${registry[0]} describing this contract change, or make the change additive and optional so it needs no new version.`,
                `Confirm with ${ctx.adr.owners.join(', ') || 'the contract owner'} whether existing clients can accept this shape.`,
            ],
        }),
    ];
}
function extractSymbols(line, re) {
    if (!re)
        return [];
    re.lastIndex = 0;
    const out = [];
    let m;
    while ((m = re.exec(line))) {
        out.push(m[1] ?? m[0]);
        if (m.index === re.lastIndex)
            re.lastIndex++;
    }
    return out;
}
/** Added or removed Pydantic/dataclass-style field declarations. */
function surfaceFieldMoves(files) {
    const FIELD_RE = /^\s{2,}([a-z_][\w]*)\s*:\s*[^=\s][^=]*(?:=\s*(.+))?$/;
    const out = [];
    for (const file of files) {
        for (const hunk of file.hunks) {
            for (const entry of hunk.addedLines) {
                const m = FIELD_RE.exec(entry.text);
                if (m)
                    out.push({ file: file.path, field: m[1], line: entry.line, direction: 'added' });
            }
            for (const entry of hunk.removedLines) {
                const m = FIELD_RE.exec(entry.text);
                if (m) {
                    out.push({
                        file: file.path,
                        field: m[1],
                        line: Math.max(1, hunk.newStart),
                        direction: 'removed',
                    });
                }
            }
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// service-public-entry
// ---------------------------------------------------------------------------
function checkServicePublicEntry(ctx) {
    const { graph } = ctx.input;
    const serviceName = str(ctx.constraint.params, 'service');
    const entries = globs(ctx.constraint.params, 'entry');
    /**
     * Paths exempt from the boundary. Tests are the standard case: a unit test
     * for an internal module has to import it, and a rule that forbids that
     * either bans unit tests or gets switched off.
     */
    const allowFrom = globs(ctx.constraint.params, 'allowFrom');
    if (!serviceName || entries.length === 0) {
        return [unknown(ctx, 'The constraint is missing `service` or `entry`.')];
    }
    const members = [...graph.nodes.values()].filter((n) => n.service === serviceName);
    if (members.length === 0) {
        return [
            unknown(ctx, `No modules are mapped to service \`${serviceName}\`. Check the service map in donna.json.`),
        ];
    }
    const memberPaths = new Set(members.map((m) => m.path));
    const results = [];
    for (const node of graph.nodes.values()) {
        if (node.service === serviceName)
            continue;
        if (allowFrom.length > 0 && (0, glob_1.matchAny)(node.path, allowFrom))
            continue;
        for (const [target, line] of Object.entries(node.importLines)) {
            if (!memberPaths.has(target))
                continue;
            if ((0, glob_1.matchAny)(target, entries))
                continue;
            const { relevant, preExisting } = relevance(ctx.scope, [node.path, target]);
            if (!relevant)
                continue;
            results.push(base(ctx, {
                status: 'conflict',
                message: `\`${node.path}\` imports \`${target}\`, an internal module of the **${serviceName}** service${preExisting ? ' (pre-existing, inside the blast radius)' : ''}. ${ctx.adr.id} says ${serviceName} is only consumed through ${entries.join(', ')}.`,
                location: { file: node.path, line },
                evidence: [
                    adrEvidence(ctx.adr),
                    { kind: 'graph', ref: node.path, line, excerpt: `imports ${target}` },
                    { kind: 'service-map', ref: serviceName, note: `public entry: ${entries.join(', ')}` },
                ],
                requiredActions: preExisting
                    ? [`Pre-existing boundary breach in the blast radius — report it to ${ctx.adr.owners.join(', ') || 'the service owner'}.`]
                    : [
                        `Import through ${entries[0]} instead, re-exporting what you need there, or ask the ${serviceName} owners to widen the public entry deliberately.`,
                    ],
            }));
        }
    }
    if (results.length === 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: `Nothing in this change's blast radius reaches into \`${serviceName}\` internals.`,
            }),
        ];
    }
    return results;
}
// ---------------------------------------------------------------------------
// change-requires-test
// ---------------------------------------------------------------------------
function checkChangeRequiresTest(ctx) {
    const when = globs(ctx.constraint.params, 'when');
    const requireChangedTest = globs(ctx.constraint.params, 'requireChangedTest');
    if (when.length === 0 || requireChangedTest.length === 0) {
        return [unknown(ctx, 'The constraint is missing `when` or `requireChangedTest`.')];
    }
    const triggers = [...ctx.scope.changed].filter((p) => (0, glob_1.matchAny)(p, when));
    if (triggers.length === 0) {
        return [base(ctx, { status: 'pass', message: 'This change does not touch the governed area.' })];
    }
    const satisfied = [...ctx.scope.changed].filter((p) => (0, glob_1.matchAny)(p, requireChangedTest));
    if (satisfied.length > 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: `Governed files changed and matching tests changed with them (${satisfied.slice(0, 3).join(', ')}).`,
                evidence: [adrEvidence(ctx.adr), { kind: 'diff', ref: satisfied[0], note: 'test changed' }],
            }),
        ];
    }
    return [
        base(ctx, {
            status: 'conflict',
            message: `${triggers.length} governed file${triggers.length === 1 ? '' : 's'} changed (${triggers.slice(0, 3).join(', ')}) but no test matching ${requireChangedTest.join(', ')} changed with them. ${ctx.adr.id} requires the two to move together.`,
            location: { file: triggers[0], line: 1 },
            evidence: [
                adrEvidence(ctx.adr),
                { kind: 'diff', ref: triggers[0], note: 'changed without a matching test change' },
            ],
            requiredActions: [
                `Add or update a test matching ${requireChangedTest[0]} in this change.`,
            ],
        }),
    ];
}
// ---------------------------------------------------------------------------
// required-decorator — a marker that must sit above a declaration
// ---------------------------------------------------------------------------
function checkRequiredDecorator(ctx) {
    const files = globs(ctx.constraint.params, 'files');
    const declPattern = str(ctx.constraint.params, 'declPattern');
    const marker = str(ctx.constraint.params, 'marker');
    const window = num(ctx.constraint.params, 'withinLines', 12);
    if (files.length === 0 || !declPattern || !marker) {
        return [
            unknown(ctx, 'The constraint needs `files`, `declPattern` and `marker` to be checkable.'),
        ];
    }
    const declRe = safeRegex(declPattern);
    const markerRe = safeRegex(marker);
    if (!declRe || !markerRe) {
        return [unknown(ctx, 'Either `declPattern` or `marker` is not a valid regular expression.')];
    }
    const candidates = [...ctx.input.graph.nodes.keys()].filter((p) => (0, glob_1.matchAny)(p, files));
    if (candidates.length === 0) {
        return [
            unknown(ctx, `No files matched ${files.join(', ')}. The ADR may be pointing at a path that has moved.`),
        ];
    }
    const results = [];
    let inspected = 0;
    for (const path of candidates) {
        if (!ctx.scope.changed.has(path) && !ctx.scope.affected.has(path))
            continue;
        const text = ctx.input.readFile(path);
        if (text === undefined) {
            results.push(unknown(ctx, `Could not read \`${path}\` to check for the required marker.`));
            continue;
        }
        inspected++;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!declRe.test(lines[i]))
                continue;
            const start = Math.max(0, i - window);
            const preceding = lines.slice(start, i).join('\n');
            if (markerRe.test(preceding))
                continue;
            const preExisting = !ctx.scope.changed.has(path);
            const declName = /def\s+(\w+)/.exec(lines[i])?.[1] ?? lines[i].trim().slice(0, 60);
            results.push(base(ctx, {
                status: 'conflict',
                message: `\`${declName}\` in \`${path}\` is missing the required \`${marker}\` in the ${window} lines above its declaration${preExisting ? ' (pre-existing, inside the blast radius)' : ''}. ${ctx.adr.id} requires it on every declaration matching this shape.`,
                location: { file: path, line: i + 1 },
                evidence: [
                    adrEvidence(ctx.adr),
                    { kind: 'diff', ref: path, line: i + 1, excerpt: lines[i].trim().slice(0, 100) },
                ],
                requiredActions: preExisting
                    ? [`Pre-existing gap in the blast radius — raise with ${ctx.adr.owners.join(', ') || 'the ADR owner'}.`]
                    : [
                        `Restore the \`${marker}\` on \`${declName}\`, or get a written exemption from ${ctx.adr.owners.join(', ') || 'the ADR owner'} before proposing this.`,
                    ],
            }));
        }
    }
    if (inspected === 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: 'No governed file is inside this change\'s blast radius.',
            }),
        ];
    }
    if (results.length === 0) {
        return [
            base(ctx, {
                status: 'pass',
                message: `All declarations in ${inspected} affected file${inspected === 1 ? '' : 's'} carry the required \`${marker}\`.`,
            }),
        ];
    }
    return results;
}
// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
function runConstraints(input, scope) {
    const active = input.adrs.filter(adr_1.isActive);
    const considered = (0, adr_1.relevantAdrs)(input.adrs, scope.changed);
    const skipped = active.filter((a) => !considered.includes(a));
    const results = [];
    for (const adr of considered) {
        for (const constraint of adr.constraints) {
            const ctx = { input, scope, adr, constraint };
            try {
                switch (constraint.kind) {
                    case 'forbidden-dependency':
                        results.push(...checkForbiddenDependency(ctx));
                        break;
                    case 'required-reachability':
                        results.push(...checkRequiredReachability(ctx));
                        break;
                    case 'contract-change-requires-version':
                        results.push(...checkContractVersion(ctx));
                        break;
                    case 'service-public-entry':
                        results.push(...checkServicePublicEntry(ctx));
                        break;
                    case 'change-requires-test':
                        results.push(...checkChangeRequiresTest(ctx));
                        break;
                    case 'required-decorator':
                        results.push(...checkRequiredDecorator(ctx));
                        break;
                    default:
                        results.push(unknown(ctx, `Unsupported constraint kind \`${constraint.kind}\`.`));
                }
            }
            catch (error) {
                // A broken constraint must not take the whole assessment down, and it
                // must not look like a pass.
                results.push(unknown(ctx, `The check threw while running: ${error.message}. Treat this constraint as unverified.`));
            }
        }
    }
    return { results, consideredAdrs: considered, skipped };
}
//# sourceMappingURL=engine.js.map