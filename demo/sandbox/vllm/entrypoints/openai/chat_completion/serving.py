"""Chat completion serving handler.

Sits between the HTTP route and the engine: validates the decoded request,
renders it into engine inputs, submits it, and shapes the result back into the
published response contract.
"""

from typing import Any, AsyncIterator

from vllm.entrypoints.openai.chat_completion.protocol import (
    ChatCompletionChoice,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    ErrorResponse,
    UsageInfo,
)
from vllm.entrypoints.serve.utils.api_utils import RequestValidationError
from vllm.entrypoints.validation.guards import enforce_request_guards
from vllm.renderers.online_renderer import render_chat_request
from vllm.v1.engine.async_llm import AsyncLLM


class OpenAIServingChat:
    """Handler bound to POST /v1/chat/completions."""

    def __init__(self, engine: AsyncLLM, served_model: str) -> None:
        self._engine = engine
        self._served_model = served_model

    async def create_chat_completion(
        self, request: ChatCompletionRequest, raw_request: Any
    ) -> ChatCompletionResponse | ErrorResponse | AsyncIterator[str]:
        """Serve one chat completion request."""
        try:
            enforce_request_guards(request, served_model=self._served_model)
        except RequestValidationError as exc:
            return ErrorResponse(message=str(exc), type="invalid_request_error", code=400)

        engine_request = render_chat_request(request)
        result = await self._engine.generate(engine_request)

        return ChatCompletionResponse(
            id=result.request_id,
            model=request.model,
            choices=[
                ChatCompletionChoice(
                    index=0,
                    message=ChatMessage(role="assistant", content=result.text),
                    finish_reason=result.finish_reason,
                )
            ],
            usage=UsageInfo(
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
                total_tokens=result.prompt_tokens + result.completion_tokens,
            ),
        )
