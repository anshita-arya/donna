"""Single-process executor used for local serving and tests."""

from vllm.v1.executor.abstract import ExecuteResult

MAX_NEW_TOKENS_PER_STEP = 8


class UniProcExecutor:
    """Runs forward passes in the calling process."""

    def __init__(self, model: str) -> None:
        self._model = model
        self._step = 0

    def execute(self, request_ids: list[str]) -> list[ExecuteResult]:
        self._step += 1
        return [
            ExecuteResult(
                request_id=request_id,
                token_ids=[self._step] * MAX_NEW_TOKENS_PER_STEP,
                finished=self._step >= 4,
            )
            for request_id in request_ids
        ]

    def shutdown(self) -> None:
        self._step = 0
