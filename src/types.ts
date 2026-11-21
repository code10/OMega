/**
 * Core TypeScript contracts for OMega runtime, execution seams, tool schemas, providers, and multi-modal HTTP/SSE.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SystemOneConfig } from './systemOne.js';
import type { ModelCatalogEntry } from './modelService/catalog.js';
import type { CheckpointRecord } from './agent/checkpoint.js';

export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface ToolParameterProperty {
  type: JSONSchemaType;
  description?: string;
  enum?: string[];
  items?: ToolParameterProperty | { type: JSONSchemaType; properties?: Record<string, ToolParameterProperty>; required?: string[] };
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
  default?: unknown;
}

export interface ToolParametersSchema {
  type: 'object' | string;
  properties: Record<string, ToolParameterProperty | Record<string, any> | undefined>;
  required?: string[];
}

export interface ExecutionFileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface ExecutionDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface ExecutionExecOptions {
  cwd: string;
  shell: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer?: number;
}

export interface ExecutionSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  sandbox?: SandboxConfig;
  sandboxCommand?: string[];
}

export interface ExecutionInteractiveOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell?: boolean;
}

export interface ExecutionProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated?: boolean;
  errorMessage?: string;
  sandboxBackend?: string;
}

/**
 * Unified execution seam for filesystem and process operations.
 * Swapping this backend redirects file tools, shell commands, and terminal sessions uniformly.
 */
