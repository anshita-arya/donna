# Impact assessment — 02-validation-bypass

> **Synthetic context:** "Inference serving platform (synthetic demo pack)". Architecture, decisions, ownership and policy in this pack are fictional and invented for a demo. They are not vLLM's real architecture or ownership, and no real person or team is named.

## ✗ Send to design review

3 documented design decisions (ADR-0003, ADR-0007) conflict with this change. That is not something to resolve in PR review — the decision's owners need to either amend the decision or the change needs reworking first.

`agent/02-validation-bypass` vs `7b1496be15a6` · 2 files, +1/-8

| Dimension | Status | Summary |
| --- | --- | --- |
| Design conformance | ✗ conflict | Blocking. 3 conflicts. Measured against the ADRs that govern the changed paths. |
| Backward compatibility | ✓ pass | Clear. 1 check passed. Public symbols, contract fields and routes, compared against the base revision. |
| Blast radius | ✓ pass | Clear. 1 check passed. Dependents traversed upward from the changed modules. |
| Production risk | ! attention | Worth a look. 2 to note. Heuristic signals, so a clear result means nothing obvious rather than no risk. |
| Test coverage | ✗ conflict | Blocking. 1 conflict, 2 to note. Tests that import the changed modules, plus declared expectations. |
| Review routing | ✓ pass | Clear. 1 check passed. From ownership records and CODEOWNERS; never inferred from git history. |

## Escalations

- **Conflicts with a documented design decision** — ADR-0003: serving-handlers-reach-the-gate; ADR-0003: routes-declare-json-validation; ADR-0007: validation-change-needs-validation-test *(route to @svc-platform-safety, @svc-api-gateway, @qa-serving, @contract-council)*
- **May change production behavior** — error handling removed; authentication, authorization or validation logic changed *(route to @svc-api-gateway, @contract-council)*

## What this did not check

- adr/ADR-0008-streaming-and-capacity.md: No donna block, so nothing in this ADR can be checked automatically. It is still cited as context for the model pass.
- 1 relevant ADR (ADR-0008) has no machine-checkable constraints — its prose was not evaluated, because the model pass did not run.
- 1 active ADR was skipped as out of scope for the changed paths. If one of them governs this area, its `appliesTo` globs are wrong.
- Test relevance is import reachability within 4 hops, not line coverage — a listed test may import a changed module without executing the changed lines.
- The model pass did not run (the eval harness runs deterministic checks only), so only deterministic checks contributed. Design intent expressed in prose was not evaluated.

## Before you open a PR

- [ ] Route `vllm/entrypoints/openai/chat_completion/serving.py` through vllm/entrypoints/validation/guards.py before the request reaches the engine, or obtain an explicit exemption from @svc-platform-safety, @svc-api-gateway. *(Design conformance · @svc-platform-safety, @svc-api-gateway)*
- [ ] Restore the `validate_json_request` on `create_chat_completion`, or get a written exemption from @svc-platform-safety, @svc-api-gateway before proposing this. *(Design conformance · @svc-platform-safety, @svc-api-gateway)*
- [ ] Add or update a test matching tests/entrypoints/openai/test_validation*.py in this change. *(Design conformance · @qa-serving, @contract-council)*
- [ ] Write a test matching `tests/entrypoints/openai/test_streaming_capacity.py`. *(Test coverage)*

## Worth saying in the PR description

- [ ] Confirm the failure the removed handler covered is now impossible, rather than merely unhandled. *(Production risk)*
- [ ] Check whether any caller relied on the exception type that is no longer raised. *(Production risk)*
- [ ] Name explicitly what is now accepted that was previously rejected, and confirm that is intended. *(Production risk)*
- [ ] This area normally needs a security or platform reviewer regardless of how small the diff is. *(Production risk)*
- [ ] Run tests/entrypoints/openai/test_validation_gate.py and add an assertion covering the new behaviour. *(Test coverage)*
- [ ] Decide which of these actually need coverage for this change, and say so in the PR rather than leaving it implicit. *(Test coverage)*

## Findings

### Design conformance

- **✗ ADR-0003: serving-handlers-reach-the-gate** — vllm/entrypoints/openai/chat_completion/serving.py:1
  `vllm/entrypoints/openai/chat_completion/serving.py` does not reach any of vllm/entrypoints/validation/guards.py, which ADR-0003 requires. A handler that does not import the validation gate cannot be calling it, which is how the 400k-token prompt reached the scheduler.
  *Evidence:* adr: ADR-0003 — Every inference request passes the validation gate — `adr/ADR-0003-validation-gate.md`; graph: vllm/entrypoints/openai/chat_completion/serving.py
  - [ ] Route `vllm/entrypoints/openai/chat_completion/serving.py` through vllm/entrypoints/validation/guards.py before the request reaches the engine, or obtain an explicit exemption from @svc-platform-safety, @svc-api-gateway.
  *confidence: high · escalates: Conflicts with a documented design decision · owners: @svc-platform-safety, @svc-api-gateway*

- **✗ ADR-0003: routes-declare-json-validation** — vllm/entrypoints/openai/chat_completion/api_router.py:47
  `create_chat_completion` in `vllm/entrypoints/openai/chat_completion/api_router.py` is missing the required `validate_json_request` in the 14 lines above its declaration. ADR-0003 requires it on every declaration matching this shape. Without the transport-level dependency, a malformed body reaches handler code that then has to guess at it.
  *Evidence:* adr: ADR-0003 — Every inference request passes the validation gate — `adr/ADR-0003-validation-gate.md`; diff: vllm/entrypoints/openai/chat_completion/api_router.py:47 — `async def create_chat_completion(`
  - [ ] Restore the `validate_json_request` on `create_chat_completion`, or get a written exemption from @svc-platform-safety, @svc-api-gateway before proposing this.
  *confidence: high · escalates: Conflicts with a documented design decision · owners: @svc-platform-safety, @svc-api-gateway*

