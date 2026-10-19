# Sample scorecards

The assessment each prepared scenario produces, captured verbatim from
`npm test` so you can read the output without running anything.

| File | Scenario | Verdict |
| --- | --- | --- |
| `01-contract-required-field.md` | One added line on a request model | Send to design review |
| `02-validation-bypass.md` | Removing a "redundant" validation check | Send to design review |
| `03-additive-optional-field.md` | A genuinely additive optional field | Looks ready to propose |
| `04-gateway-reaches-scheduler.md` | A better `Retry-After` header | Send to design review |

These are the **deterministic** checks only — the harness runs with the model
pass off, which is why each one's blind-spot list says the prose in ADR-0008 was
not evaluated. In the extension the model pass adds to this rather than
replacing any of it.

Compare `01` and `03`: nearly the same change to the same files, opposite
verdicts. That difference is the product.
