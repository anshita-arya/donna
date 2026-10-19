"""Renders chat-shaped requests into engine inputs."""

from typing import Any

from vllm.renderers.inputs.preprocess import EngineRequest, preprocess_prompt

CHAT_TEMPLATE = "{role}: {content}"


def flatten_messages(messages: list[Any]) -> str:
    """Flatten a chat conversation into a single prompt string."""
    return "\n".join(
        CHAT_TEMPLATE.format(role=message.role, content=message.content) for message in messages
    )


def render_chat_request(request: Any) -> EngineRequest:
    """Render a chat completion request into engine inputs."""
    prompt = flatten_messages(request.messages)
    engine_request = preprocess_prompt(prompt, model=request.model, max_tokens=request.max_tokens)
    engine_request.stream = bool(getattr(request, "stream", False))
    return engine_request
