"""The executor contract."""

from dataclasses import dataclass
from typing import Protocol


@dataclass
class ExecuteResult:
    """Output of one forward pass."""

    request_id: str
    token_ids: list[int]
    finished: bool


class Executor(Protocol):
    """What the engine assumes about any executor backend."""

    def execute(self, request_ids: list[str]) -> list[ExecuteResult]: ...

    def shutdown(self) -> None: ...
