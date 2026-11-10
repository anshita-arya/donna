# Donna

TL/DR: For all Suits fan, she's the Donna to your Harvey.

🕶️ Meet Donna: The Background Design Review Agent


Most AI coding assistants are just execution engines. For all Suits fans, they are the legal secretaries of the software world—they type exactly what you dictate, even if you are dictating a mistake.
Donna is different. She isn’t the assistant you hire to type; she’s the partner you need to stay ahead.
While your primary coding agent is hyper-focused on hammering out syntax and shipping immediate features, Donna operates in the background. She reads between the lines, analyzes your broader architecture, conducts silent design reviews, and stops you from walking into technical debt traps.

So how exactly does Donna do this? 
A VS Code extension that runs **in parallel to your coding agent** and assesses
the system-wide impact of its change **before you open a pull request**.

The coding agent writes the code. Donna does the background investigation
you would otherwise do manually afterwards:
1. Which services and dependencies the change reaches
2. Which documented design decisions it conflicts with
3. Whether it is backward compatible, what could go wrong in production, which
   tests apply, and who needs to review it.

It produces a reviewable scorecard. It does not change or approve anything on your behalf.

> **Why "Donna":** Donna is the assistant everyone needs. She has already read the file nobody else opened, and she
> tells you the uncomfortable thing *before* you walk into the room. And the part
> that matters for a tool like this one — she has no formal authority and
> enormous influence. She doesn't sign anything and she doesn't decide. She makes
> sure you aren't about to make a mistake which will be incredibly difficult to walk back.

---

## The problem it addresses

A coding assistant finishes a change. The diff looks fine. The code builds. The tests pass. The developer opens a PR, and then finds out that the change conflicts with an
architecture decision written eight months ago by someone on another team, or
that the "additive" field they added is required and breaks every existing
client, or that the redundant-looking check they removed was the only thing
standing between a malformed request and the scheduler.

That evidence exists. It is just spread across service repositories, dependency
relationships, design documentation, CODEOWNERS files and test suites — and
none of it is visible in the diff. So the conflict surfaces in PR review, or in
a lead's end-of-week read of the codebase, which is the most expensive possible
moment: the change gets sent back for design review, and sometimes rewritten or
abandoned.

Donna moves that discovery to before the PR exists.

## What it actually checks

Six dimensions, each reported with evidence, a confidence level, and what to do
about it:

| Dimension | What it answers | How |
| --- | --- | --- |
| **Design conformance** | Does this appear to conflict with a documented decision? | Active ADR prose reviewed against the change by the model; findings are labeled as inferred and cited |
| **Backward compatibility** | Does this break existing callers? | Public symbols, contract fields and routes compared against the base revision |
| **Blast radius** | What else does this reach? | Dependents traversed upward, by hop distance, mapped onto services |
| **Production risk** | What could fail in a way tests will not catch? | Heuristics over the changed lines: concurrency, removed error handling, changed limits, dropped observability, resource allocation, auth |
| **Test coverage** | What should be run, and what is missing? | Which tests import the changed modules, plus declared test expectations |
| **Review routing** | Who needs to see this? | Existing CODEOWNERS files and ADR owner metadata — never inferred from git history |

The verdict is one of **ready to propose**, **needs revision**, or **send to
design review**.

## Three design decisions worth knowing about

**1. `unknown` is never rolled up as a pass.** If the base revision cannot be
read, or a check cannot run, the result is `unknown` and it is reported as such. The scorecard has a "What this
did not check" section that sits *above* the findings rather than in a footer,
because a reader who stops halfway should have seen the limits of the analysis
before its conclusions. A confident green on a check that did not run is the
worst output this tool could produce.

**2. Fixed checks and inferred ADR review stay distinct.** The dependency
graph, contract comparison, ownership lookup, and test reachability run without
a model and produce repeatable results. The model also reads ordinary, active
ADR prose and compares it with the change. Any finding based on that
interpretation is explicitly marked **Inferred**, cites the ADR passage and
changed code, and may affect the verdict. The developer can accept or dismiss
the finding; that choice is saved for this workspace and tied to the cited
evidence. Inferred review is not deterministic proof.

