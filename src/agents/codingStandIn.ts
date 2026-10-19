import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A scripted stand-in for the coding agent, used only to demonstrate the
 * three-agent flow end to end.
 *
 * This is **not** part of Donna's own behaviour and is not bound by the
 * guardrails that constrain the review agents — it is playing the role of
 * Claude Code or Cursor, which legitimately do write code. It exists because a
 * demo of "the impact agent runs in parallel to a coding agent" needs a coding
 * agent, and a scripted one makes the demo deterministic and repeatable.
 *
 * It is deliberately kept in its own module, behind its own command, so there
 * is no path by which the review agents can reach a file-writing routine.
 */

export interface ScenarioEdit {
  file: string;
  find: string;
  replace: string;
}

export interface Scenario {
  id: string;
  title: string;
  agentPrompt: string;
  whyItLooksFine: string;
  whatIsActuallyWrong: string;
  edits: ScenarioEdit[];
  expect?: {
    verdict: string;
    mustFlag: string[];
    mustNotFlag: string[];
    notes?: string;
  };
}

export interface AppliedScenario {
  scenario: Scenario;
  /** Original contents, so the demo can be reverted without touching git. */
  originals: Map<string, string>;
  touched: string[];
}

export function loadScenarios(dir: string): { scenarios: Scenario[]; issues: string[] } {
  const scenarios: Scenario[] = [];
  const issues: string[] = [];

  if (!fs.existsSync(dir)) {
    return { scenarios, issues: [`Scenario directory \`${dir}\` does not exist.`] };
  }

  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Scenario;
      if (!parsed.id || !Array.isArray(parsed.edits)) {
        issues.push(`${name}: missing \`id\` or \`edits\`.`);
        continue;
      }
      scenarios.push(parsed);
    } catch (error) {
      issues.push(`${name}: ${(error as Error).message}`);
    }
  }

  return { scenarios, issues };
}

/**
 * Applies a scenario to the working tree.
 *
 * Every edit is verified to match exactly once before anything is written, and
 * the whole set is applied or none of it is. A half-applied scenario would
 * produce an assessment of a state the demo never intended to show.
 */
export function applyScenario(repoRoot: string, scenario: Scenario): AppliedScenario {
  const originals = new Map<string, string>();
  const planned: { abs: string; next: string; rel: string }[] = [];

  for (const [index, edit] of scenario.edits.entries()) {
    const abs = path.resolve(repoRoot, edit.file);
    if (!abs.startsWith(path.resolve(repoRoot))) {
      throw new Error(`Edit #${index + 1} points outside the workspace: ${edit.file}`);
    }
    if (!fs.existsSync(abs)) {
      throw new Error(`Edit #${index + 1}: \`${edit.file}\` does not exist in this workspace.`);
    }

    const current = originals.get(edit.file) ?? fs.readFileSync(abs, 'utf8');
    if (!originals.has(edit.file)) originals.set(edit.file, current);

    const latest = planned.find((p) => p.rel === edit.file)?.next ?? current;
    const occurrences = latest.split(edit.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Edit #${index + 1} on \`${edit.file}\`: the text to replace occurs ${occurrences} times, expected exactly once. The scenario does not match this workspace.`,
      );
    }

    const next = latest.replace(edit.find, edit.replace);
    const existing = planned.find((p) => p.rel === edit.file);
    if (existing) existing.next = next;
    else planned.push({ abs, next, rel: edit.file });
  }

  for (const entry of planned) {
    fs.writeFileSync(entry.abs, entry.next, 'utf8');
  }

  return { scenario, originals, touched: planned.map((p) => p.rel) };
}

/** Restores the files a scenario changed, without involving git. */
export function revertScenario(repoRoot: string, applied: AppliedScenario): string[] {
  const restored: string[] = [];
  for (const [rel, text] of applied.originals) {
    const abs = path.resolve(repoRoot, rel);
    try {
      fs.writeFileSync(abs, text, 'utf8');
      restored.push(rel);
    } catch {
      // Report what did restore rather than failing the whole revert.
    }
  }
  return restored;
}
