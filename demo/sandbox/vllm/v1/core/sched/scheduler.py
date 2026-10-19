"""Continuous-batching scheduler.

Internal to the scheduler service. The engine talks to it through
``SchedulerInterface``, never by importing this module directly, so that batching
policy can change without every caller changing with it.
"""

from collections import deque

from vllm.v1.core.kv_cache_manager import KVCacheManager
from vllm.v1.core.sched.interface import SchedulerOutput

MAX_NUM_BATCHED_TOKENS = 8192
MAX_NUM_RUNNING = 256


class Scheduler:
    """Admits queued requests into the running batch as capacity allows."""

    def __init__(self, kv_cache: KVCacheManager) -> None:
        self._kv_cache = kv_cache
        self._waiting: deque[tuple[str, int]] = deque()
        self._running: dict[str, int] = {}

    def add_request(self, request_id: str, num_tokens: int) -> None:
        self._waiting.append((request_id, num_tokens))

    def schedule(self) -> SchedulerOutput:
        output = SchedulerOutput()
        budget = MAX_NUM_BATCHED_TOKENS

        # Continuous batching: every running request is re-scheduled each step
        # for one decode token, and whatever is still waiting is admitted into
        # the remaining budget.
        for request_id in self._running:
            output.scheduled_request_ids.append(request_id)
            output.num_batched_tokens += 1
            budget -= 1

        while self._waiting and len(self._running) < MAX_NUM_RUNNING:
            request_id, num_tokens = self._waiting[0]
            if num_tokens > budget or not self._kv_cache.can_allocate(num_tokens):
                break
            self._waiting.popleft()
            self._kv_cache.allocate(request_id, num_tokens)
            self._running[request_id] = num_tokens
            output.scheduled_request_ids.append(request_id)
            output.num_batched_tokens += num_tokens
            budget -= num_tokens

        return output

    def finish_request(self, request_id: str) -> None:
        self._running.pop(request_id, None)
        self._kv_cache.free(request_id)

    @property
    def num_running(self) -> int:
        return len(self._running)

    @property
    def num_waiting(self) -> int:
        return len(self._waiting)

    @property
    def kv_cache_usage(self) -> float:
        """Fraction of the KV cache currently assigned.

        Exposed here so callers outside the scheduler never have to reach for
        the cache manager themselves.
        """
        return self._kv_cache.usage
