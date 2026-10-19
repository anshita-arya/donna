"""Version registry for the OpenAI-compatible HTTP contracts.

Every change to a request or response model under ``vllm/entrypoints/openai``
gets an entry here in the same change. The registry is what lets a client pin a
contract and what lets us answer "when did this field appear" without reading
git history.
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ContractVersion:
    """One published revision of one contract."""

    contract: str
    version: str
    summary: str
    breaking: bool = False
    fields_added: tuple[str, ...] = field(default_factory=tuple)
    fields_removed: tuple[str, ...] = field(default_factory=tuple)


CHAT_COMPLETION_VERSIONS: tuple[ContractVersion, ...] = (
    ContractVersion(
        contract="ChatCompletionRequest",
        version="2026-01-15",
        summary="Initial published shape.",
    ),
    ContractVersion(
        contract="ChatCompletionResponse",
        version="2026-01-15",
        summary="Initial published shape.",
    ),
    ContractVersion(
        contract="ChatCompletionRequest",
        version="2026-04-02",
        summary="Added optional reasoning_effort.",
        fields_added=("reasoning_effort",),
    ),
)

COMPLETION_VERSIONS: tuple[ContractVersion, ...] = (
    ContractVersion(
        contract="CompletionRequest",
        version="2026-01-15",
        summary="Initial published shape.",
    ),
)

CURRENT_CONTRACT_VERSION = "2026-04-02"


def latest_for(contract: str) -> ContractVersion | None:
    """Return the most recent published revision of ``contract``."""
    matches = [
        entry
        for entry in (*CHAT_COMPLETION_VERSIONS, *COMPLETION_VERSIONS)
        if entry.contract == contract
    ]
    return matches[-1] if matches else None
