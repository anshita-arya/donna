"""Contract tests for the chat completion request/response shapes."""

from vllm.entrypoints.openai.api_versions import (
    CHAT_COMPLETION_VERSIONS,
    CURRENT_CONTRACT_VERSION,
    latest_for,
)
from vllm.entrypoints.openai.chat_completion.protocol import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
)


def test_minimal_request_is_accepted():
    """A caller sending only model and messages must still be valid."""
    request = ChatCompletionRequest(
        model="demo-7b", messages=[ChatMessage(role="user", content="hello")]
    )
    assert request.temperature == 1.0
    assert request.max_tokens is None
    assert request.stream is False


def test_every_request_field_is_optional_except_model_and_messages():
    """Guards against a required field being added without a version bump."""
    required = {"model", "messages"}
    annotations = ChatCompletionRequest.__annotations__
    defaults = ChatCompletionRequest.__dataclass_fields__
    for name in annotations:
        if name in required:
            continue
        field = defaults[name]
        has_default = field.default is not field.default_factory
        assert has_default, f"{name} must have a default to stay backward compatible"


def test_response_shape_is_stable():
    """The response envelope keys are part of the published contract."""
    response = ChatCompletionResponse(id="req-1", model="demo-7b", choices=[])
    assert response.object == "chat.completion"
    assert response.usage.total_tokens == 0


def test_contract_version_registry_is_current():
    """Every published contract has a registry entry."""
    assert latest_for("ChatCompletionRequest") is not None
    assert latest_for("ChatCompletionResponse") is not None
    assert CHAT_COMPLETION_VERSIONS[-1].version == CURRENT_CONTRACT_VERSION
