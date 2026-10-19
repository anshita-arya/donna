"use strict";
/**
 * Ownership resolution.
 *
 * Two sources, and the order matters. Explicit ownership records in
 * `donna.json` win over CODEOWNERS, because CODEOWNERS answers "who must
 * approve this file" while an ownership record answers "which team owns this
 * component" — and for routing a design question, the second is the better
 * answer. Both are reported as evidence so the developer can see which one
 * produced a name.
 *
 * The agent never assigns ownership. If neither source covers a changed path,
 * that is surfaced as a missing-ownership escalation rather than guessed from
 * git history, which would silently nominate whoever last touched the file.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OwnershipIndex = void 0;
exports.codeownersPatternToGlob = codeownersPatternToGlob;
exports.parseCodeowners = parseCodeowners;
const glob_1 = require("../core/glob");
/**
 * Converts a CODEOWNERS pattern to a glob.
 *
 * CODEOWNERS uses gitignore-style matching: a pattern with no slash matches at
 * any depth, a leading slash anchors to the repo root, and a trailing slash
 * means "everything under this directory".
 */
function codeownersPatternToGlob(pattern) {
    let p = pattern.trim();
    if (p === '*')
        return '**';
    const anchored = p.startsWith('/');
    if (anchored)
        p = p.slice(1);
    const isDir = p.endsWith('/');
    if (isDir)
        p = p.slice(0, -1);
    const hasInnerSlash = p.includes('/');
    if (isDir)
        p = `${p}/**`;
    if (!anchored && !hasInnerSlash)
        p = `**/${p}`;
    return p;
}
function parseCodeowners(path, text) {
    const rules = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const withoutComment = line.replace(/#.*$/, '').trim();
        if (!withoutComment)
            continue;
        const parts = withoutComment.split(/\s+/);
        const pattern = parts[0];
        const owners = parts.slice(1).filter((p) => p.startsWith('@') || p.includes('@'));
        if (!pattern || owners.length === 0)
            continue;
        rules.push({
            pattern,
            glob: codeownersPatternToGlob(pattern),
            owners,
            source: 'codeowners',
            line: i + 1,
            sourcePath: path,
        });
    }
    return rules;
}
class OwnershipIndex {
    recordRules = [];
    codeownerRules = [];
    serviceRules = [];
    cache = new Map();
    constructor(config, codeownersText) {
        for (const record of config.ownership.records) {
            for (const glob of record.match) {
                this.recordRules.push({
                    pattern: glob,
                    glob,
                    owners: record.owners,
                    team: record.team,
                    source: 'record',
                    sourcePath: 'donna.json',
                });
            }
        }
        for (const service of config.services) {
            if (!service.owners?.length)
                continue;
            for (const glob of service.match) {
                this.serviceRules.push({
                    pattern: glob,
                    glob,
                    owners: service.owners,
                    team: service.name,
                    source: 'service',
                    sourcePath: 'donna.json',
                });
            }
        }
        if (codeownersText && config.ownership.codeowners) {
            this.codeownerRules.push(...parseCodeowners(config.ownership.codeowners, codeownersText));
        }
    }
    /**
     * Resolves one path. Within a source, the last matching rule wins, which is
     * the CODEOWNERS convention and the least surprising for records too.
     */
    lookup(path) {
        const cached = this.cache.get(path);
        if (cached)
            return cached;
        const result = this.resolve(path);
        this.cache.set(path, result);
        return result;
    }
    resolve(path) {
        for (const bucket of [this.recordRules, this.serviceRules, this.codeownerRules]) {
            let hit = null;
            for (const rule of bucket) {
                if ((0, glob_1.matchGlob)(path, rule.glob))
                    hit = rule;
            }
            if (!hit)
                continue;
            return {
                owners: hit.owners,
                team: hit.team,
                source: {
                    kind: 'ownership',
                    ref: hit.sourcePath,
                    line: hit.line,
                    excerpt: `${hit.pattern} ${hit.owners.join(' ')}`,
                    note: hit.source === 'codeowners'
                        ? 'from CODEOWNERS'
                        : hit.source === 'service'
                            ? `service owner for ${hit.team}`
                            : 'from ownership records',
                },
            };
        }
        return { owners: [], source: null };
    }
    /** True when no source names an owner for any of these paths. */
    unowned(paths) {
        const out = [];
        for (const path of paths) {
            if (this.lookup(path).owners.length === 0)
                out.push(path);
        }
        return out;
    }
    get hasAnyRules() {
        return (this.recordRules.length + this.codeownerRules.length + this.serviceRules.length > 0);
    }
}
exports.OwnershipIndex = OwnershipIndex;
//# sourceMappingURL=owners.js.map