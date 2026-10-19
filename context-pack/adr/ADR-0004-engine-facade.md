# ADR-0004: AsyncLLM is the engine's only entry point

- **Status:** Accepted
- **Date:** 2026-02-18
- **Owners:** @svc-engine-core

> *Fictional decision, written for the Donna demo. Not vLLM's real architecture.*

## Context

The engine is three things that have to change independently: a request
lifecycle, an admission policy, and a step loop over a scheduler and an
executor. Teams outside the engine care about exactly one of them — "give me
tokens for this request" — and have no reason to know about the other two.

When callers import engine internals, two things happen. The obvious one is that
internal refactors break external callers. The less obvious and more expensive
one is that **the internals stop being free to change shape at all**, because
every signature becomes a contract with someone who never agreed to it. We spent
most of a quarter unable to change how admission control counts in-flight
requests, because four call sites outside the engine were reading the counter.

## Decision

**Everything outside `vllm/v1/engine/` uses `AsyncLLM` and nothing else.**

`vllm/v1/engine/async_llm.py` is the public entry point. `EngineCore`,
`AdmissionController`, `InputProcessor` and the step loop are internal, and their
signatures are not contracts.

The facade's own signature *is* a contract — across a service boundary, between
teams — and is governed accordingly in the compatibility rules.

## Consequences

The facade will accrete methods, because every legitimate need from outside has
to arrive as one. That is visible pressure in a single reviewed file, which we
prefer to invisible pressure spread across the internals.

Some callers will want a fact the facade does not expose and will have to ask
for it. Each of those requests is a chance to ask whether the caller should know
that fact at all — which is the question that the four call sites reading the
admission counter never got asked.

## Enforcement

```donna
{
  "id": "ADR-0004",
  "status": "accepted",
  "owners": ["@svc-engine-core"],
  "appliesTo": [
    "vllm/v1/engine/**",
    "vllm/entrypoints/**",
    "vllm/renderers/**"
  ],
  "constraints": [
    {
      "id": "engine-consumed-through-facade",
      "kind": "service-public-entry",
      "severity": "blocker",
      "rationale": "Importing engine internals turns every internal signature into an unagreed contract, which is what froze admission control for a quarter.",
      "params": {
        "service": "engine-core",
        "entry": [
          "vllm/v1/engine/async_llm.py",
          "vllm/v1/engine/__init__.py"
        ],
        "allowFrom": ["tests/**"]
      }
    }
  ]
}
```
