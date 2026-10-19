"""Scheduler admission and preemption behaviour."""

from vllm.v1.core.kv_cache_manager import BLOCK_SIZE, KVCacheManager
from vllm.v1.core.sched.scheduler import MAX_NUM_BATCHED_TOKENS, Scheduler


def _scheduler(num_blocks: int = 64) -> Scheduler:
    return Scheduler(KVCacheManager(num_blocks))


def test_requests_are_scheduled_in_arrival_order():
    scheduler = _scheduler()
    scheduler.add_request("a", 16)
    scheduler.add_request("b", 16)
    output = scheduler.schedule()
    assert output.scheduled_request_ids == ["a", "b"]


def test_token_budget_is_respected():
    scheduler = _scheduler(num_blocks=4096)
    scheduler.add_request("big", MAX_NUM_BATCHED_TOKENS + 1)
    output = scheduler.schedule()
    assert output.scheduled_request_ids == []


def test_kv_cache_exhaustion_stops_admission():
    scheduler = _scheduler(num_blocks=1)
    scheduler.add_request("a", BLOCK_SIZE)
    scheduler.add_request("b", BLOCK_SIZE)
    output = scheduler.schedule()
    assert output.scheduled_request_ids == ["a"]
    assert scheduler.num_waiting == 1


def test_finishing_a_request_frees_its_blocks():
    scheduler = _scheduler(num_blocks=1)
    scheduler.add_request("a", BLOCK_SIZE)
    scheduler.schedule()
    scheduler.finish_request("a")
    scheduler.add_request("b", BLOCK_SIZE)
    assert scheduler.schedule().scheduled_request_ids == ["b"]
