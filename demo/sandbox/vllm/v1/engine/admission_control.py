"""Admission control for the engine.

Decides whether a request is accepted into the engine at all. This is a load
decision, not a correctness decision — request *shape* is settled at the edge by
the validation gate before anything reaches here.
"""

MAX_CONCURRENT_REQUESTS = 512


class AdmissionController:
    """Tracks in-flight requests and sheds load past the ceiling."""

    def __init__(self, max_concurrent: int = MAX_CONCURRENT_REQUESTS) -> None:
        self._max_concurrent = max_concurrent
        self._in_flight = 0

    def try_admit(self) -> bool:
        if self._in_flight >= self._max_concurrent:
            return False
        self._in_flight += 1
        return True

    def release(self) -> None:
        self._in_flight = max(0, self._in_flight - 1)

    @property
    def in_flight(self) -> int:
        return self._in_flight
