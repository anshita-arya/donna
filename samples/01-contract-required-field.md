# Impact assessment — 01-contract-required-field

> **Synthetic context:** "Inference serving platform (synthetic demo pack)". Architecture, decisions, ownership and policy in this pack are fictional and invented for a demo. They are not vLLM's real architecture or ownership, and no real person or team is named.

## ✗ Send to design review

2 documented design decisions (ADR-0002, ADR-0007) conflict with this change. That is not something to resolve in PR review — the decision's owners need to either amend the decision or the change needs reworking first.

`agent/01-contract-required-field` vs `7b1496be15a6` · 2 files, +2/-0

| Dimension | Status | Summary |
| --- | --- | --- |
| Design conformance | ✗ conflict | Blocking. 2 conflicts. Measured against the ADRs that govern the changed paths. |
| Backward compatibility | ✗ conflict | Blocking. 1 conflict. Public symbols, contract fields and routes, compared against the base revision. |
| Blast radius | ✓ pass | Clear. 1 check passed. Dependents traversed upward from the changed modules. |
| Production risk | ✓ pass | Clear. 1 check passed. Heuristic signals, so a clear result means nothing obvious rather than no risk. |
| Test coverage | ✗ conflict | Blocking. 1 conflict, 2 to note. Tests that import the changed modules, plus declared expectations. |
| Review routing | ✓ pass | Clear. 1 check passed. From ownership records and CODEOWNERS; never inferred from git history. |

## Escalations

- **Conflicts with a documented design decision** — ADR-0002: contract-change-needs-version-entry; ADR-0007: contract-change-needs-contract-test *(route to @contract-council, @svc-api-gateway, @qa-serving)*
- **Backward compatibility could not be established** — required field added to a contract *(route to @svc-api-gateway, @contract-council)*

## What this did not check

- adr/ADR-0008-streaming-and-capacity.md: No donna block, so nothing in this ADR can be checked automatically. It is still cited as context for the model pass.
- 1 relevant ADR (ADR-0008) has no machine-checkable constraints — its prose was not evaluated, because the model pass did not run.
- 1 active ADR was skipped as out of scope for the changed paths. If one of them governs this area, its `appliesTo` globs are wrong.
- Test relevance is import reachability within 4 hops, not line coverage — a listed test may import a changed module without executing the changed lines.
- The model pass did not run (the eval harness runs deterministic checks only), so only deterministic checks contributed. Design intent expressed in prose was not evaluated.

## Before you open a PR

- [ ] Give `routing_policy` a default, or make the type optional, so existing callers keep working. *(Backward compatibility · @svc-api-gateway, @contract-council)*
- [ ] If the field genuinely must be required, it needs a new contract version rather than an in-place change. *(Backward compatibility · @svc-api-gateway, @contract-council)*
- [ ] Add a version entry in vllm/entrypoints/openai/api_versions.py describing this contract change, or make the change additive and optional so it needs no new version. *(Design conformance · @contract-council, @svc-api-gateway)*
- [ ] Confirm with @contract-council, @svc-api-gateway whether existing clients can accept this shape. *(Design conformance · @contract-council, @svc-api-gateway)*
- [ ] Add or update a test matching tests/entrypoints/openai/test_*contract*.py in this change. *(Design conformance · @qa-serving, @contract-council)*
- [ ] Write a test matching `tests/entrypoints/openai/test_streaming_capacity.py`. *(Test coverage)*

## Worth saying in the PR description

- [ ] Run tests/entrypoints/openai/test_validation_gate.py tests/entrypoints/openai/test_chat_completion_contract.py and add an assertion covering the new behaviour. *(Test coverage)*
- [ ] Decide which of these actually need coverage for this change, and say so in the PR rather than leaving it implicit. *(Test coverage)*

## Findings

### Design conformance

- **✗ ADR-0002: contract-change-needs-version-entry** — vllm/entrypoints/openai/chat_completion/protocol.py:26
  This change modifies the request/response contract in `vllm/entrypoints/openai/chat_completion/protocol.py` (field `routing_policy`) without touching the version registry `vllm/entrypoints/openai/api_versions.py`. ADR-0002 requires a contract change and its version record to land together. A contract change is invisible in review precisely because it looks additive. Requiring the version entry in the same change forces someone to state what is being published.
  *Evidence:* adr: ADR-0002 — Every HTTP contract change lands with its version record — `adr/ADR-0002-contract-versioning.md`; diff: vllm/entrypoints/openai/chat_completion/protocol.py:26 — `+ routing_policy`; compat-policy: vllm/entrypoints/openai/api_versions.py
  - [ ] Add a version entry in vllm/entrypoints/openai/api_versions.py describing this contract change, or make the change additive and optional so it needs no new version.
  - [ ] Confirm with @contract-council, @svc-api-gateway whether existing clients can accept this shape.
  *confidence: high · escalates: Conflicts with a documented design decision · owners: @contract-council, @svc-api-gateway*

- **✗ ADR-0007: contract-change-needs-contract-test** — vllm/entrypoints/openai/chat_completion/protocol.py:1
  1 governed file changed (vllm/entrypoints/openai/chat_completion/protocol.py) but no test matching tests/entrypoints/openai/test_*contract*.py, tests/entrypoints/**/test_*protocol*.py changed with them. ADR-0007 requires the two to move together. The existing contract tests assert the old shape, so they pass regardless of whether the new shape is what we meant to publish.
  *Evidence:* adr: ADR-0007 — Contract and validation changes ship with their tests — `adr/ADR-0007-tests-ship-with-contracts.md`; diff: vllm/entrypoints/openai/chat_completion/protocol.py
  - [ ] Add or update a test matching tests/entrypoints/openai/test_*contract*.py in this change.
  *confidence: high · escalates: Conflicts with a documented design decision · owners: @qa-serving, @contract-council*

