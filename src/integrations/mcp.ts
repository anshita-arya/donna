import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientInformationContext,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import * as vscode from 'vscode';

import type { ChangeSet } from '../core/types';
import { buildSearchArguments, isReadOnlySearchTool } from './tools';

export type IntegrationId = 'github' | 'atlassian' | 'notion' | 'aha';

export interface ExternalContext {
  service: IntegrationId;
  ref: string;
  text: string;
}

export interface IntegrationResult {
  context: ExternalContext[];
  notes: string[];
}

const MAX_RESULT_CHARS = 3_000;
const MAX_TOTAL_CHARS = 10_000;

function secretKey(service: IntegrationId, name: string): string {
  return `donna.mcp.${service}.${name}`;
}

function serviceUrl(
  service: IntegrationId,
  ahaDomain?: string,
): URL {
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

class SecretOAuthProvider implements OAuthClientProvider {
  private readonly stateValue = randomUUID();

  constructor(
    private readonly service: IntegrationId,
    private readonly secrets: vscode.SecretStorage,
    private readonly redirect: string,
    private readonly openAuthorization: (url: URL) => Promise<void>,
  ) {}

  get redirectUrl(): string {
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

  state(): string {
    return this.stateValue;
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    return this.readSecret<StoredOAuthClientInformation>(
      this.issuerKey('client', ctx?.issuer),
    );
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.writeSecret(this.issuerKey('client', ctx?.issuer), clientInformation);
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    return this.readSecret<StoredOAuthTokens>(this.issuerKey('tokens', ctx?.issuer));
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.writeSecret(this.issuerKey('tokens', ctx?.issuer), tokens);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.secrets.store(secretKey(this.service, 'verifier'), codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.secrets.get(secretKey(this.service, 'verifier'));
    if (!verifier) throw new Error('Donna could not find the OAuth verifier. Reconnect this service.');
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.openAuthorization(authorizationUrl);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.readSecret<OAuthDiscoveryState>(secretKey(this.service, 'discovery'));
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.writeSecret(secretKey(this.service, 'discovery'), state);
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const names = scope === 'all' ? ['client', 'tokens', 'verifier', 'discovery'] : [scope];
    await Promise.all(names.map((name) => this.secrets.delete(secretKey(this.service, name))));
  }

  private issuerKey(kind: string, issuer?: string): string {
    const suffix = issuer ? Buffer.from(issuer).toString('base64url') : 'default';
    return secretKey(this.service, `${kind}.${suffix}`);
  }

  private async readSecret<T>(key: string): Promise<T | undefined> {
    const serialized = await this.secrets.get(key);
    if (!serialized) return undefined;
    try {
      return JSON.parse(serialized) as T;
    } catch {
      await this.secrets.delete(key);
      return undefined;
    }
  }

  private async writeSecret(key: string, value: unknown): Promise<void> {
    await this.secrets.store(key, JSON.stringify(value));
  }
}

interface CallbackServer {
  server: Server;
  redirectUrl: string;
  waitForCallback(): Promise<URL>;
}

async function startCallbackServer(
  service: IntegrationId,
  secrets: vscode.SecretStorage,
): Promise<CallbackServer> {
  const storedRedirect = await secrets.get(secretKey(service, 'redirect'));
  const port = storedRedirect ? Number(new URL(storedRedirect).port) : 0;
  let resolveCallback!: (url: URL) => void;
  const callback = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });

  const server = createServer((request, response) => {
    const origin = request.headers.host;
    if (origin !== `127.0.0.1:${(server.address() as { port: number }).port}`) {
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
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (storedRedirect) {
      await secrets.delete(secretKey(service, 'redirect'));
      await Promise.all(
        ['client', 'tokens', 'verifier', 'discovery'].map((name) =>
          secrets.delete(secretKey(service, name)),
        ),
      );
      return startCallbackServer(service, secrets);
    }
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not open the OAuth callback listener.');
  const redirectUrl = `http://127.0.0.1:${address.port}/oauth/callback`;
  await secrets.store(secretKey(service, 'redirect'), redirectUrl);

  return {
    server,
    redirectUrl,
    waitForCallback: () =>
      new Promise<URL>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => reject(new Error('OAuth sign-in timed out.')), 180_000);
        timeoutHandle.unref();
        callback.then(resolve, reject).finally(() => clearTimeout(timeoutHandle));
      }),
  };
}

async function authorizeOAuth(
  service: IntegrationId,
  url: URL,
  secrets: vscode.SecretStorage,
): Promise<SecretOAuthProvider> {
  const callback = await startCallbackServer(service, secrets);
  const provider = new SecretOAuthProvider(
    service,
    secrets,
    callback.redirectUrl,
    async (authorizationUrl) => {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl.toString()));
      if (!opened) throw new Error(`Could not open the ${service} sign-in page.`);
    },
  );

  try {
    const result = await auth(provider, { serverUrl: url });
    if (result === 'REDIRECT') {
      const response = await callback.waitForCallback();
      const returnedState = response.searchParams.get('state');
      if (!returnedState || returnedState !== provider.state()) {
        throw new Error('The OAuth response could not be verified. Try connecting again.');
      }
      const error = response.searchParams.get('error');
      if (error) throw new Error(`The ${service} sign-in was declined (${error}).`);
      const code = response.searchParams.get('code');
      if (!code) throw new Error(`The ${service} sign-in did not return an authorization code.`);
      await auth(provider, {
        serverUrl: url,
        authorizationCode: code,
        iss: response.searchParams.get('iss') ?? undefined,
      });
    }
    return provider;
  } finally {
    await new Promise<void>((resolve) => callback.server.close(() => resolve()));
  }
}

