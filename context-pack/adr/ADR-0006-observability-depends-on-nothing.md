# ADR-0006: Observability depends on nothing

- **Status:** Accepted
- **Date:** 2026-03-19
- **Owners:** @svc-observability

> *Fictional decision, written for the Donna demo. Not vLLM's real architecture.*

## Context

Every service emits metrics, so every service depends on the observability
package. That makes it the one module in the system that genuinely cannot
depend on anything else: the moment it imports from the engine, the engine and
the metrics package form a cycle, and the cycle has to be broken by whoever
notices it next — usually at an inconvenient moment, because import cycles in
Python surface as partially-initialized modules at startup rather than as a
clean error.

We have had this cycle twice. Both times it was introduced for a sympathetic
reason: the metrics code wanted a type that happened to live in the engine, so
it imported it. The type was `SchedulerStats` the first time and a request-state
enum the second.

## Decision

**Nothing under `vllm/v1/metrics/`, `vllm/tracing/` or `vllm/logging_utils/`
imports from any other service.**

If observability code needs a type, that type moves into the observability
package, or the caller passes a plain value. Observability does not reach for
things; things are handed to it.

A corollary worth stating because it is the part people forget: a metric
emission point is a production interface. Dashboards and alerts query it.
Removing an emission is a change to what the on-call engineer can see during the
next incident, and it is invisible in tests — the test suite does not assert that
a counter still exists. Removals need the observability owners.

## Consequences

Observability ends up with some type definitions that arguably belong elsewhere.
That duplication is cheaper than the cycle.

## Enforcement

```donna
{
  "id": "ADR-0006",
  "status": "accepted",
  "owners": ["@svc-observability"],
  "appliesTo": [
    "vllm/v1/metrics/**",
    "vllm/tracing/**",
    "vllm/logging_utils/**"
  ],
  "constraints": [
    {
      "id": "observability-has-no-upward-deps",
      "kind": "forbidden-dependency",
      "severity": "blocker",
      "rationale": "An import from observability into any other service closes a cycle that surfaces as a partially-initialized module at startup rather than as an error.",
      "params": {
        "from": ["vllm/v1/metrics/**", "vllm/tracing/**", "vllm/logging_utils/**"],
        "to": [
          "vllm/entrypoints/**",
          "vllm/renderers/**",
          "vllm/v1/engine/**",
          "vllm/v1/core/**",
          "vllm/v1/executor/**"
        ],
        "transitive": false
      }
    }
  ]
}
```
