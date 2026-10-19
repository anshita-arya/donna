# ADR-0005: Batching policy stays inside the scheduler

- **Status:** Accepted
- **Date:** 2026-03-04
- **Owners:** @svc-scheduler, @svc-engine-core

> *Fictional decision, written for the Donna demo. Not vLLM's real architecture.*

## Context

Batching policy is the part of this system we change most often and understand
least well. Queue ordering, preemption, the token budget, how KV cache pressure
feeds back into admission — all of it is empirical, all of it gets retuned when
the traffic mix shifts, and none of it has a stable right answer.

Code that changes that often cannot have external callers. Every caller is a
constraint on the next retune.

The specific thing we got wrong before this decision: `KVCacheManager` was
imported in four places outside the scheduler, because reading cache usage was
convenient. When we wanted to change block accounting to support prefix sharing,
the change was mechanically simple and took three weeks, because the four
callers each had a slightly different assumption about what `usage` meant and two
of them were in a different service with a different release cadence.

## Decision

**The scheduler is consumed through `vllm/v1/core/sched/` and
`SchedulerInterface`.**

`build_scheduler()` constructs one. `SchedulerInterface` and `SchedulerOutput`
describe what callers may assume. `Scheduler`, the request queue, and
`KVCacheManager` are internal.

Facts about scheduler state that callers legitimately need — queue depth, cache
usage — are exposed as properties on the scheduler itself, so there is one
definition of each rather than four interpretations.

Tests are exempt. A unit test for the request queue has to import the request
queue; a rule that forbids that either bans unit testing the thing most worth
unit testing, or gets turned off.

## Consequences

`SchedulerInterface` becomes the thing we have to be careful about, and it is
listed as a compatibility surface for that reason. In exchange, everything behind
it is genuinely free to change, which is what the retune cadence requires.

## Enforcement

```donna
{
  "id": "ADR-0005",
  "status": "accepted",
  "owners": ["@svc-scheduler", "@svc-engine-core"],
  "appliesTo": [
    "vllm/v1/core/**",
    "vllm/v1/engine/**",
    "vllm/entrypoints/**"
  ],
  "constraints": [
    {
      "id": "scheduler-consumed-through-entry",
      "kind": "service-public-entry",
      "severity": "blocker",
      "rationale": "External callers of the scheduler's internals are constraints on the next retune; four of them turned a simple block-accounting change into three weeks.",
      "params": {
        "service": "scheduler",
        "entry": [
          "vllm/v1/core/sched/__init__.py",
          "vllm/v1/core/sched/interface.py",
          "vllm/v1/core/__init__.py"
        ],
        "allowFrom": ["tests/**"]
      }
    }
  ]
}
```
