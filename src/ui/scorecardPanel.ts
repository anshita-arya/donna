import * as vscode from 'vscode';

import {
  DIMENSION_LABELS,
  ESCALATION_LABELS,
  VERDICT_LABELS,
  type DimensionScore,
  type Observation,
  type ObservationStatus,
  type Scorecard,
} from '../core/types';
import type { ChangeRequest, GuardrailViolation, SuggestedEdit } from '../agents/guardrails';

const STATUS_WORD: Record<ObservationStatus, string> = {
  conflict: 'conflict',
  unknown: 'not checked',
  attention: 'to note',
  pass: 'clear',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the limited inline markdown the findings actually use — backticks and
 * bold. A full markdown library is not worth bundling for this, and letting raw
 * model text through unescaped is not acceptable, so the escape happens first
 * and only these two forms are re-enabled afterwards.
 */
function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export interface PanelState {
  card?: Scorecard;
  /** Present once the design-review agent has run. */
  changeRequest?: {
    request: ChangeRequest;
    applicable: SuggestedEdit[];
    violations: GuardrailViolation[];
    unapplicable: { edit: SuggestedEdit; reason: string }[];
    provider?: string;
    model?: string;
  };
  busy?: string;
  error?: string;
}

/**
 * The scorecard webview.
 *
 * The ordering of this page is the argument it is making. The verdict comes
 * first, then what the developer has to do, then what the tool could not check,
 * and only then the evidence. Blind spots sit above the findings rather than in
 * a footer, because a reader who stops halfway should have seen the limits of
 * the analysis before they saw its conclusions.
 */
export class ScorecardPanel {
  private static current: ScorecardPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private state: PanelState = {};

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly repoRoot: string,
  ) {
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: { command?: string; file?: string; line?: number; id?: string }) => {
        switch (message.command) {
          case 'openFile':
            if (message.file) {
              void vscode.commands.executeCommand(
                'donna.openFinding',
                message.file,
                message.line ?? 1,
              );
            }
            break;
          case 'assess':
            void vscode.commands.executeCommand('donna.assess');
            break;
          case 'assessWithModel':
            void vscode.commands.executeCommand('donna.assessWithModel');
            break;
          case 'designReview':
            void vscode.commands.executeCommand('donna.requestDesignReview');
            break;
          case 'copyMarkdown':
            void vscode.commands.executeCommand('donna.copyAssessment');
            break;
          case 'applyEdit':
            void vscode.commands.executeCommand('donna.applyProposedEdit', message.id);
            break;
          case 'showLog':
            void vscode.commands.executeCommand('donna.showLog');
            break;
        }
      },
      undefined,
      this.disposables,
    );
  }

  static show(repoRoot: string): ScorecardPanel {
    if (ScorecardPanel.current) {
      ScorecardPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return ScorecardPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'donna.scorecard',
      'Donna — Impact Assessment',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    ScorecardPanel.current = new ScorecardPanel(panel, repoRoot);
    return ScorecardPanel.current;
  }

  static get existing(): ScorecardPanel | undefined {
    return ScorecardPanel.current;
  }

  update(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    this.panel.webview.html = this.render();
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  private render(): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Donna — Impact Assessment</title>
<style>${STYLES}</style>
</head>
<body>
${this.body()}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }

  private body(): string {
    const { card, busy, error } = this.state;

    const toolbar = `
<div class="toolbar">
  <button data-cmd="assess">Re-assess</button>
  <button data-cmd="assessWithModel">Assess with model pass</button>
  <button data-cmd="designReview" ${card && card.escalations.length === 0 ? 'disabled title="No conflicts to revise."' : ''}>Send to design-review agent</button>
  <button data-cmd="copyMarkdown" class="ghost">Copy as markdown</button>
</div>`;

    if (error) {
      return `${toolbar}
<div class="banner error">
  <strong>Assessment failed.</strong>
  <p>${escapeHtml(error)}</p>
  <button data-cmd="showLog" class="ghost">Show log</button>
</div>`;
    }

    if (busy) {
      return `${toolbar}
<div class="banner busy"><span class="spinner"></span> ${escapeHtml(busy)}</div>
${card ? this.cardBody(card) : ''}`;
    }

    if (!card) {
      return `${toolbar}
<div class="banner">
  <strong>No assessment yet.</strong>
  <p>Donna watches for the changes your coding agent makes and assesses their system-wide
  impact before you open a pull request. Run an assessment to begin.</p>
</div>`;
    }

    return `${toolbar}${this.cardBody(card)}`;
  }

  private cardBody(card: Scorecard): string {
    const parts: string[] = [];

    if (card.contextPack?.synthetic) {
      parts.push(`
<div class="banner synthetic">
  <strong>Synthetic context pack:</strong> ${escapeHtml(card.contextPack.name)}.
  ${card.contextPack.disclaimer ? `<p>${escapeHtml(card.contextPack.disclaimer)}</p>` : ''}
</div>`);
    }

    parts.push(this.verdictBlock(card));
    parts.push(this.dimensionGrid(card));
    if (card.escalations.length) parts.push(this.escalationsBlock(card));
    parts.push(this.checklistBlock(card));
    if (card.blindSpots.length) parts.push(this.blindSpotsBlock(card));
    parts.push(this.findingsBlock(card));
    if (card.affectedServices.length) parts.push(this.servicesBlock(card));
    if (card.requiredTests.length) parts.push(this.testsBlock(card));
    if (card.reviewers.length) parts.push(this.reviewersBlock(card));
    if (this.state.changeRequest) parts.push(this.changeRequestBlock());
    parts.push(this.provenanceBlock(card));

    return parts.join('\n');
  }

  private verdictBlock(card: Scorecard): string {
    const tone =
      card.verdict.value === 'ready-to-propose'
        ? 'ok'
        : card.verdict.value === 'needs-revision'
          ? 'warn'
          : 'bad';

    return `
<section class="verdict ${tone}">
  <div class="verdict-head">
    <h1>${escapeHtml(VERDICT_LABELS[card.verdict.value])}</h1>
    <span class="meta">${escapeHtml(card.branch)} vs ${escapeHtml(card.baseRef.slice(0, 12))}
      &middot; ${card.change.files} file${card.change.files === 1 ? '' : 's'}
      &middot; <span class="add">+${card.change.added}</span> <span class="del">-${card.change.removed}</span></span>
  </div>
  <p>${inlineMarkdown(card.verdict.rationale)}</p>
  <p class="note">Donna assesses whether this is ready to <em>propose</em>. A human owner still approves.</p>
</section>`;
  }

  private dimensionGrid(card: Scorecard): string {
    const tiles = card.dimensions
      .map((score) => {
        const counts = score.observations.reduce(
          (acc, o) => {
            acc[o.status]++;
            return acc;
          },
          { conflict: 0, unknown: 0, attention: 0, pass: 0 } as Record<ObservationStatus, number>,
        );
        const bits: string[] = [];
        if (counts.conflict) bits.push(`${counts.conflict} conflict`);
        if (counts.unknown) bits.push(`${counts.unknown} not checked`);
        if (counts.attention) bits.push(`${counts.attention} to note`);
        if (!bits.length) bits.push('clear');

        return `
<a class="tile ${score.status}" href="#dim-${score.dimension}">
  <span class="tile-status">${STATUS_WORD[score.status]}</span>
  <span class="tile-name">${escapeHtml(DIMENSION_LABELS[score.dimension])}</span>
  <span class="tile-counts">${escapeHtml(bits.join(' · '))}</span>
</a>`;
      })
      .join('');

    return `<section class="grid">${tiles}</section>`;
  }

  private escalationsBlock(card: Scorecard): string {
    const rows = card.escalations
      .map(
        (escalation) => `
<li>
  <strong>${escapeHtml(ESCALATION_LABELS[escalation.reason])}</strong>
  <span class="detail">${escapeHtml(escalation.detail)}</span>
  ${escalation.owners.length ? `<span class="owners">route to ${escapeHtml(escalation.owners.join(', '))}</span>` : '<span class="owners none">no owner recorded</span>'}
</li>`,
      )
      .join('');

    return `
<section>
  <h2>Escalations</h2>
  <p class="note">These are handed back rather than resolved. The agent does not decide design questions.</p>
  <ul class="escalations">${rows}</ul>
</section>`;
  }

  private checklistBlock(card: Scorecard): string {
    const blocking = card.checklist.filter((c) => c.blocking);
    const optional = card.checklist.filter((c) => !c.blocking);

    const render = (items: typeof card.checklist, cls: string) =>
      items
        .map(
          (item) => `
<li class="${cls}">
  <label>
    <input type="checkbox" data-check="${escapeHtml(item.id)}">
    <span>${inlineMarkdown(item.text)}</span>
  </label>
  <span class="tag">${escapeHtml(DIMENSION_LABELS[item.dimension])}${item.owners.length ? ` · ${escapeHtml(item.owners.join(', '))}` : ''}</span>
</li>`,
        )
        .join('');

    if (!blocking.length && !optional.length) {
      return `
<section>
  <h2>Before you open a PR</h2>
  <p class="note">Nothing outstanding.</p>
</section>`;
    }

    return `
<section>
  <h2>Before you open a PR</h2>
  ${blocking.length ? `<ul class="checklist">${render(blocking, 'blocking')}</ul>` : '<p class="note">Nothing blocking.</p>'}
  ${optional.length ? `<h3>Worth saying in the PR description</h3><ul class="checklist">${render(optional, 'optional')}</ul>` : ''}
</section>`;
  }

  private blindSpotsBlock(card: Scorecard): string {
    return `
<section class="blindspots">
  <h2>What this did not check</h2>
  <p class="note">Gaps in the assessment itself, not findings. A clean dimension above means "nothing found by the checks that ran" — this is the list of checks that did not.</p>
  <ul>${card.blindSpots.map((s) => `<li>${inlineMarkdown(s)}</li>`).join('')}</ul>
</section>`;
  }

  private findingsBlock(card: Scorecard): string {
    const sections = card.dimensions
      .map((score) => this.dimensionSection(score))
      .filter(Boolean)
      .join('');

    return `<section><h2>Findings</h2>${sections || '<p class="note">No findings.</p>'}</section>`;
  }

  private dimensionSection(score: DimensionScore): string {
    if (score.observations.length === 0) return '';
    const notable = score.observations.filter((o) => o.status !== 'pass');
    const passes = score.observations.filter((o) => o.status === 'pass');

    const body = [
      ...notable.map((o) => this.observationCard(o)),
      passes.length
        ? `<details class="passes"><summary>${passes.length} check${passes.length === 1 ? '' : 's'} passed</summary>${passes.map((o) => this.observationCard(o)).join('')}</details>`
        : '',
    ].join('');

    return `
<div class="dimension" id="dim-${score.dimension}">
  <h3>${escapeHtml(DIMENSION_LABELS[score.dimension])} <span class="pill ${score.status}">${STATUS_WORD[score.status]}</span></h3>
  <p class="note">${escapeHtml(score.summary)}</p>
  ${body}
</div>`;
  }

  private observationCard(observation: Observation): string {
    const location = observation.location
      ? `<button class="link" data-file="${escapeHtml(observation.location.file)}" data-line="${observation.location.line}">${escapeHtml(observation.location.file)}:${observation.location.line}</button>`
      : '';

    const evidence = observation.evidence
      .map((e) => {
        const locatable =
          (e.kind === 'diff' || e.kind === 'graph' || e.kind === 'tests') &&
          /[./]/.test(e.ref) &&
          !e.ref.includes('*');
        const ref = locatable
          ? `<button class="link" data-file="${escapeHtml(e.ref)}" data-line="${e.line ?? 1}">${escapeHtml(e.ref)}${e.line ? `:${e.line}` : ''}</button>`
          : `<span class="ref">${escapeHtml(e.ref)}</span>`;
        return `<li><span class="kind">${escapeHtml(e.kind)}</span> ${ref}${e.excerpt ? ` <code>${escapeHtml(e.excerpt.slice(0, 120))}</code>` : ''}${e.note ? ` <span class="detail">${escapeHtml(e.note)}</span>` : ''}</li>`;
      })
      .join('');

    const actions = observation.requiredActions
      .map((a) => `<li>${inlineMarkdown(a)}</li>`)
      .join('');

    return `
<article class="observation ${observation.status}">
  <header>
    <span class="pill ${observation.status}">${STATUS_WORD[observation.status]}</span>
    <h4>${escapeHtml(observation.title)}</h4>
    ${observation.source === 'model' ? '<span class="badge model">model</span>' : ''}
    <span class="badge">${escapeHtml(observation.confidence)} confidence</span>
  </header>
  <p>${inlineMarkdown(observation.detail)}</p>
  ${location ? `<p class="where">${location}</p>` : ''}
  ${actions ? `<div class="sub"><h5>What to do</h5><ul class="actions">${actions}</ul></div>` : ''}
  ${evidence ? `<details class="sub"><summary>Evidence (${observation.evidence.length})</summary><ul class="evidence">${evidence}</ul></details>` : ''}
  <footer>
    <code>${escapeHtml(observation.checkId)}</code>
    ${observation.escalate ? `<span class="badge esc">${escapeHtml(ESCALATION_LABELS[observation.escalate])}</span>` : ''}
    ${observation.owners.length ? `<span class="badge">${escapeHtml(observation.owners.join(', '))}</span>` : ''}
  </footer>
</article>`;
  }

  private servicesBlock(card: Scorecard): string {
    const rows = card.affectedServices
      .map(
        (service) => `
<tr>
  <td><strong>${escapeHtml(service.service)}</strong></td>
  <td><span class="pill ${service.reach === 'direct' ? 'attention' : 'pass'}">${escapeHtml(service.reach)}</span></td>
  <td>${service.modules.length}</td>
  <td>${escapeHtml(service.owners.join(', ') || '—')}</td>
  <td class="detail">${escapeHtml(service.via ?? '')}</td>
</tr>`,
      )
      .join('');

    return `
<section>
  <h2>Affected services</h2>
  <table>
    <thead><tr><th>Service</th><th>Reach</th><th>Modules</th><th>Owners</th><th>Why</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
  }

  private testsBlock(card: Scorecard): string {
    const rows = card.requiredTests
      .map(
        (test) => `
<li class="${test.exists ? 'exists' : 'missing'}">
  ${
    test.exists
      ? `<button class="link" data-file="${escapeHtml(test.target)}" data-line="1">${escapeHtml(test.target)}</button>`
      : `<span class="ref missing">missing: ${escapeHtml(test.target)}</span>`
  }
  <span class="detail">${escapeHtml(test.reason)}</span>
</li>`,
      )
      .join('');

    return `
<section>
  <h2>Tests</h2>
  <p class="note">Relevance is import reachability, not line coverage. A listed test imports a changed module; it may not execute the changed lines.</p>
  <ul class="tests">${rows}</ul>
</section>`;
  }

  private reviewersBlock(card: Scorecard): string {
    const rows = card.reviewers
      .map(
        (reviewer) => `
<li>
  <span class="pill ${reviewer.weight === 'required' ? 'conflict' : 'attention'}">${escapeHtml(reviewer.weight)}</span>
  <strong>${escapeHtml(reviewer.handle)}</strong>
  <span class="detail">${escapeHtml(reviewer.reason)}</span>
</li>`,
      )
      .join('');

    return `
<section>
  <h2>Reviewers</h2>
  <p class="note">Read from ownership records and CODEOWNERS. Donna does not assign ownership, and does not guess it from who last touched the file.</p>
  <ul class="reviewers">${rows}</ul>
</section>`;
  }

  private changeRequestBlock(): string {
    const cr = this.state.changeRequest;
    if (!cr) return '';

    const edits = cr.applicable
      .map(
        (edit, index) => `
<article class="proposed">
  <header>
    <h4>${escapeHtml(edit.file)}</h4>
    <button data-apply="${index}">Apply this edit</button>
  </header>
  ${edit.note ? `<p>${escapeHtml(edit.note)}</p>` : ''}
  <div class="diff">
    <pre class="removed">${escapeHtml(edit.find)}</pre>
    <pre class="added">${escapeHtml(edit.replace)}</pre>
  </div>
</article>`,
      )
      .join('');

    const violations = cr.violations.length
      ? `
<div class="banner error">
  <strong>${cr.violations.length} proposed edit${cr.violations.length === 1 ? '' : 's'} ${cr.violations.length === 1 ? 'was' : 'were'} rejected by the guardrails.</strong>
  <ul>${cr.violations.map((v) => `<li><code>${escapeHtml(v.path)}</code> — ${escapeHtml(v.detail)}</li>`).join('')}</ul>
</div>`
      : '';

    const unapplicable = cr.unapplicable.length
      ? `
<div class="banner warn">
  <strong>${cr.unapplicable.length} edit${cr.unapplicable.length === 1 ? '' : 's'} could not be applied cleanly.</strong>
  <ul>${cr.unapplicable.map((u) => `<li><code>${escapeHtml(u.edit.file)}</code> — ${escapeHtml(u.reason)}</li>`).join('')}</ul>
</div>`
      : '';

    return `
<section class="change-request">
  <h2>Design-review agent — proposed revision</h2>
  <p class="note">A proposal, not an applied change. Nothing here touches your files until you choose it.</p>
  <p><strong>${escapeHtml(cr.request.summary)}</strong></p>
  <p>${inlineMarkdown(cr.request.rationale)}</p>
  ${violations}
  ${unapplicable}
  ${edits || '<p class="note">No directly applicable edits — see the open questions below.</p>'}
  ${
    cr.request.suggestedTests.length
      ? `<h3>Tests to add</h3><ul>${cr.request.suggestedTests.map((t) => `<li><code>${escapeHtml(t.target)}</code> — ${escapeHtml(t.asserts)}</li>`).join('')}</ul>`
      : ''
  }
  ${
    cr.request.openQuestions.length
      ? `<h3>Handed back to you</h3><ul class="open-questions">${cr.request.openQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
      : ''
  }
  ${cr.request.routeTo.length ? `<p class="note">Route to: ${escapeHtml(cr.request.routeTo.join(', '))}</p>` : ''}
  ${cr.provider ? `<p class="note">Produced by ${escapeHtml(cr.provider)} (${escapeHtml(cr.model ?? 'unknown model')}).</p>` : ''}
</section>`;
  }

  private provenanceBlock(card: Scorecard): string {
    return `
<section class="provenance">
  <h2>How this was produced</h2>
  <ul>
    <li><strong>Deterministic checks:</strong> dependency graph, ADR constraints, contract comparison against the base revision, ownership lookup, test reachability.</li>
    <li><strong>Model pass:</strong> ${
      card.modelPass.ran
        ? `ran via ${escapeHtml(card.modelPass.provider ?? 'unknown')} (${escapeHtml(card.modelPass.model ?? 'unknown model')}). Its findings are badged <span class="badge model">model</span> above.`
        : `did not run${card.modelPass.skippedBecause ? ` — ${escapeHtml(card.modelPass.skippedBecause)}` : ''}.`
    }</li>
  </ul>
  <h3>What this agent does not do</h3>
  <ul class="limits">${card.limits.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
  <p class="note">Enforced in code, not only stated: edits to design records, ownership, this tool's config, test expectations and CI configuration are rejected before you ever see them.</p>
  <p class="stamp">Generated ${escapeHtml(card.generatedAt)} · ${escapeHtml(this.repoRoot)}</p>
</section>`;
  }

  dispose(): void {
    ScorecardPanel.current = undefined;
    this.panel.dispose();
    for (const disposable of this.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        /* teardown race */
      }
    }
  }
}

