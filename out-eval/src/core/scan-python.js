"use strict";
/**
 * Python module scanning: imports, module-level public symbols, LOC.
 *
 * Like the TS scanner, this is a lexer rather than a parser. A full AST pass
 * (or worse, importing the module) is the wrong cost for something that reruns
 * every time an agent writes a file, and module-level import edges plus
 * top-level symbol names are all the impact analysis needs.
 *
 * Correctness that matters here and that naive regex scanners get wrong:
 * comments inside strings, `#` inside strings, triple-quoted docstrings
 * containing import examples, and parenthesized multi-line `from X import (...)`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports._internal = void 0;
exports.maskPython = maskPython;
exports.scanPython = scanPython;
/**
 * Replaces string literal bodies and comments with spaces, preserving every
 * byte offset and newline so line numbers stay exact.
 */
function maskPython(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    const pushSpaces = (count) => {
        out.push(' '.repeat(count));
    };
    while (i < n) {
        const ch = src[i];
        // Comment: to end of line.
        if (ch === '#') {
            let j = i;
            while (j < n && src[j] !== '\n')
                j++;
            pushSpaces(j - i);
            i = j;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const triple = src.slice(i, i + 3);
            const isTriple = triple === '"""' || triple === "'''";
            const delim = isTriple ? triple : ch;
            // Preserve the quote characters so `from X import "..."`-shaped text is
            // still distinguishable, then blank the body.
            out.push(delim);
            let j = i + delim.length;
            while (j < n) {
                if (src[j] === '\\') {
                    pushSpaces(Math.min(2, n - j));
                    j += 2;
                    continue;
                }
                if (src.startsWith(delim, j))
                    break;
                if (src[j] === '\n') {
                    out.push('\n'); // keep line count intact
                }
                else {
                    out.push(' ');
                }
                j++;
            }
            out.push(delim.slice(0, Math.min(delim.length, Math.max(0, n - j))));
            i = j + delim.length;
            continue;
        }
        out.push(ch);
        i++;
    }
    return out.join('');
}
function lineNumberAt(src, index) {
    let line = 1;
    for (let i = 0; i < index && i < src.length; i++) {
        if (src[i] === '\n')
            line++;
    }
    return line;
}
/** Builds a prefix-sum of line starts so offset→line is O(log n), not O(n). */
function lineIndex(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) {
        if (src[i] === '\n')
            starts.push(i + 1);
    }
    return starts;
}
function lineOf(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lo + 1;
}
const IMPORT_RE = /^([ \t]*)(?:(from)[ \t]+([.\w]+)[ \t]+import[ \t]+(\(?)([^\n]*)|(import)[ \t]+([^\n]*))/gm;
function splitNames(raw) {
    return raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
        // `x as y` -> the imported name is `x`; we care about the source symbol.
        const m = /^([.\w*]+)(?:\s+as\s+[\w]+)?$/.exec(part);
        return m ? m[1] : part;
    })
        .filter((name) => name !== '');
}
function scanPython(src) {
    const masked = maskPython(src);
    const starts = lineIndex(masked);
    const imports = [];
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(masked))) {
        const indent = m[1] ?? '';
        const line = lineOf(starts, m.index);
        const deferred = indent.length > 0;
        if (m[2] === 'from') {
            const moduleRaw = m[3] ?? '';
            const openParen = m[4] === '(';
            let namesRaw = m[5] ?? '';
            if (openParen) {
                // Continue until the matching close paren, which may be lines later.
                const bodyStart = masked.indexOf('(', m.index) + 1;
                const close = masked.indexOf(')', bodyStart);
                if (close !== -1) {
                    namesRaw = masked.slice(bodyStart, close);
                    IMPORT_RE.lastIndex = close;
                }
            }
            else if (namesRaw.trimEnd().endsWith('\\')) {
                // Backslash continuation.
                let cursor = masked.indexOf('\n', m.index);
                let acc = namesRaw.trimEnd().slice(0, -1);
                while (cursor !== -1) {
                    const nextEnd = masked.indexOf('\n', cursor + 1);
                    const segment = masked.slice(cursor + 1, nextEnd === -1 ? masked.length : nextEnd);
                    const trimmed = segment.trimEnd();
                    if (trimmed.endsWith('\\')) {
                        acc += trimmed.slice(0, -1);
                        cursor = nextEnd;
                        continue;
                    }
                    acc += trimmed;
                    IMPORT_RE.lastIndex = nextEnd === -1 ? masked.length : nextEnd;
                    break;
                }
                namesRaw = acc;
            }
            const level = /^\.+/.exec(moduleRaw)?.[0].length ?? 0;
            imports.push({
                module: moduleRaw,
                names: splitNames(namesRaw),
                level,
                line,
                form: 'from',
                deferred,
            });
            continue;
        }
        // `import a.b, c as d`
        const body = m[7] ?? '';
        for (const part of body.split(',')) {
            const name = /^\s*([.\w]+)/.exec(part)?.[1];
            if (!name)
                continue;
            imports.push({
                module: name,
                names: [],
                level: /^\.+/.exec(name)?.[0].length ?? 0,
                line,
                form: 'import',
                deferred,
            });
        }
    }
    // Module-level public symbols: zero-indentation defs, classes, constants.
    const exports = [];
    const DEF_RE = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm;
    const CLASS_RE = /^class[ \t]+([A-Za-z_]\w*)/gm;
    const CONST_RE = /^([A-Z][A-Z0-9_]{1,})(?:\s*:\s*[^=\n]+)?\s*=/gm;
    for (const re of [DEF_RE, CLASS_RE, CONST_RE]) {
        re.lastIndex = 0;
        let dm;
        while ((dm = re.exec(masked))) {
            const name = dm[1];
            if (name.startsWith('_'))
                continue;
            exports.push(name);
        }
    }
    // `__all__ = [...]` — when present it is the real public surface, so we read
    // it from the *unmasked* source (the names live inside string literals).
    let dunderAll = null;
    const allMatch = /^__all__\s*[:=][^=]*?=?\s*[[(]([\s\S]*?)[\])]/m.exec(src);
    if (allMatch) {
        const names = [...allMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
        if (names.length)
            dunderAll = names;
    }
    const decorators = [];
    const DECO_RE = /^[ \t]*@([\w.]+)/gm;
    DECO_RE.lastIndex = 0;
    let dec;
    while ((dec = DECO_RE.exec(masked))) {
        decorators.push({ name: dec[1], line: lineOf(starts, dec.index) });
    }
    return {
        imports,
        exports: [...new Set(dunderAll ?? exports)],
        dunderAll,
        loc: src.length === 0 ? 0 : src.split('\n').length,
        decorators,
    };
}
/** Exposed for tests of the masking behaviour. */
exports._internal = { lineNumberAt };
//# sourceMappingURL=scan-python.js.map