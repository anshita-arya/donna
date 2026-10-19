import * as vscode from 'vscode';

/**
 * One output channel for the extension.
 *
 * Assessments run in the background without the developer asking, so when one
 * is slow, finds nothing, or fails, there has to be somewhere that says why.
 * Everything that would otherwise be a silent catch goes here.
 */
class Logger {
  private channel: vscode.OutputChannel | undefined;

  init(): vscode.OutputChannel {
    this.channel ??= vscode.window.createOutputChannel('Donna');
    return this.channel;
  }

  private write(level: string, message: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    this.channel?.appendLine(`${stamp} ${level} ${message}`);
  }

  info(message: string): void {
    this.write('INFO ', message);
  }

  warn(message: string): void {
    this.write('WARN ', message);
  }

  error(message: string, error?: unknown): void {
    const detail =
      error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
        : error !== undefined
          ? String(error)
          : '';
    this.write('ERROR', detail ? `${message} — ${detail}` : message);
  }

  /** Logs how long an operation took; assessments that get slow should be visible. */
  timing(label: string, startedAtMs: number): void {
    this.write('INFO ', `${label} took ${Date.now() - startedAtMs}ms`);
  }

  show(): void {
    this.channel?.show(true);
  }
}

export const log = new Logger();