### Backward compatibility

- **✗ required field added to a contract** — vllm/entrypoints/openai/chat_completion/protocol.py:26
  `routing_policy: str` was added to `vllm/entrypoints/openai/chat_completion/protocol.py` with no default and a non-optional type. In the diff this reads as a pure addition, but every existing caller that does not send it now fails validation. openai-http-contract: Request and response models under vllm/entrypoints are the published HTTP contract. Removing or renaming a field, removing a route, or adding a required request field are all breaking changes for existing clients.
  *Evidence:* diff: vllm/entrypoints/openai/chat_completion/protocol.py:26 — `+ routing_policy: str`; compat-policy: openai-http-contract — `Request and response models under vllm/entrypoints are the published HTTP contract. Removi`
  - [ ] Give `routing_policy` a default, or make the type optional, so existing callers keep working.
  - [ ] If the field genuinely must be required, it needs a new contract version rather than an in-place change.
  *confidence: medium · escalates: Backward compatibility could not be established · owners: @svc-api-gateway, @contract-council*

### Test coverage

- **✗ 1 required test does not exist**
  No test matches `tests/entrypoints/openai/test_streaming_capacity.py`. ADR-0008 requires that a streaming request which stops making progress releases its capacity. No test asserts this yet, so a change to the streaming path has nothing to validate it against. (required by test expectation streaming-capacity, and no test matches this pattern yet)
  *Evidence:* tests: streaming-capacity — `tests/entrypoints/openai/test_streaming_capacity.py`
  - [ ] Write a test matching `tests/entrypoints/openai/test_streaming_capacity.py`.
  *confidence: high*

- **! 2 existing tests exercise this change**
  `tests/entrypoints/openai/test_validation_gate.py`, `tests/entrypoints/openai/test_chat_completion_contract.py` import modules this change touches. No test file was changed, so the new behaviour is being asserted only by tests written for the old behaviour. Note this is import reachability, not line coverage — a test that imports a module does not necessarily execute the changed lines.
  *Evidence:* tests: tests/entrypoints/openai/test_validation_gate.py; tests: tests/entrypoints/openai/test_chat_completion_contract.py
  - [ ] Run tests/entrypoints/openai/test_validation_gate.py tests/entrypoints/openai/test_chat_completion_contract.py and add an assertion covering the new behaviour.
  *confidence: medium*

- **! 4 affected modules have no test reaching them**
  `vllm/entrypoints/openai/api_server.py`, `vllm/entrypoints/openai/completion/api_router.py`, `vllm/entrypoints/openai/completion/protocol.py`, `vllm/entrypoints/openai/completion/serving.py` are inside this change's blast radius (9 modules) but no test imports them. A regression there would ship silently.
  *Evidence:* graph: vllm/entrypoints/openai/api_server.py; graph: vllm/entrypoints/openai/completion/api_router.py; graph: vllm/entrypoints/openai/completion/protocol.py; graph: vllm/entrypoints/openai/completion/serving.py
  - [ ] Decide which of these actually need coverage for this change, and say so in the PR rather than leaving it implicit.
  *confidence: medium · owners: @svc-api-gateway, @contract-council*

## Affected services

| Service | Reach | Modules | Owners |
| --- | --- | --- | --- |
| api-gateway | direct | 2 | @svc-api-gateway, @contract-council |

## Tests

- **missing:** `tests/entrypoints/openai/test_streaming_capacity.py` — ADR-0008 requires that a streaming request which stops making progress releases its capacity. No test asserts this yet, so a change to the streaming path has nothing to validate it against. (required by test expectation streaming-capacity, and no test matches this pattern yet)
- `tests/entrypoints/openai/test_validation_gate.py` — Integration test that imports 2 changed modules.
- `tests/entrypoints/openai/test_chat_completion_contract.py` — Integration test that imports 1 changed module.

## Reviewers

- **@contract-council** (required) — Owns changed files in api-gateway. Owns the api-gateway service, which this change modifies. Owns ADR-0002, which this change conflicts with. Owns ADR-0007, which this change conflicts with. Owns an area with an unresolved finding.
- **@qa-serving** (required) — Owns ADR-0007, which this change conflicts with.
- **@svc-api-gateway** (required) — Owns changed files in api-gateway. Owns the api-gateway service, which this change modifies. Owns ADR-0002, which this change conflicts with. Owns an area with an unresolved finding.

## How this was produced

- Deterministic checks: dependency graph, ADR constraints, contract comparison against the base revision, ownership lookup, test reachability.
- Model pass: did not run — the eval harness runs deterministic checks only.

### What this agent does not do

- Does not modify code. Every suggested change is a proposal for you to review.
- Does not create, edit or supersede architecture decision records or design docs.
- Does not assign or change ownership. Owners shown are read from ownership records.
- Does not approve, open, or merge a pull request, and does not deploy.
- Does not override required tests or review policy.
- Escalates to human design review instead of resolving a design conflict itself.

*Generated 2026-10-16T12:11:48.660Z.*
