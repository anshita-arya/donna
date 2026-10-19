# Donna

A VS Code extension that runs **in parallel to your coding agent** and assesses
the system-wide impact of its change **before you open a pull request**.

The coding agent writes the code. Donna does the background investigation
you would otherwise do by hand afterwards: which services and dependencies the
change reaches, which documented design decisions it conflicts with, whether it
is backward compatible, what could go wrong in production, which tests apply,
and who needs to review it.

It produces a reviewable scorecard. It does not approve anything.

> **Why "Donna":** she has already read the file nobody else opened, and she
> tells you the uncomfortable thing *before* you walk into the room. And the part
> that matters for a tool like this one — she has no formal authority and
> enormous influence. She doesn't sign anything and she doesn't decide. She makes
> sure you aren't about to make a mistake you can't walk back.

---

## The problem it addresses

An assistant finishes a change. The diff looks fine. The tests pass. The
developer opens a PR — and then finds out that the change conflicts with an
architecture decision written eight months ago by someone on another team, or
that the "additive" field they added is required and breaks every existing
client, or that the redundant-looking check they removed was the only thing
standing between a malformed request and the scheduler.

That evidence exists. It is just spread across service repositories, dependency
relationships, design documentation, ownership records and test suites — and
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
| **Design conformance** | Does this contradict a documented decision? | ADR constraints executed against the diff and the dependency graph |
| **Backward compatibility** | Does this break existing callers? | Public symbols, contract fields and routes compared against the base revision |
| **Blast radius** | What else does this reach? | Dependents traversed upward, by hop distance, mapped onto services |
| **Production risk** | What could fail in a way tests will not catch? | Heuristics over the changed lines: concurrency, removed error handling, changed limits, dropped observability, resource allocation, auth |
| **Test coverage** | What should be run, and what is missing? | Which tests import the changed modules, plus declared test expectations |
| **Review routing** | Who needs to see this? | Ownership records and CODEOWNERS — never inferred from git history |

The verdict is one of **ready to propose**, **needs revision**, or **send to
design review**. Never "approved" — a human owner approves.

## Three design decisions worth knowing about

**1. `unknown` is never rolled up as a pass.** If the base revision cannot be
read, or an ADR points at a path that has moved, or a constraint throws, the
result is `unknown` and it is reported as such. The scorecard has a "What this
did not check" section that sits *above* the findings rather than in a footer,
because a reader who stops halfway should have seen the limits of the analysis
before its conclusions. A confident green on a check that did not run is the
worst output this tool could produce.

**2. Deterministic checks first; the model judges what they cannot.** The
dependency graph, the ADR constraints, the contract comparison, the ownership
lookup and test reachability all run without a model and produce the same result
every time. The model pass is additive: it reads design *prose* — the integration
assumptions stated in English and nowhere else — and its findings are badged
`model`, carry their citations, and are dropped if they cite nothing real. If
the model is unavailable the assessment still stands, and says so.

**3. Not every escalation reason drives the verdict.** The policy says to
escalate on a design conflict, missing documentation or ownership, uncertain
compatibility, or a possible production-behaviour change. Taken literally the
last one fires on nearly every real change, and a tool that routes everything to
design review is a tool people switch off — which would make the metric worse,
not better. So all four reasons are recorded and shown, but only a design
conflict or an unresolved compatibility question moves the verdict. Production
risk becomes blocking checklist items instead. This calibration is explicit in
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
   │ constraints/engine   │  six constraint kinds, executed against the diff
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

`src/core`, `src/evidence`, `src/constraints` and `src/assess` never import
`vscode`, so the whole assessment pipeline runs headlessly — which is what lets
the eval harness exercise the same code path the extension does.

### Layout