export interface ExecutionBackend {
  readonly name: string;
  exists(targetPath: string): Promise<boolean> | boolean;
  stat(targetPath: string): Promise<ExecutionFileStat> | ExecutionFileStat;
  realpath(targetPath: string): Promise<string> | string;
  readFile(targetPath: string, encoding?: BufferEncoding): Promise<string> | string;
  writeFile(targetPath: string, content: string, encoding?: BufferEncoding): Promise<void> | void;
  mkdir(targetPath: string, options?: { recursive?: boolean }): Promise<void> | void;
  readdir(targetPath: string): Promise<ExecutionDirEntry[]> | ExecutionDirEntry[];
  rm?(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> | void;
  copyFile?(srcPath: string, destPath: string): Promise<void> | void;
  symlink?(targetPath: string, linkPath: string, type?: 'dir' | 'file' | 'junction'): Promise<void> | void;
  isSymlink?(targetPath: string): Promise<boolean> | boolean;
  unlink?(targetPath: string): Promise<void> | void;
  execSync?(executable: string, args: string[], options: { cwd: string }): string;
  exec(command: string, options: ExecutionExecOptions): Promise<ExecutionProcessResult>;
  spawn(executable: string, args: string[], options: ExecutionSpawnOptions): Promise<ExecutionProcessResult>;
  spawnInteractive?(executable: string, args: string[], options: ExecutionInteractiveOptions): ChildProcessWithoutNullStreams;
}

export interface SkillConfirmInfo {
  tool?: string;
  args?: Record<string, unknown>;
  command?: string;
  cwd?: string;
  systemOneRisk?: unknown;
}

export type ConfirmCommandHandler = (info: SkillConfirmInfo) => Promise<boolean> | boolean;

export interface SkillMemoryHandle {
  appendFact: (fact: string, category?: string) => unknown;
  readLongTermMemory: () => string;
  search: (query: string, opts?: Record<string, any>) => any[];
  indexKnowledge: (title: string, content: string) => Promise<unknown> | unknown;
  [key: string]: any;
}

export interface SkillGitHandle {
  isGitRepo: () => boolean;
  getStatus: () => Record<string, any>;
  getDiff: (baseRef?: any, file?: string) => any;
  createBranch: (branchName: string) => Record<string, any>;
  createWorktree: (worktreePath: string, branchName: string) => { worktreePath: string; branch: string };
  removeWorktree: (worktreePath: string, deleteBranch?: boolean) => unknown;
  [key: string]: any;
}

export interface SkillAgentHandle {
  sessionId?: string;
  config: OMConfig;
  confirmCommand?: ConfirmCommandHandler | null;
  git?: SkillGitHandle;
  skills: {
    list: () => SkillDefinition<any>[];
    register: (skill: SkillDefinition<any>, sourceOverride?: string) => unknown;
    [key: string]: any;
  };
  emit?: (event: string, payload?: unknown) => boolean;
  [key: string]: any;
}

export interface SkillContext {
  config?: OMConfig;
  memory?: SkillMemoryHandle;
  agent?: SkillAgentHandle;
  execution?: ExecutionBackend;
  signal?: AbortSignal;
  subagentDepth?: number;
  confirmCommand?: ConfirmCommandHandler | null;
  onStreamEvent?: (event: SSEParsedEvent) => void;
}

export interface SkillResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface SkillDefinition<TArgs = Record<string, any>> {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  type?: 'function' | 'workflow' | 'mcp';
  source?: string;
  body?: string;
  triggers?: string[];
  references?: string[];
  disableModelInvocation?: boolean;
  execute: (args: TArgs, context?: SkillContext) => Promise<SkillResult | unknown> | SkillResult | unknown;
}

export interface ChatAttachment {
  type?: 'image' | 'file' | 'audio';
  mimeType?: string;
  data?: string; // base64
  url?: string;
  path?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  attachments?: ChatAttachment[];
  provider?: string;
  model?: string;
  target?: string;
  timestamp?: string;
  rawParts?: unknown;
}

export interface SSEParsedEvent {
  event?: string;
  id?: string;
  data: string;
  json?: unknown;
  token?: string;
}

export interface HttpFileInput {
  field?: string;
  path: string;
  filename?: string;
  mimeType?: string;
}

export interface HttpImageInput {
  field?: string;
  path?: string;
  url?: string;
  base64?: string;
  filename?: string;
  mimeType?: string;
}

export interface EmbeddingConfig {
  url?: string;
  model?: string;
  apiKey?: string;
}

export interface ProviderEndpointConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface RoutingFallbackTarget {
  provider: string;
  model: string;
}

export interface RoutingConfig {
  enabled?: boolean;
  maxRetries?: number;
  autoHandoffOnContextLimit?: boolean;
  cooldownMs?: number;
  fallbackChain?: RoutingFallbackTarget[];
  maxCostUsd?: number;
  maxTotalTokens?: number;
  [key: string]: unknown;
}

export interface SandboxConfig {
  mode?: 'off' | 'auto' | 'os' | 'container';
  strict?: boolean;
  allowNetwork?: boolean;
  memoryMb?: number;
  cpus?: number;
  maxProcesses?: number;
  maxOutputBytes?: number;
  image?: string;
  [key: string]: unknown;
}

export interface SecurityConfig {
  requireConfirmationForShell?: boolean;
  requireConfirmationForTools?: string[];
  allowedCommands?: string[];
  deniedCommands?: string[];
  allowAllCommands?: boolean;
  allowExternalPaths?: boolean;
  allowSelfModification?: boolean;
  allowedPaths?: string[];
  allowedEnvVars?: string[];
  inheritSensitiveEnv?: boolean;
  commandRules?: {
    allow?: string[];
    deny?: string[];
  };
  sandboxCommand?: string[];
  sandbox?: SandboxConfig;
  [key: string]: unknown;
}

export interface GatewayAuthConfig {
  mode?: 'local' | 'multiuser';
  jwtSecret?: string;
  tokenTtlSeconds?: number;
  users?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface MCPServerConfig {
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface SelfHealConfig {
  enabled?: boolean;
  autoCommit?: boolean;
  testCommand?: string;
  maxHealAttempts?: number;
  maxSubagentSteps?: number;
  healOnToolFailure?: boolean;
  healOnUnhandledError?: boolean;
  savePatchDir?: string;
  testRunner?: (workspaceDir: string, testCommand: string) => Promise<{
    passed: boolean;
    exitCode: number;
    stdout?: string;
    stderr?: string;
    output?: string;
    durationMs?: number;
  }>;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ExecutionBackendConfig {
  type?: 'local' | 'docker' | 'ssh';
  container?: string;
  workdir?: string;
  localWorkspaceDir?: string;
  dockerBinary?: string;
  host?: string;
  port?: number;
  identityFile?: string;
  sshBinary?: string;
}

export interface OMConfig {
  rootDir: string;
  provider: string;
  model: string;
  memoryDir: string;
  skillsDir: string;
  workspaceDir: string;
  maxSteps: number;
  temperature?: number;
  effort?: ReasoningEffort;
  version?: string;
  name?: string;
  systemPrompt?: string;
  maxDailyLogLines?: number;
  maxHistoryMessages?: number;
  compactionThresholdChars?: number;
  compactionThresholdTokens?: number;
  llmCompaction?: boolean;
  worktreeIsolation?: boolean;
  embedding?: EmbeddingConfig;
  parallelToolExecution?: boolean;
  providers?: Record<string, ProviderEndpointConfig>;
  security?: SecurityConfig;
  mcpServers?: Record<string, MCPServerConfig>;
  routing: RoutingConfig;
  systemOne?: SystemOneConfig;
  selfHeal?: SelfHealConfig;
  execution?: ExecutionBackendConfig;
  gateway: {
    port: number;
    host: string;
    openBrowser: boolean;
    authToken?: string;
    corsOrigins?: string[];
    allowedOrigins?: string[];
    allowSkillCreation?: boolean;
    auth?: GatewayAuthConfig;
  };
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

export interface AgentUsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export interface AgentActivityEntry {
  id: string;
  type: string;
  timestamp: string;
  provider: string;
  model: string;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface AgentHook {
  beforeModel?: (ctx: Record<string, unknown>) => Promise<void> | void;
  afterModel?: (ctx: Record<string, unknown>) => Promise<void> | void;
  beforeTool?: (ctx: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void;
  afterTool?: (ctx: Record<string, unknown>) => Promise<void> | void;
  [key: string]: unknown;
}

export interface OMAgentOptions extends Partial<Omit<OMConfig, 'selfHeal'>> {
  reloadEnv?: boolean;
  sessionId?: string;
  providerInstance?: ProviderLike;
  executionBackend?: ExecutionBackend;
  asyncEmbedder?: (text: string) => Promise<number[]>;
  systemOneEmbedder?: (text: string) => Promise<number[]>;
  confirmCommand?: ConfirmCommandHandler | null;
  hooks?: AgentHook | AgentHook[];
  selfHeal?: boolean | SelfHealConfig;
  port?: number;
  host?: string;
}

export type ModelInfo = ModelCatalogEntry | {
  id: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  capabilities?: string[];
};

export interface ProviderConstructorOptions {
  name?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface ProviderLike {
  name: string;
  model: string;
  baseUrl?: string;
  chat(params: ProviderChatOptions): Promise<ProviderChatResult>;
  listModels?(options?: Record<string, unknown>): Promise<ModelInfo[]>;
}

export interface ProviderChatOptions {
  messages: ChatMessage[];
  tools?: SkillDefinition[];
  systemPrompt?: string;
  temperature?: number;
  effort?: ReasoningEffort;
  maxTokens?: number;
  responseFormat?: Record<string, unknown>;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface ProviderChatResult {
  content: string;
  toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  usage?: TokenUsage;
  rawParts?: unknown;
}

export interface AgentRunOptions {
  maxSteps?: number;
  temperature?: number;
  effort?: ReasoningEffort;
  attachments?: ChatAttachment[];
  signal?: AbortSignal;
  worktree?: boolean;
  subagentDepth?: number;
  selfHeal?: boolean | SelfHealConfig;
  resumeCheckpoint?: CheckpointRecord | null;
  checkpoint?: boolean;
  detached?: boolean;
  workspaceMode?: 'shared' | 'worktree';
  swarmId?: string | null;
  parentSessionId?: string | null;
  logFile?: string | null;
  stream?: boolean;
  responseFormat?: Record<string, unknown>;
  budgets?: Record<string, unknown>;
  confirmCommand?: ConfirmCommandHandler | null;
  onToken?: (token: string, step?: number) => void;
  onStreamEvent?: (event: SSEParsedEvent) => void;
  [key: string]: unknown;
}

export interface AgentRunResult {
  content: string;
  answer?: string;
  provider?: string;
  model?: string;
  target?: string;
  usage?: TokenUsage;
  steps: Array<Record<string, unknown>>;
  totalSteps?: number;
  sessionId?: string;
  runId?: string;
  aborted?: boolean;
  fallbackUsed?: boolean;
  fallbackEvents?: Array<Record<string, unknown>>;
  answers?: unknown[];
  success: boolean;
  error?: string;
  [key: string]: unknown;
}
