"""Request and response contracts for POST /v1/completions."""

from dataclasses import dataclass, field

from vllm.entrypoints.openai.chat_completion.protocol import UsageInfo


@dataclass
class CompletionRequest:
    """Inbound body for a text completion."""

    model: str
    prompt: str
    max_tokens: int | None = None
    temperature: float = 1.0
    stream: bool = False


@dataclass
class CompletionChoice:
    """One generated candidate."""

    index: int
    text: str
    finish_reason: str


@dataclass
class CompletionResponse:
    """Outbound body for a text completion."""

    id: str
    model: str
    choices: list[CompletionChoice]
    usage: UsageInfo = field(default_factory=UsageInfo)
    object: str = "text_completion"
