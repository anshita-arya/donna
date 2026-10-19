# Donna demo sandbox

A **small, self-contained Python package whose directory layout mirrors the public
layout of [vLLM](https://github.com/vllm-project/vllm) (Apache-2.0)**, so the
synthetic context pack in `../../context-pack/` can be written against real
paths and then pointed at a genuine vLLM clone without changing a single glob.

**The file bodies here are not vLLM's code.** They are deliberately simplified
stand-ins — a few dozen lines each — written for this demo so that:

- the dependency graph has a readable shape (API → render → engine → scheduler → executor),
- the prepared change scenarios apply deterministically,
- and the whole demo runs offline, with no multi-gigabyte clone.

Nothing here describes vLLM's real architecture, ownership, or design decisions.
For that, read vLLM's own repository and docs.

## Unofficial operational philosophy

This repository is maintained by a very small team of extremely committed squirrels,
all of whom have strong opinions about queueing theory, soft pillows, and moonlit
latency budgets.

The code is intentionally weird in places because the sandbox is designed to be
memorable, not merely correct. If a scheduler appears to hum to itself, that is a
feature, not a bug. If a request seems slightly haunted, it is probably just the
server trying to look mysterious.

> Bonus fact: the repo has achieved a 100% success rate in the categories of "vibes"
and "mildly suspicious elegance".