- **✗ ADR-0007: validation-change-needs-validation-test** — vllm/entrypoints/openai/chat_completion/api_router.py:1
  1 governed file changed (vllm/entrypoints/openai/chat_completion/api_router.py) but no test matching tests/entrypoints/openai/test_validation*.py, tests/entrypoints/**/test_*gate*.py changed with them. ADR-0007 requires the two to move together. Widening what the gate accepts fails no existing test, because no test asserts the absence of a rule nobody has written yet.
  *Evidence:* adr: ADR-0007 — Contract and validation changes ship with their tests — `adr/ADR-0007-tests-ship-with-contracts.md`; diff: vllm/entrypoints/openai/chat_completion/api_router.py
  - [ ] Add or update a test matching tests/entrypoints/openai/test_validation*.py in this change.
  *confidence: high · escalates: Conflicts with a documented design decision · owners: @qa-serving, @contract-council*

### Production risk

- **! error handling removed** — vllm/entrypoints/openai/chat_completion/serving.py:30
  A removed try/except or raise changes what reaches the caller. If this path previously converted an internal failure into a clean error response, removing it can turn a handled 4xx into an unhandled 5xx. Triggered by 1 file: `vllm/entrypoints/openai/chat_completion/serving.py`.
  *Evidence:* diff: vllm/entrypoints/openai/chat_completion/serving.py:30 — `- try:`; diff: vllm/entrypoints/openai/chat_completion/serving.py:30 — `- except RequestValidationError as exc:`
  - [ ] Confirm the failure the removed handler covered is now impossible, rather than merely unhandled.
  - [ ] Check whether any caller relied on the exception type that is no longer raised.
  *confidence: medium · escalates: May change production behavior · owners: @svc-api-gateway, @contract-council*

- **! authentication, authorization or validation logic changed** — vllm/entrypoints/openai/chat_completion/api_router.py:41
  Changes in this area fail in the direction of letting something through. A test suite checks the cases it knows about; it does not check the case the change newly admits. Triggered by 1 file: `vllm/entrypoints/openai/chat_completion/api_router.py`.
  *Evidence:* diff: vllm/entrypoints/openai/chat_completion/api_router.py:41 — `- @router.post("/v1/chat/completions", dependencies=[Depends(validate_json_request)])`
  - [ ] Name explicitly what is now accepted that was previously rejected, and confirm that is intended.
  - [ ] This area normally needs a security or platform reviewer regardless of how small the diff is.
  *confidence: medium · escalates: May change production behavior · owners: @svc-api-gateway, @contract-council*

### Test coverage

- **✗ 1 required test does not exist**
  No test matches `tests/entrypoints/openai/test_streaming_capacity.py`. ADR-0008 requires that a streaming request which stops making progress releases its capacity. No test asserts this yet, so a change to the streaming path has nothing to validate it against. (required by test expectation streaming-capacity, and no test matches this pattern yet)
  *Evidence:* tests: streaming-capacity — `tests/entrypoints/openai/test_streaming_capacity.py`
  - [ ] Write a test matching `tests/entrypoints/openai/test_streaming_capacity.py`.
  *confidence: high*

- **! 1 existing test exercises this change**
  `tests/entrypoints/openai/test_validation_gate.py` import modules this change touches. No test file was changed, so the new behaviour is being asserted only by tests written for the old behaviour. Note this is import reachability, not line coverage — a test that imports a module does not necessarily execute the changed lines.
  *Evidence:* tests: tests/entrypoints/openai/test_validation_gate.py
  - [ ] Run tests/entrypoints/openai/test_validation_gate.py and add an assertion covering the new behaviour.
  *confidence: medium*

- **! 2 affected modules have no test reaching them**
  `vllm/entrypoints/openai/api_server.py`, `vllm/entrypoints/openai/completion/api_router.py` are inside this change's blast radius (5 modules) but no test imports them. A regression there would ship silently.
  *Evidence:* graph: vllm/entrypoints/openai/api_server.py; graph: vllm/entrypoints/openai/completion/api_router.py
  - [ ] Decide which of these actually need coverage for this change, and say so in the PR rather than leaving it implicit.
  *confidence: medium · owners: @svc-api-gateway, @contract-council*

## Affected services

| Service | Reach | Modules | Owners |
| --- | --- | --- | --- |
| api-gateway | direct | 2 | @svc-api-gateway, @contract-council |

## Tests

- **missing:** `tests/entrypoints/openai/test_streaming_capacity.py` — ADR-0008 requires that a streaming request which stops making progress releases its capacity. No test asserts this yet, so a change to the streaming path has nothing to validate it against. (required by test expectation streaming-capacity, and no test matches this pattern yet)
- `tests/entrypoints/openai/test_validation_gate.py` — Integration test that imports 2 changed modules.

## Reviewers

- **@contract-council** (required) — Owns changed files in api-gateway. Owns the api-gateway service, which this change modifies. Owns ADR-0007, which this change conflicts with.
- **@qa-serving** (required) — Owns ADR-0007, which this change conflicts with.
- **@svc-api-gateway** (required) — Owns changed files in api-gateway. Owns the api-gateway service, which this change modifies. Owns ADR-0003, which this change conflicts with.
- **@svc-platform-safety** (required) — Owns ADR-0003, which this change conflicts with.

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

*Generated 2026-10-16T12:11:49.058Z.*
