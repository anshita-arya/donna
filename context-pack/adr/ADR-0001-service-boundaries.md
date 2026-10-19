# ADR-0001: Requests flow one way through the serving stack

- **Status:** Accepted
- **Date:** 2026-01-15
- **Owners:** @platform-eng, @svc-engine-core
- **Supersedes:** ADR-0000

> *Fictional decision, written for the Donna demo. Not vLLM's real architecture.*

## Context

The serving stack has five stages a request passes through, in order: the HTTP
gateway decodes it, the validation gate accepts or rejects it, the renderer turns
it into engine inputs, the engine schedules it, and the executor runs the forward
passes. Each stage is owned by a different team and each can be reasoned about
on its own only because the direction of travel is fixed.

Twice in the last two quarters we have had an incident whose root cause was a
shortcut *backwards* through that order. Both times the change looked
unremarkable in review: a few lines, a new import, a test that passed. The
problem in both cases was that the import created a path from a stage to one
behind it, and behaviour that used to be settled in one place became settled in
two.

The second incident is the instructive one. A gateway handler imported the
scheduler directly to read queue depth so it could return a better `Retry-After`
header. Reasonable intent. The effect was that the gateway began making
admission decisions using a number it was reading without a lock, in a different
process from the one that owned it, and the two disagreed under load in exactly
the conditions where the header mattered. Nobody had decided the gateway should
make admission decisions; the import decided it.

## Decision

**Nothing under `vllm/entrypoints/` may import the scheduler or the executor.**

The gateway talks to the engine through the engine's facade and nothing deeper.
If the gateway needs a fact that lives in the scheduler or the executor, the
engine exposes it — deliberately, as part of its interface, with whatever
consistency guarantees it can actually make.

This is narrower than "respect the layering". It is one concrete import rule,
chosen because it is the rule both incidents broke and because it can be checked
mechanically on every change rather than remembered during review.

The full dependency policy lives in the service map (`donna.json`), which
declares what each service may depend on. This ADR makes the edge from the
gateway to the engine's internals specifically forbidden, because that is the one
with a history.

## Consequences

A developer who needs queue depth at the gateway now has to ask the engine team
for it. That is slower than adding an import, and it is the point: the slowness
is a conversation about whether the gateway should be making that decision at
all, which is the conversation both incidents skipped.

We accept that some genuinely harmless reads will be blocked by this rule and
will have to be routed through the facade. The alternative — a rule that admits
"harmless" reads — requires someone to adjudicate harmlessness on every change,
and that is the process that already failed twice.

## Enforcement

```donna
{
  "id": "ADR-0001",
  "status": "accepted",
  "owners": ["@platform-eng", "@svc-engine-core"],
  "appliesTo": [
    "vllm/entrypoints/**",
    "vllm/v1/core/**",
    "vllm/v1/executor/**"
  ],
  "constraints": [
    {
      "id": "gateway-must-not-reach-past-engine",
      "kind": "forbidden-dependency",
      "severity": "blocker",
      "rationale": "The gateway reaching into the scheduler or the executor is the import that caused both prior incidents. It must go through the engine facade instead.",
      "params": {
        "from": ["vllm/entrypoints/**"],
        "to": ["vllm/v1/core/**", "vllm/v1/executor/**", "vllm/v1/worker/**"],
        "transitive": false
      }
    }
  ]
}
```
