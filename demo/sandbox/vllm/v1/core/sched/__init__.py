"""The scheduler service's public entry point.

Callers outside the scheduler construct one through ``build_scheduler`` and
talk to it through ``SchedulerInterface``. Batching policy, the request queue
and KV cache accounting stay inside this package so they can change without
every caller changing with them.
"""

from vllm.v1.core.sched.interface import SchedulerInterface, SchedulerOutput
from vllm.v1.core.sched.scheduler import Scheduler

__all__ = ["SchedulerInterface", "SchedulerOutput", "build_scheduler"]

DEFAULT_KV_BLOCKS = 2048


def build_scheduler(num_kv_blocks: int = DEFAULT_KV_BLOCKS) -> Scheduler:
    """Construct a scheduler that owns its own KV cache accounting."""
    from vllm.v1.core.kv_cache_manager import KVCacheManager

    return Scheduler(KVCacheManager(num_kv_blocks))
