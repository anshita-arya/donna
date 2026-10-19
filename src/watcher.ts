import * as vscode from 'vscode';

import { debounce, type Debounced } from './util/debounce';
import { log } from './util/log';

/**
 * Watches the workspace for the coding agent's writes.
 *
 * This is the thing that makes Donna *parallel* rather than a command you
 * remember to run: it is agent-agnostic by design, reacting to file writes
 * rather than hooking into any one assistant, so it works the same whether the
 * change came from Claude Code, Cursor, Copilot, a script, or the developer's
 * own hands.
 *
 * Two details that matter:
 *
 *  - **Saves are watched, not keystrokes.** `onDidChangeTextDocument` fires per
 *    character and would assess a half-typed line. Agents write whole files.
 *  - **Creates and deletes count.** An agent that adds a new module or removes
 *    one has changed the dependency graph more than any edit to an existing
 *    file, and a watcher that only sees modifications misses exactly that.
 */
export class ChangeWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private trigger: Debounced | undefined;
  private enabled = false;
  private lastTouched: string | undefined;

  constructor(private readonly onSettled: (reason: string) => void | Promise<void>) {}

  start(): void {
    this.stop();

    const config = vscode.workspace.getConfiguration('donna');
    this.enabled = config.get<boolean>('watch.enabled', true);
    const delay = Math.max(500, config.get<number>('watch.debounceMs', 2500));

    if (!this.enabled) {
      log.info('Watch mode is off.');
      return;
    }

    this.trigger = debounce(() => {
      const reason = this.lastTouched
        ? `files changed (last: ${this.lastTouched})`
        : 'files changed';
      this.lastTouched = undefined;
      return this.onSettled(reason);
    }, delay);

    // One broad watcher rather than one per language: the config decides which
    // files matter, and re-reading that on every event is cheaper than
    // rebuilding watchers when the config changes.
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const touch = (uri: vscode.Uri) => this.handle(uri);
    this.disposables.push(
      this.watcher.onDidChange(touch),
      this.watcher.onDidCreate(touch),
      this.watcher.onDidDelete(touch),
      this.watcher,
    );

    // A save from inside the editor does not always surface through the file
    // system watcher promptly, so listen for it too. The debounce collapses
    // the duplicate.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => this.handle(document.uri)),
    );

    log.info(`Watching for changes, assessing after ${delay}ms of quiet.`);
  }

  private handle(uri: vscode.Uri): void {
    if (!this.enabled || !this.trigger) return;

    const path = uri.fsPath.split(/[\\/]/).join('/');

    // Ignore our own writes and the noise that would otherwise retrigger
    // continuously: version control internals, caches, build output.
    if (
      /\/(\.git|node_modules|__pycache__|\.venv|venv|dist|build|out|out-eval|\.mypy_cache|\.pytest_cache|\.ruff_cache)\//.test(
        `${path}/`,
      ) ||
      /\.(pyc|pyo|log|tmp|swp)$/.test(path) ||
      /\/\.donna\//.test(path)
    ) {
      return;
    }

    if (!/\.(py|pyi|ts|tsx|js|jsx|mts|cts|mjs|cjs|json|md)$/.test(path)) return;

    this.lastTouched = vscode.workspace.asRelativePath(uri);
    this.trigger.trigger();
  }

  /** True while a reassessment is queued — the status bar shows this. */
  get pending(): boolean {
    return this.trigger?.pending ?? false;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  stop(): void {
    this.trigger?.dispose();
    this.trigger = undefined;
    for (const disposable of this.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // Disposal races with workspace teardown; nothing useful to do.
      }
    }
    this.watcher = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
