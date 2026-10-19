"""Turns caller-supplied text into engine inputs."""

from dataclasses import dataclass


@dataclass
class EngineRequest:
    """What the engine accepts: already-validated, already-tokenized input."""

    request_id: str
    model: str
    token_ids: list[int]
    max_tokens: int | None = None
    stream: bool = False


_NEXT_ID = {"value": 0}


def _allocate_request_id() -> str:
    _NEXT_ID["value"] += 1
    return f"req-{_NEXT_ID['value']:08d}"


def tokenize(text: str) -> list[int]:
    """Stand-in tokenizer: one token per whitespace-delimited word."""
    return [abs(hash(word)) % 50_000 for word in text.split()]


def preprocess_prompt(prompt: str, *, model: str, max_tokens: int | None = None) -> EngineRequest:
    """Build an engine request from a raw prompt string."""
    return EngineRequest(
        request_id=_allocate_request_id(),
        model=model,
        token_ids=tokenize(prompt),
        max_tokens=max_tokens,
    )
