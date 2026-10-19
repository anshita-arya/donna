"use strict";
/**
 * Model access, kept free of `vscode` so the agents can be driven from the
 * headless harness as well as the extension.
 *
 * Two providers:
 *  - the editor's Language Model API, which reuses whatever subscription the
 *    developer is already signed in to (see `vscodeModel.ts`);
 *  - the Anthropic API directly, for CI and for the eval harness.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicClient = exports.ModelUnavailableError = void 0;
exports.extractJson = extractJson;
exports.budget = budget;
class ModelUnavailableError extends Error {
    hint;
    constructor(message, hint) {
        super(message);
        this.hint = hint;
        this.name = 'ModelUnavailableError';
    }
}
exports.ModelUnavailableError = ModelUnavailableError;
class AnthropicClient {
    apiKey;
    model;
    baseUrl;
    provider = 'anthropic';
    constructor(apiKey, model, baseUrl = 'https://api.anthropic.com') {
        this.apiKey = apiKey;
        this.model = model;
        this.baseUrl = baseUrl;
    }
    async complete(args) {
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
            throw new ModelUnavailableError(`Anthropic API returned ${response.status}.`, body.slice(0, 400) || undefined);
        }
        const payload = (await response.json());
        if (payload.error) {
            throw new ModelUnavailableError(payload.error.message);
        }
        return (payload.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('');
    }
}
exports.AnthropicClient = AnthropicClient;
/**
 * Extracts the first JSON object or array from a model response.
 *
 * Models wrap JSON in prose or fences often enough that parsing the raw string
 * fails intermittently, and an intermittent parse failure in a review tool
 * reads to the user as the tool being broken. This scans for a balanced
 * object/array instead of trusting the response shape.
 */
function extractJson(raw) {
    const text = raw.trim();
    if (!text)
        return { ok: false, reason: 'The model returned an empty response.' };
    const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
    const candidates = [fenced?.[1], text].filter((c) => !!c);
    for (const candidate of candidates) {
        const direct = tryParse(candidate);
        if (direct.ok)
            return direct;
        const start = candidate.search(/[[{]/);
        if (start === -1)
            continue;
        const opener = candidate[start];
        const closer = opener === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < candidate.length; i++) {
            const ch = candidate[i];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (ch === '\\')
                    escaped = true;
                else if (ch === '"')
                    inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === opener)
                depth++;
            else if (ch === closer) {
                depth--;
                if (depth === 0) {
                    const slice = candidate.slice(start, i + 1);
                    const parsed = tryParse(slice);
                    if (parsed.ok)
                        return parsed;
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
function tryParse(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    }
    catch (error) {
        return { ok: false, reason: error.message };
    }
}
/** Truncates text to a character budget on a line boundary, noting what was cut. */
function budget(text, maxChars, label) {
    if (text.length <= maxChars)
        return text;
    const cut = text.slice(0, maxChars);
    const lastNewline = cut.lastIndexOf('\n');
    const body = lastNewline > maxChars * 0.5 ? cut.slice(0, lastNewline) : cut;
    const omitted = text.length - body.length;
    return `${body}\n\n[${label}: ${omitted} more characters omitted to fit the context budget]`;
}
//# sourceMappingURL=model.js.map