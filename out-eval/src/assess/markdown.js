"use strict";
/**
 * Renders a scorecard as markdown.
 *
 * Used by the eval harness (where it is the whole output) and by the extension
 * when the developer wants the assessment as text. The ordering is deliberate:
 * the verdict and what to do about it come first, the evidence second, and the
 * blind spots are not buried at the bottom as a disclaimer — they sit directly
 * under the verdict, because "what this did not check" is part of the answer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderScorecardMarkdown = renderScorecardMarkdown;
const types_1 = require("../core/types");
const STATUS_MARK = {
    conflict: '✗',
    unknown: '?',
    attention: '!',
    pass: '✓',
};
function observationBlock(observation, indent = '') {
    const lines = [];
    const mark = STATUS_MARK[observation.status];
    const where = observation.location ? ` — ${observation.location.file}:${observation.location.line}` : '';
    const src = observation.source === 'model' ? ' *(model)*' : '';
    lines.push(`${indent}- **${mark} ${observation.title}**${where}${src}`);
    lines.push(`${indent}  ${observation.detail}`);
    if (observation.evidence.length) {
        const cited = observation.evidence
            .slice(0, 4)
            .map((e) => {
            const loc = e.line ? `:${e.line}` : '';
            const excerpt = e.excerpt ? ` — \`${e.excerpt.replace(/`/g, "'").slice(0, 90)}\`` : '';
            return `${e.kind}: ${e.ref}${loc}${excerpt}`;
        })
            .join('; ');
        lines.push(`${indent}  *Evidence:* ${cited}`);
    }
    if (observation.requiredActions.length) {
        for (const action of observation.requiredActions) {
            lines.push(`${indent}  - [ ] ${action}`);
        }
    }
    const bits = [`confidence: ${observation.confidence}`];
    if (observation.escalate)
        bits.push(`escalates: ${types_1.ESCALATION_LABELS[observation.escalate]}`);
    if (observation.owners.length)
        bits.push(`owners: ${observation.owners.join(', ')}`);
    lines.push(`${indent}  *${bits.join(' · ')}*`);
    return lines;
}
function renderScorecardMarkdown(card, options = {}) {
    const out = [];
    const verdictMark = card.verdict.value === 'ready-to-propose'
        ? '✓'
        : card.verdict.value === 'needs-revision'
            ? '!'
            : '✗';
    out.push(`# ${options.title ?? 'Impact assessment'}`);
    out.push('');
    if (card.contextPack?.synthetic) {
        out.push(`> **Synthetic context:** "${card.contextPack.name}". ${card.contextPack.disclaimer ?? ''}`);
        out.push('');
    }
    out.push(`## ${verdictMark} ${types_1.VERDICT_LABELS[card.verdict.value]}`);
    out.push('');
    out.push(card.verdict.rationale);
    out.push('');
    out.push(`\`${card.branch}\` vs \`${card.baseRef.slice(0, 12)}\` · ${card.change.files} file${card.change.files === 1 ? '' : 's'}, +${card.change.added}/-${card.change.removed}`);
    out.push('');
    // --- Dimensions at a glance ---------------------------------------------
    out.push('| Dimension | Status | Summary |');
    out.push('| --- | --- | --- |');
    for (const dimension of card.dimensions) {
        out.push(`| ${types_1.DIMENSION_LABELS[dimension.dimension]} | ${STATUS_MARK[dimension.status]} ${dimension.status} | ${dimension.summary} |`);
    }
    out.push('');
    // --- Escalations ---------------------------------------------------------
    if (card.escalations.length) {
        out.push('## Escalations');
        out.push('');
        for (const escalation of card.escalations) {
            out.push(`- **${types_1.ESCALATION_LABELS[escalation.reason]}** — ${escalation.detail}${escalation.owners.length ? ` *(route to ${escalation.owners.join(', ')})*` : ''}`);
        }
        out.push('');
    }
    // --- Blind spots, up front rather than buried ---------------------------
    if (card.blindSpots.length) {
        out.push('## What this did not check');
        out.push('');
        for (const spot of card.blindSpots)
            out.push(`- ${spot}`);
        out.push('');
    }
    // --- Blocking checklist --------------------------------------------------
    const blocking = card.checklist.filter((c) => c.blocking);
    const nonBlocking = card.checklist.filter((c) => !c.blocking);
    if (blocking.length) {
        out.push('## Before you open a PR');
        out.push('');
        for (const item of blocking) {
            out.push(`- [ ] ${item.text} *(${types_1.DIMENSION_LABELS[item.dimension]}${item.owners.length ? ` · ${item.owners.join(', ')}` : ''})*`);
        }
        out.push('');
    }
    if (nonBlocking.length) {
        out.push('## Worth saying in the PR description');
        out.push('');
        for (const item of nonBlocking) {
            out.push(`- [ ] ${item.text} *(${types_1.DIMENSION_LABELS[item.dimension]})*`);
        }
        out.push('');
    }
    // --- Findings by dimension ----------------------------------------------
    out.push('## Findings');
    out.push('');
    for (const dimension of card.dimensions) {
        const shown = options.includePasses
            ? dimension.observations
            : dimension.observations.filter((o) => o.status !== 'pass');
        if (shown.length === 0)
            continue;
        out.push(`### ${types_1.DIMENSION_LABELS[dimension.dimension]}`);
        out.push('');
        for (const observation of shown) {
            out.push(...observationBlock(observation));
            out.push('');
        }
    }
    // --- Services ------------------------------------------------------------
    if (card.affectedServices.length) {
        out.push('## Affected services');
        out.push('');
        out.push('| Service | Reach | Modules | Owners |');
        out.push('| --- | --- | --- | --- |');
        for (const service of card.affectedServices) {
            out.push(`| ${service.service} | ${service.reach} | ${service.modules.length} | ${service.owners.join(', ') || '—'} |`);
        }
        out.push('');
    }
    // --- Tests ---------------------------------------------------------------
    if (card.requiredTests.length) {
        out.push('## Tests');
        out.push('');
        for (const test of card.requiredTests) {
            out.push(`- ${test.exists ? '`' + test.target + '`' : '**missing:** `' + test.target + '`'} — ${test.reason}`);
        }
        out.push('');
    }
    // --- Reviewers -----------------------------------------------------------
    if (card.reviewers.length) {
        out.push('## Reviewers');
        out.push('');
        for (const reviewer of card.reviewers) {
            out.push(`- **${reviewer.handle}** (${reviewer.weight}) — ${reviewer.reason}`);
        }
        out.push('');
    }
    // --- Provenance ----------------------------------------------------------
    out.push('## How this was produced');
    out.push('');
    out.push(`- Deterministic checks: dependency graph, ADR constraints, contract comparison against the base revision, ownership lookup, test reachability.`);
    out.push(card.modelPass.ran
        ? `- Model pass: ran via ${card.modelPass.provider} (${card.modelPass.model}). Model observations are marked *(model)* above.`
        : `- Model pass: did not run${card.modelPass.skippedBecause ? ` — ${card.modelPass.skippedBecause}` : ''}.`);
    out.push('');
    out.push('### What this agent does not do');
    out.push('');
    for (const limit of card.limits)
        out.push(`- ${limit}`);
    out.push('');
    out.push(`*Generated ${card.generatedAt}.*`);
    return out.join('\n');
}
//# sourceMappingURL=markdown.js.map