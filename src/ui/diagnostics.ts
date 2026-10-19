import * as vscode from 'vscode';
import * as path from 'node:path';

import {
  DIMENSION_LABELS,
  type ObservationStatus,
  type Scorecard,
} from '../core/types';

const SEVERITY: Record<ObservationStatus, vscode.DiagnosticSeverity> = {
  conflict: vscode.DiagnosticSeverity.Error,
  unknown: vscode.DiagnosticSeverity.Warning,
  attention: vscode.DiagnosticSeverity.Information,
  pass: vscode.DiagnosticSeverity.Hint,
};

const FLOOR_RANK: Record<string, number> = { conflict: 0, unknown: 1, attention: 2 };

/**
 * Publishes findings into the Problems pane.
 *
 * Two deliberate choices:
 *
 *  - An `unknown` is a Warning, not a Hint. A check that did not run is not a
 *    minor note; it is the thing most likely to bite later, and burying it
 *    under "Hint" would reproduce the exact failure Donna exists to stop.
 *  - Related locations are attached, so a boundary violation shows both the
 *    importing file and what it reached for. A finding you can only see from
 *    one end is half a finding.
 */
export class DiagnosticsPublisher implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;

  constructor(private readonly repoRoot: string) {
    this.collection = vscode.languages.createDiagnosticCollection('donna');
  }

  publish(card: Scorecard): void {
    this.collection.clear();

    const config = vscode.workspace.getConfiguration('donna');
    if (!config.get<boolean>('diagnostics.enabled', true)) return;

    const floor = FLOOR_RANK[config.get<string>('diagnostics.floor', 'unknown')] ?? 1;
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const dimension of card.dimensions) {
      for (const observation of dimension.observations) {
        if (observation.status === 'pass') continue;
        if ((FLOOR_RANK[observation.status] ?? 3) > floor) continue;
        if (!observation.location) continue;

        const line = Math.max(0, observation.location.line - 1);
        const range = new vscode.Range(line, 0, line, 500);

        const diagnostic = new vscode.Diagnostic(
          range,
          `${observation.title}\n\n${observation.detail}${
            observation.requiredActions.length
              ? `\n\nTo resolve:\n${observation.requiredActions.map((a) => `• ${a}`).join('\n')}`
              : ''
          }`,
          SEVERITY[observation.status],
        );

        diagnostic.source = `Donna · ${DIMENSION_LABELS[observation.dimension]}`;
        diagnostic.code = observation.checkId;

        const related: vscode.DiagnosticRelatedInformation[] = [];
        for (const evidence of observation.evidence.slice(0, 4)) {
          // Only file-shaped evidence can be a location; ADR ids and policy
          // names are carried in the message instead.
          if (evidence.kind !== 'diff' && evidence.kind !== 'graph' && evidence.kind !== 'tests') {
            continue;
          }
          const uri = this.toUri(evidence.ref);
          if (!uri) continue;
          const evidenceLine = Math.max(0, (evidence.line ?? 1) - 1);
          related.push(
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(uri, new vscode.Range(evidenceLine, 0, evidenceLine, 500)),
              evidence.note ?? evidence.excerpt ?? evidence.kind,
            ),
          );
        }
        if (related.length) diagnostic.relatedInformation = related;

        const file = observation.location.file;
        const list = byFile.get(file) ?? [];
        list.push(diagnostic);
        byFile.set(file, list);
      }
    }

    for (const [file, diagnostics] of byFile) {
      const uri = this.toUri(file);
      if (uri) this.collection.set(uri, diagnostics);
    }
  }

  private toUri(relativeOrRef: string): vscode.Uri | undefined {
    // Evidence refs are not always paths — an ADR id or a glob can appear here.
    if (!/[./]/.test(relativeOrRef) || relativeOrRef.includes('*')) return undefined;
    try {
      return vscode.Uri.file(path.resolve(this.repoRoot, relativeOrRef));
    } catch {
      return undefined;
    }
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
