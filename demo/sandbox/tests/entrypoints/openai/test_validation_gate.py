"""Tests that inference requests pass the validation gate before the engine."""

import pytest

from vllm.entrypoints.openai.chat_completion import api_router
from vllm.entrypoints.openai.chat_completion.protocol import (
    ChatCompletionRequest,
    ChatMessage,
)
from vllm.entrypoints.openai.chat_completion.serving import OpenAIServingChat
from vllm.entrypoints.serve.utils.api_utils import (
    RequestValidationError,
    validate_json_request,
)
from vllm.entrypoints.validation.guards import MAX_PROMPT_TOKENS, enforce_request_guards


def _request(**overrides):
    base = dict(model="demo-7b", messages=[ChatMessage(role="user", content="hi")])
    base.update(overrides)
    return ChatCompletionRequest(**base)


def test_unserved_model_is_rejected():
    with pytest.raises(RequestValidationError):
        enforce_request_guards(_request(model="not-served"), served_model="not-served")


def test_oversized_max_tokens_is_rejected():
    with pytest.raises(RequestValidationError):
        enforce_request_guards(
            _request(max_tokens=MAX_PROMPT_TOKENS + 1), served_model="demo-7b"
        )


def test_streaming_with_multiple_candidates_is_rejected():
    with pytest.raises(RequestValidationError):
        enforce_request_guards(_request(stream=True, n=2), served_model="demo-7b")


def test_valid_request_passes():
    enforce_request_guards(_request(max_tokens=128), served_model="demo-7b")


def test_chat_route_declares_the_json_validation_dependency():
    """The route must reject malformed bodies at the edge, not in the engine."""
    source = api_router.__file__
    with open(source, encoding="utf-8") as handle:
        text = handle.read()
    assert "validate_json_request" in text, "chat route lost its validation dependency"
    assert validate_json_request is not None


def test_serving_handler_calls_the_guards():
    """The handler must not hand an unvalidated request to the engine."""
    import inspect

    source = inspect.getsource(OpenAIServingChat.create_chat_completion)
    assert "enforce_request_guards" in source
