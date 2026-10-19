# Demo script — three agents around one change

Roughly 8 minutes. Everything runs offline; nothing here touches private code.

## What the audience should take away

Three agents, each with a different authority:

1. **The coding agent** writes code. (Claude Code, Cursor — or the scripted
   stand-in, so the demo is deterministic.)
2. **The impact-analysis agent** runs *in parallel*, investigates, and produces a
   scorecard. It cannot change anything.
3. **The design-review agent** runs only when the developer asks, and produces a
   change *request* the developer chooses to apply.

The developer decides at every step. The point of the demo is not that the tool
is clever — it is that the conflict is found **before the PR exists**.

---

## Setup (once, before the room)

```bash
cd donna
npm install
npm run build
```

Open **two** VS Code windows:

- **Window A** — `donna/` itself. Press **F5**. This launches the Extension
  Development Host.
- **Window B** — the Extension Development Host that appears. Open
  `donna/demo/sandbox` as its folder.

In Window B, set two settings (`.vscode/settings.json` in the sandbox):

```json
{
  "donna.contextPack": "../../context-pack",
  "donna.demo.scenarioDir": "../../scenarios",
  "donna.llm.trigger": "onConflict"
}
```

Make the sandbox a git repo with a clean baseline, so the diff is real:

```bash
cd demo/sandbox
git init -b main && git add -A && git commit -m baseline
git checkout -b agent/demo
```

**Dry run it first.** If the model provider is not signed in, the deterministic
findings still land — which is itself worth showing, but better as a deliberate
choice than a surprise.

---

## Act 1 — the setup (1 min)

Open `context-pack/README.md` and say the quiet part out loud:

> "The paths here are vLLM's real layout. Everything else — the architecture,
> the decisions, the ownership — is invented for this demo. No private code, no
> real teams, no claims about vLLM."

Then open `context-pack/adr/ADR-0002-contract-versioning.md` and scroll to
**Enforcement**.

> "This is the mechanism. The ADR is prose, because engineering leads write
> prose. The fenced block is the part a machine can check. An ADR with no block
> isn't unenforced — it's *unchecked*, and the tool says so instead of showing
> you a green tick."

---

## Act 2 — the coding agent produces a change (1 min)

In Window B, run **Donna: Run Demo Scenario** and pick
**“Add a routing_policy field to the chat completion request”**.

Show what the developer would see. Open the diff:

```bash
git diff
```

Two files. Two added lines. One of them is `routing_policy: str`.

> "Put yourself in review. One added line on a request model. Additive change to
> an API — the most routinely-approved kind of diff there is. Tests pass, because
> every assertion in the contract suite is about the fields that were already
> there. Would you catch this?"

Let the silence sit. Most people will not.

---

## Act 3 — the impact agent, in parallel (3 min)

The scorecard opens on its own — Donna assessed the moment the writes
settled. Nobody ran a command.

Walk the panel **top to bottom**, in that order, because the order is the
argument:

**The verdict.** "Send to design review." Not *rejected* — the tool does not
have that authority. It is saying: this needs the decision's owners, not a PR
reviewer.

**The six tiles.** Design conformance: conflict. Backward compatibility:
conflict. Three others clear.

**Escalations.** Two ADRs by number, with the owners to route to.

**"What this did not check."** Stop here and dwell.

> "This is the section I care most about. It is above the findings, not in a
> footer. It tells you ADR-0008 has no machine-checkable constraints, so its
> prose wasn't verified. It tells you test relevance is import reachability, not
> line coverage. The failure this tool exists to prevent is a developer being
> told something is fine and finding out later it wasn't — so a confident green
> on a check that didn't run would be the worst thing it could produce."

**The findings.** Open the ADR-0002 conflict. Point at the evidence line and
click it — it jumps to `protocol.py:26`. Then the backward-compatibility
finding:

> "`routing_policy: str` — no default, non-optional type. In the diff this reads
> as a pure addition. Every existing caller that doesn't send it now fails
> validation. That's the one humans miss, because adding a line looks safe."

**Reviewers.** `@contract-council` is required, and the reason is given: they
own ADR-0002, which this conflicts with. Note what is *not* there:

> "It never guesses an owner from git history. Whoever last touched the file is
> not the same as the owner, and nominating them would be worse than saying
> nothing."

**What this agent does not do.** Scroll to the footer.

