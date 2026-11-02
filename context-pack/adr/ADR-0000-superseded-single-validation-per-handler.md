# ADR-0000: Each serving handler validates its own requests

- **Status:** Superseded
- **Date:** 2025-11-02
- **Superseded by:** ADR-0003
- **Owners:** @svc-api-gateway

> *Fictional decision, written for the Donna demo. Not vLLM's real history.*

> **Note for readers of the Donna demo:** this ADR is here to show that
> status is honoured. It is `Superseded`, so Donna excludes it from review —
> treating a retired decision as current would be worse than missing it.

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
