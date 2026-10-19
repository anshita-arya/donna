"use strict";
/**
 * A small glob matcher, so the analysis core has zero runtime dependencies.
 * Supports `**`, `*`, `?`, and brace alternation `{a,b}` — enough for the
 * path patterns that appear in `donna.json`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchGlob = matchGlob;
exports.matchAny = matchAny;
function expandBraces(pattern) {
    const open = pattern.indexOf('{');
    if (open === -1)
        return [pattern];
    let depth = 0;
    let close = -1;
    for (let i = open; i < pattern.length; i++) {
        if (pattern[i] === '{')
            depth++;
        else if (pattern[i] === '}') {
            depth--;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close === -1)
        return [pattern];
    const before = pattern.slice(0, open);
    const after = pattern.slice(close + 1);
    const body = pattern.slice(open + 1, close);
    const parts = [];
    let buf = '';
    let d = 0;
    for (const ch of body) {
        if (ch === '{')
            d++;
        if (ch === '}')
            d--;
        if (ch === ',' && d === 0) {
            parts.push(buf);
            buf = '';
        }
        else {
            buf += ch;
        }
    }
    parts.push(buf);
    return parts.flatMap((p) => expandBraces(before + p + after));
}
function toRegexSource(pattern) {
    let out = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            const isDouble = pattern[i + 1] === '*';
            if (isDouble) {
                const followedBySlash = pattern[i + 2] === '/';
                if (followedBySlash) {
                    // `**/` matches zero or more path segments.
                    out += '(?:[^/]+/)*';
                    i += 3;
                }
                else {
                    out += '.*';
                    i += 2;
                }
            }
            else {
                out += '[^/]*';
                i += 1;
            }
            continue;
        }
        if (ch === '?') {
            out += '[^/]';
            i += 1;
            continue;
        }
        out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        i += 1;
    }
    return out;
}
const cache = new Map();
function compile(pattern) {
    const hit = cache.get(pattern);
    if (hit)
        return hit;
    const alternatives = expandBraces(pattern).map(toRegexSource);
    const re = new RegExp(`^(?:${alternatives.join('|')})$`);
    cache.set(pattern, re);
    return re;
}
/** Matches a POSIX, workspace-relative path against one glob. */
function matchGlob(path, pattern) {
    const normalized = path.replace(/^\.\//, '');
    let p = pattern.replace(/^\.\//, '');
    // A bare directory pattern (`src/ui`) is treated as that whole subtree.
    if (!p.includes('*') && !p.endsWith('/')) {
        if (normalized === p)
            return true;
        p = `${p}/**`;
    }
    return compile(p).test(normalized);
}
function matchAny(path, patterns) {
    return patterns.some((p) => matchGlob(path, p));
}
//# sourceMappingURL=glob.js.map