| Path | What is in it |
| --- | --- |
| `src/core/` | Graph, scanners (Python + TS/JS), resolvers, diff parsing, config, git/disk I/O |
| `src/evidence/` | ADR indexing, ownership resolution, test coverage mapping |
| `src/constraints/` | The constraint engine and its six kinds |
| `src/assess/` | Blast radius, compatibility, production risk, scorecard assembly, markdown rendering |
| `src/agents/` | Model access, prompts, the impact pass, the design-review agent, guardrails, the coding-agent stand-in |
| `src/ui/` | Scorecard webview, tree views, diagnostics, status bar |
| `context-pack/` | **Synthetic, clearly labelled** demo context: service map, 9 ADRs, CODEOWNERS, test expectations |
| `demo/sandbox/` | A self-contained Python package whose layout mirrors vLLM's public layout |
| `scenarios/` | Four prepared changes an assistant plausibly produces |
| `test/` | Unit tests for the primitives; the scenario eval harness |

## ADRs as executable constraints

This is the mechanism that catches "looks fine in the diff but violates a design
decision".

An ADR stays prose — humans write and read it. The subset of the decision a
machine can check lives in a fenced ` ```donna ` JSON block:

````markdown
# ADR-0002: Every HTTP contract change lands with its version record

- **Status:** Accepted
- **Owners:** @contract-council

## Context

...the reasoning a person needs...

## Enforcement

```donna
{
  "id": "ADR-0002",
  "status": "accepted",
  "appliesTo": ["vllm/entrypoints/openai/**"],
  "constraints": [{
    "id": "contract-change-needs-version-entry",
    "kind": "contract-change-requires-version",
    "severity": "blocker",
    "rationale": "A contract change is invisible in review precisely because it looks additive.",
    "params": {
      "surface": ["vllm/entrypoints/openai/**/protocol.py"],
      "symbolPattern": "class\\s+(\\w*(?:Request|Response)\\w*)",
      "versionRegistry": ["vllm/entrypoints/openai/api_versions.py"]
    }
  }]
}
```
````

An ADR with no block is **unchecked, not unenforced** — it is cited, its prose
goes to the model pass, and the scorecard's blind spots say it was not verified.

### The six constraint kinds

| Kind | Checks |
| --- | --- |
| `forbidden-dependency` | Modules matching `from` must not import (optionally: must not transitively reach) modules matching `to` |
| `required-reachability` | Every module matching `from` must reach at least one module matching `mustReach` |
| `contract-change-requires-version` | Touching a declared type or field in `surface` requires a change in `versionRegistry` |
| `service-public-entry` | Modules outside a service may only import its declared `entry` files |
| `change-requires-test` | A change matching `when` requires a changed test matching `requireChangedTest` |
| `required-decorator` | Declarations matching `declPattern` must carry `marker` within `withinLines` above them |

`forbidden-dependency`, `required-reachability` and `service-public-entry` accept
`allowFrom` to exempt paths — tests being the standard case, since a rule that
forbids unit-testing an internal module either bans unit tests or gets switched
off.

`status` is honoured: superseded and deprecated ADRs are not evaluated.

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

Point Donna at your context with `donna.json` at the repo root, or at a
separate directory via the `donna.contextPack` setting — useful when the
context pack is maintained apart from the code it describes.

Run `Donna: Create Config File` for a starter.

### Model provider

`donna.llm.provider` defaults to `vscode`, which uses the editor's Language
Model API and reuses whatever subscription you are already signed in to — no API
key, no second bill. Set it to `anthropic` and run
`Donna: Set Anthropic API Key` to call the API directly; the key goes into
VS Code secret storage, not your settings or your repo.

`donna.llm.trigger` defaults to `onConflict`: the model runs when the
deterministic checks have found something concrete for it to judge.

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
$ npm test

All 140 assertions passed.

scenario                       expected                     got                          result
01-contract-required-field     escalate-to-design-review    escalate-to-design-review    PASS
02-validation-bypass           escalate-to-design-review    escalate-to-design-review    PASS
03-additive-optional-field     ready-to-propose             ready-to-propose             PASS
04-gateway-reaches-scheduler   escalate-to-design-review    escalate-to-design-review    PASS

Pre-PR conflict detection
  Design conflicts caught before PR:  3/3
  Clean changes left alone:           1/1
```

The scenario harness stands up a real git repository, plays the coding agent by
applying the scenario's edits, and runs the same `assess()` the extension runs
against a real `git diff`. Scenario 03 is the control: a tool that cannot say
"this is ready" is a brake, and brakes get disabled.

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
