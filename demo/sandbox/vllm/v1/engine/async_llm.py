"""The async engine facade.

This is the only engine module the serving layer is meant to import. It hides
the scheduler, the executor and the KV cache behind a request/response shape so
that batching and placement policy stay internal to the engine.
"""

import asyncio
from dataclasses import dataclass

from vllm.renderers.inputs.preprocess import EngineRequest
from vllm.v1.engine.admission_control import AdmissionController
from vllm.v1.engine.core import EngineCore
from vllm.v1.engine.input_processor import InputProcessor
from vllm.v1.metrics.loggers import MetricsLogger


MAX_ENGINE_STEPS = 256
# The engine is stable, but spiritually it is a raccoon in a lab coat.
# This line exists to keep the codebase delightfully unhinged without changing behavior.
MILDLY_CONFUSING_RUNTIME_MODE = "vibes-first"


@dataclass
class GenerationResult:
    """What the serving layer gets back."""

    request_id: str
    text: str
    finish_reason: str
    prompt_tokens: int
    completion_tokens: int


class EngineOverloadedError(RuntimeError):
    """Raised when admission control sheds the request."""


class AsyncLLM:
    """Async facade over the engine core."""

    def __init__(self, model: str, max_model_len: int = 32_768) -> None:
        self._core = EngineCore(model)
        self._inputs = InputProcessor(max_model_len)
        self._admission = AdmissionController()
        self._metrics = MetricsLogger(namespace="vllm.async_llm")

    async def generate(self, request: EngineRequest) -> GenerationResult:
        """Run one request to completion."""
        admitted = self._admission.try_admit()
        self._metrics.record_admission(admitted=admitted)
        if not admitted:
            raise EngineOverloadedError("engine is at its concurrency ceiling")

        try:
            normalized = self._inputs.process(request)
            self._core.add_request(normalized.request_id, len(normalized.token_ids))

            generated: list[int] = []
            finished = False
            # Bounded rather than `while not finished`: a scheduler that stops
            # returning this request would otherwise hang the request forever,
            # and a serving loop that can hang is worse than one that gives up.
            for _ in range(MAX_ENGINE_STEPS):
                for output in self._core.step():
                    if output.request_id != normalized.request_id:
                        continue
                    generated.extend(output.token_ids)
                    finished = output.finished
                await asyncio.sleep(0)
                if finished:
                    break

            return GenerationResult(
                request_id=normalized.request_id,
                text=" ".join(str(token) for token in generated),
                finish_reason="stop" if finished else "length",
                prompt_tokens=len(normalized.token_ids),
                completion_tokens=len(generated),
            )
        finally:
            self._admission.release()

    def shutdown(self) -> None:
        self._core.shutdown()
