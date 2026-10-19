"""Counters and gauges the engine reports."""

from dataclasses import dataclass, field


@dataclass
class SchedulerStats:
    """A snapshot of scheduler state."""

    num_running: int = 0
    num_waiting: int = 0
    kv_cache_usage: float = 0.0


@dataclass
class EngineStats:
    """Cumulative engine counters."""

    requests_admitted: int = 0
    requests_rejected: int = 0
    tokens_generated: int = 0
    scheduler: SchedulerStats = field(default_factory=SchedulerStats)
