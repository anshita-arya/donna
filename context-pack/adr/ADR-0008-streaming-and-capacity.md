# ADR-0008: A streaming response must not hold scheduler capacity while idle

- **Status:** Accepted
- **Date:** 2026-04-21
- **Owners:** @svc-engine-core, @svc-reliability

> *Fictional decision, written for the Donna demo. Not vLLM's real architecture.*

> **Note for readers of the Donna demo:** this ADR deliberately has **no
> `donna` enforcement block.** It is a real design constraint that no
> mechanical rule can check, and it is here to show what Donna does with
> that: it cites the decision, hands the prose to the model pass, and records in
> its blind spots that the constraint was *not* verified. A tool that reported a
> clean pass on this ADR would be lying.

## Context

A streaming request occupies a slot in the running batch for as long as the
client is reading from it. That is correct while tokens are being produced. It
is not correct while the request is waiting on something else — a slow consumer,
a tool call being resolved upstream, a client that has stopped reading but not
disconnected.

We learned this during an incident where throughput collapsed to roughly a
fifth of normal with the GPU almost idle. The cause was a few hundred streaming
requests, all nominally active, all blocked on clients that had gone away
without closing their connections. Every one of them was holding a batch slot
and a KV cache allocation. The scheduler had no way to know they were idle,
because from its point of view an unfinished request is an unfinished request.

## Decision

**A streaming request that is not making progress releases its capacity.**

Three properties follow, and all three are about *intent* rather than mechanism,
which is why this decision is prose and not a rule:

1. **Progress is observable.** Anything that holds a batch slot can be asked
   whether it is advancing. A code path where "waiting for the client" and
   "waiting for the model" are indistinguishable from the scheduler violates
   this decision even if it passes every test.
2. **Idleness is recoverable, not fatal.** A request whose capacity is released
   and which then becomes readable again is rescheduled, not failed. Dropping it
   converts a slow client into an error the client did not cause.
3. **The timeout belongs to the engine.** The gateway must not implement its own
   idle-stream timeout, because two independent timeouts on the same request
   produce a race whose outcome depends on which fires first — and we have had
   that race too.

The third point is the one most often missed in review. It is tempting to solve
a stuck stream at the gateway, where the connection is, and the resulting code
looks local and sensible.

## Consequences

Any change that introduces a new way for a request to be in-flight but not
advancing — a new await on something outside the engine, a new buffering layer, a
hand-off to an external service mid-generation — needs to say how the scheduler
learns about it. "The existing timeout covers it" is a claim that has to be
checked, not assumed.

Reviewers on the engine and reliability teams should read this decision before
approving changes to the streaming path, and should expect the author to have an
answer to "what happens when the client stops reading here".