> "Six limits, and they're enforced in code, not in a prompt. There's a
> guardrail module that rejects edits to design records, ownership, CI config,
> and the tool's own settings. If the agent reached for an ADR to make a
> conflict go away, you'd be told it tried."

---

## Act 4 — the design-review agent, on request (2 min)

Click **Send to design-review agent**. Note the word *send* — the developer
decided.

When the proposal lands:

- A summary and a rationale.
- Concrete edits, shown as a diff, each with **Apply this edit** — nothing is
  applied until clicked, and clicking shows a confirmation with the exact text.
- Tests to add, described rather than written.
- **Handed back to you** — the open questions. This is the honest part: where the
  fix would need the decision itself amended, it says so instead of editing it.

Click **Apply** on one edit. Donna re-assesses automatically. Watch a tile
go from conflict to clear.

> "The loop closed without anyone opening a PR."

---

## Act 5 — the control case (1 min)

This is the act people skip, and it is the one that decides whether the tool
survives contact with a real team.

Run **Donna: Revert Demo Scenario**, then **Run Demo Scenario** →
**“Add an optional seed parameter for reproducible sampling”**.

Verdict: **Looks ready to propose.** No conflicts. Checklist empty of blockers.

> "Same files. Same kind of change. But the field is optional, the version
> registry was updated in the same commit, and the contract test gained an
> assertion. A tool that flags everything is a brake, and brakes get disabled —
> so the assessment has to be able to say *this is fine*."

Then, if there is time, the third scenario — **validation bypass** — because the
premise is the most seductive:

> "The agent was told to remove a duplicate check. It was right that the engine
> also validates. It was wrong about what the engine's validation is *for*. The
> ADR is explicit: the engine assumes its inputs are already acceptable. Bypass
> the gate and an oversized prompt doesn't get a 4xx — it reaches the scheduler,
> fails KV cache allocation, and takes the in-flight batch down with it."

---

## Act 6 — the metric (1 min)

Back in Window A, in a terminal:

```bash
npm test
```

```
All 132 assertions passed.

01-contract-required-field     escalate-to-design-review    PASS
02-validation-bypass           escalate-to-design-review    PASS
03-additive-optional-field     ready-to-propose             PASS
04-gateway-reaches-scheduler   escalate-to-design-review    PASS

Pre-PR conflict detection
  Design conflicts caught before PR:  3/3
  Clean changes left alone:           1/1
```

> "The real metric is the percentage of PRs sent back for design review because
> the change conflicts with an existing decision. This is the prototype's
> version: of the scenarios with a genuine conflict, how many were caught before
> a PR existed — and of the clean one, was it left alone.
>
> Three for three, and no false positive. Without the agent, each of those three
> surfaces in PR review or in a lead's Friday read of the codebase. That gap is
> the whole product."

---

## If something goes wrong

| Symptom | What to do |
| --- | --- |
| Scorecard empty, status bar says "no changes against the base ref" | The sandbox has no commits, or no `main`. Run the git setup above. |
| "No language model is available" | Expected without a signed-in provider. The deterministic findings still land — say so and carry on; it demonstrates the model pass being additive rather than load-bearing. |
| Model pass returns nothing usable | The impact agent drops uncited observations by design, and reports the drop in blind spots. Point at that — it is the behaviour, not a failure. |
| Demo scenario will not apply | The sandbox has drifted. `git checkout .` in `demo/sandbox`, then re-run. |
| Findings look stale | Something is still writing. The watcher waits 2.5s after the last write; the status bar shows "waiting for writes to settle". |

## Questions worth pre-loading

**"How is this different from a linter?"** A linter checks the code against
rules about code. This checks a change against *decisions*, by id, with the ADR
cited and the owner named — and it reports what it could not check.

**"Why not just put this in CI?"** CI runs after the PR exists. The expensive
failure is the PR that gets sent back. This is the same checks, moved earlier,
to the moment the developer still has the context in their head.

**"What stops it being wrong?"** Nothing stops it being wrong. What is built in
is that it tells you *how* it knows, how confident it is, and what it did not
look at — and that the three strongest claims it can make (design conflict,
compatibility break, required test missing) all come from deterministic checks
with a citation, not from a model.

**"Can it just fix things?"** No, and that is a design decision rather than a
missing feature. It proposes; you apply. It cannot touch design records,
ownership, CI, or its own config at all.
