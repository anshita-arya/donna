/**
 * ADR indexing.
 *
 * ADRs remain ordinary Markdown authored by the team. Donna reads their
 * metadata and passes the full prose to the model for explicitly inferred
 * review.
 */

import type { AdrDocument } from '../core/types';

const TITLE_RE = /^#\s+(.+)$/m;
const STATUS_LINE_RE = /^[-*]\s*\*\*Status:?\*\*:?\s*(.+)$/im;
const OWNERS_LINE_RE = /^[-*]\s*\*\*Owners?:?\*\*:?\s*(.+)$/im;
const ADR_ID_RE = /\b(ADR[-_]?\d{1,4})\b/i;

export interface AdrParseIssue {
  path: string;
  message: string;
}

export interface AdrIndex {
  documents: AdrDocument[];
  issues: AdrParseIssue[];
}

function normalizeId(raw: string): string {
  const m = ADR_ID_RE.exec(raw);
  if (!m) return raw.trim();
  return m[1].toUpperCase().replace('_', '-').replace(/^ADR(\d)/, 'ADR-$1');
}

function parseHandles(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('@'))
    .map((s) => s.replace(/[.,;]$/, ''));
}

export function parseAdr(path: string, text: string): { doc: AdrDocument | null; issues: AdrParseIssue[] } {
  const issues: AdrParseIssue[] = [];
  const titleMatch = TITLE_RE.exec(text);
  const heading = titleMatch?.[1]?.trim() ?? '';
  const idFromHeading = heading ? ADR_ID_RE.exec(heading)?.[1] : null;
  const idFromPath = ADR_ID_RE.exec(path)?.[1];
  const rawId = idFromHeading ?? idFromPath;

  if (!rawId) {
    issues.push({
      path,
      message: 'No ADR id found in the heading or filename.',
    });
    return { doc: null, issues };
  }

  const id = normalizeId(rawId);
  const title = heading.replace(new RegExp(`^${id}\\s*[:–—-]\\s*`, 'i'), '').trim() || id;

  const statusFromProse = STATUS_LINE_RE.exec(text)?.[1]?.trim();
  const status = (statusFromProse ?? 'unknown').toLowerCase().replace(/\.$/, '');

  const ownersFromProse = OWNERS_LINE_RE.exec(text)?.[1] ?? '';
  const owners = [...new Set(parseHandles(ownersFromProse))];

  const doc: AdrDocument = {
    id,
    title,
    status,
    path,
    owners,
    body: text.replace(/\r\n/g, '\n'),
  };

  return { doc, issues };
}

export function indexAdrs(files: { path: string; text: string }[]): AdrIndex {
  const documents: AdrDocument[] = [];
  const issues: AdrParseIssue[] = [];

  for (const file of files) {
    const { doc, issues: fileIssues } = parseAdr(file.path, file.text);
    issues.push(...fileIssues);
    if (doc) documents.push(doc);
  }

  documents.sort((a, b) => a.id.localeCompare(b.id));
  return { documents, issues };
}

/** An ADR is in force when accepted — superseded and deprecated ones are not. */
export function isActive(doc: AdrDocument): boolean {
  return doc.status === 'accepted' || doc.status === 'approved' || doc.status === 'adopted';
}

/** Return active ADRs for prose-based applicability review. */
export function relevantAdrs(docs: AdrDocument[], _changedPaths: Iterable<string>): AdrDocument[] {
  return docs.filter(isActive);
}
