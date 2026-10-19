# ADR-0003: Every inference request passes the validation gate

- **Status:** Accepted
- **Date:** 2026-02-03
- **Owners:** @svc-platform-safety, @svc-api-gateway

> *Fictional decision, written for the Donna demo. Not vLLM's real policy.*

## Context

Request validation used to be spread across the serving handlers. Each handler
checked the things its author remembered: one checked the token ceiling, one
checked the model allow-list, one checked neither and relied on the engine to
fail. The result was that "what is a valid request" had no single answer, and a
new endpoint started life with whichever subset its author copied from the
endpoint next to it.

The incident that forced this decision: a new endpoint shipped without the token
ceiling check. A request with a 400k-token prompt reached the scheduler, which
tried to allocate KV cache for it, failed, and took down the in-flight batch
with it. The request itself was obviously invalid. Nothing on the path to the
engine was responsible for saying so.

The engine cannot be that place. By the time a request reaches the scheduler it
has already been admitted, counted, and partially allocated; rejecting it there
is a rollback, not a rejection. Validation has to happen at the edge, before
anything is committed.

## Decision

**There is one validation gate, and every inference request goes through it.**

The gate is `vllm/entrypoints/validation/guards.py`. It owns request-shape rules:
token budgets, model allow-lists, unsupported parameter combinations.

Two things are required, and they are separate because they fail separately:

1. **Transport-level.** Every inference-serving route declares
   `Depends(validate_json_request)`, so a malformed body is rejected before any
   handler code runs. A route without it accepts a body the handler will then
   guess at.
2. **Semantic.** Every serving handler reaches
   `vllm/entrypoints/validation/guards.py` before it submits to the engine. "Reaches"
   means through the import graph — a handler that does not import the gate,
   directly or transitively, cannot be calling it.

The gate raises; it does not sanitize. A request that is not acceptable is
refused with a 4xx, not quietly adjusted into something servable. Silent
adjustment is how a client ends up believing it sent something it did not.

## Consequences

Adding a validation rule now means editing one file that every endpoint depends
on, which makes the gate a high-fan-in module and a change amplifier. We accept
that: a single place that everything depends on and that is therefore reviewed
carefully is better than seven places that are each reviewed casually.

Endpoints with genuinely different validation needs are handled by parameters to
the gate, not by bypassing it. If an endpoint truly cannot use the gate, that is
a conversation with @svc-platform-safety and an amendment to this ADR — not a
local exception.

The import-graph check is weaker than proving the gate is actually *called* on
every path. A handler could import it and not call it. We know this; it is
recorded as a gap rather than papered over, and the handler tests in
`tests/entrypoints/openai/test_validation_gate.py` are what close it.

## Enforcement

```donna
{
  "id": "ADR-0003",
  "status": "accepted",
  "owners": ["@svc-platform-safety", "@svc-api-gateway"],
  "appliesTo": [
    "vllm/entrypoints/**"
  ],
  "constraints": [
    {
      "id": "serving-handlers-reach-the-gate",
      "kind": "required-reachability",
      "severity": "blocker",
      "rationale": "A handler that does not import the validation gate cannot be calling it, which is how the 400k-token prompt reached the scheduler.",
      "params": {
        "from": ["vllm/entrypoints/openai/**/serving.py"],
        "mustReach": ["vllm/entrypoints/validation/guards.py"]
      }
    },
    {
      "id": "routes-declare-json-validation",
      "kind": "required-decorator",
      "severity": "blocker",
      "rationale": "Without the transport-level dependency, a malformed body reaches handler code that then has to guess at it.",
      "params": {
        "files": ["vllm/entrypoints/**/api_router.py"],
        "declPattern": "^async def (create_|serve_|stream_)\\w+",
        "marker": "validate_json_request",
        "withinLines": 14
      }
    }
  ]
}
```
