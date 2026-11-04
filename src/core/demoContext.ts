import type { RawConfig } from './config';

export const SYNTHETIC_DEMO_CONTEXT: RawConfig = {
  _comment: 'Fictional demo context. Service names, ownership, and policies are invented.',
  contextPack: {
    name: 'Inference serving platform (synthetic demo pack)',
    synthetic: true,
    disclaimer: 'Architecture, decisions, ownership, and policy are fictional and not vLLM facts.',
  },
  services: [
    {
      name: 'api-gateway',
      description: 'Public HTTP surface. Owns the request/response contracts clients depend on.',
      match: [
        'vllm/entrypoints/openai/**',
        'vllm/entrypoints/anthropic/**',
        'vllm/entrypoints/cohere/**',
        'vllm/entrypoints/generate/**',
      ],
      dependsOn: [
        'serving-common',
        'request-validation',
        'request-render',
        'engine-core',
        'observability',
      ],
    },
    {
      name: 'serving-common',
      description: 'Shared HTTP plumbing: dependencies, cancellation, and load-aware dispatch.',
      match: ['vllm/entrypoints/serve/**'],
      dependsOn: [],
    },
    {
      name: 'request-validation',
      description: 'The validation gate before an inference request reaches the engine.',
      match: ['vllm/entrypoints/validation/**'],
      dependsOn: ['serving-common'],
    },
    {
      name: 'request-render',
      description: 'Turns caller-supplied messages and prompts into engine inputs.',
      match: ['vllm/renderers/**', 'vllm/inputs/**'],
      dependsOn: ['serving-common', 'observability'],
    },
    {
      name: 'engine-core',
      description: 'Request lifecycle, admission control, and the step loop.',
      match: ['vllm/v1/engine/**'],
      dependsOn: ['scheduler', 'executor', 'request-render', 'observability'],
    },
    {
      name: 'scheduler',
      description: 'Continuous batching, the request queue, and KV cache accounting.',
      match: ['vllm/v1/core/**'],
      dependsOn: ['observability'],
    },
    {
      name: 'executor',
      description: 'Forward-pass execution across one or many processes.',
      match: ['vllm/v1/executor/**', 'vllm/v1/worker/**'],
      dependsOn: ['observability'],
    },
    {
      name: 'observability',
      description: 'Metrics, tracing, and structured logging.',
      match: ['vllm/v1/metrics/**', 'vllm/tracing/**', 'vllm/logging_utils/**'],
      dependsOn: [],
    },
  ],
  adrDir: 'adr',
  designDocs: ['architecture-overview.md'],
  tests: {
    match: ['tests/**', '**/test_*.py', '**/*_test.py'],
    integration: ['tests/entrypoints/**', 'tests/v1/engine/**', '**/test_*_e2e.py'],
    expectations: 'test-expectations.json',
  },
  compat: [
    {
      id: 'openai-http-contract',
      surface: [
        'vllm/entrypoints/openai/**/protocol.py',
        'vllm/entrypoints/anthropic/protocol.py',
        'vllm/entrypoints/cohere/protocol.py',
      ],
      policy:
        'Request and response models under vllm/entrypoints are the published HTTP contract. Removing or renaming a field, removing a route, or adding a required request field are breaking changes for existing clients.',
      versionRegistry: ['vllm/entrypoints/openai/api_versions.py'],
      severity: 'blocker',
    },
    {
      id: 'engine-facade-contract',
      surface: ['vllm/v1/engine/async_llm.py'],
      policy:
        'AsyncLLM is the only engine entry point the serving layer may use, so its public signature is a contract across a service boundary.',
      severity: 'blocker',
    },
    {
      id: 'scheduler-interface-contract',
      surface: ['vllm/v1/core/sched/interface.py'],
      policy:
        'SchedulerInterface and SchedulerOutput are what the engine is allowed to assume about any scheduler. Changing them changes every scheduler implementation.',
      severity: 'concern',
    },
  ],
  include: ['**/*.{py,pyi}'],
  ignore: [
    '**/node_modules/**',
    '**/.git/**',
    '**/__pycache__/**',
    '**/.venv/**',
    '**/build/**',
    '**/dist/**',
    '**/*.egg-info/**',
  ],
  accepted: [],
};
