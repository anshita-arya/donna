/**
 * Module-level source scanning: import specifiers, export surface, LOC.
 *
 * This deliberately does not use the TypeScript compiler API. A design
 * analyzer that runs on every agent edit has to be cheap and synchronous —
 * a full program build per burst of writes would make the editor feel slow,
 * and module-level import/export edges are all the graph actually needs.
 * The lexer below strips comments and string bodies properly, which is where
 * naive regex import scanners go wrong.
 *
 * If you later need symbol-level truth (who uses which export), swap this for
 * `ts.createSourceFile` behind the same `scanSource` signature.
 */

export interface ScannedImport {
  specifier: string;
  /** 1-based line of the specifier. */
  line: number;
  /** `import`/`export ... from`, `require(...)`, or `import(...)`. */
  kind: 'static' | 'dynamic' | 'require';
}

export interface ScanResult {
  imports: ScannedImport[];
  exportCount: number;
  loc: number;
}

interface StringToken {
  value: string;
  line: number;
}

const PLACEHOLDER_START = '\u0000';
const PLACEHOLDER_END = '\u0001';

/**
 * Replaces comments with spaces and string literals with `\0<index>\1`
 * placeholders, preserving nothing about the original offsets except line
 * counts (which we track separately per token). Template literals with
 * interpolation are kept as code inside `${...}` so imports there are not lost.
 */
function normalize(src: string): { code: string; strings: StringToken[] } {
  const strings: StringToken[] = [];
  let code = '';
  let i = 0;
  let line = 1;
  const n = src.length;

  // Tracks `${` nesting inside template literals.
  const templateStack: number[] = [];

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '\n') {
      line++;
      code += '\n';
      i++;
      continue;
    }

    // Line comment
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++;
          code += '\n';
        }
        i++;
      }
      i += 2;
      continue;
    }

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      let value = '';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          value += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (src[i] === '\n') line++; // unterminated, but stay in sync
        value += src[i];
        i++;
      }
      i++; // closing quote
      strings.push({ value, line: startLine });
      code += `${PLACEHOLDER_START}${strings.length - 1}${PLACEHOLDER_END}`;
      continue;
    }

    // Template literal
    if (ch === '`') {
      const startLine = line;
      let value = '';
      let interpolated = false;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          value += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (src[i] === '`') {
          i++;
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          interpolated = true;
          // Emit the interpolation body as code so nested imports survive.
          code += ' ';
          i += 2;
          templateStack.push(1);
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
              depth--;
              if (depth === 0) {
                i++;
                break;
              }
            } else if (src[i] === '\n') {
              line++;
            }
            code += src[i];
            i++;
          }
          templateStack.pop();
          continue;
        }
        if (src[i] === '\n') line++;
        value += src[i];
        i++;
      }
      if (!interpolated) {
        strings.push({ value, line: startLine });
        code += `${PLACEHOLDER_START}${strings.length - 1}${PLACEHOLDER_END}`;
      }
      continue;
    }

    code += ch;
    i++;
  }

  return { code, strings };
}

const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`, 'g');

/** How the text immediately before a string placeholder identifies an import. */
const STATIC_FROM = /(?:^|[^.\w$])from\s*$/;
const BARE_IMPORT = /(?:^|[^.\w$])import\s*$/;
const DYNAMIC_IMPORT = /(?:^|[^.\w$])import\s*\(\s*$/;
const REQUIRE_CALL = /(?:^|[^.\w$])require\s*\(\s*$/;

function classify(before: string): ScannedImport['kind'] | null {
  if (DYNAMIC_IMPORT.test(before)) return 'dynamic';
  if (REQUIRE_CALL.test(before)) return 'require';
  if (STATIC_FROM.test(before)) return 'static';
  if (BARE_IMPORT.test(before)) return 'static';
  return null;
}

function countExports(code: string): number {
  let count = 0;

  // `export { a, b as c }` — count the names, ignoring re-export source.
  const braceRe = /\bexport\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = braceRe.exec(code))) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    count += names.length;
  }

  // `export default ...`
  count += (code.match(/\bexport\s+default\b/g) ?? []).length;

  // `export * from ...` / `export * as ns from ...`
  count += (code.match(/\bexport\s+\*/g) ?? []).length;

  // Declaration exports.
  const declRe =
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\s*\*?|class|interface|type|enum|namespace)\b/g;
  count += (code.match(declRe) ?? []).length;

  return count;
}

export function scanSource(src: string): ScanResult {
  const { code, strings } = normalize(src);
  const imports: ScannedImport[] = [];

  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(code))) {
    const idx = Number(m[1]);
    const token = strings[idx];
    if (!token) continue;

    // Look back a bounded window; import syntax never needs more.
    const windowStart = Math.max(0, m.index - 64);
    const before = code.slice(windowStart, m.index);
    const kind = classify(before);
    if (!kind) continue;
    if (!token.value || token.value.includes(PLACEHOLDER_START)) continue;

    imports.push({ specifier: token.value, line: token.line, kind });
  }

  const loc = src.length === 0 ? 0 : src.split('\n').length;

  return { imports, exportCount: countExports(code), loc };
}
