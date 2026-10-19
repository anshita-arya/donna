"""KV cache block accounting."""

BLOCK_SIZE = 16


class KVCacheManager:
    """Hands out and reclaims KV cache blocks."""

    def __init__(self, num_blocks: int) -> None:
        self._num_blocks = num_blocks
        self._free = list(range(num_blocks))
        self._assigned: dict[str, list[int]] = {}

    def blocks_needed(self, num_tokens: int) -> int:
        return (num_tokens + BLOCK_SIZE - 1) // BLOCK_SIZE

    def can_allocate(self, num_tokens: int) -> bool:
        return self.blocks_needed(num_tokens) <= len(self._free)

    def allocate(self, request_id: str, num_tokens: int) -> list[int]:
        needed = self.blocks_needed(num_tokens)
        if needed > len(self._free):
            raise MemoryError("insufficient KV cache blocks")
        blocks = [self._free.pop() for _ in range(needed)]
        self._assigned[request_id] = blocks
        return blocks

    def free(self, request_id: str) -> None:
        for block in self._assigned.pop(request_id, []):
            self._free.append(block)

    @property
    def usage(self) -> float:
        if self._num_blocks == 0:
            return 0.0
        return 1.0 - (len(self._free) / self._num_blocks)
