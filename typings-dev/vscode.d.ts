/**
 * DEV-ONLY stub of the subset of the VS Code API this extension uses.
 *
 * This file exists so the editor-facing code can be typechecked in an
 * environment without network access to install `@types/vscode`. It is NOT
 * part of the shipped build and NOT referenced by `tsconfig.json` — it is used
 * only by `tsconfig.devcheck.json`.
 *
 * On a developer machine, `npm install` brings the real `@types/vscode`, and
 * `npm run typecheck` uses that instead. If the two ever disagree, the real
 * types are correct and this file is wrong; treat a mismatch as a signal to
 * delete the stub rather than to change the extension.
 */

declare module 'vscode' {
  export interface Disposable {
    dispose(): void;
  }
  export const Disposable: {
    new (callOnDispose: () => void): Disposable;
    from(...items: { dispose(): unknown }[]): Disposable;
  };

  export interface Event<T> {
    (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]): Disposable;
  }

  export class EventEmitter<T> {
    event: Event<T>;
    fire(data: T): void;
    dispose(): void;
  }

  export class CancellationTokenSource {
    token: CancellationToken;
    cancel(): void;
    dispose(): void;
  }
  export interface CancellationToken {
    isCancellationRequested: boolean;
    onCancellationRequested: Event<unknown>;
  }

  export class Uri {
    static file(path: string): Uri;
    static parse(value: string): Uri;
    static joinPath(base: Uri, ...paths: string[]): Uri;
    readonly fsPath: string;
    readonly path: string;
    readonly scheme: string;
    toString(): string;
    with(change: { scheme?: string; path?: string; fragment?: string; query?: string }): Uri;
  }

  export class Position {
    constructor(line: number, character: number);
    readonly line: number;
    readonly character: number;
  }

  export class Range {
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
    readonly start: Position;
    readonly end: Position;
  }

  export class Selection extends Range {}

  export class ThemeIcon {
    constructor(id: string, color?: ThemeColor);
    static readonly File: ThemeIcon;
    static readonly Folder: ThemeIcon;
  }

  export class ThemeColor {
    constructor(id: string);
  }

  export class MarkdownString {
    constructor(value?: string, supportThemeIcons?: boolean);
    value: string;
    isTrusted?: boolean;
    supportHtml?: boolean;
    appendMarkdown(value: string): MarkdownString;
    appendText(value: string): MarkdownString;
    appendCodeblock(value: string, language?: string): MarkdownString;
  }

  export interface MessageOptions {
    modal?: boolean;
    detail?: string;
  }

  export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
  }

  export class TreeItem {
    constructor(label: string | TreeItemLabel, collapsibleState?: TreeItemCollapsibleState);
    label?: string | TreeItemLabel;
    id?: string;
    description?: string | boolean;
    tooltip?: string | MarkdownString;
    iconPath?: string | Uri | ThemeIcon;
    contextValue?: string;
    command?: Command;
    collapsibleState?: TreeItemCollapsibleState;
    resourceUri?: Uri;
  }

  export interface TreeItemLabel {
    label: string;
    highlights?: [number, number][];
  }

  export interface Command {
    title: string;
    command: string;
    arguments?: unknown[];
    tooltip?: string;
  }

  export interface TreeDataProvider<T> {
    onDidChangeTreeData?: Event<T | T[] | undefined | null | void>;
    getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
    getChildren(element?: T): ProviderResult<T[]>;
    getParent?(element: T): ProviderResult<T>;
  }

  export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;

  export interface TreeView<T> extends Disposable {
    message?: string;
    title?: string;
    badge?: { tooltip: string; value: number };
    reveal(element: T, options?: { select?: boolean; focus?: boolean; expand?: boolean }): Thenable<void>;
  }

  export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
  }

  export class Location {
    constructor(uri: Uri, rangeOrPosition: Range | Position);
    uri: Uri;
    range: Range;
  }

  export class DiagnosticRelatedInformation {
    constructor(location: Location, message: string);
  }

  export class Diagnostic {
    constructor(range: Range, message: string, severity?: DiagnosticSeverity);
    code?: string | number | { value: string | number; target: Uri };
    source?: string;
    relatedInformation?: DiagnosticRelatedInformation[];
    tags?: number[];
  }

  export interface DiagnosticCollection extends Disposable {
    set(uri: Uri, diagnostics: readonly Diagnostic[] | undefined): void;
    delete(uri: Uri): void;
    clear(): void;
  }

  export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
  }

  export interface StatusBarItem extends Disposable {
    text: string;
    tooltip?: string | MarkdownString;
    command?: string | Command;
    color?: string | ThemeColor;
    backgroundColor?: ThemeColor;
    show(): void;
    hide(): void;
  }

  export interface OutputChannel extends Disposable {
    appendLine(value: string): void;
    append(value: string): void;
    clear(): void;
    show(preserveFocus?: boolean): void;
  }

  export interface Memento {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
  }

  export interface SecretStorage {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
  }

  export interface ExtensionContext {
    subscriptions: { dispose(): unknown }[];
    extensionUri: Uri;
    extensionPath: string;
    workspaceState: Memento;
    globalState: Memento;
    secrets: SecretStorage;
  }

  export interface WorkspaceFolder {
    uri: Uri;
    name: string;
    index: number;
  }

  export interface WorkspaceConfiguration {
    get<T>(section: string): T | undefined;
    get<T>(section: string, defaultValue: T): T;
    update(section: string, value: unknown, target?: ConfigurationTarget): Thenable<void>;
  }

  export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
  }

  export interface FileSystemWatcher extends Disposable {
    onDidCreate: Event<Uri>;
    onDidChange: Event<Uri>;
    onDidDelete: Event<Uri>;
  }

  export interface TextDocument {
    uri: Uri;
    fileName: string;
    languageId: string;
    isDirty: boolean;
    getText(range?: Range): string;
    lineAt(line: number): { text: string; range: Range };
    lineCount: number;
  }

  export interface TextEditor {
    document: TextDocument;
    selection: Selection;
    revealRange(range: Range, revealType?: number): void;
  }

  export interface Webview {
    html: string;
    options: { enableScripts?: boolean; localResourceRoots?: Uri[] };
    cspSource: string;
    asWebviewUri(localResource: Uri): Uri;
    postMessage(message: unknown): Thenable<boolean>;
    onDidReceiveMessage: Event<any>;
  }

  export interface WebviewPanel extends Disposable {
    webview: Webview;
    title: string;
    visible: boolean;
    active: boolean;
    reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
    onDidDispose: Event<void>;
    onDidChangeViewState: Event<unknown>;
    iconPath?: Uri | { light: Uri; dark: Uri };
  }

  export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
  }

  export interface Progress<T> {
    report(value: T): void;
  }

  export enum ProgressLocation {
    SourceControl = 1,
    Window = 10,
    Notification = 15,
  }

  export interface QuickPickItem {
    label: string;
    description?: string;
    detail?: string;
    picked?: boolean;
  }

  export namespace window {
    export function showInformationMessage(
      message: string,
      ...items: string[]
    ): Thenable<string | undefined>;
    export function showInformationMessage(
      message: string,
      options: MessageOptions,
      ...items: string[]
    ): Thenable<string | undefined>;
    export function showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    export function showWarningMessage(
      message: string,
      options: MessageOptions,
      ...items: string[]
    ): Thenable<string | undefined>;
    export function showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    export function showErrorMessage(
      message: string,
      options: MessageOptions,
      ...items: string[]
    ): Thenable<string | undefined>;
    export function showTextDocument(
      document: TextDocument | Uri,
      options?: { selection?: Range; preview?: boolean; preserveFocus?: boolean },
    ): Thenable<TextEditor>;
    export function createOutputChannel(name: string): OutputChannel;
    export function createStatusBarItem(
      alignment?: StatusBarAlignment,
      priority?: number,
    ): StatusBarItem;
    export function createTreeView<T>(
      viewId: string,
      options: { treeDataProvider: TreeDataProvider<T>; showCollapseAll?: boolean },
    ): TreeView<T>;
    export function createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: ViewColumn | { viewColumn: ViewColumn; preserveFocus?: boolean },
      options?: {
        enableScripts?: boolean;
        retainContextWhenHidden?: boolean;
        localResourceRoots?: Uri[];
      },
    ): WebviewPanel;
    export function withProgress<R>(
      options: { location: ProgressLocation; title?: string; cancellable?: boolean },
      task: (
        progress: Progress<{ message?: string; increment?: number }>,
        token: CancellationToken,
      ) => Thenable<R>,
    ): Thenable<R>;
    export function showQuickPick<T extends QuickPickItem>(
      items: T[] | Thenable<T[]>,
      options?: { placeHolder?: string; canPickMany?: boolean; title?: string },
    ): Thenable<T | undefined>;
    export function showInputBox(options?: {
      prompt?: string;
      placeHolder?: string;
      password?: boolean;
      title?: string;
      value?: string;
    }): Thenable<string | undefined>;
    export const activeTextEditor: TextEditor | undefined;
    export const onDidChangeActiveTextEditor: Event<TextEditor | undefined>;
  }

  export namespace workspace {
    export const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    export function getConfiguration(section?: string): WorkspaceConfiguration;
    export function createFileSystemWatcher(
      globPattern: string,
      ignoreCreateEvents?: boolean,
      ignoreChangeEvents?: boolean,
      ignoreDeleteEvents?: boolean,
    ): FileSystemWatcher;
    export function openTextDocument(uri: Uri): Thenable<TextDocument>;
    export function openTextDocument(options: { content?: string; language?: string }): Thenable<TextDocument>;
    export function asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string;
    export const onDidSaveTextDocument: Event<TextDocument>;
    export const onDidChangeConfiguration: Event<{ affectsConfiguration(section: string): boolean }>;
    export const fs: {
      writeFile(uri: Uri, content: Uint8Array): Thenable<void>;
      readFile(uri: Uri): Thenable<Uint8Array>;
      createDirectory(uri: Uri): Thenable<void>;
      stat(uri: Uri): Thenable<{ type: number; size: number; mtime: number }>;
    };
  }

  export namespace commands {
    export function registerCommand(
      command: string,
      callback: (...args: any[]) => unknown,
      thisArg?: unknown,
    ): Disposable;
    export function executeCommand<T>(command: string, ...rest: unknown[]): Thenable<T>;
  }

  export namespace languages {
    export function createDiagnosticCollection(name?: string): DiagnosticCollection;
  }

  export namespace env {
    export const clipboard: { writeText(value: string): Thenable<void>; readText(): Thenable<string> };
    export function openExternal(target: Uri): Thenable<boolean>;
  }

  // --- Language Model API (stable since 1.90) ------------------------------

  export interface LanguageModelChatSelector {
    vendor?: string;
    family?: string;
    version?: string;
    id?: string;
  }

  export class LanguageModelChatMessage {
    static User(content: string, name?: string): LanguageModelChatMessage;
    static Assistant(content: string, name?: string): LanguageModelChatMessage;
  }

  export interface LanguageModelChatResponse {
    text: AsyncIterable<string>;
  }

  export interface LanguageModelChat {
    readonly id: string;
    readonly vendor: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    sendRequest(
      messages: LanguageModelChatMessage[],
      options?: { justification?: string; modelOptions?: Record<string, unknown> },
      token?: CancellationToken,
    ): Thenable<LanguageModelChatResponse>;
    countTokens(text: string, token?: CancellationToken): Thenable<number>;
  }

  export namespace lm {
    export function selectChatModels(
      selector?: LanguageModelChatSelector,
    ): Thenable<LanguageModelChat[]>;
  }

  export class LanguageModelError extends Error {
    readonly code: string;
  }
}
