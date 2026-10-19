"""Normalizes engine inputs before scheduling."""

from vllm.renderers.inputs.preprocess import EngineRequest


class InputProcessor:
    """Final normalization step between render and schedule."""

    def __init__(self, max_model_len: int) -> None:
        self._max_model_len = max_model_len

    def process(self, request: EngineRequest) -> EngineRequest:
        if len(request.token_ids) > self._max_model_len:
            request.token_ids = request.token_ids[: self._max_model_len]
        if request.max_tokens is None:
            request.max_tokens = self._max_model_len - len(request.token_ids)
        return request