**3. Not every escalation reason drives the verdict.** The policy says to
escalate on a design conflict, missing documentation or ownership, uncertain
compatibility, or a possible production-behaviour change. Taken literally the
last one fires on nearly every real change, and a tool that routes everything to
design review is a tool people switch off — which would make the metric worse,
not better. So all four reasons are recorded and shown, but only a design
conflict or an unresolved compatibility question routes the change to design
review. Missing documentation or ownership is surfaced as an unknown/action;
production-risk signals call for attention rather than automatic design review.
This calibration is explicit in
`src/assess/scorecard.ts` rather than buried.

## What the agent is not allowed to do

Enforced in `src/agents/guardrails.ts`, not just stated in a prompt:

- **Does not modify code.** Every suggested change is a proposal. The
  design-review agent produces a change *request*; applying it takes an explicit
  click and shows the diff first.
- **Does not create, edit or supersede architecture decision records.** If it
  could, the cheapest way to resolve a design conflict would be to rewrite the
  decision — which inverts the whole point.
- **Does not assign or change ownership.** An agent that can edit CODEOWNERS can
  route its own work to a reviewer who will not object.
- **Does not edit its own configuration.** That would let it widen a boundary or
  mute a finding to make its own report green.
- **Does not override test expectations or CI configuration.** Overriding a
  required test is indistinguishable from passing it.
- **Does not approve, open or merge a pull request, and does not deploy.**

Edits to any of those paths are rejected before the developer sees them, and the
rejection is *reported* rather than hidden — if the agent reached for an ADR, you
should know that.

## Architecture

```
          coding agent (Claude Code, Cursor, you)
                        │ writes files
                        ▼
              ┌──── watcher.ts ────┐   debounced; agent-agnostic by design
              │                     │
              ▼                     │
   ┌──────────────────────┐         │
   │ evidence             │         │
   │  diff (git)          │         │
   │  graph (py + ts)     │         │
   │  ADR index           │         │
   │  service map         │         │
   │  ownership           │         │
   │  test reachability   │         │
   └──────────┬───────────┘         │
              ▼                     │
   ┌──────────────────────┐         │
   │ fixed checks         │  graph · compatibility · tests · production risk
   └──────────┬───────────┘         │
              ▼                     │
   ┌──────────────────────┐         │
   │ assess/              │  blast · compat · risk · scorecard
   └──────────┬───────────┘         │
              │                     │
              ├──► impact agent (model pass, judges prose) ──┐
              │                                              │
              ▼                                              ▼
       ui/scorecardPanel ◄──── design-review agent (explicit trigger only)
       ui/treeViews
       ui/diagnostics
```

`src/core`, `src/evidence` and `src/assess` never import
`vscode`, so the whole assessment pipeline runs headlessly — which is what lets
the eval harness exercise the same code path the extension does.

### Codebase Layout

| Path | What is in it |
| --- | --- |
| `src/core/` | Graph, scanners (Python + TS/JS), resolvers, diff parsing, config, git/disk I/O |
| `src/evidence/` | ADR indexing, ownership resolution, test coverage mapping |
| `src/assess/` | Blast radius, compatibility, production risk, scorecard assembly, markdown rendering |
| `src/agents/` | Model access, prompts, the impact pass, the design-review agent, guardrails |
| `src/ui/` | Scorecard webview, tree views, diagnostics, status bar |
| `context-pack/` | **Synthetic, clearly labelled** demo context: service map, 9 ADRs, CODEOWNERS, test expectations |
| `demo/sandbox/` | A self-contained Python package whose layout mirrors vLLM's public layout |
| `scenarios/` | Four prepared changes for the evaluation harness |
| `test/` | Unit tests for the primitives; the scenario eval harness |

## Reviewing ADRs

ADRs stay ordinary Markdown, written and maintained by the engineering team.
Donna does not require a separate Donna-specific JSON block or a new format.
It reads the status and owners from the document, excludes superseded and
deprecated ADRs, and gives active ADR prose to the model for review against the
change.

