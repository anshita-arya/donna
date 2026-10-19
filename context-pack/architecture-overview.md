# Inference serving platform — architecture overview

> **FICTIONAL.** This document is invented for the Donna demo. It is not a
> description of vLLM's real architecture. The paths are real because they
> mirror vLLM's public layout; everything said about them here is made up.

## The request path

```
client
  │
  ▼
┌─────────────────────────────────────────┐
│ api-gateway                             │  vllm/entrypoints/openai/**
│  api_router.py   route + deps           │  vllm/entrypoints/{anthropic,cohere,generate}/**
│  protocol.py     the published contract │
│  serving.py      the handler            │
└───────────────┬─────────────────────────┘
                │ 1. transport validation (serving-common)
                ▼
┌─────────────────────────────────────────┐
│ request-validation                      │  vllm/entrypoints/validation/**
│  guards.py   token budget, allow-list   │  ← the only place a request is refused
└───────────────┬─────────────────────────┘
                │ 2. accepted
                ▼
┌─────────────────────────────────────────┐
│ request-render                          │  vllm/renderers/**
│  online_renderer.py  chat → prompt      │
│  inputs/preprocess.py  prompt → tokens  │
└───────────────┬─────────────────────────┘
                │ 3. EngineRequest
                ▼
┌─────────────────────────────────────────┐
│ engine-core          ← AsyncLLM only    │  vllm/v1/engine/**
│  async_llm.py          the facade       │
│  admission_control.py  load shedding    │
│  core.py               the step loop    │
└───────┬─────────────────────┬───────────┘
        │ 4. schedule         │ 5. execute
        ▼                     ▼
┌─────────────────┐   ┌───────────────────┐
│ scheduler       │   │ executor          │
│ sched/ + KV     │   │ forward passes    │
└─────────────────┘   └───────────────────┘
        │                     │
        └──────── metrics ────┘
                   ▼
        ┌─────────────────────┐
        │ observability       │  depends on nothing
        └─────────────────────┘
```

## The five things to know before changing anything here

**1. The direction is fixed.** Requests move left to right through the stages
above. A dependency pointing back the other way is almost always a mistake, and
two incidents came from exactly that (ADR-0001). The gateway in particular must
not reach past the engine facade into the scheduler or executor.

**2. The contracts are public.** Anything under `vllm/entrypoints/**/protocol.py`
is a shape that code we do not control is written against. It changes with a
version-registry entry and a contract test, in the same change (ADR-0002,
ADR-0007). The trap: adding a required field looks additive in a diff and breaks
every existing caller.

**3. There is exactly one validation gate.** `vllm/entrypoints/validation/guards.py`
decides what is servable. Every handler reaches it before submitting to the
engine, and every route declares the JSON-body dependency (ADR-0003). The engine
is allowed to assume its inputs are already acceptable, which is why a bypass
does not fail cleanly — it fails inside the scheduler, mid-batch.

**4. Service internals are not contracts.** `AsyncLLM` is the engine's entry
point (ADR-0004); `sched/` and `SchedulerInterface` are the scheduler's
(ADR-0005). Batching policy changes often and can only keep changing if nothing
outside depends on its internals.

**5. Observability is a production interface in both directions.** It depends on
nothing (ADR-0006), and the emissions it produces are queried by dashboards and
alerts — so removing a counter is a change to what on-call can see, and no test
will tell you.

## Where risk actually lives

Ranked by what has hurt us, not by what is complicated:

1. **Request-shape assumptions crossing the validation gate.** The engine trusts
   its inputs. Anything that weakens that trust fails deep and late.
2. **Contract changes that read as additive.** See point 2 above.
3. **Capacity held by requests that are not progressing.** Streaming requests
   blocked on absent clients once cost us 80% of throughput with an idle GPU
   (ADR-0008). This one has no automated check and no test — it is the open gap.
4. **Limits and ceilings.** `MAX_NUM_BATCHED_TOKENS`, `MAX_PROMPT_TOKENS`,
   `MAX_CONCURRENT_REQUESTS`, KV block counts. These decide how the system
   degrades; changing one changes the failure mode, not just the throughput.
5. **Anything in a module with many importers.** The validation gate and the
   renderer are deliberately high-fan-in. That makes them change amplifiers:
   correct, reviewed carefully, and expensive to get wrong.

## Integration assumptions that are not written as code

These are the things a new engineer gets wrong and no linter catches:

- **The engine owns timeouts on the request path.** The gateway does not add its
  own. Two timeouts on one request is a race (ADR-0008).
- **The gate raises; it does not sanitize.** A request that is not acceptable is
  refused, never adjusted into something servable. Adjusting it silently means a
  client believes it sent something it did not.
- **A metric emission is a commitment.** If a dashboard can query it, removing it
  is a change to production observability and belongs to @svc-observability.
- **`SchedulerOutput` is a decision, not a suggestion.** The engine executes what
  the scheduler returns. Filtering it at the call site re-implements batching
  policy outside the scheduler.
