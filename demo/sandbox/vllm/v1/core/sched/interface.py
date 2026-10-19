"""The scheduler contract the engine depends on."""

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class SchedulerOutput:
    """One scheduling decision."""

    scheduled_request_ids: list[str] = field(default_factory=list)
    preempted_request_ids: list[str] = field(default_factory=list)
    num_batched_tokens: int = 0


class SchedulerInterface(Protocol):
    """What the engine is allowed to assume about a scheduler."""

    def add_request(self, request_id: str, num_tokens: int) -> None: ...

    def schedule(self) -> SchedulerOutput: ...

    def finish_request(self, request_id: str) -> None: ...
