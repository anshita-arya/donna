"""HTTP routes for the text completion API."""

from typing import Any

from vllm.entrypoints.openai.chat_completion.api_router import APIRouter, Depends
from vllm.entrypoints.openai.completion.protocol import CompletionRequest, CompletionResponse
from vllm.entrypoints.openai.completion.serving import OpenAIServingCompletion
from vllm.entrypoints.serve.utils.api_utils import validate_json_request, with_cancellation

router = APIRouter()


def completion(request: Any) -> OpenAIServingCompletion | None:
    return request.app.state.openai_serving_completion


@router.post("/v1/completions", dependencies=[Depends(validate_json_request)])
@with_cancellation
async def create_completion(request: CompletionRequest, raw_request: Any) -> CompletionResponse:
    """Serve POST /v1/completions."""
    handler = completion(raw_request)
    if handler is None:
        raise NotImplementedError("the model does not support the Completions API")
    return await handler.create_completion(request, raw_request)
