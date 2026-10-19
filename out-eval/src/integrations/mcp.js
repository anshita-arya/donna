"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectIntegrations = connectIntegrations;
exports.collectExternalContext = collectExternalContext;
const node_crypto_1 = require("node:crypto");
const node_http_1 = require("node:http");
const client_1 = require("@modelcontextprotocol/client");
const vscode = __importStar(require("vscode"));
const tools_1 = require("./tools");
const MAX_RESULT_CHARS = 3_000;
const MAX_TOTAL_CHARS = 10_000;
function secretKey(service, name) {
    return `donna.mcp.${service}.${name}`;
}
function serviceUrl(service, ahaDomain) {
    switch (service) {
        case 'github':
            return new URL('https://api.githubcopilot.com/mcp/readonly');
        case 'atlassian':
            return new URL('https://mcp.atlassian.com/v2/mcp');
        case 'notion':
            return new URL('https://mcp.notion.com/mcp');
        case 'aha':
            if (!ahaDomain || !/^[a-z0-9][a-z0-9-]*$/i.test(ahaDomain)) {
                throw new Error('Enter the Aha! account subdomain, such as acme.');
            }
            return new URL(`https://${ahaDomain}.aha.io/api/v1/mcp`);
    }
}
class SecretOAuthProvider {
    service;
    secrets;
    redirect;
    openAuthorization;
    stateValue = (0, node_crypto_1.randomUUID)();
    constructor(service, secrets, redirect, openAuthorization) {
        this.service = service;
        this.secrets = secrets;
        this.redirect = redirect;
        this.openAuthorization = openAuthorization;
    }
    get redirectUrl() {
        return this.redirect;
    }
    get clientMetadata() {
        return {
            client_name: 'Donna Pre-PR Impact Assessment',
            redirect_uris: [this.redirect],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        };
    }
    state() {
        return this.stateValue;
    }
    async clientInformation(ctx) {
        return this.readSecret(this.issuerKey('client', ctx?.issuer));
    }
    async saveClientInformation(clientInformation, ctx) {
        await this.writeSecret(this.issuerKey('client', ctx?.issuer), clientInformation);
    }
    async tokens(ctx) {
        return this.readSecret(this.issuerKey('tokens', ctx?.issuer));
    }
    async saveTokens(tokens, ctx) {
        await this.writeSecret(this.issuerKey('tokens', ctx?.issuer), tokens);
    }
    async saveCodeVerifier(codeVerifier) {
        await this.secrets.store(secretKey(this.service, 'verifier'), codeVerifier);
    }
    async codeVerifier() {
        const verifier = await this.secrets.get(secretKey(this.service, 'verifier'));
        if (!verifier)
            throw new Error('Donna could not find the OAuth verifier. Reconnect this service.');
        return verifier;
    }
    async redirectToAuthorization(authorizationUrl) {
        await this.openAuthorization(authorizationUrl);
    }
    async discoveryState() {
        return this.readSecret(secretKey(this.service, 'discovery'));
    }
    async saveDiscoveryState(state) {
        await this.writeSecret(secretKey(this.service, 'discovery'), state);
    }
    async invalidateCredentials(scope) {
        const names = scope === 'all' ? ['client', 'tokens', 'verifier', 'discovery'] : [scope];
        await Promise.all(names.map((name) => this.secrets.delete(secretKey(this.service, name))));
    }
    issuerKey(kind, issuer) {
        const suffix = issuer ? Buffer.from(issuer).toString('base64url') : 'default';
        return secretKey(this.service, `${kind}.${suffix}`);
    }
    async readSecret(key) {
        const serialized = await this.secrets.get(key);
        if (!serialized)
            return undefined;
        try {
            return JSON.parse(serialized);
        }
        catch {
            await this.secrets.delete(key);
            return undefined;
        }
    }
    async writeSecret(key, value) {
        await this.secrets.store(key, JSON.stringify(value));
    }
}
async function startCallbackServer(service, secrets) {
    const storedRedirect = await secrets.get(secretKey(service, 'redirect'));
    const port = storedRedirect ? Number(new URL(storedRedirect).port) : 0;
    let resolveCallback;
    const callback = new Promise((resolve) => {
        resolveCallback = resolve;
    });
    const server = (0, node_http_1.createServer)((request, response) => {
        const origin = request.headers.host;
        if (origin !== `127.0.0.1:${server.address().port}`) {
            response.writeHead(400).end('Invalid OAuth callback host.');
            return;
        }
        const url = new URL(request.url ?? '/', `http://${origin}`);
        if (url.pathname !== '/oauth/callback') {
            response.writeHead(404).end('Not found.');
            return;
        }
        response
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end('<!doctype html><title>Donna connected</title><p>Donna is connected. You can return to VS Code.</p>');
        resolveCallback(url);
    });
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
    }
    catch (error) {
        if (storedRedirect) {
            await secrets.delete(secretKey(service, 'redirect'));
            await Promise.all(['client', 'tokens', 'verifier', 'discovery'].map((name) => secrets.delete(secretKey(service, name))));
            return startCallbackServer(service, secrets);
        }
        throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Could not open the OAuth callback listener.');
    const redirectUrl = `http://127.0.0.1:${address.port}/oauth/callback`;
    await secrets.store(secretKey(service, 'redirect'), redirectUrl);
    return {
        server,
        redirectUrl,
        waitForCallback: () => new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => reject(new Error('OAuth sign-in timed out.')), 180_000);
            timeoutHandle.unref();
            callback.then(resolve, reject).finally(() => clearTimeout(timeoutHandle));
        }),
    };
}
async function authorizeOAuth(service, url, secrets) {
    const callback = await startCallbackServer(service, secrets);
    const provider = new SecretOAuthProvider(service, secrets, callback.redirectUrl, async (authorizationUrl) => {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl.toString()));
        if (!opened)
            throw new Error(`Could not open the ${service} sign-in page.`);
    });
    try {
        const result = await (0, client_1.auth)(provider, { serverUrl: url });
        if (result === 'REDIRECT') {
            const response = await callback.waitForCallback();
            const returnedState = response.searchParams.get('state');
            if (!returnedState || returnedState !== provider.state()) {
                throw new Error('The OAuth response could not be verified. Try connecting again.');
            }
            const error = response.searchParams.get('error');
            if (error)
                throw new Error(`The ${service} sign-in was declined (${error}).`);
            const code = response.searchParams.get('code');
            if (!code)
                throw new Error(`The ${service} sign-in did not return an authorization code.`);
            await (0, client_1.auth)(provider, {
                serverUrl: url,
                authorizationCode: code,
                iss: response.searchParams.get('iss') ?? undefined,
            });
        }
        return provider;
    }
    finally {
        await new Promise((resolve) => callback.server.close(() => resolve()));
    }
}
function toolPriority(name, service) {
    const normalized = name.toLowerCase();
    if (service === 'notion' && normalized === 'notion-search')
        return 0;
    if (service === 'atlassian' && normalized === 'search')
        return 0;
    if (service === 'github' && normalized.includes('search_code'))
        return 0;
    if (service === 'aha' && normalized.includes('search'))
        return 0;
    return 1;
}
async function readGitHubToken(context, allowSetup) {
    const key = secretKey('github', 'token');
    let token = await context.secrets.get(key);
    if (token || !allowSetup)
        return token;
    token = await vscode.window.showInputBox({
        title: 'Connect Donna to GitHub',
        prompt: 'Enter a GitHub token with read-only repository and issue access. Donna stores it in VS Code SecretStorage.',
        password: true,
        ignoreFocusOut: true,
    });
    if (token?.trim()) {
        token = token.trim();
        await context.secrets.store(key, token);
    }
    return token || undefined;
}
async function ahaUrl(context, allowSetup) {
    let domain = context.workspaceState.get('donna.mcp.ahaDomain');
    if (!domain && allowSetup) {
        domain = await vscode.window.showInputBox({
            title: 'Connect Donna to Aha!',
            prompt: 'Enter your Aha! account subdomain, the part before .aha.io.',
            placeHolder: 'acme',
            ignoreFocusOut: true,
            validateInput: (value) => /^[a-z0-9][a-z0-9-]*$/i.test(value.trim()) ? undefined : 'Enter the subdomain only, such as acme.',
        });
        if (domain?.trim()) {
            domain = domain.trim();
            await context.workspaceState.update('donna.mcp.ahaDomain', domain);
        }
    }
    if (!domain)
        return undefined;
    return serviceUrl('aha', domain);
}
async function withClient(service, url, context, operation) {
    let authProvider;
    if (service === 'github') {
        const token = await context.secrets.get(secretKey('github', 'token'));
        if (!token)
            throw new Error('GitHub is not connected. Run "Donna: Connect Integrations".');
        authProvider = { token: async () => token };
    }
    else {
        authProvider = await authorizeOAuth(service, url, context.secrets);
    }
    const transport = new client_1.StreamableHTTPClientTransport(url, { authProvider });
    const client = new client_1.Client({ name: 'donna', version: '0.1.0' });
    try {
        await client.connect(transport);
        return await operation(client);
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
function assessmentQuery(change) {
    const paths = [...new Set(change.files.map((file) => file.path))].slice(0, 8);
    return `Related work, requirements, incidents, and design documentation for changed files: ${paths.join(', ')}`;
}
async function connectIntegrations(context) {
    const connected = [];
    const failures = [];
    for (const service of ['github', 'atlassian', 'notion', 'aha']) {
        try {
            let url;
            if (service === 'aha')
                url = await ahaUrl(context, true);
            else
                url = serviceUrl(service);
            if (!url)
                continue;
            if (service === 'github') {
                const token = await readGitHubToken(context, true);
                if (!token)
                    continue;
            }
            const count = await withClient(service, url, context, async (client) => {
                const { tools } = await client.listTools();
                return tools.filter((tool) => (0, tools_1.isReadOnlySearchTool)(tool.name, tool.description ?? '', service)).length;
            });
            connected.push(`${service} (${count} read/search tools)`);
        }
        catch (error) {
            failures.push(`${service}: ${error.message}`);
        }
    }
    return [...connected.map((item) => `Connected: ${item}`), ...failures.map((item) => `Could not connect: ${item}`)];
}
async function collectExternalContext(change, context, allowSetup) {
    const contextItems = [];
    const notes = [];
    const query = assessmentQuery(change);
    let remaining = MAX_TOTAL_CHARS;
    for (const service of ['github', 'atlassian', 'notion', 'aha']) {
        if (remaining <= 0)
            break;
        try {
            let url;
            if (service === 'aha')
                url = await ahaUrl(context, allowSetup);
            else
                url = serviceUrl(service);
            if (!url) {
                notes.push('Aha! context was skipped because no account subdomain is configured.');
                continue;
            }
            if (service === 'github' && !(await readGitHubToken(context, allowSetup))) {
                notes.push('GitHub context was skipped because no token was provided.');
                continue;
            }
            const item = await withClient(service, url, context, async (client) => {
                const { tools } = await client.listTools();
                const candidates = tools
                    .filter((tool) => (0, tools_1.isReadOnlySearchTool)(tool.name, tool.description ?? '', service))
                    .map((tool) => ({ tool, args: (0, tools_1.buildSearchArguments)(tool.inputSchema, query) }))
                    .filter((candidate) => candidate.args)
                    .sort((a, b) => toolPriority(a.tool.name, service) - toolPriority(b.tool.name, service));
                const candidate = candidates[0];
                if (!candidate)
                    return undefined;
                const result = await client.callTool({ name: candidate.tool.name, arguments: candidate.args });
                if (result.isError)
                    throw new Error(`The ${candidate.tool.name} search failed.`);
                const serialized = JSON.stringify(result.structuredContent ?? result.content);
                if (!serialized || serialized === '[]')
                    return undefined;
                const text = serialized.slice(0, Math.min(MAX_RESULT_CHARS, remaining));
                return { service, ref: `mcp:${service}:${candidate.tool.name}`, text };
            });
            if (item) {
                contextItems.push(item);
                remaining -= item.text.length;
            }
            else {
                notes.push(`${service} connected, but no compatible read-only search tool was available.`);
            }
        }
        catch (error) {
            notes.push(`${service} context was unavailable: ${error.message}`);
        }
    }
    return { context: contextItems, notes };
}
//# sourceMappingURL=mcp.js.map