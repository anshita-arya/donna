# Prepared change scenarios

Four changes an AI coding assistant plausibly produces, each one a thing a
developer would reasonably believe was finished. Each is declared as a set of
exact find/replace edits against `demo/sandbox/`, so a run is deterministic and
reproducible.

| # | Scenario | Looks like | Actually is |
| --- | --- | --- | --- |
| 01 | `contract-required-field` | One added line on a request model | A breaking change for every existing client, with no version record and no contract test |
| 02 | `validation-bypass` | Removing a redundant-looking check and dependency | The validation gate bypassed, so malformed requests fail inside the scheduler |
| 03 | `additive-optional-field` | A new optional parameter | Exactly that — the control case, and it should come back clean |
| 04 | `gateway-reaches-scheduler` | A better `Retry-After` header | The gateway making admission decisions off an unlocked cross-process read |

Scenario 01 is the one from the brief: *a change that looks valid in the code
diff but violates a design decision.* Scenario 03 exists because a tool that
flags everything is worthless — it is the check that the assessment can say
"this is fine".

## Each scenario file

```jsonc
{
  "id": "01-contract-required-field",
  "title": "...",
  "agentPrompt": "the request a developer would type into Claude Code or Cursor",
  "whyItLooksFine": "what a reviewer sees",
  "whatIsActuallyWrong": "what they do not see",
  "edits": [{ "file": "...", "find": "...", "replace": "..." }],
  "expect": {
    "verdict": "escalate-to-design-review",
    "mustFlag": ["check ids that have to appear as conflicts"],
    "mustNotFlag": ["check ids that must NOT appear — the false-positive guard"]
  }
}
```

`mustNotFlag` matters as much as `mustFlag`. An impact tool that reports every
constraint on every change moves the metric in the wrong direction, because the
developer stops reading it.

## Running them

```bash
npm run eval          # all scenarios, static checks only
npm run eval -- 01    # one scenario, with full scorecard output
```

The harness copies the sandbox to a temp directory, initialises a real git
repository, commits the baseline, branches, applies the scenario's edits, and
then runs the same `assess()` the extension runs — against a real `git diff`, not
a synthesised one. If the harness passes, the extension is exercising the same
code path.

## What the pass/fail means

The harness records, per scenario, whether the conflict was identified **before
PR creation**. That is the prototype's version of the real metric: the
percentage of PRs sent back for design review because the change conflicts with
an existing design decision. Here it is measured as: of the scenarios that
contain a genuine design conflict, how many did the assessment catch — and of
the ones that do not, how many did it leave alone.
