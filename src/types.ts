/**
 * Core TypeScript contracts for OMega runtime, tool schemas, providers, and multi-modal HTTP/SSE.
 */

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
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface SkillContext {
  config?: OMConfig;
  memory?: any;
  agent?: any;
  signal?: AbortSignal;
  subagentDepth?: number;
  confirmCommand?: (info: { tool?: string; args?: any; command?: string }) => Promise<boolean>;
  onStreamEvent?: (event: SSEParsedEvent) => void;
}

export interface SkillResult {
  success: boolean;
  error?: string;
  [key: string]: any;
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
  execute: (args: TArgs, context?: SkillContext) => Promise<SkillResult | any> | SkillResult | any;
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
  args: Record<string, any>;
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
  rawParts?: any;
}

export interface SSEParsedEvent {
  event?: string;
  id?: string;
  data: string;
  json?: any;
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

import type { LayaConfig } from './laya.js';

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

export interface OMConfig {
  rootDir: string;
  provider: string;
  model: string;
  memoryDir: string;
  skillsDir: string;
  workspaceDir: string;
  maxSteps: number;
  temperature?: number;
  version?: string;
  systemPrompt?: string;
  maxDailyLogLines?: number;
  maxHistoryMessages?: number;
  compactionThresholdChars?: number;
  compactionThresholdTokens?: number;
  llmCompaction?: boolean;
  embedding?: EmbeddingConfig;
  parallelToolExecution?: boolean;
  providers?: Record<string, any>;
  security?: Record<string, any>;
  mcpServers?: Record<string, any>;
  routing: Record<string, any>;
  laya?: LayaConfig;
  selfHeal?: SelfHealConfig;
  gateway: {
    port: number;
    host: string;
    openBrowser: boolean;
    authToken?: string;
    corsOrigins?: string[];
    allowSkillCreation?: boolean;
  };
}

export interface ProviderChatOptions {
  messages: ChatMessage[];
  tools?: SkillDefinition[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: Record<string, any>;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface ProviderChatResult {
  content: string;
  toolCalls: Array<{ id?: string; name: string; args: Record<string, any> }>;
  usage?: Record<string, any>;
  rawParts?: any;
}
