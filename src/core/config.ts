import type { CompatRule, DonnaConfig, ServiceSpec } from './types';

export const WORKSPACE_CONTEXT_KEY = 'donna.analysisContext';

export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/*.egg-info/**',
  '**/site-packages/**',
];

export const DEFAULT_TEST_MATCH = [
  'tests/**',
  'test/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/*.{test,spec}.{ts,tsx,js,jsx}',
];

export const WORKSPACE_CONTEXT_TEMPLATE: RawConfig = {
  _comment: 'Donna stores this context in VS Code workspace storage, not in the repository.',
  services: [],
  adrDir: 'docs/adr',
  designDocs: [],
  tests: {
    match: DEFAULT_TEST_MATCH,
    integration: ['tests/**/integration/**', '**/test_*_e2e.py'],
    expectations: null,
  },
  compat: [],
};

/** User-defined assessment context, stored in VS Code workspace storage. */
export interface RawConfig {
  _comment?: string;
  contextDirectory?: string;
  services?: ServiceSpec[];
  adrDir?: string | null;
  designDocs?: string[];
  tests?: {
    match?: string[];
    integration?: string[];
    expectations?: string | null;
  };
  compat?: CompatRule[];
  include?: string[];
  ignore?: string[];
  accepted?: string[];
  contextPack?: { name: string; synthetic: boolean; disclaimer?: string } | null;
}

export function resolveConfig(raw: RawConfig | undefined, repoRoot: string): DonnaConfig {
  return {
    repoRoot,
    services: raw?.services ?? [],
    adrDir: raw?.adrDir !== undefined ? raw.adrDir : 'docs/adr',
    designDocs: raw?.designDocs ?? [],
    tests: {
      match: raw?.tests?.match ?? DEFAULT_TEST_MATCH,
      integration: raw?.tests?.integration ?? ['tests/**/integration/**', '**/test_*_e2e.py'],
      expectations: raw?.tests?.expectations ?? null,
    },
    compat: raw?.compat ?? [],
    include: raw?.include ?? ['**/*.{py,pyi,ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
    ignore: raw?.ignore ?? DEFAULT_IGNORE,
    accepted: raw?.accepted ?? [],
    contextPack: raw?.contextPack ?? null,
  };
}

export function parseRawConfig(text: string): RawConfig {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Context settings must be a JSON object.');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw._comment !== undefined && typeof raw._comment !== 'string') {
    throw new Error('_comment must be a string.');
  }
  const allowedFields = new Set([
    '_comment',
    'contextDirectory',
    'contextPack',
    'services',
    'adrDir',
    'designDocs',
    'tests',
    'compat',
    'include',
    'ignore',
    'accepted',
  ]);
  const unknownFields = Object.keys(raw).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) {
    throw new Error(`Unsupported context setting${unknownFields.length === 1 ? '' : 's'}: ${unknownFields.join(', ')}.`);
  }

  const stringArray = (value: unknown, name: string): void => {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
      throw new Error(`${name} must be an array of strings.`);
    }
  };
  const optionalString = (value: unknown, name: string): void => {
    if (value !== undefined && typeof value !== 'string' && value !== null) {
      throw new Error(`${name} must be a string or null.`);
    }
  };

  if (raw.contextDirectory !== undefined && typeof raw.contextDirectory !== 'string') {
    throw new Error('contextDirectory must be a string.');
  }
  optionalString(raw.adrDir, 'adrDir');
  stringArray(raw.designDocs, 'designDocs');
  stringArray(raw.include, 'include');
  stringArray(raw.ignore, 'ignore');
  stringArray(raw.accepted, 'accepted');

  if (raw.services !== undefined) {
    if (!Array.isArray(raw.services)) throw new Error('services must be an array.');
    for (const [index, item] of raw.services.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`services[${index}] must be an object.`);
      }
      const service = item as Record<string, unknown>;
      if (typeof service.name !== 'string') throw new Error(`services[${index}].name must be a string.`);
      if ('owners' in service) {
        throw new Error(`services[${index}].owners is no longer supported; define ownership in CODEOWNERS.`);
      }
      if (!Array.isArray(service.match) || service.match.length === 0) {
        throw new Error(`services[${index}].match must be a non-empty array of strings.`);
      }
      stringArray(service.match, `services[${index}].match`);
      stringArray(service.dependsOn, `services[${index}].dependsOn`);
      if (service.description !== undefined && typeof service.description !== 'string') {
        throw new Error(`services[${index}].description must be a string.`);
      }
    }
  }

  if (raw.tests !== undefined) {
    if (!raw.tests || typeof raw.tests !== 'object' || Array.isArray(raw.tests)) {
      throw new Error('tests must be an object.');
    }
    const tests = raw.tests as Record<string, unknown>;
    stringArray(tests.match, 'tests.match');
    stringArray(tests.integration, 'tests.integration');
    optionalString(tests.expectations, 'tests.expectations');
  }

  if (raw.compat !== undefined) {
    if (!Array.isArray(raw.compat)) throw new Error('compat must be an array.');
    for (const [index, item] of raw.compat.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`compat[${index}] must be an object.`);
      }
      const rule = item as Record<string, unknown>;
      if (typeof rule.id !== 'string' || typeof rule.policy !== 'string') {
        throw new Error(`compat[${index}] requires string id and policy fields.`);
      }
      if (!Array.isArray(rule.surface) || rule.surface.length === 0) {
        throw new Error(`compat[${index}].surface must be a non-empty array of strings.`);
      }
      stringArray(rule.surface, `compat[${index}].surface`);
      stringArray(rule.versionRegistry, `compat[${index}].versionRegistry`);
      if (rule.severity !== 'blocker' && rule.severity !== 'concern') {
        throw new Error(`compat[${index}].severity must be "blocker" or "concern".`);
      }
    }
  }

  if (raw.contextPack !== undefined && raw.contextPack !== null) {
    const pack = raw.contextPack;
    if (typeof pack !== 'object' || Array.isArray(pack)) {
      throw new Error('contextPack must be an object or null.');
    }
    const value = pack as Record<string, unknown>;
    if (typeof value.name !== 'string' || typeof value.synthetic !== 'boolean') {
      throw new Error('contextPack requires a string name and boolean synthetic flag.');
    }
    if (value.disclaimer !== undefined && typeof value.disclaimer !== 'string') {
      throw new Error('contextPack.disclaimer must be a string.');
    }
  }

  return raw as RawConfig;
}

/**
 * What the agent cannot do, rendered verbatim in the scorecard.
 *
 * This is kept in code rather than in docs because it is load-bearing: the
 * guardrail module asserts against this same list, and the panel shows it so a
 * reader never has to infer the agent's authority from its tone.
 */
export const AGENT_LIMITS: string[] = [
  'Does not modify code. Every suggested change is a proposal for you to review.',
  'Does not create, edit or supersede architecture decision records or design docs.',
  'Does not assign or change ownership. Owners shown are read from CODEOWNERS and ADRs.',
  'Does not approve, open, or merge a pull request, and does not deploy.',
  'Does not override required tests or review policy.',
  'Escalates to human design review instead of resolving a design conflict itself.',
];
