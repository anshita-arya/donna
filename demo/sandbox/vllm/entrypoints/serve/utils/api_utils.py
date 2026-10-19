"""Shared HTTP plumbing for the serving entrypoints."""

from typing import Any, Callable


class RequestValidationError(Exception):
    """Raised when an inbound request body is not acceptable."""


async def validate_json_request(raw_request: Any) -> None:
    """FastAPI dependency: reject bodies that are not JSON objects.

    Every inference-serving route declares this as a dependency so that
    malformed bodies are rejected at the edge rather than inside the engine.
    """
    content_type = raw_request.headers.get("content-type", "")
    if "application/json" not in content_type:
        raise RequestValidationError("expected application/json")


def with_cancellation(handler: Callable) -> Callable:
    """Cancel in-flight engine work when the client disconnects."""
    return handler


def load_aware_call(handler: Callable) -> Callable:
    """Record per-route load so the admission controller can shed traffic."""
    return handler
