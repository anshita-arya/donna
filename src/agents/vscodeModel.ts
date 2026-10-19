import * as vscode from 'vscode';

import { ModelUnavailableError, type ModelClient } from './model';

/**
 * Model access through the editor's Language Model API.
 *
 * This is the default provider because it reuses whatever subscription the
 * developer is already signed in to in VS Code — no API key to manage, and no
 * second bill. The trade-off is that the first call shows a consent prompt and
 * the available models depend on what they have installed, so failures here
 * are reported with the actual reason rather than as a generic error.
 */
export class VsCodeModelClient implements ModelClient {
  readonly provider = 'vscode-lm';

  private constructor(
    private readonly chat: vscode.LanguageModelChat,
    readonly model: string,
  ) {}

  static async create(preferredFamily?: string): Promise<VsCodeModelClient> {
    if (!vscode.lm?.selectChatModels) {
      throw new ModelUnavailableError(
        'This VS Code build does not expose the Language Model API.',
        'Switch `donna.llm.provider` to "anthropic" and set an API key, or update VS Code.',
      );
    }

    let models: vscode.LanguageModelChat[] = [];
    try {
      models = await vscode.lm.selectChatModels(
        preferredFamily ? { family: preferredFamily } : undefined,
      );
    } catch (error) {
      throw new ModelUnavailableError(
        `Could not list language models: ${(error as Error).message}`,
      );
    }

    if (models.length === 0 && preferredFamily) {
      // Fall back to anything available rather than failing, but say so.
      models = await vscode.lm.selectChatModels();
      if (models.length > 0) {
        return new VsCodeModelClient(
          models[0],
          `${models[0].family} (requested "${preferredFamily}", not available)`,
        );
      }
    }

    if (models.length === 0) {
      throw new ModelUnavailableError(
        'No language model is available through VS Code.',
        'Sign in to a provider that supplies the Language Model API (for example GitHub Copilot), or switch `donna.llm.provider` to "anthropic".',
      );
    }

    return new VsCodeModelClient(models[0], models[0].family);
  }

  async complete(args: {
    system: string;
    user: string;
    maxTokens?: number;
    signal?: { isCancellationRequested: boolean };
  }): Promise<string> {
    // The Language Model API has no dedicated system role, so the instructions
    // go in as the first user message. Keeping them in a separate message
    // rather than concatenating preserves the boundary between instructions
    // and the material being reviewed.
    const messages = [
      vscode.LanguageModelChatMessage.User(args.system),
      vscode.LanguageModelChatMessage.User(args.user),
    ];

    const source = new vscode.CancellationTokenSource();
    try {
      const response = await this.chat.sendRequest(
        messages,
        {
          justification:
            'Donna is assessing the system-wide impact of your current change before you open a pull request.',
        },
        source.token,
      );

      let out = '';
      for await (const chunk of response.text) {
        if (args.signal?.isCancellationRequested) {
          source.cancel();
          break;
        }
        out += chunk;
      }
      return out;
    } catch (error) {
      const err = error as { code?: string; message?: string };
      if (err.code === 'NoPermissions' || /consent|permission/i.test(err.message ?? '')) {
        throw new ModelUnavailableError(
          'Language model access was declined.',
          'Run the review again and allow access, or switch `donna.llm.provider` to "anthropic".',
        );
      }
      if (err.code === 'Blocked' || /quota|rate/i.test(err.message ?? '')) {
        throw new ModelUnavailableError(
          'The language model request was throttled or blocked.',
          err.message,
        );
      }
      throw new ModelUnavailableError(err.message ?? 'The language model request failed.');
    } finally {
      source.dispose();
    }
  }
}
