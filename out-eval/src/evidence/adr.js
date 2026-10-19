"use strict";
/**
 * ADR indexing.
 *
 * An ADR is markdown prose written by an engineering lead. The part a machine
 * can check lives in a fenced ```donna block containing JSON. That split is
 * deliberate:
 *
 *  - Prose stays prose. Nobody writes a design decision as a config file, and
 *    an ADR whose rationale is squeezed into YAML stops being read by humans.
 *  - The enforceable part is explicit and unambiguous. JSON parses with no
 *    dependency and no indentation guessing, and a lead can see exactly what
 *    the tool will check versus what it will only *cite*.
 *  - The prose that is not machine-checkable is not discarded — it is handed to
 *    the model pass as context, with the ADR cited as evidence. That is how an
 *    "integration assumption" written in English still influences the
 *    assessment without the tool pretending to have verified it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAdr = parseAdr;
exports.indexAdrs = indexAdrs;
exports.isActive = isActive;
exports.relevantAdrs = relevantAdrs;
exports.undocumentedPaths = undocumentedPaths;
const glob_1 = require("../core/glob");
const FENCE_RE = /```donna\s*\n([\s\S]*?)```/;
const TITLE_RE = /^#\s+(.+)$/m;
const STATUS_LINE_RE = /^[-*]\s*\*\*Status:?\*\*:?\s*(.+)$/im;
const OWNERS_LINE_RE = /^[-*]\s*\*\*Owners?:?\*\*:?\s*(.+)$/im;
const ADR_ID_RE = /\b(ADR[-_]?\d{1,4})\b/i;
const VALID_KINDS = [
    'forbidden-dependency',
    'required-reachability',
    'contract-change-requires-version',
    'service-public-entry',
    'change-requires-test',
    'required-decorator',
];
function normalizeId(raw) {
    const m = ADR_ID_RE.exec(raw);
    if (!m)
        return raw.trim();
    return m[1].toUpperCase().replace('_', '-').replace(/^ADR(\d)/, 'ADR-$1');
}
function parseHandles(raw) {
    return raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith('@'))
        .map((s) => s.replace(/[.,;]$/, ''));
}
function parseAdr(path, text) {
    const issues = [];
    const titleMatch = TITLE_RE.exec(text);
    const heading = titleMatch?.[1]?.trim() ?? '';
    const fence = FENCE_RE.exec(text);
    const body = text.replace(FENCE_RE, '').trim();
    let block = {};
    if (fence) {
        try {
            const parsed = JSON.parse(fence[1]);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                block = parsed;
            }
            else {
                issues.push({ path, message: 'The donna block must be a JSON object.' });
            }
        }
        catch (error) {
            issues.push({
                path,
                message: `The donna block is not valid JSON: ${error.message}. Constraints in this ADR will not be checked.`,
            });
        }
    }
    const idFromBlock = typeof block.id === 'string' ? block.id : null;
    const idFromHeading = heading ? ADR_ID_RE.exec(heading)?.[1] : null;
    const idFromPath = ADR_ID_RE.exec(path)?.[1];
    const rawId = idFromBlock ?? idFromHeading ?? idFromPath;
    if (!rawId) {
        issues.push({
            path,
            message: 'No ADR id found in the donna block, the heading, or the filename.',
        });
        return { doc: null, issues };
    }
    const id = normalizeId(rawId);
    const title = heading.replace(new RegExp(`^${id}\\s*[:–—-]\\s*`, 'i'), '').trim() || id;
    const statusFromBlock = typeof block.status === 'string' ? block.status : null;
    const statusFromProse = STATUS_LINE_RE.exec(text)?.[1]?.trim();
    const status = (statusFromBlock ?? statusFromProse ?? 'unknown').toLowerCase().replace(/\.$/, '');
    const ownersFromBlock = Array.isArray(block.owners)
        ? block.owners.filter((o) => typeof o === 'string')
        : [];
    const ownersFromProse = OWNERS_LINE_RE.exec(text)?.[1] ?? '';
    const owners = [...new Set([...ownersFromBlock, ...parseHandles(ownersFromProse)])];
    const appliesTo = Array.isArray(block.appliesTo)
        ? block.appliesTo.filter((g) => typeof g === 'string')
        : [];
    const constraints = [];
    const rawConstraints = Array.isArray(block.constraints) ? block.constraints : [];
    for (const [i, entry] of rawConstraints.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            issues.push({ path, message: `Constraint #${i + 1} is not an object.` });
            continue;
        }
        const c = entry;
        const kind = c.kind;
        if (typeof kind !== 'string' || !VALID_KINDS.includes(kind)) {
            issues.push({
                path,
                message: `Constraint #${i + 1} has unknown kind "${String(kind)}". Known kinds: ${VALID_KINDS.join(', ')}.`,
            });
            continue;
        }
        const constraintId = typeof c.id === 'string' ? c.id : `c${i + 1}`;
        const severity = c.severity === 'concern' ? 'concern' : 'blocker';
        const rationale = typeof c.rationale === 'string' ? c.rationale : '';
        const params = c.params && typeof c.params === 'object' && !Array.isArray(c.params)
            ? c.params
            : {};
        constraints.push({ id: constraintId, kind: kind, severity, rationale, params });
    }
    if (!fence && !constraints.length) {
        issues.push({
            path,
            message: 'No donna block, so nothing in this ADR can be checked automatically. It is still cited as context for the model pass.',
        });
    }
    const doc = {
        id,
        title,
        status,
        path,
        owners,
        appliesTo,
        constraints,
        body,
    };
    if (typeof block.supersededBy === 'string')
        doc.supersededBy = block.supersededBy;
    return { doc, issues };
}
function indexAdrs(files) {
    const documents = [];
    const issues = [];
    for (const file of files) {
        const { doc, issues: fileIssues } = parseAdr(file.path, file.text);
        issues.push(...fileIssues);
        if (doc)
            documents.push(doc);
    }
    documents.sort((a, b) => a.id.localeCompare(b.id));
    return { documents, issues };
}
/** An ADR is in force when accepted — superseded and deprecated ones are not. */
function isActive(doc) {
    return doc.status === 'accepted' || doc.status === 'approved' || doc.status === 'adopted';
}
/**
 * ADRs whose `appliesTo` globs cover any changed path.
 *
 * An ADR with no `appliesTo` is treated as repo-wide rather than irrelevant:
 * failing to surface a governing decision is the exact failure this tool
 * exists to prevent, so the default leans toward showing it.
 */
function relevantAdrs(docs, changedPaths) {
    const paths = [...changedPaths];
    return docs.filter((doc) => {
        if (!isActive(doc))
            return false;
        if (doc.appliesTo.length === 0)
            return true;
        return paths.some((p) => (0, glob_1.matchAny)(p, doc.appliesTo));
    });
}
/** Changed areas that no active ADR governs — a missing-documentation signal. */
function undocumentedPaths(docs, changedPaths) {
    const active = docs.filter(isActive).filter((d) => d.appliesTo.length > 0);
    const out = [];
    for (const path of changedPaths) {
        if (!active.some((doc) => (0, glob_1.matchAny)(path, doc.appliesTo)))
            out.push(path);
    }
    return out;
}
//# sourceMappingURL=adr.js.map