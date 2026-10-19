/**
 * Unified-diff parsing.
 *
 * The change under assessment is a diff, not a working tree, because the
 * question is "what did this change do" rather than "what does this repo look
 * like". Line-level added/removed text is kept per hunk so the contract and
 * decorator constraints can ask *which lines* moved, not just which files.
 */

import type { ChangeSet, ChangedFile, Hunk } from './types';

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const lines = diff.split('\n');

  let current: ChangedFile | null = null;
  let hunk: Hunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;
  let pendingOldPath: string | null = null;

  const closeHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (current) files.push(current);
    current = null;
    pendingOldPath = null;
  };

  for (const raw of lines) {
    const headerMatch = FILE_HEADER.exec(raw);
    if (headerMatch) {
      closeFile();
      current = {
        path: headerMatch[2],
        kind: 'modified',
        hunks: [],
        added: 0,
        removed: 0,
      };
      pendingOldPath = headerMatch[1];
      continue;
    }

    if (!current) continue;

    if (raw.startsWith('new file mode')) {
      current.kind = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      current.kind = 'deleted';
      continue;
    }
    if (raw.startsWith('rename from ')) {
      current.kind = 'renamed';
      current.oldPath = raw.slice('rename from '.length);
      continue;
    }
    if (raw.startsWith('rename to ')) {
      current.path = raw.slice('rename to '.length);
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(raw);
    if (hunkMatch) {
      closeHunk();
      oldCursor = Number(hunkMatch[1]);
      newCursor = Number(hunkMatch[3]);
      hunk = {
        oldStart: oldCursor,
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: newCursor,
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        addedLines: [],
        removedLines: [],
      };
      continue;
    }

    if (!hunk) continue;

    if (raw.startsWith('+')) {
      hunk.addedLines.push({ line: newCursor, text: raw.slice(1) });
      current.added++;
      newCursor++;
      continue;
    }
    if (raw.startsWith('-')) {
      hunk.removedLines.push({ line: oldCursor, text: raw.slice(1) });
      current.removed++;
      oldCursor++;
      continue;
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      continue;
    }
    // Context line.
    oldCursor++;
    newCursor++;
  }

  closeFile();

  // `rename from` arrives before we rewrite `path`, so backfill when git chose
  // a similarity rename but we only saw the a/ b/ header.
  for (const file of files) {
    if (file.kind === 'renamed' && !file.oldPath && pendingOldPath) {
      file.oldPath = pendingOldPath;
    }
  }

  return files;
}

export function buildChangeSet(
  diff: string,
  meta: { baseRef: string; headRef: string; branch: string },
): ChangeSet {
  const files = parseUnifiedDiff(diff);
  return {
    ...meta,
    files,
    paths: new Set(files.map((f) => f.path)),
  };
}

/** Every added-or-removed line's text for one file, for keyword scanning. */
export function changedText(file: ChangedFile): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.addedLines) added.push(line.text);
    for (const line of hunk.removedLines) removed.push(line.text);
  }
  return { added, removed };
}

/** True when any changed line in `file` matches `re`. */
export function diffTouches(file: ChangedFile, re: RegExp): boolean {
  const { added, removed } = changedText(file);
  return added.some((l) => re.test(l)) || removed.some((l) => re.test(l));
}

/** The first changed line matching `re`, for anchoring a finding. */
export function firstTouchedLine(file: ChangedFile, re: RegExp): number | null {
  for (const hunk of file.hunks) {
    for (const line of hunk.addedLines) {
      if (re.test(line.text)) return line.line;
    }
  }
  for (const hunk of file.hunks) {
    for (const line of hunk.removedLines) {
      if (re.test(line.text)) return Math.max(1, hunk.newStart);
    }
  }
  return null;
}