const STYLES = `
:root {
  --ok: var(--vscode-charts-green, #39a85b);
  --warn: var(--vscode-charts-yellow, #d9a406);
  --bad: var(--vscode-charts-red, #e5534b);
  --info: var(--vscode-charts-blue, #4c8ed9);
  --line: var(--vscode-panel-border, rgba(128,128,128,0.35));
  --soft: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px 20px 48px;
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground); background: var(--vscode-editor-background);
  line-height: 1.55;
}
h1 { font-size: 1.45em; margin: 0; font-weight: 600; }
h2 { font-size: 1.1em; margin: 28px 0 8px; font-weight: 600; letter-spacing: 0.01em; }
h3 { font-size: 1em; margin: 20px 0 6px; font-weight: 600; }
h4 { font-size: 1em; margin: 0; font-weight: 600; }
h5 { font-size: 0.9em; margin: 0 0 4px; font-weight: 600; text-transform: uppercase;
     letter-spacing: 0.04em; opacity: 0.75; }
p { margin: 6px 0; }
code { font-family: var(--vscode-editor-font-family); font-size: 0.92em;
       background: var(--soft); padding: 1px 4px; border-radius: 3px; }
ul { margin: 6px 0; padding-left: 20px; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; }

.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
button {
  font-family: inherit; font-size: 0.95em; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; padding: 5px 12px; border-radius: 3px;
}
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.45; cursor: default; }
button.ghost {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--line);
}
button.link {
  background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground);
  font-family: var(--vscode-editor-font-family); font-size: 0.92em; text-align: left;
}
button.link:hover { text-decoration: underline; background: none; }

.banner { border: 1px solid var(--line); border-left-width: 3px; border-radius: 4px;
          padding: 10px 14px; margin: 12px 0; background: var(--soft); }
.banner.error { border-left-color: var(--bad); }
.banner.warn { border-left-color: var(--warn); }
.banner.synthetic { border-left-color: var(--info); }
.banner.busy { display: flex; align-items: center; gap: 10px; }
.spinner { width: 12px; height: 12px; border: 2px solid var(--line);
           border-top-color: var(--info); border-radius: 50%;
           animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.verdict { border: 1px solid var(--line); border-left-width: 4px; border-radius: 4px;
           padding: 14px 16px; background: var(--soft); }
.verdict.ok { border-left-color: var(--ok); }
.verdict.warn { border-left-color: var(--warn); }
.verdict.bad { border-left-color: var(--bad); }
.verdict-head { display: flex; align-items: baseline; justify-content: space-between;
                gap: 12px; flex-wrap: wrap; }
.meta { font-family: var(--vscode-editor-font-family); font-size: 0.86em; opacity: 0.8; }
.add { color: var(--ok); } .del { color: var(--bad); }
.note { font-size: 0.9em; opacity: 0.75; }

.grid { display: grid; gap: 8px; margin: 16px 0 0;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.tile { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px;
        border: 1px solid var(--line); border-top-width: 3px; border-radius: 4px;
        background: var(--vscode-editor-background); }
.tile:hover { background: var(--soft); }
.tile.conflict { border-top-color: var(--bad); }
.tile.unknown { border-top-color: var(--warn); }
.tile.attention { border-top-color: var(--info); }
.tile.pass { border-top-color: var(--ok); }
.tile-status { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em;
               opacity: 0.7; }
.tile-name { font-weight: 600; }
.tile-counts { font-size: 0.86em; opacity: 0.78; }

.pill { display: inline-block; font-size: 0.74em; text-transform: uppercase;
        letter-spacing: 0.05em; padding: 1px 7px; border-radius: 10px;
        border: 1px solid currentColor; white-space: nowrap; }
.pill.conflict { color: var(--bad); }
.pill.unknown { color: var(--warn); }
.pill.attention { color: var(--info); }
.pill.pass { color: var(--ok); }

.escalations { list-style: none; padding: 0; }
.escalations li { border-left: 3px solid var(--bad); padding: 6px 0 6px 12px; margin: 8px 0; }
.escalations strong { display: block; }
.detail { font-size: 0.88em; opacity: 0.78; }
.owners { display: block; font-size: 0.85em; opacity: 0.8;
          font-family: var(--vscode-editor-font-family); }
.owners.none { font-style: italic; }

.checklist { list-style: none; padding: 0; }
.checklist li { display: flex; align-items: flex-start; justify-content: space-between;
                gap: 12px; padding: 5px 0; border-bottom: 1px solid var(--line); }
.checklist label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.checklist input { margin-top: 4px; }
.checklist li.blocking { border-left: 3px solid var(--bad); padding-left: 10px; }
.checklist li.optional { border-left: 3px solid var(--info); padding-left: 10px; }
.checklist input:checked + span { opacity: 0.5; text-decoration: line-through; }
.tag { font-size: 0.8em; opacity: 0.65; white-space: nowrap; }

.blindspots { border: 1px dashed var(--line); border-radius: 4px; padding: 10px 14px; }

.dimension { margin: 20px 0; }
.observation { border: 1px solid var(--line); border-left-width: 3px; border-radius: 4px;
               padding: 10px 14px; margin: 10px 0; }
.observation.conflict { border-left-color: var(--bad); }
.observation.unknown { border-left-color: var(--warn); }
.observation.attention { border-left-color: var(--info); }
.observation.pass { border-left-color: var(--ok); opacity: 0.85; }
.observation header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.observation footer { display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
                      margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--line);
                      font-size: 0.84em; opacity: 0.8; }
.badge { font-size: 0.76em; padding: 1px 6px; border-radius: 3px; background: var(--soft);
         opacity: 0.9; white-space: nowrap; }
.badge.model { border: 1px solid var(--info); color: var(--info); }
.badge.esc { border: 1px solid var(--warn); color: var(--warn); }
.sub { margin-top: 8px; }
.actions { list-style: none; padding: 0; }
.actions li { padding-left: 18px; position: relative; }
.actions li::before { content: "☐"; position: absolute; left: 0; opacity: 0.6; }
.evidence { list-style: none; padding: 0; font-size: 0.9em; }
.evidence li { padding: 2px 0; }
.kind { display: inline-block; min-width: 86px; font-size: 0.82em; text-transform: uppercase;
        letter-spacing: 0.04em; opacity: 0.6; }
.ref { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
.ref.missing { color: var(--bad); }
details summary { cursor: pointer; opacity: 0.85; }
details.passes { margin-top: 10px; }
.where { font-size: 0.9em; }

table { width: 100%; border-collapse: collapse; font-size: 0.92em; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line);
         vertical-align: top; }
th { font-weight: 600; opacity: 0.75; font-size: 0.88em; text-transform: uppercase;
     letter-spacing: 0.04em; }

.tests, .reviewers { list-style: none; padding: 0; }
.tests li, .reviewers li { padding: 5px 0; border-bottom: 1px solid var(--line);
                           display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }

.change-request { border: 1px solid var(--info); border-radius: 4px; padding: 12px 16px;
                  margin-top: 28px; }
.proposed { border: 1px solid var(--line); border-radius: 4px; padding: 10px 12px; margin: 10px 0; }
.proposed header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.diff pre { margin: 4px 0; padding: 8px 10px; border-radius: 3px; overflow-x: auto;
            font-family: var(--vscode-editor-font-family); font-size: 0.88em; white-space: pre-wrap; }
.diff .removed { background: rgba(229,83,75,0.12); border-left: 3px solid var(--bad); }
.diff .added { background: rgba(57,168,91,0.12); border-left: 3px solid var(--ok); }
.open-questions li { margin: 4px 0; }

.provenance { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line);
              font-size: 0.92em; }
.limits li { opacity: 0.85; }
.stamp { font-size: 0.82em; opacity: 0.55; font-family: var(--vscode-editor-font-family);
         word-break: break-all; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-cmd],[data-file],[data-apply]') : null;
  if (!target) return;

  const cmd = target.getAttribute('data-cmd');
  if (cmd) { vscode.postMessage({ command: cmd }); return; }

  const apply = target.getAttribute('data-apply');
  if (apply !== null) { vscode.postMessage({ command: 'applyEdit', id: apply }); return; }

  const file = target.getAttribute('data-file');
  if (file) {
    vscode.postMessage({
      command: 'openFile',
      file,
      line: Number(target.getAttribute('data-line') || '1'),
    });
  }
});

// Checklist ticks survive a re-render of the panel, so re-assessing does not
// lose the developer's place in a long list.
const saved = vscode.getState() || { checked: {} };

for (const box of document.querySelectorAll('input[data-check]')) {
  const id = box.getAttribute('data-check');
  if (saved.checked[id]) box.checked = true;
  box.addEventListener('change', () => {
    saved.checked[id] = box.checked;
    vscode.setState(saved);
  });
}
`;
