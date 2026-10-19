"""Text completion serving handler."""

from typing import Any

from vllm.entrypoints.openai.chat_completion.protocol import ErrorResponse, UsageInfo
from vllm.entrypoints.openai.completion.protocol import (
    CompletionChoice,
    CompletionRequest,
    CompletionResponse,
)
from vllm.entrypoints.serve.utils.api_utils import RequestValidationError
from vllm.entrypoints.validation.guards import enforce_request_guards
from vllm.renderers.inputs.preprocess import preprocess_prompt
from vllm.v1.engine.async_llm import AsyncLLM


class OpenAIServingCompletion:
    """Handler bound to POST /v1/completions."""

    def __init__(self, engine: AsyncLLM, served_model: str) -> None:
        self._engine = engine
        self._served_model = served_model

    async def create_completion(
        self, request: CompletionRequest, raw_request: Any
    ) -> CompletionResponse | ErrorResponse:
        """Serve one text completion request."""
        try:
            enforce_request_guards(request, served_model=self._served_model)
        except RequestValidationError as exc:
            return ErrorResponse(message=str(exc), type="invalid_request_error", code=400)

        engine_request = preprocess_prompt(request.prompt, model=request.model)
        result = await self._engine.generate(engine_request)

        return CompletionResponse(
            id=result.request_id,
            model=request.model,
            choices=[CompletionChoice(index=0, text=result.text, finish_reason=result.finish_reason)],
            usage=UsageInfo(
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
                total_tokens=result.prompt_tokens + result.completion_tokens,
            ),
        )
