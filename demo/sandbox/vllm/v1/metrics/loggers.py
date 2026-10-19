"""Metric emission points.

Every emission here is something a dashboard or alert may query, which is why
removing one is treated as a change to production observability rather than as
cleanup.
"""

from vllm.v1.metrics.stats import EngineStats, SchedulerStats


class MetricsLogger:
    """Collects and emits engine metrics."""

    def __init__(self, namespace: str) -> None:
        self._namespace = namespace
        self._stats = EngineStats()

    def log_startup(self, *, served_model: str) -> None:
        print(f"[{self._namespace}] serving model={served_model}")

    def record_admission(self, *, admitted: bool) -> None:
        if admitted:
            self._stats.requests_admitted += 1
        else:
            self._stats.requests_rejected += 1

    def record_scheduler(self, stats: SchedulerStats) -> None:
        self._stats.scheduler = stats
        print(
            f"[{self._namespace}] running={stats.num_running} "
            f"waiting={stats.num_waiting} kv_usage={stats.kv_cache_usage:.2f}"
        )

    def record_generation(self, *, tokens: int) -> None:
        self._stats.tokens_generated += tokens

    @property
    def stats(self) -> EngineStats:
        return self._stats