An ADR-based model finding is **inferred**, not a deterministic rule result.
Donna marks it **Inferred**, cites the exact ADR passage and relevant changed
code, and explains that the conclusion depends on interpretation. Inferred
conflicts can affect the verdict. The developer can accept the concern or
dismiss it as a false positive; the choice is stored in the workspace and
applies only while the cited ADR passage and code evidence remain unchanged.

Fixed code checks—such as dependency analysis, compatibility checks, test
reachability, and production-risk heuristics—remain separate and repeatable.
They do not prove that every sentence in an ADR has been satisfied. Donna
should report ambiguity or missing evidence rather than present an inferred
reading as deterministic enforcement.

## Setup

```bash
npm install
npm run build          # bundle the extension
npm run typecheck      # uses the real @types/vscode
npm test               # unit tests + the four scenarios
```

> `typings-dev/vscode.d.ts` is a hand-written stub of the VS Code API subset this
> extension uses, so the editor-facing code can be typechecked on a machine
> without network access to install `@types/vscode`
> (`npm run typecheck:offline`). It is not part of the build and not referenced
> by `tsconfig.json`. Once `npm install` has run, `npm run typecheck` uses the
> real types — and if the two ever disagree, the real types are right and the
> stub should be deleted.

Then press **F5** in VS Code to launch the Extension Development Host.

Donna does not create or automatically load a Donna-specific configuration
file in your repository. Run **Donna: Configure Analysis Context** to edit context settings
in an untitled VS Code document, then run **Donna: Save Context Settings**.
Donna stores those settings in VS Code's workspace storage, outside your
checkout. Use **Donna: Import Context File** to copy an existing JSON context
file into that storage; the source file is read-only and is not deleted.

Repository context is read in place: ADRs default to `docs/adr`, and reviewer
ownership comes from the first existing standard CODEOWNERS location
(`.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS`). Donna does not
create or modify those files. Optional `contextDirectory` in the workspace
context settings points to a separate directory for ADRs and test expectations.

### Model provider

`donna.llm.provider` defaults to `vscode`, which uses the editor's Language
Model API and reuses whatever subscription you are already signed in to — no API
key, no second bill. Set it to `anthropic` and run
`Donna: Set Anthropic API Key` to call the API directly; the key goes into
VS Code secret storage, not your settings or your repo.

`donna.llm.trigger` defaults to `onConflict`: the model runs when fixed checks
find something concrete to review, and when active ADRs are available for
prose-based design review. Set the trigger to `manual` to suppress automatic
model review.

### Donna integrations

Donna can retrieve read-only external context directly through MCP. Run
**Donna: Connect Integrations** to set up GitHub, Atlassian (Jira and
Confluence), Notion, and Aha!. GitHub asks for a read-scoped token; the other
services open their OAuth sign-in flow. Aha! also asks for the account
subdomain, such as `acme` for `acme.aha.io`. Tokens and OAuth state are stored
in VS Code SecretStorage; the Aha! subdomain is stored in workspace state.

Connections are also offered during a user-initiated assessment when the model
pass runs. Automatic file-watch assessments never open sign-in prompts. To
include external context on every assessment, set `donna.llm.trigger` to
`everyAssessment`; otherwise it is queried when the model pass is requested or
when deterministic checks find a conflict.

Donna only invokes provider tools that look like read-only search/query tools,
and the model may cite only results fetched for that assessment. Configure
GitHub tokens with read-only scopes, keep Atlassian MCP write permission groups
disabled, restrict Aha! MCP to read access in account AI controls, and expose
only read/search tools through Notion workspace MCP controls.

## Verification

```

`npm test` runs the unit assertions and four scenario fixtures. The scenario
harness checks fixed code-analysis results only; model interpretation of ADR
prose is covered separately and is never presented as deterministic enforcement.

The scenario harness stands up a real git repository, applies prepared change
fixtures, and runs the same `assess()` the extension runs against a real
`git diff`. It is test infrastructure; the extension does not write these
changes. Scenario 03 is the control: a tool that cannot say "this is ready" is
a brake, and brakes get disabled.

Each scenario declares `mustNotFlag` as well as `mustFlag`, because false
positives move the metric in the wrong direction.

## Known limits

Stated here and in every scorecard's blind-spot list:

- **Test relevance is import reachability within four hops, not line coverage.**
  A listed test imports a changed module; it may not execute the changed lines.
- **Import scanning is lexical, not an AST pass.** The scanners strip comments
  and string bodies properly (verified against docstrings containing import
  examples, `#` inside strings, and parenthesized multi-line imports), but
  dynamic imports built at runtime are invisible. Swapping in the TypeScript
  compiler API or Python's `ast` behind the same `scanSource` / `scanPython`
  signature is the upgrade path; it was not taken because this reruns on every
  agent write and has to stay cheap.