function toolPriority(name: string, service: IntegrationId): number {
  const normalized = name.toLowerCase();
  if (service === 'notion' && normalized === 'notion-search') return 0;
  if (service === 'atlassian' && normalized === 'search') return 0;
  if (service === 'github' && normalized.includes('search_code')) return 0;
  if (service === 'aha' && normalized.includes('search')) return 0;
  return 1;
}

async function readGitHubToken(
  context: vscode.ExtensionContext,
  allowSetup: boolean,
): Promise<string | undefined> {
  const key = secretKey('github', 'token');
  let token = await context.secrets.get(key);
  if (token || !allowSetup) return token;

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

async function ahaUrl(
  context: vscode.ExtensionContext,
  allowSetup: boolean,
): Promise<URL | undefined> {
  let domain = context.workspaceState.get<string>('donna.mcp.ahaDomain');
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
  if (!domain) return undefined;
  return serviceUrl('aha', domain);
}

async function withClient<T>(
  service: IntegrationId,
  url: URL,
  context: vscode.ExtensionContext,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  let authProvider: OAuthClientProvider | { token: () => Promise<string | undefined> };
  if (service === 'github') {
    const token = await context.secrets.get(secretKey('github', 'token'));
    if (!token) throw new Error('GitHub is not connected. Run "Donna: Connect Integrations".');
    authProvider = { token: async () => token };
  } else {
    authProvider = await authorizeOAuth(service, url, context.secrets);
  }

  const transport = new StreamableHTTPClientTransport(url, { authProvider });
  const client = new Client({ name: 'donna', version: '0.1.0' });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function assessmentQuery(change: ChangeSet): string {
  const paths = [...new Set(change.files.map((file) => file.path))].slice(0, 8);
  return `Related work, requirements, incidents, and design documentation for changed files: ${paths.join(', ')}`;
}

export async function connectIntegrations(context: vscode.ExtensionContext): Promise<string[]> {
  const connected: string[] = [];
  const failures: string[] = [];

  for (const service of ['github', 'atlassian', 'notion', 'aha'] as IntegrationId[]) {
    try {
      let url: URL | undefined;
      if (service === 'aha') url = await ahaUrl(context, true);
      else url = serviceUrl(service);
      if (!url) continue;

      if (service === 'github') {
        const token = await readGitHubToken(context, true);
        if (!token) continue;
      }

      const count = await withClient(service, url, context, async (client) => {
        const { tools } = await client.listTools();
        return tools.filter((tool) => isReadOnlySearchTool(tool.name, tool.description ?? '', service)).length;
      });
      connected.push(`${service} (${count} read/search tools)`);
    } catch (error) {
      failures.push(`${service}: ${(error as Error).message}`);
    }
  }

  return [...connected.map((item) => `Connected: ${item}`), ...failures.map((item) => `Could not connect: ${item}`)];
}

export async function collectExternalContext(
  change: ChangeSet,
  context: vscode.ExtensionContext,
  allowSetup: boolean,
): Promise<IntegrationResult> {
  const contextItems: ExternalContext[] = [];
  const notes: string[] = [];
  const query = assessmentQuery(change);
  let remaining = MAX_TOTAL_CHARS;

  for (const service of ['github', 'atlassian', 'notion', 'aha'] as IntegrationId[]) {
    if (remaining <= 0) break;
    try {
      let url: URL | undefined;
      if (service === 'aha') url = await ahaUrl(context, allowSetup);
      else url = serviceUrl(service);
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
          .filter((tool) => isReadOnlySearchTool(tool.name, tool.description ?? '', service))
          .map((tool) => ({ tool, args: buildSearchArguments(tool.inputSchema, query) }))
          .filter((candidate) => candidate.args)
          .sort((a, b) => toolPriority(a.tool.name, service) - toolPriority(b.tool.name, service));
        const candidate = candidates[0];
        if (!candidate) return undefined;

        const result = await client.callTool({ name: candidate.tool.name, arguments: candidate.args });
        if (result.isError) throw new Error(`The ${candidate.tool.name} search failed.`);
        const serialized = JSON.stringify(result.structuredContent ?? result.content);
        if (!serialized || serialized === '[]') return undefined;
        const text = serialized.slice(0, Math.min(MAX_RESULT_CHARS, remaining));
        return { service, ref: `mcp:${service}:${candidate.tool.name}`, text } satisfies ExternalContext;
      });

      if (item) {
        contextItems.push(item);
        remaining -= item.text.length;
      } else {
        notes.push(`${service} connected, but no compatible read-only search tool was available.`);
      }
    } catch (error) {
      notes.push(`${service} context was unavailable: ${(error as Error).message}`);
    }
  }

  return { context: contextItems, notes };
}