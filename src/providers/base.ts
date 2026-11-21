import type {
  ModelInfo,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderConstructorOptions,
  ProviderLike
} from '../types.js';

/**
 * Base Model Provider Interface
 */
export class BaseProvider implements ProviderLike {
  name: string;
  model: string;
  baseUrl?: string;

  constructor(options: ProviderConstructorOptions = {}) {
    this.name = options.name || 'base';
    this.model = options.model || 'default';
    this.baseUrl = options.baseUrl;
  }

  async chat(_params: ProviderChatOptions): Promise<ProviderChatResult> {
    throw new Error('Provider chat() method must be implemented by subclass');
  }

  async listModels(_options: Record<string, unknown> = {}): Promise<ModelInfo[]> {
    throw new Error(`listModels() is not implemented for provider '${this.name}'`);
  }

  async ListModels(options: Record<string, unknown> = {}): Promise<ModelInfo[]> {
    return this.listModels(options);
  }
}
