"""Request and response contracts for POST /v1/chat/completions.

These classes are the published HTTP contract. Anything a client can send or
read is declared here, which is why this module is governed by the contract
versioning decision rather than treated as ordinary application code.
"""

from dataclasses import dataclass, field


@dataclass
class ChatMessage:
    """One message in a chat conversation."""

    role: str
    content: str
    name: str | None = None


@dataclass
class ChatCompletionRequest:
    """Inbound body for a chat completion."""

    model: str
    messages: list[ChatMessage]
    max_tokens: int | None = None
    temperature: float = 1.0
    top_p: float = 1.0
    n: int = 1
    stream: bool = False
    stop: list[str] | None = None
    reasoning_effort: str | None = None


@dataclass
class ChatCompletionChoice:
    """One generated candidate."""

    index: int
    message: ChatMessage
    finish_reason: str


@dataclass
class UsageInfo:
    """Token accounting returned to the caller."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass
class ChatCompletionResponse:
    """Outbound body for a non-streaming chat completion."""

    id: str
    model: str
    choices: list[ChatCompletionChoice]
    usage: UsageInfo = field(default_factory=UsageInfo)
    object: str = "chat.completion"


@dataclass
class ChatCompletionStreamResponse:
    """One server-sent event in a streaming chat completion."""

    id: str
    model: str
    delta: ChatMessage
    object: str = "chat.completion.chunk"


@dataclass
class ErrorResponse:
    """Error envelope shared by every serving route."""

    message: str
    type: str
    code: int
