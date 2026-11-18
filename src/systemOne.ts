import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cosineSimilarity } from './vectorStore.js';
import { createLogger } from './utils/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('SystemOne');

export interface HardwareProfile {
  hasCudaGpu: boolean;
  vramMb: number;
  totalRamGb: number;
}

export interface SystemOneConfig {
  enabled?: boolean;
  model?: string;
  device?: 'auto' | 'cpu' | 'cuda' | 'dml';
  dtype?: 'q8' | 'fp16' | 'fp32';
  complexityRouting?: boolean;
  riskGating?: boolean;
  riskThreshold?: number;
  toolShortlisting?: boolean;
  toolShortlistK?: number;
  selfHealTriage?: boolean;
}

export type TextEmbedder = (text: string) => Promise<number[]>;

let _hwProfilePromise: Promise<HardwareProfile> | null = null;
const _pipelineCache = new Map<string, Promise<TextEmbedder | null>>();

export async function detectHardwareProfile(): Promise<HardwareProfile> {
  if (!_hwProfilePromise) {
    _hwProfilePromise = (async () => {
      const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
      let hasCudaGpu = false;
      let vramMb = 0;
      try {
        const { stdout } = await execFileAsync(
          'nvidia-smi',
          ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
          { timeout: 1500, windowsHide: true }
        );
        const maxVram = stdout
          .split(/\r?\n/)
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
          .reduce((a, b) => Math.max(a, b), 0);
        if (maxVram > 0) {
          hasCudaGpu = true;
          vramMb = maxVram;
        }
      } catch {
        // No NVIDIA CUDA driver/GPU available
      }
      return { hasCudaGpu, vramMb, totalRamGb };
    })();
  }
  return _hwProfilePromise;
}

