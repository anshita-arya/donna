# ADR-0000: Each serving handler validates its own requests

- **Status:** Superseded
- **Date:** 2025-11-02
- **Superseded by:** ADR-0003
- **Owners:** @svc-api-gateway

> *Fictional decision, written for the Donna demo. Not vLLM's real history.*

> **Note for readers of the Donna demo:** this ADR is here to show that
> status is honoured. It is `Superseded`, so Donna does not evaluate its
> constraints and does not cite it as governing anything — a tool that enforced
> retired decisions would be worse than one that enforced none.

## Context

Each serving endpoint has slightly different requirements, so validation logic
was placed in the handler that needed it. This kept the rules close to the code
that depended on them.

## Decision

Each serving handler is responsible for validating its own requests before
submitting them to the engine.

## Consequences

Validation rules are duplicated across handlers, and a new handler starts with
whatever subset its author copies.

## Why this was superseded

The duplication was not a cosmetic problem. A new endpoint shipped without the
token-ceiling check, a 400k-token prompt reached the scheduler, and the KV cache
allocation failure took down the in-flight batch with it. See ADR-0003, which
replaces this decision with a single validation gate.

## Enforcement

```donna
{
  "id": "ADR-0000",
  "status": "superseded",
  "supersededBy": "ADR-0003",
  "owners": ["@svc-api-gateway"],
  "appliesTo": ["vllm/entrypoints/**"],
  "constraints": [
    {
      "id": "handlers-validate-locally",
      "kind": "forbidden-dependency",
      "severity": "blocker",
      "rationale": "RETIRED. This rule forbade a shared validation module, which is exactly what ADR-0003 now requires. If Donna ever reports this constraint, it is ignoring ADR status and that is a bug.",
      "params": {
        "from": ["vllm/entrypoints/openai/**/serving.py"],
        "to": ["vllm/entrypoints/validation/**"],
        "transitive": false
      }
    }
  ]
}
```
