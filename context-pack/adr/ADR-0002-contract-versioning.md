# ADR-0002: Every HTTP contract change lands with its version record

- **Status:** Accepted
- **Date:** 2026-01-15
- **Owners:** @contract-council, @svc-api-gateway

> *Fictional decision, written for the Donna demo. Not vLLM's real policy.*

## Context

The request and response models under `vllm/entrypoints/` are the published HTTP
contract. Clients we do not control — SDKs, other teams' services, customer code
we will never see — are written against them. Once a shape is out, changing it is
not a refactor; it is a change to someone else's running software.

The failure mode we keep hitting is not malice or carelessness. It is that **a
contract change does not look like a contract change in a diff.** Adding a field
to a Pydantic model is one line. It reads as additive. Reviewers approve
additive changes quickly, because additive changes are usually safe.

But a field added without a default is required, and a required field breaks
every existing caller the moment it deploys. The diff for "safe optional field"
and "every client now gets a 422" differs by the four characters `= None`. We
have shipped that twice. Both times it was caught by a customer, not by us.

Related: we cannot answer "when did this field appear" without archaeology
through git history, which means we cannot tell a client which contract version
they are safe to pin.

## Decision

**A change to a contract model and its entry in the version registry land in the
same change.**

The registry is `vllm/entrypoints/openai/api_versions.py`. It records, per
contract, what changed, when, whether it was breaking, and which fields moved.

Concretely:

1. Touching a declared `*Request` or `*Response` type under
   `vllm/entrypoints/**/protocol.py` requires a corresponding registry entry in
   the same change.
2. A new request field is **optional with a default** unless the registry entry
   marks the change breaking and a reviewer from @contract-council has signed
   off.
3. Removing or renaming a field or a route is breaking, always. The old name
   stays as a deprecated alias for at least one release.

The registry is deliberately a source file rather than a generated artifact.
Generated version records get regenerated without anybody reading them; a source
file shows up in the diff and has to be written by a person who has thought
about what they are publishing.

## Consequences

Every contract change now costs an extra file edit and, when it is breaking, a
second reviewer. We think that is the right price: the registry entry is the
place where "is this actually additive?" gets asked, and it gets asked by the
person who knows the answer rather than by a reviewer skimming a one-line diff.

The rule will occasionally fire on a change that is genuinely internal — a
docstring on a contract class, a reordered field. The registry entry for those
is one line saying so, and we would rather pay that than tune the rule until it
stops catching the case it exists for.

This ADR governs the *shape* of the contract. ADR-0007 governs the tests that
have to come with it.

## Enforcement

```donna
{
  "id": "ADR-0002",
  "status": "accepted",
  "owners": ["@contract-council", "@svc-api-gateway"],
  "appliesTo": [
    "vllm/entrypoints/openai/**",
    "vllm/entrypoints/anthropic/**",
    "vllm/entrypoints/cohere/**"
  ],
  "constraints": [
    {
      "id": "contract-change-needs-version-entry",
      "kind": "contract-change-requires-version",
      "severity": "blocker",
      "rationale": "A contract change is invisible in review precisely because it looks additive. Requiring the version entry in the same change forces someone to state what is being published.",
      "params": {
        "surface": ["vllm/entrypoints/openai/**/protocol.py"],
        "symbolPattern": "class\\s+(\\w*(?:Request|Response|Choice|Message)\\w*)",
        "versionRegistry": ["vllm/entrypoints/openai/api_versions.py"]
      }
    }
  ]
}
```
