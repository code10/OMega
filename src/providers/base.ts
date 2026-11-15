import type { ProviderChatOptions, ProviderChatResult } from '../types.js';

/**
 * Base Model Provider Interface
 */
export class BaseProvider {
  name: string;
  model: string;
  baseUrl?: string;

  constructor(options: Record<string, any> = {}) {
    this.name = options.name || 'base';
    this.model = options.model || 'default';
    this.baseUrl = options.baseUrl;
  }

  async chat(_params: ProviderChatOptions): Promise<ProviderChatResult> {
    throw new Error('Provider chat() method must be implemented by subclass');
  }

  async listModels(_options: Record<string, any> = {}): Promise<any[]> {
    throw new Error(`listModels() is not implemented for provider '${this.name}'`);
  }

  async ListModels(options: Record<string, any> = {}): Promise<any[]> {
    return this.listModels(options);
  }
}
