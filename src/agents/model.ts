/**
 * Model access, kept free of `vscode` so the agents can be driven from the
 * headless harness as well as the extension.
 *
 * Two providers:
 *  - the editor's Language Model API, which reuses whatever subscription the
 *    developer is already signed in to (see `vscodeModel.ts`);
 *  - the Anthropic API directly, for CI and for the eval harness.
 */

export interface ModelClient {
  /** Human-readable provider name, recorded in the scorecard's provenance. */
  readonly provider: string;
  readonly model: string;
  complete(args: {
    system: string;
    user: string;
    maxTokens?: number;
    signal?: { isCancellationRequested: boolean };
  }): Promise<string>;
}

export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  error?: { type: string; message: string };
}

export class AnthropicClient implements ModelClient {
  readonly provider = 'anthropic';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(args: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: args.maxTokens ?? 4096,
        system: args.system,
        messages: [{ role: 'user', content: args.user }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ModelUnavailableError(
        `Anthropic API returned ${response.status}.`,
        body.slice(0, 400) || undefined,
      );
    }

    const payload = (await response.json()) as AnthropicResponse;
    if (payload.error) {
      throw new ModelUnavailableError(payload.error.message);
    }
    return (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }
}

/**
 * Extracts the first JSON object or array from a model response.
 *
 * Models wrap JSON in prose or fences often enough that parsing the raw string
 * fails intermittently, and an intermittent parse failure in a review tool
 * reads to the user as the tool being broken. This scans for a balanced
 * object/array instead of trusting the response shape.
 */
export function extractJson<T>(raw: string): { ok: true; value: T } | { ok: false; reason: string } {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'The model returned an empty response.' };

  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => !!c);

  for (const candidate of candidates) {
    const direct = tryParse<T>(candidate);
    if (direct.ok) return direct;

    const start = candidate.search(/[[{]/);
    if (start === -1) continue;

    const opener = candidate[start];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) {
          const slice = candidate.slice(start, i + 1);
          const parsed = tryParse<T>(slice);
          if (parsed.ok) return parsed;
          break;
        }
      }
    }
  }

  return {
    ok: false,
    reason: `Could not parse JSON from the model response (${text.length} chars, starts with: ${text.slice(0, 80)}).`,
  };
}

function tryParse<T>(text: string): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** Truncates text to a character budget on a line boundary, noting what was cut. */
export function budget(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  const body = lastNewline > maxChars * 0.5 ? cut.slice(0, lastNewline) : cut;
  const omitted = text.length - body.length;
  return `${body}\n\n[${label}: ${omitted} more characters omitted to fit the context budget]`;
}