- **Reachability is weaker than call-path proof.** ADR-0003's gate check proves
  a handler *imports* the validation gate, not that it calls it on every path.
  The ADR says so.
- **Blast radius is capped at three hops by default** and reports when it was
  cut short. Uncapped, the transitive dependent set of a core module in a large
  repo is "most of the codebase" — true and useless.
- **Python and TypeScript/JavaScript only.** Other languages are reported as
  untraced changed files rather than silently ignored.
- **Production risk is heuristic.** A clean result means "nothing obvious", and
  the scorecard says exactly that, at low confidence.

## About the demo material

`context-pack/` and `demo/sandbox/` exist so the tool can be demonstrated
without any private code. Read `context-pack/README.md` before using either.

In short: the **paths** mirror vLLM's real public layout so the same globs work
against a real clone. Everything else — the architecture overview, the nine
ADRs, the service ownership, the dependency policy, the compatibility rules, the
test expectations, the file bodies in the sandbox — is **invented for this demo**.
It is not vLLM's architecture, not vLLM's decisions, not vLLM's ownership. Every
`@handle` is a made-up team name; no real person or company appears anywhere.

vLLM is Apache-2.0. The only thing borrowed from it is the shape of its
directory tree.

## License

MIT.

## Repository map

```text
donna/
├── src/                 The VS Code extension
├── context-pack/        Example project knowledge for assessments
├── demo/sandbox/        Example codebase used by the evaluation tests
├── scenarios/           Sample changes and their expected assessment results
├── samples/             Human-readable descriptions of the scenarios
├── test/                Unit tests and the evaluation runner
├── schemas/             Rules for validating Donna configuration
├── media/               Extension artwork
└── package.json, etc.   Extension metadata, build scripts, and TypeScript settings
```

### How the code fits together

```text
VS Code starts Donna
        ↓
Donna watches for file changes
        ↓
It reads the change and gathers project context
        ↓
It checks risks and produces a scorecard
        ↓
It displays the results in VS Code
```

- `src/extension.ts` is the VS Code composition root. It wires together the
  watcher, assessment controller, commands, and result views.
- `src/assessmentController.ts` prepares and runs assessments, including the
  optional model pass.
- `src/commands.ts` registers assessment-related commands and their handlers.
- `src/watcher.ts` notices saved, created, or deleted files and starts an
  assessment after changes settle.
- `src/core/` reads the project and its Git changes, then builds a picture of
  how the code relates.
- `src/evidence/` gathers supporting context, such as design decisions,
  ownership, and relevant tests.
- `src/assess/` turns the evidence and checks into findings, a verdict, and a
  scorecard.
- `src/ui/` displays Donna's results in VS Code.
- `src/agents/` contains optional model-assisted review and its safety checks.
- `src/integrations/` connects to external services such as GitHub, Atlassian,
  and Notion.
- `src/util/` contains shared helpers, such as logging and debouncing.

### Example and test material

- `context-pack/` contains example reference material Donna can assess against:
  architecture notes, ADRs (records of design decisions), ownership information,
  and test expectations.
- `demo/sandbox/` is a sample project the evaluation harness uses to test
  Donna.
- `scenarios/` describes sample changes and what Donna is expected to flag.
- `samples/` explains those scenarios in a human-readable format.
- `test/` contains automated checks. The evaluation runner creates temporary
  local Git repositories; it does not create or host repositories online.
- `schemas/` defines what Donna's configuration files are allowed to look like.

At a high level, the main path through Donna is
`src/extension.ts` → `src/watcher.ts` → `src/assessmentController.ts` →
`src/core/` and `src/evidence/` → `src/assess/` → `src/ui/`, with the model pass
reviewing active ADR prose when enabled.
