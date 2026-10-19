"use strict";
/**
 * Scorecard assembly.
 *
 * Everything above this file finds things; this file decides what they add up
 * to. Two judgement calls are made here deliberately and are worth reading
 * before trusting the verdict:
 *
 * 1. **Not every escalation reason drives the verdict.** The escalation policy
 *    says to escalate on a design conflict, missing documentation or ownership,
 *    uncertain compatibility, or a possible production-behaviour change. Taken
 *    literally, the last one fires on nearly every real change — and a tool
 *    that routes every change to design review is a tool people turn off,
 *    which would make the metric worse rather than better. So all four reasons
 *    are *recorded and shown*, but only a design conflict or an unresolved
 *    compatibility question moves the verdict to `escalate-to-design-review`.
 *    Production-behaviour risk becomes blocking checklist items the developer
 *    must answer in the PR description instead.
 *
 * 2. **`unknown` is never rolled up as `pass`.** A dimension containing an
 *    unknown reports `unknown`, and the blind-spot list says why. The point of
 *    the tool is to stop a developer being surprised later, and a confident
 *    green on a check that did not actually run is the worst possible output.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assess = assess;
const id_1 = require("../core/id");
const config_1 = require("../core/config");
const blast_1 = require("./blast");
const compat_1 = require("./compat");
const risk_1 = require("./risk");
const engine_1 = require("../constraints/engine");
const adr_1 = require("../evidence/adr");
const tests_1 = require("../evidence/tests");
const STATUS_RANK = {
    conflict: 0,
    unknown: 1,
    attention: 2,
    pass: 3,
};
/** A dimension takes the worst status it contains, with `unknown` above `attention`. */
function rollUp(observations) {
    if (observations.length === 0)
        return 'pass';
    let worst = 'pass';
    for (const o of observations) {
        if (STATUS_RANK[o.status] < STATUS_RANK[worst])
            worst = o.status;
    }
    return worst;
}
function constraintToObservation(result) {
    const status = result.status === 'conflict' ? 'conflict' : result.status === 'unknown' ? 'unknown' : 'pass';
    return {
        id: (0, id_1.findingId)('adr-constraint', [
            result.adrId,
            result.constraint.id,
            result.location?.file ?? '',
            result.message.slice(0, 80),
        ]),
        dimension: 'design-conformance',
        checkId: `adr-constraint:${result.adrId}/${result.constraint.id}`,
        status,
        confidence: status === 'unknown' ? 'low' : 'high',
        title: status === 'conflict'
            ? `${result.adrId}: ${result.constraint.id}`
            : status === 'unknown'
                ? `${result.adrId}: ${result.constraint.id} could not be checked`
                : `${result.adrId}: ${result.constraint.id} holds`,
        detail: [result.message, result.constraint.rationale].filter(Boolean).join(' '),
        evidence: result.evidence,
        source: 'static',
        requiredActions: result.requiredActions,
        escalate: status === 'conflict'
            ? 'design-conflict'
            : status === 'unknown'
                ? 'missing-documentation'
                : undefined,
        owners: result.owners,
        location: result.location,
    };
}
function testsToObservations(input, analysis, affectedCount) {
    const observations = [];
    const { requirements, uncovered, changedTests, missingExpected } = analysis;
    const existing = requirements.filter((r) => r.exists);
    const missing = requirements.filter((r) => !r.exists);
    if (missing.length > 0) {
        observations.push({
            id: (0, id_1.findingId)('tests-missing-expected', missing.map((m) => m.target).sort()),
            dimension: 'test-coverage',
            checkId: 'tests/expectation-unmet',
            status: 'conflict',
            confidence: 'high',
            title: `${missing.length} required test${missing.length === 1 ? '' : 's'} do${missing.length === 1 ? 'es' : ''} not exist`,
            detail: missing
                .map((m) => `No test matches \`${m.target}\`. ${m.reason}`)
                .join(' '),
            evidence: missingExpected.slice(0, 4).map((m) => ({
                kind: 'tests',
                ref: m.expectation.id,
                excerpt: m.pattern,
                note: 'declared test expectation with no matching test',
            })),
            source: 'static',
            requiredActions: missing.map((m) => `Write a test matching \`${m.target}\`.`),
            owners: [],
        });
    }
    if (existing.length > 0) {
        observations.push({
            id: (0, id_1.findingId)('tests-relevant', existing.map((r) => r.target).sort()),
            dimension: 'test-coverage',
            checkId: 'tests/relevant-tests-found',
            status: changedTests.length > 0 ? 'pass' : 'attention',
            confidence: 'medium',
            title: `${existing.length} existing test${existing.length === 1 ? '' : 's'} exercise${existing.length === 1 ? 's' : ''} this change`,
            detail: `${existing.slice(0, 5).map((r) => `\`${r.target}\``).join(', ')}${existing.length > 5 ? `, +${existing.length - 5} more` : ''} import modules this change touches. ` +
                (changedTests.length > 0
                    ? `This change also updates ${changedTests.length} test file${changedTests.length === 1 ? '' : 's'}.`
                    : `No test file was changed, so the new behaviour is being asserted only by tests written for the old behaviour.`) +
                ' Note this is import reachability, not line coverage — a test that imports a module does not necessarily execute the changed lines.',
            evidence: existing.slice(0, 5).map((r) => ({
                kind: 'tests',
                ref: r.target,
                note: r.reason,
            })),
            source: 'static',
            requiredActions: changedTests.length > 0
                ? [`Run these before opening the PR: ${existing.slice(0, 4).map((r) => r.target).join(' ')}`]
                : [
                    `Run ${existing.slice(0, 4).map((r) => r.target).join(' ')} and add an assertion covering the new behaviour.`,
                ],
            owners: [],
        });
    }
    else if (missing.length === 0) {
        observations.push({
            id: (0, id_1.findingId)('tests-none-found', [...input.change.paths].sort()),
            dimension: 'test-coverage',
            checkId: 'tests/no-relevant-tests',
            status: 'conflict',
            confidence: 'medium',
            title: 'no test in the repo imports anything this change touches',
            detail: `Nothing under the configured test globs (${input.config.tests.match.join(', ')}) reaches the changed modules within 4 import hops. ` +
                `Either the change is in genuinely untested territory, or the test globs are wrong — both are worth resolving before a PR.`,
            evidence: [
                { kind: 'tests', ref: input.config.tests.match.join(', '), note: 'configured test globs' },
            ],
            source: 'static',
            requiredActions: [
                'Add a test that covers the changed behaviour, or confirm the test globs in donna.json are right.',
            ],
            owners: [],
        });
    }
    if (uncovered.length > 0) {
        observations.push({
            id: (0, id_1.findingId)('tests-uncovered-affected', uncovered.sort()),
            dimension: 'test-coverage',
            checkId: 'tests/uncovered-affected-module',
            status: 'attention',
            confidence: 'medium',
            title: `${uncovered.length} affected module${uncovered.length === 1 ? '' : 's'} ${uncovered.length === 1 ? 'has' : 'have'} no test reaching ${uncovered.length === 1 ? 'it' : 'them'}`,
            detail: `${uncovered.slice(0, 5).map((p) => `\`${p}\``).join(', ')}${uncovered.length > 5 ? `, +${uncovered.length - 5} more` : ''} ` +
                `${uncovered.length === 1 ? 'is' : 'are'} inside this change's blast radius (${affectedCount} modules) but no test imports ${uncovered.length === 1 ? 'it' : 'them'}. ` +
                `A regression there would ship silently.`,
            evidence: uncovered.slice(0, 5).map((p) => ({
                kind: 'graph',
                ref: p,
                note: 'in blast radius, no test reaches it',
            })),
            source: 'static',
            requiredActions: [
                'Decide which of these actually need coverage for this change, and say so in the PR rather than leaving it implicit.',
            ],
            owners: [...new Set(uncovered.flatMap((p) => input.ownersOf(p).owners))],
        });
    }
    return observations;
}
function reviewRouting(args) {
    const { input, blastServices, conflicted, adrOwners } = args;
    const reviewers = new Map();
    const add = (suggestion) => {
        const existing = reviewers.get(suggestion.handle);
        if (!existing) {
            reviewers.set(suggestion.handle, suggestion);
            return;
        }
        // Required beats suggested, and reasons accumulate.
        reviewers.set(suggestion.handle, {
            ...existing,
            weight: existing.weight === 'required' || suggestion.weight === 'required' ? 'required' : 'suggested',
            reason: existing.reason.includes(suggestion.reason)
                ? existing.reason
                : `${existing.reason} ${suggestion.reason}`,
            evidence: [...existing.evidence, ...suggestion.evidence].slice(0, 4),
        });
    };
    // Owners of directly changed files.
    for (const path of input.change.paths) {
        const lookup = input.ownersOf(path);
        for (const handle of lookup.owners) {
            add({
                handle,
                team: lookup.team,
                reason: `Owns changed files${lookup.team ? ` in ${lookup.team}` : ''}.`,
                weight: 'required',
                evidence: lookup.source ? [lookup.source] : [],
            });
        }
    }
    // Owners of directly-affected services.
    for (const service of blastServices.filter((s) => s.reach === 'direct')) {
        for (const handle of service.owners) {
            add({
                handle,
                team: service.service,
                reason: `Owns the ${service.service} service, which this change modifies.`,
                weight: 'required',
                evidence: [{ kind: 'service-map', ref: service.service, note: service.via }],
            });
        }
    }
    // Downstream service owners: suggested, because the change does not edit them.
    for (const service of blastServices.filter((s) => s.reach === 'downstream')) {
        for (const handle of service.owners) {
            add({
                handle,
                team: service.service,
                reason: `Owns ${service.service}, which is downstream of this change.`,
                weight: 'suggested',
                evidence: [{ kind: 'service-map', ref: service.service, note: service.via }],
            });
        }
    }
    // ADR owners, when their decision is in conflict.
    for (const observation of conflicted) {
        const adrId = /^adr-constraint:([^/]+)/.exec(observation.checkId)?.[1];
        const owners = adrId ? (adrOwners.get(adrId) ?? observation.owners) : observation.owners;
        for (const handle of owners) {
            add({
                handle,
                reason: adrId
                    ? `Owns ${adrId}, which this change conflicts with.`
                    : `Owns an area with an unresolved finding.`,
                weight: 'required',
                evidence: observation.evidence.filter((e) => e.kind === 'adr').slice(0, 1),
            });
        }
    }
    const list = [...reviewers.values()].sort((a, b) => (a.weight === b.weight ? 0 : a.weight === 'required' ? -1 : 1) ||
        a.handle.localeCompare(b.handle));
    const unowned = [...input.change.paths].filter((p) => input.ownersOf(p).owners.length === 0);
    const observations = [];
    if (list.length === 0) {
        observations.push({
            id: (0, id_1.findingId)('routing-no-owners', [...input.change.paths].sort()),
            dimension: 'review-routing',
            checkId: 'routing/no-owner-found',
            status: 'unknown',
            confidence: 'high',
            title: 'no owner could be identified for this change',
            detail: `Neither the ownership records nor CODEOWNERS covers any changed path, so Donna cannot tell you who should review this. ` +
                `It will not guess from git history — that nominates whoever last touched the file, which is not the same as the owner.`,
            evidence: [
                { kind: 'ownership', ref: input.config.ownership.codeowners ?? 'donna.json', note: 'no matching rule' },
            ],
            source: 'static',
            requiredActions: ['Ask your lead who owns these paths, and add an ownership record so the next change routes itself.'],
            escalate: 'missing-ownership',
            owners: [],
        });
    }
    else {
        observations.push({
            id: (0, id_1.findingId)('routing-owners', list.map((r) => r.handle).sort()),
            dimension: 'review-routing',
            checkId: 'routing/owners-resolved',
            status: unowned.length > 0 ? 'attention' : 'pass',
            confidence: 'high',
            title: `${list.filter((r) => r.weight === 'required').length} required, ${list.filter((r) => r.weight === 'suggested').length} suggested reviewer${list.length === 1 ? '' : 's'}`,
            detail: list
                .slice(0, 6)
                .map((r) => `${r.handle} (${r.weight})`)
                .join(', ') +
                (list.length > 6 ? `, +${list.length - 6} more.` : '.') +
                (unowned.length > 0
                    ? ` ${unowned.length} changed path${unowned.length === 1 ? ' has' : 's have'} no recorded owner: ${unowned.slice(0, 3).map((p) => `\`${p}\``).join(', ')}.`
                    : ''),
            evidence: list.slice(0, 4).flatMap((r) => r.evidence.slice(0, 1)),
            source: 'static',
            requiredActions: unowned.length > 0 ? ['Find an owner for the unowned paths before requesting review.'] : [],
            escalate: unowned.length > 0 ? 'missing-ownership' : undefined,
            owners: list.map((r) => r.handle),
        });
    }
    return { observations, reviewers: list };
}
// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
function decideVerdict(observations) {
    const conflicts = observations.filter((o) => o.status === 'conflict');
    const designConflicts = conflicts.filter((o) => o.escalate === 'design-conflict');
    const compatUncertain = observations.filter((o) => o.escalate === 'compat-uncertain' && o.status !== 'pass');
    const unknowns = observations.filter((o) => o.status === 'unknown');
    if (designConflicts.length > 0) {
        const adrs = [
            ...new Set(designConflicts
                .map((o) => /^adr-constraint:([^/]+)/.exec(o.checkId)?.[1])
                .filter((x) => !!x)),
        ];
        return {
            value: 'escalate-to-design-review',
            rationale: `${designConflicts.length} documented design decision${designConflicts.length === 1 ? '' : 's'}${adrs.length ? ` (${adrs.join(', ')})` : ''} ` +
                `conflict${designConflicts.length === 1 ? 's' : ''} with this change. That is not something to resolve in PR review — ` +
                `the decision's owners need to either amend the decision or the change needs reworking first.`,
        };
    }
    if (compatUncertain.length > 0) {
        return {
            value: 'escalate-to-design-review',
            rationale: `Backward compatibility could not be established for ${compatUncertain.length} item${compatUncertain.length === 1 ? '' : 's'}. ` +
                `A compatibility break found after merge is far more expensive than the review it takes to rule one out now.`,
        };
    }
    if (conflicts.length > 0) {
        return {
            value: 'needs-revision',
            rationale: `${conflicts.length} finding${conflicts.length === 1 ? '' : 's'} need${conflicts.length === 1 ? 's' : ''} to be addressed in the change itself ` +
                `(no documented design decision is in conflict, so this does not need design review). Work through the blocking checklist, then re-run.`,
        };
    }
    if (unknowns.length > 0) {
        return {
            value: 'needs-revision',
            rationale: `No conflicts found, but ${unknowns.length} check${unknowns.length === 1 ? '' : 's'} could not be completed. ` +
                `Resolve the blind spots below — or confirm by hand that they do not apply — before treating this as assessed.`,
        };
    }
    const attention = observations.filter((o) => o.status === 'attention');
    return {
        value: 'ready-to-propose',
        rationale: attention.length > 0
            ? `No conflicts and no unchecked constraints. ${attention.length} item${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} a sentence in the PR description rather than a code change. A human owner still has to approve.`
            : `No conflicts, no unchecked constraints, no risk signals. A human owner still has to approve.`,
    };
}
function buildEscalations(observations) {
    const grouped = new Map();
    for (const o of observations) {
        if (!o.escalate || o.status === 'pass')
            continue;
        const list = grouped.get(o.escalate) ?? [];
        list.push(o);
        grouped.set(o.escalate, list);
    }
    const order = [
        'design-conflict',
        'compat-uncertain',
        'production-behavior-change',
        'missing-documentation',
        'missing-ownership',
    ];
    return order
        .filter((reason) => grouped.has(reason))
        .map((reason) => {
        const items = grouped.get(reason);
        return {
            reason,
            detail: items
                .slice(0, 3)
                .map((o) => o.title)
                .join('; ') + (items.length > 3 ? `; +${items.length - 3} more` : ''),
            observationIds: items.map((o) => o.id),
            owners: [...new Set(items.flatMap((o) => o.owners))],
        };
    });
}
function buildChecklist(observations) {
    const items = new Map();
    for (const o of observations) {
        if (o.status === 'pass' && o.requiredActions.length === 0)
            continue;
        for (const action of o.requiredActions) {
            const id = (0, id_1.findingId)('checklist', [o.dimension, action]);
            if (items.has(id))
                continue;
            items.set(id, {
                id,
                text: action,
                blocking: o.status === 'conflict' || o.status === 'unknown',
                dimension: o.dimension,
                owners: o.owners,
            });
        }
    }
    return [...items.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.dimension.localeCompare(b.dimension));
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function assess(input, options = {}) {
    const maxDepth = options.maxDepth ?? 3;
    const blast = (0, blast_1.analyzeBlast)(input, maxDepth);
    const scope = { changed: input.change.paths, affected: blast.radius.all };
    const { results: constraintResults, consideredAdrs, skipped } = (0, engine_1.runConstraints)(input, scope);
    const designObservations = constraintResults.map(constraintToObservation);
    const compat = (0, compat_1.analyzeCompat)(input);
    const risk = (0, risk_1.analyzeRisk)(input, blast.radius.all);
    const coverage = (0, tests_1.buildTestCoverage)(input.graph, input.config);
    const testAnalysis = (0, tests_1.analyzeTests)({
        graph: input.graph,
        config: input.config,
        coverage,
        changedPaths: input.change.paths,
        affected: blast.radius.all,
        expectations: options.testExpectations ?? [],
    });
    const testObservations = testsToObservations(input, testAnalysis, blast.radius.all.size);
    // Missing design documentation for changed areas.
    //
    // Only production code counts. Test files and non-code files are excluded
    // because almost no ADR scopes itself to `tests/**`, so including them would
    // make "governed by no ADR" fire on essentially every change — and a signal
    // that always fires is one developers learn to scroll past. Tests have their
    // own governance through ADR-0007-style constraints and test expectations.
    const undocumented = (0, adr_1.undocumentedPaths)(input.adrs, input.change.paths).filter((p) => input.graph.nodes.has(p) && !input.graph.nodes.get(p).isTest);
    if (undocumented.length > 0 && input.adrs.some(adr_1.isActive)) {
        designObservations.push({
            id: (0, id_1.findingId)('design-undocumented', undocumented.sort()),
            dimension: 'design-conformance',
            checkId: 'design/no-governing-adr',
            status: 'unknown',
            confidence: 'high',
            title: `${undocumented.length} changed path${undocumented.length === 1 ? '' : 's'} ${undocumented.length === 1 ? 'is' : 'are'} governed by no ADR`,
            detail: `${undocumented.slice(0, 5).map((p) => `\`${p}\``).join(', ')}${undocumented.length > 5 ? `, +${undocumented.length - 5} more` : ''} ` +
                `fall outside every active ADR's scope. That might mean the area is genuinely unconstrained, or it might mean the governing decision was never written down — ` +
                `which is the case where a conflict only surfaces in a lead's review later.`,
            evidence: undocumented.slice(0, 5).map((p) => ({
                kind: 'diff',
                ref: p,
                note: 'no ADR covers this path',
            })),
            source: 'static',
            requiredActions: [
                'Ask whoever owns this area whether an unwritten design constraint applies before you open the PR.',
            ],
            escalate: 'missing-documentation',
            owners: [],
        });
    }
    else if (input.adrs.length === 0) {
        designObservations.push({
            id: (0, id_1.findingId)('design-no-adrs', ['none']),
            dimension: 'design-conformance',
            checkId: 'design/no-adrs-found',
            status: 'unknown',
            confidence: 'high',
            title: 'no architecture decision records were found',
            detail: `Nothing was loaded from \`${input.config.adrDir ?? '(no adrDir configured)'}\`, so design conformance was not assessed at all. This dimension is blank, not green.`,
            evidence: [{ kind: 'adr', ref: input.config.adrDir ?? 'unset', note: 'no ADRs loaded' }],
            source: 'static',
            requiredActions: ['Point `adrDir` at your design records, or review design conformance by hand.'],
            escalate: 'missing-documentation',
            owners: [],
        });
    }
    const allBeforeRouting = [
        ...blast.observations,
        ...designObservations,
        ...compat.observations,
        ...risk.observations,
        ...testObservations,
        ...(options.modelObservations ?? []),
    ].filter((o) => !input.config.accepted.includes(o.id));
    const adrOwners = new Map(consideredAdrs.map((a) => [a.id, a.owners]));
    const routing = reviewRouting({
        input,
        blastServices: blast.services,
        conflicted: allBeforeRouting.filter((o) => o.status === 'conflict'),
        adrOwners,
    });
    const observations = [...allBeforeRouting, ...routing.observations];
    const dimensionOrder = [
        'design-conformance',
        'backward-compatibility',
        'blast-radius',
        'production-risk',
        'test-coverage',
        'review-routing',
    ];
    const dimensions = dimensionOrder.map((dimension) => {
        const own = observations
            .filter((o) => o.dimension === dimension)
            .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
        const status = rollUp(own);
        return {
            dimension,
            status,
            summary: summarize(dimension, own, status),
            observations: own,
        };
    });
    const verdict = decideVerdict(observations);
    const escalations = buildEscalations(observations);
    const checklist = buildChecklist(observations);
    // --- Blind spots ---------------------------------------------------------
    // `loadIssues` already carries the ADR parse issues from the loader, so they
    // are not recomputed here — doing both listed every malformed ADR twice.
    const blindSpots = [...(options.loadIssues ?? [])];
    const proseOnly = consideredAdrs.filter((a) => a.constraints.length === 0);
    if (proseOnly.length > 0) {
        blindSpots.push(`${proseOnly.length} relevant ADR${proseOnly.length === 1 ? '' : 's'} (${proseOnly.map((a) => a.id).join(', ')}) ` +
            `${proseOnly.length === 1 ? 'has' : 'have'} no machine-checkable constraints — ${proseOnly.length === 1 ? 'its' : 'their'} prose was ` +
            `${options.modelPass?.ran ? 'handed to the model pass' : 'not evaluated, because the model pass did not run'}.`);
    }
    if (skipped.length > 0) {
        blindSpots.push(`${skipped.length} active ADR${skipped.length === 1 ? '' : 's'} ${skipped.length === 1 ? 'was' : 'were'} skipped as out of scope for the changed paths. If one of them governs this area, its \`appliesTo\` globs are wrong.`);
    }
    if (blast.radius.truncated) {
        blindSpots.push(`The dependent traversal stopped at ${maxDepth} hops with modules still beyond it, so the downstream list is a floor rather than a total.`);
    }
    if (blast.nonCodeChanges.length > 0) {
        blindSpots.push(`${blast.nonCodeChanges.length} changed file${blast.nonCodeChanges.length === 1 ? '' : 's'} (${blast.nonCodeChanges.slice(0, 3).join(', ')}${blast.nonCodeChanges.length > 3 ? ', …' : ''}) are not Python or TypeScript and were not traced through the graph.`);
    }
    if (compat.incomplete) {
        blindSpots.push('At least one compatibility check could not run. See the unknown items under backward compatibility.');
    }
    blindSpots.push('Test relevance is import reachability within 4 hops, not line coverage — a listed test may import a changed module without executing the changed lines.');
    if (!options.modelPass?.ran) {
        blindSpots.push(`The model pass did not run${options.modelPass?.skippedBecause ? ` (${options.modelPass.skippedBecause})` : ''}, so only deterministic checks contributed. Design intent expressed in prose was not evaluated.`);
    }
    const added = input.change.files.reduce((sum, f) => sum + f.added, 0);
    const removed = input.change.files.reduce((sum, f) => sum + f.removed, 0);
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        repo: input.config.repoRoot,
        branch: input.change.branch,
        baseRef: input.change.baseRef,
        change: {
            files: input.change.files.length,
            added,
            removed,
            paths: [...input.change.paths].sort(),
        },
        dimensions,
        affectedServices: blast.services,
        requiredTests: dedupeTests(testAnalysis.requirements),
        reviewers: routing.reviewers,
        checklist,
        verdict,
        escalations,
        modelPass: options.modelPass ?? { ran: false, skippedBecause: 'not requested' },
        contextPack: input.config.contextPack,
        limits: config_1.AGENT_LIMITS,
        blindSpots,
    };
}
function dedupeTests(requirements) {
    const seen = new Map();
    for (const requirement of requirements) {
        const existing = seen.get(requirement.target);
        if (!existing) {
            seen.set(requirement.target, requirement);
            continue;
        }
        seen.set(requirement.target, {
            ...existing,
            covers: [...new Set([...existing.covers, ...requirement.covers])],
            reason: existing.reason.includes(requirement.reason)
                ? existing.reason
                : `${existing.reason} ${requirement.reason}`,
        });
    }
    return [...seen.values()].sort((a, b) => Number(a.exists) - Number(b.exists) || b.covers.length - a.covers.length);
}
function summarize(dimension, observations, status) {
    const counts = {
        conflict: observations.filter((o) => o.status === 'conflict').length,
        unknown: observations.filter((o) => o.status === 'unknown').length,
        attention: observations.filter((o) => o.status === 'attention').length,
        pass: observations.filter((o) => o.status === 'pass').length,
    };
    if (observations.length === 0)
        return 'Nothing to report.';
    const parts = [];
    if (counts.conflict)
        parts.push(`${counts.conflict} conflict${counts.conflict === 1 ? '' : 's'}`);
    if (counts.unknown)
        parts.push(`${counts.unknown} unchecked`);
    if (counts.attention)
        parts.push(`${counts.attention} to note`);
    if (counts.pass && parts.length === 0)
        parts.push(`${counts.pass} check${counts.pass === 1 ? '' : 's'} passed`);
    const lead = status === 'conflict'
        ? 'Blocking.'
        : status === 'unknown'
            ? 'Incomplete.'
            : status === 'attention'
                ? 'Worth a look.'
                : 'Clear.';
    const hint = {
        'design-conformance': 'Measured against the ADRs that govern the changed paths.',
        'backward-compatibility': 'Public symbols, contract fields and routes, compared against the base revision.',
        'blast-radius': 'Dependents traversed upward from the changed modules.',
        'production-risk': 'Heuristic signals, so a clear result means nothing obvious rather than no risk.',
        'test-coverage': 'Tests that import the changed modules, plus declared expectations.',
        'review-routing': 'From ownership records and CODEOWNERS; never inferred from git history.',
    };
    return `${lead} ${parts.join(', ')}. ${hint[dimension]}`;
}
//# sourceMappingURL=scorecard.js.map