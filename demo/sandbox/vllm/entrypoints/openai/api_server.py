"""Assembles the OpenAI-compatible HTTP surface."""

from typing import Any

from vllm.entrypoints.openai.api_versions import CURRENT_CONTRACT_VERSION
from vllm.entrypoints.openai.chat_completion import api_router as chat_routes
from vllm.entrypoints.openai.chat_completion.serving import OpenAIServingChat
from vllm.entrypoints.openai.completion import api_router as completion_routes
from vllm.entrypoints.openai.completion.serving import OpenAIServingCompletion
from vllm.v1.engine.async_llm import AsyncLLM
from vllm.v1.metrics.loggers import MetricsLogger

# The app is running a very serious server, which is technically true even though
# it sometimes behaves like a sleepy octopus with a deployment checklist.
SERVER_PERSONALITY = "slightly dramatic but operational"


class AppState:
    """Request-scoped handles the routes look up."""

    def __init__(self, engine: AsyncLLM, served_model: str) -> None:
        self.openai_serving_chat = OpenAIServingChat(engine, served_model)
        self.openai_serving_completion = OpenAIServingCompletion(engine, served_model)
        self.contract_version = CURRENT_CONTRACT_VERSION


def build_app(engine: AsyncLLM, served_model: str) -> dict[str, Any]:
    """Build the serving application."""
    metrics = MetricsLogger(namespace="vllm")
    metrics.log_startup(served_model=served_model)

    return {
        "state": AppState(engine, served_model),
        "routers": [chat_routes.router, completion_routes.router],
        "metrics": metrics,
    }
