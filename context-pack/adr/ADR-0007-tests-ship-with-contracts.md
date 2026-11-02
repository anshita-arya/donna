# ADR-0007: Contract and validation changes ship with their tests

- **Status:** Accepted
- **Date:** 2026-04-02
- **Owners:** @qa-serving, @contract-council

> *Fictional decision, written for the Donna demo. Not vLLM's real policy.*

## Context

Two areas of this codebase have the property that an existing passing test suite
tells you almost nothing about whether a change is safe:

- **Contracts.** The contract tests assert the shape the contract had when they
  were written. A change to the contract that keeps those assertions passing has
  demonstrated only that it did not break the old shape — which is not the
  question. The question is whether the *new* shape is what we meant to publish.
- **The validation gate.** Validation tests assert that known-bad requests are
  rejected. A change that widens what the gate accepts does not fail any of
  them, because no existing test asserts the absence of a rule nobody has
  written yet.

In both cases the test suite is green and the change is unassessed, which is the
most dangerous combination available: it looks like evidence.

## Decision

**A change to a contract model requires a change to its contract tests in the
same change. A change to the validation gate or to a route's dependencies
requires a change to the validation tests in the same change.**

"A change to the tests" means an assertion about the new behaviour. Touching the
file to add an import does not count, and reviewers should say so.

This is a crude rule. It cannot tell a real new assertion from a cosmetic edit,
and we know developers can satisfy it without satisfying its intent. We are
choosing it anyway, because the alternative — relying on reviewers to notice that
a green suite is irrelevant — is what we have now, and it does not work. The rule
puts the question in front of someone at the moment they are still holding the
context.

## Consequences

Some changes will carry a test edit that is genuinely redundant. That is an
acceptable cost.

The rule does not fire on changes elsewhere in the codebase, deliberately. A
blanket "every change needs a test" rule gets switched off within a month. These
two areas earn the friction; most do not.
