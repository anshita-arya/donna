# Synthetic context pack — FICTIONAL

> **Everything in this directory is invented for a demo.**
>
> The architecture overview, the architecture decision records, the service
> ownership, the dependency policy, the API compatibility rules and the test
> expectations are **fiction**. They are *not* a description of vLLM's real
> architecture, *not* vLLM's real design decisions, and *not* vLLM's real
> ownership. Every `@handle` in here is a made-up team name. No real person,
> employee, team or company appears anywhere in this pack.
>
> The **file paths** are real, because they mirror the public directory layout
> of [vLLM](https://github.com/vllm-project/vllm) (Apache-2.0). That is the only
> thing borrowed from the project, and it is borrowed so the same pack can be
> pointed at a real clone without rewriting every glob.
>
> If you want to know how vLLM is actually designed and governed, read vLLM's
> own repository and documentation. Do not read this.

## Why this pack exists

Donna assesses a proposed change against the design context a developer
would otherwise have to assemble by hand. To demo that honestly, the context has
to come from somewhere — and it cannot come from a real company's private
repository. So it is invented here, labelled, and kept in its own directory
separate from the code it describes.

## What is in it

| File | What it stands in for |
| --- | --- |
| `donna.json` | The service map, ownership records, compatibility rules and paths. In a real repo this would live at the root. |
| `architecture-overview.md` | The "how the system fits together" doc an engineering lead writes once and everyone half-remembers. |
| `adr/ADR-00xx-*.md` | Architecture decision records. Each has prose for humans and, where the decision is mechanically checkable, a fenced ````donna` JSON block the constraint engine executes. |
| `CODEOWNERS` | Ownership in the format GitHub uses, so the CODEOWNERS parser is exercised on a real-shaped file. |
| `test-expectations.json` | Declared rules of the form "a change here requires a test there". |

## How the two parts of an ADR differ

This is the central idea of the pack, so it is worth being explicit.

An ADR's **prose** is the decision: the context, the reasoning, the
consequences. Humans read it. Donna cites it and hands it to the model pass,
but it does not pretend to have verified it.

An ADR's **`donna` block** is the subset of the decision that a machine can
check without judgement — a forbidden import, a required reachability, a
contract that must be versioned alongside its registry. Donna executes those
deterministically and reports them with the ADR id attached.

A decision with no block is not unenforced; it is *unchecked*, and Donna
says so in its blind spots rather than reporting a clean pass. That distinction
is the difference between a tool you can trust and one that makes you feel safe.

## Pointing this at a real vLLM clone

The globs already target real paths, so:

```bash
git clone --filter=blob:none --depth 1 https://github.com/vllm-project/vllm.git
# then, in VS Code, set:
#   donna.contextPack  ->  /path/to/donna/context-pack
#   and open the vllm clone as the workspace
```

The findings will be about a real codebase measured against fictional rules.
That is a legitimate way to exercise the tool, and an illegitimate way to make
any claim about vLLM. Keep the distinction.
