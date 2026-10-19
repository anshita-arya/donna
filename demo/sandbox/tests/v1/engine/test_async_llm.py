"""End-to-end engine behaviour through the async facade."""

import asyncio

import pytest

from vllm.renderers.inputs.preprocess import preprocess_prompt
from vllm.v1.engine.admission_control import AdmissionController
from vllm.v1.engine.async_llm import AsyncLLM, EngineOverloadedError


def test_generate_returns_usage_counts():
    engine = AsyncLLM("demo-7b")
    request = preprocess_prompt("hello world", model="demo-7b")
    result = asyncio.run(engine.generate(request))
    assert result.prompt_tokens == 2
    assert result.completion_tokens > 0
    assert result.finish_reason == "stop"


def test_admission_ceiling_sheds_load():
    controller = AdmissionController(max_concurrent=1)
    assert controller.try_admit() is True
    assert controller.try_admit() is False
    controller.release()
    assert controller.try_admit() is True


def test_overloaded_engine_raises():
    engine = AsyncLLM("demo-7b")
    engine._admission = AdmissionController(max_concurrent=0)
    request = preprocess_prompt("hello", model="demo-7b")
    with pytest.raises(EngineOverloadedError):
        asyncio.run(engine.generate(request))
