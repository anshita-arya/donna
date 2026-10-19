"""HTTP routes for the chat completion API."""

from typing import Any

from vllm.entrypoints.openai.chat_completion.protocol import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ErrorResponse,
)
from vllm.entrypoints.openai.chat_completion.serving import OpenAIServingChat
from vllm.entrypoints.serve.utils.api_utils import (
    load_aware_call,
    validate_json_request,
    with_cancellation,
)


class APIRouter:
    """Minimal stand-in for the FastAPI router used by the real server."""

    def __init__(self) -> None:
        self.routes: list[tuple[str, str, Any]] = []

    def post(self, path: str, dependencies: list[Any] | None = None):
        def decorate(handler: Any) -> Any:
            self.routes.append((path, "POST", handler))
            return handler

        return decorate


def Depends(dependency: Any) -> Any:  # noqa: N802 - mirrors the FastAPI name
    """Marker for a route dependency."""
    return dependency


router = APIRouter()


def chat(request: Any) -> OpenAIServingChat | None:
    return request.app.state.openai_serving_chat


@router.post("/v1/chat/completions", dependencies=[Depends(validate_json_request)])
@with_cancellation
@load_aware_call
async def create_chat_completion(
    request: ChatCompletionRequest, raw_request: Any
) -> ChatCompletionResponse | ErrorResponse:
    """Serve POST /v1/chat/completions."""
    handler = chat(raw_request)
    if handler is None:
        raise NotImplementedError("the model does not support the Chat Completions API")
    return await handler.create_chat_completion(request, raw_request)
