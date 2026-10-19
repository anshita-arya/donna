"use strict";
/**
 * The design-review agent.
 *
 * Triggered explicitly by the developer after the scorecard has flagged a
 * conflict — never automatically, because preparing a revision presumes the
 * developer has decided the conflict is real and wants to resolve it in code
 * rather than by amending the decision. That decision is theirs.
 *
 * The output is a change request. It passes through the guardrails before the
 * developer sees it, and rejected edits are reported rather than hidden: if the
 * agent tried to edit an ADR to make a conflict disappear, the developer should
 * know that is what it reached for.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.filesForReview = filesForReview;
exports.runDesignReview = runDesignReview;
const guardrails_1 = require("./guardrails");
const model_1 = require("./model");
const prompts_1 = require("./prompts");
function asString(value, max = 1200) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function asStringArray(value, max = 10) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((v) => asString(v, 400))
        .filter(Boolean)
        .slice(0, max);
}
/** Files the agent may need to see: anything a conflict points at. */
function filesForReview(scorecard, change, limit) {
    const ranked = new Map();
    for (const dimension of scorecard.dimensions) {
        for (const observation of dimension.observations) {
            if (observation.status !== 'conflict' && observation.status !== 'unknown')
                continue;
            const paths = [
                observation.location?.file,
                ...observation.evidence.filter((e) => e.kind === 'diff' || e.kind === 'graph').map((e) => e.ref),
            ].filter((p) => !!p);
            for (const path of paths) {
                // Conflicts weigh more than unknowns, and a path cited twice weighs more.
                ranked.set(path, (ranked.get(path) ?? 0) + (observation.status === 'conflict' ? 2 : 1));
            }
        }
    }
    // Always include changed files, so the agent can see what it is revising.
    for (const path of change.paths)
        ranked.set(path, (ranked.get(path) ?? 0) + 1);
    return [...ranked]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([path]) => path)
        .slice(0, limit);
}
async function runDesignReview(args) {
    const { client, scorecard, change, adrs, config, readFile } = args;
    const maxFiles = args.maxFiles ?? 6;
    const conflicts = scorecard.dimensions
        .flatMap((d) => d.observations)
        .filter((o) => o.status === 'conflict' || o.status === 'unknown');
    if (conflicts.length === 0) {
        return {
            request: null,
            applicableEdits: [],
            violations: [],
            unapplicable: [],
            error: 'There are no conflicts or unchecked findings to revise.',
        };
    }
    const fileContents = new Map();
    for (const path of filesForReview(scorecard, change, maxFiles)) {
        const text = readFile(path);
        if (text !== undefined)
            fileContents.set(path, text);
    }
    const prompt = (0, prompts_1.buildDesignReviewPrompt)({ scorecard, change, adrs, fileContents, maxFiles });
    let raw;
    try {
        raw = await client.complete({
            system: prompts_1.DESIGN_REVIEW_SYSTEM,
            user: prompt,
            maxTokens: 8192,
            signal: args.signal,
        });
    }
    catch (error) {
        const message = error instanceof model_1.ModelUnavailableError
            ? `${error.message}${error.hint ? ` ${error.hint}` : ''}`
            : error.message;
        return {
            request: null,
            applicableEdits: [],
            violations: [],
            unapplicable: [],
            error: `The model call failed: ${message}`,
            provider: client.provider,
            model: client.model,
        };
    }
    const parsed = (0, model_1.extractJson)(raw);
    if (!parsed.ok) {
        return {
            request: null,
            applicableEdits: [],
            violations: [],
            unapplicable: [],
            error: parsed.reason,
            provider: client.provider,
            model: client.model,
        };
    }
    const rawEdits = Array.isArray(parsed.value.edits) ? parsed.value.edits : [];
    const edits = [];
    for (const entry of rawEdits.slice(0, 20)) {
        if (!entry || typeof entry !== 'object')
            continue;
        const row = entry;
        const file = asString(row.file, 300);
        const find = typeof row.find === 'string' ? row.find : '';
        const replace = typeof row.replace === 'string' ? row.replace : '';
        if (!file || !find)
            continue;
        edits.push({ file, find, replace, note: asString(row.note, 400) || undefined });
    }
    const suggestedTests = (Array.isArray(parsed.value.suggestedTests) ? parsed.value.suggestedTests : [])
        .slice(0, 8)
        .map((entry) => {
        const row = (entry ?? {});
        return { target: asString(row.target, 300), asserts: asString(row.asserts, 500) };
    })
        .filter((t) => t.target && t.asserts);
    const knownIds = new Set(conflicts.map((o) => o.id));
    const request = {
        summary: asString(parsed.value.summary, 300) || 'Revision proposed by the design-review agent.',
        rationale: asString(parsed.value.rationale, 1500),
        addresses: asStringArray(parsed.value.addresses).filter((id) => knownIds.has(id)),
        edits,
        suggestedTests,
        openQuestions: asStringArray(parsed.value.openQuestions),
        routeTo: asStringArray(parsed.value.routeTo, 8).filter((h) => h.startsWith('@')),
    };
    // If the model referenced no real observation ids, fall back to all the
    // conflicts rather than claiming it addressed nothing.
    if (request.addresses.length === 0) {
        request.addresses = conflicts.filter((o) => o.status === 'conflict').map((o) => o.id);
    }
    const { allowed, violations } = (0, guardrails_1.checkChangeRequest)(request, config);
    const applicableEdits = [];
    const unapplicable = [];
    for (const edit of allowed) {
        const check = (0, guardrails_1.validateEditAgainstFile)(edit, readFile(edit.file));
        if (check.ok)
            applicableEdits.push(edit);
        else
            unapplicable.push({ edit, reason: check.reason });
    }
    return {
        request,
        applicableEdits,
        violations,
        unapplicable,
        provider: client.provider,
        model: client.model,
    };
}
//# sourceMappingURL=designReview.js.map