function softmaxScores(scores: number[], temperature = 0.08): number[] {
  if (scores.length === 0) return [];
  const scaled = scores.map((s) => s / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

const COMPLEXITY_PROTOTYPES: Record<'simple' | 'moderate' | 'complex', string> = {
  simple: 'quick lookup, greeting, status check, current time, or simple single-step question',
  moderate: 'standard single-file edit, routine shell command, list files, or normal bugfix',
  complex: 'multi-file refactor, software architecture, debugging stack traces, security audit, or error recovery',
};

const RISK_PROTOTYPES = {
  safe: 'read-only status check, local GET health check, list directory, read file, or harmless query',
  destructive: 'delete files, rm -rf, format disk, overwrite production database, POST/DELETE mutation, or exfiltrate secrets',
};

const TRIAGE_PROTOTYPES: Record<'transient_network' | 'bad_tool_args' | 'code_bug', string> = {
  transient_network: 'temporary network timeout, ECONNRESET, rate limit 429, or upstream service unavailable',
  bad_tool_args: 'ENOENT no such file or directory, invalid path, missing parameter, or bad user input',
  code_bug: 'SyntaxError, TypeError, ReferenceError, uncaught exception, or broken source implementation',
};

/**
 * OMega-native System 1 decision engine.
 *
 * Uses a lightweight, hardware-adaptive ONNX embedding pipeline (`@huggingface/transformers` +
 * `onnxruntime-node`) for sub-30ms classification, risk gating, tool shortlisting, and evals.
 */
export class OMSystemOne {
  config: Required<SystemOneConfig>;
  private _embedder: TextEmbedder | null;
  private _initPromise: Promise<TextEmbedder | null> | null;
  private _initFailed: boolean;
  private _hardwareDetector: () => Promise<HardwareProfile>;
  private _resolvedProfile: { device: 'cpu' | 'cuda' | 'dml'; model: string; dtype: 'q8' | 'fp16' | 'fp32'; hardware?: HardwareProfile } | null;
  private _vectorCache: Map<string, number[]>;

  constructor(
    config: SystemOneConfig = {},
    options: { embedder?: TextEmbedder; hardwareDetector?: () => Promise<HardwareProfile> } = {}
  ) {
    this.config = {
      enabled: config.enabled ?? false,
      model: config.model || '',
      device: config.device || 'auto',
      dtype: config.dtype || 'q8',
      complexityRouting: config.complexityRouting ?? true,
      riskGating: config.riskGating ?? true,
      riskThreshold: typeof config.riskThreshold === 'number' ? config.riskThreshold : 0.45,
      toolShortlisting: config.toolShortlisting ?? true,
      toolShortlistK: typeof config.toolShortlistK === 'number' ? config.toolShortlistK : 20,
      selfHealTriage: config.selfHealTriage ?? true,
    };
    this._embedder = options.embedder || null;
    this._initPromise = null;
    this._initFailed = false;
    this._hardwareDetector = options.hardwareDetector || detectHardwareProfile;
    this._resolvedProfile = null;
    this._vectorCache = new Map();
  }

  isConfigured(): boolean {
    return Boolean(this._embedder || this.config.enabled);
  }

  /**
   * Adapts device, precision, and model size to the host hardware once at startup.
   */
  async getResolvedProfile() {
    if (this._resolvedProfile) return this._resolvedProfile;

    if (this.config.device !== 'auto') {
      this._resolvedProfile = {
        device: this.config.device,
        model: this.config.model || 'Xenova/all-MiniLM-L6-v2',
        dtype: this.config.dtype,
      };
      return this._resolvedProfile;
    }

    const hw = await this._hardwareDetector();
    const useCuda = hw.hasCudaGpu && hw.vramMb >= 4096;
    const device: 'cpu' | 'cuda' = useCuda ? 'cuda' : 'cpu';
    const model = this.config.model || (useCuda ? 'Xenova/bge-small-en-v1.5' : 'Xenova/all-MiniLM-L6-v2');
    const dtype: 'q8' | 'fp16' = useCuda ? 'fp16' : 'q8';

    this._resolvedProfile = { device, model, dtype, hardware: hw };
    log.debug(`OMSystemOne auto profile: device=${device}, model=${model}, dtype=${dtype} (RAM=${hw.totalRamGb}GB, VRAM=${hw.vramMb}MB)`);
    return this._resolvedProfile;
  }

  async getEmbedder(): Promise<TextEmbedder | null> {
    if (this._embedder) return this._embedder;
    if (this._initFailed || !this.isConfigured()) return null;

    const profile = await this.getResolvedProfile();
    const cacheKey = `${profile.model}|${profile.device}|${profile.dtype}`;
    if (!this._initPromise) {
      let cached = _pipelineCache.get(cacheKey);
      if (!cached) {
        cached = this._loadPipeline(profile).catch((err: any) => {
          this._initFailed = true;
          _pipelineCache.delete(cacheKey);
          log.debug(`OMSystemOne initialization skipped: ${err?.message || err}`);
          return null;
        });
        _pipelineCache.set(cacheKey, cached);
      }
      this._initPromise = cached;
    }
    this._embedder = await this._initPromise;
    return this._embedder;
  }

  private async _loadPipeline(profile: { model: string; device: string; dtype: string }): Promise<TextEmbedder> {
    const transformers = await import('@huggingface/transformers');
    const extractor = await transformers.pipeline('feature-extraction', profile.model, {
      device: profile.device as any,
      dtype: profile.dtype as any,
    });
    return async (text: string): Promise<number[]> => {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data as Float32Array);
    };
  }

  private async _embedCached(text: string): Promise<number[] | null> {
    const cached = this._vectorCache.get(text);
    if (cached) return cached;
    const embed = await this.getEmbedder();
    if (!embed) return null;
    try {
      const vec = await embed(text);
      if (this._vectorCache.size > 512) this._vectorCache.clear();
      this._vectorCache.set(text, vec);
      return vec;
    } catch (err: any) {
      log.debug(`OMSystemOne embedding failed, falling back: ${err?.message || err}`);
      return null;
    }
  }

  private async _classifyByPrototypes<T extends string>(
    inputText: string,
    prototypes: Record<T, string>
  ): Promise<{ choice: T; probabilities: Record<T, number> } | null> {
    const embed = await this.getEmbedder();
    if (!embed) return null;

    try {
      const inputVec = await embed(inputText);
      const entries = Object.entries(prototypes) as Array<[T, string]>;
      const protoVecs = await Promise.all(entries.map(([, desc]) => this._embedCached(desc)));
      if (protoVecs.some((v) => !v)) return null;

      const sims = protoVecs.map((vec) => cosineSimilarity(inputVec, vec!));
      const probs = softmaxScores(sims);

      let bestIdx = 0;
      const probMap = {} as Record<T, number>;
      entries.forEach(([label], idx) => {
        probMap[label] = probs[idx];
        if (probs[idx] > probs[bestIdx]) bestIdx = idx;
      });
      return { choice: entries[bestIdx][0], probabilities: probMap };
    } catch (err: any) {
      log.debug(`OMSystemOne classification failed, falling back: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * A. Classify prompt complexity ('simple' | 'moderate' | 'complex').
   */
  async classifyComplexity(chatParams: Record<string, any> = {}): Promise<'simple' | 'moderate' | 'complex' | null> {
    if (!this.config.complexityRouting || !this.isConfigured()) return null;
    const messages = Array.isArray(chatParams.messages) ? chatParams.messages : [];
    const last = messages[messages.length - 1];
    const userMsg = [...messages].reverse().find((m) => m.role === 'user');
    const text = [
      String(userMsg?.content || ''),
      last?.role === 'tool' ? `Last tool output: ${String(last?.content || '').slice(0, 400)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const res = await this._classifyByPrototypes(text, COMPLEXITY_PROTOTYPES);
    return res ? res.choice : null;
  }

  /**
   * B. Assess whether a tool call is safe to auto-approve or requires human confirmation.
   */
  async assessToolRisk(
    toolName: string,
    args: Record<string, any> = {},
    context = ''
  ): Promise<{ safeToAutoApprove: boolean; riskScore: number; reason: string } | null> {
    if (!this.config.riskGating || !this.isConfigured()) return null;
    const input = `Tool: ${toolName}; Args: ${JSON.stringify(args || {})}; Context: ${String(context || '').slice(0, 300)}`;
    const res = await this._classifyByPrototypes(input, RISK_PROTOTYPES);
    if (!res) return null;

    const riskScore = res.probabilities.destructive;
    const safeToAutoApprove = riskScore < this.config.riskThreshold;
    return {
      safeToAutoApprove,
      riskScore,
      reason: safeToAutoApprove
        ? `SystemOne risk score ${riskScore.toFixed(3)} < ${this.config.riskThreshold}`
        : `SystemOne risk score ${riskScore.toFixed(3)} >= ${this.config.riskThreshold}`,
    };
  }

  /**
   * C. Shortlist the most relevant tools for a prompt in a single prompt forward pass.
   */
  async shortlistTools<T extends { name: string; description?: string }>(
    prompt: string,
    tools: T[],
    k = this.config.toolShortlistK
  ): Promise<T[]> {
    if (!this.config.toolShortlisting || !this.isConfigured() || !Array.isArray(tools) || tools.length <= k || k <= 0) {
      return tools;
    }
    const embed = await this.getEmbedder();
    if (!embed) return tools;

    try {
      const promptVec = await embed(String(prompt || '').slice(0, 500));
      const scored = await Promise.all(
        tools.map(async (tool) => {
          const toolVec = await this._embedCached(`${tool.name}: ${tool.description || ''}`);
          const score = toolVec ? cosineSimilarity(promptVec, toolVec) : 0;
          return { tool, score };
        })
      );
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k).map((item) => item.tool);
    } catch {
      return tools;
    }
  }

  /**
   * D1. Triage a tool failure before triggering OMSelfHealer.
   */
  async triageToolFailure(
    toolName: string,
    errorText: string,
    args: Record<string, any> = {}
  ): Promise<'transient_network' | 'bad_tool_args' | 'code_bug' | null> {
    if (!this.config.selfHealTriage || !this.isConfigured()) return null;
    const input = `Tool: ${toolName}; Args: ${JSON.stringify(args || {})}; Error: ${String(errorText || '').slice(0, 600)}`;
    const res = await this._classifyByPrototypes(input, TRIAGE_PROTOTYPES);
    return res ? res.choice : null;
  }

  /**
   * D2. Semantic assertion check for OMEvalRunner.
   */
  async evaluateAssertion(
    prompt: string,
    answer: string,
    assertion: string
  ): Promise<{ ok: boolean; score: number } | null> {
    if (!this.isConfigured()) return null;
    const input = `Question: ${String(prompt || '').slice(0, 300)}\nAnswer: ${String(answer || '').slice(0, 1000)}`;
    const res = await this._classifyByPrototypes(input, {
      passes: `Answer clearly satisfies: ${assertion}`,
      fails: `Answer fails or contradicts: ${assertion}`,
    });
    if (!res) return null;

    const score = res.probabilities.passes;
    return { ok: score >= 0.5, score };
  }
}
