"""The request validation gate.

Everything that reaches the engine passes through here first. The gate is the
single place where request-shape rules, token budgets and model allow-lists are
enforced, so that the engine can assume its inputs are already acceptable.
"""

from typing import Any

from vllm.entrypoints.serve.utils.api_utils import RequestValidationError

MAX_PROMPT_TOKENS = 32_768
ALLOWED_MODELS = ("demo-7b", "demo-13b")


def enforce_request_guards(request: Any, *, served_model: str) -> None:
    """Validate a decoded request before it is handed to the engine.

    Raises:
        RequestValidationError: if the request must not be served.
    """
    if served_model not in ALLOWED_MODELS:
        raise RequestValidationError(f"model {served_model!r} is not served here")

    requested_model = getattr(request, "model", None)
    if requested_model is not None and requested_model != served_model:
        raise RequestValidationError(
            f"model {requested_model!r} is not served by this process"
        )

    max_tokens = getattr(request, "max_tokens", None)
    if max_tokens is not None and max_tokens > MAX_PROMPT_TOKENS:
        raise RequestValidationError("max_tokens exceeds the configured ceiling")

    if getattr(request, "stream", False) and getattr(request, "n", 1) > 1:
        raise RequestValidationError("streaming with n > 1 is not supported")


def enforce_token_budget(prompt_tokens: int) -> None:
    """Reject prompts that would not fit the KV cache budget."""
    if prompt_tokens > MAX_PROMPT_TOKENS:
        raise RequestValidationError("prompt exceeds the token budget")
