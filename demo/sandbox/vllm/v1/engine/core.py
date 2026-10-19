"""The engine core: scheduling and execution loop."""

from dataclasses import dataclass

from vllm.v1.core.sched import build_scheduler
from vllm.v1.executor.uniproc_executor import UniProcExecutor
from vllm.v1.metrics.loggers import MetricsLogger
from vllm.v1.metrics.stats import SchedulerStats


@dataclass
class CoreOutput:
    """One step's worth of engine output."""

    request_id: str
    token_ids: list[int]
    finished: bool


class EngineCore:
    """Owns the scheduler, the executor and the KV cache."""

    def __init__(self, model: str, num_kv_blocks: int = 2048) -> None:
        self._scheduler = build_scheduler(num_kv_blocks)
        self._executor = UniProcExecutor(model)
        self._metrics = MetricsLogger(namespace="vllm.engine")

    def add_request(self, request_id: str, num_tokens: int) -> None:
        self._scheduler.add_request(request_id, num_tokens)

    def step(self) -> list[CoreOutput]:
        decision = self._scheduler.schedule()
        self._metrics.record_scheduler(
            SchedulerStats(
                num_running=self._scheduler.num_running,
                num_waiting=self._scheduler.num_waiting,
                kv_cache_usage=self._scheduler.kv_cache_usage,
            )
        )

        if not decision.scheduled_request_ids:
            return []

        outputs: list[CoreOutput] = []
        for result in self._executor.execute(decision.scheduled_request_ids):
            self._metrics.record_generation(tokens=len(result.token_ids))
            if result.finished:
                self._scheduler.finish_request(result.request_id)
            outputs.append(
                CoreOutput(
                    request_id=result.request_id,
                    token_ids=result.token_ids,
                    finished=result.finished,
                )
            )
        return outputs

    def shutdown(self) -> None:
        self._executor.shutdown()
