import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './utils/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('Laya');
const _routerCache = new Map<string, Promise<LayaPredictor | null>>();
let _hwProfilePromise: Promise<HardwareProfile> | null = null;

export interface HardwareProfile {
  hasCudaGpu: boolean;
  vramMb: number;
  totalRamGb: number;
}

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

export interface LayaConfig {
  enabled?: boolean;
  modelDir?: string;
  multilingualModelDir?: string;
  device?: 'auto' | 'cpu' | 'cuda';
  complexityRouting?: boolean;
  riskGating?: boolean;
  riskThreshold?: number;
  toolShortlisting?: boolean;
  toolShortlistK?: number;
  selfHealTriage?: boolean;
}

export interface LayaPredictor {
  predict(state: unknown, questions: Record<string, any>, options?: Record<string, any>): Promise<{ answers: Record<string, any> }>;
}

/**
 * Lightweight System 1 decision engine wrapper powered by `laya-ts`.
 *
 * Gracefully degrades to `null` / pass-through when disabled, when no local ONNX
 * checkpoint exists yet, or when `onnxruntime-node` is unavailable.
 */
export class LayaEngine {
  config: Required<LayaConfig>;
  private _predictor: LayaPredictor | null;
  private _initPromise: Promise<LayaPredictor | null> | null;
  private _initFailed: boolean;
  private _explicitToolShortlisting: boolean;
  private _hardwareDetector: () => Promise<HardwareProfile>;
  private _resolvedProfile: { device: 'cpu' | 'cuda'; toolShortlisting: boolean; loadMultilingual: boolean; hardware?: HardwareProfile } | null;

  constructor(
    config: LayaConfig = {},
    options: { predictor?: LayaPredictor; hardwareDetector?: () => Promise<HardwareProfile> } = {}
  ) {
    this._explicitToolShortlisting = typeof config.toolShortlisting === 'boolean';
    this.config = {
      enabled: config.enabled ?? false,
      modelDir: config.modelDir || './models/laya',
      multilingualModelDir: config.multilingualModelDir || '',
      device: config.device || 'auto',
      complexityRouting: config.complexityRouting ?? true,
      riskGating: config.riskGating ?? true,
      riskThreshold: typeof config.riskThreshold === 'number' ? config.riskThreshold : 0.15,
      toolShortlisting: config.toolShortlisting ?? true,
      toolShortlistK: typeof config.toolShortlistK === 'number' ? config.toolShortlistK : 20,
      selfHealTriage: config.selfHealTriage ?? true,
    };
    this._predictor = options.predictor || null;
    this._initPromise = null;
    this._initFailed = false;
    this._hardwareDetector = options.hardwareDetector || detectHardwareProfile;
    this._resolvedProfile = null;
  }

  /**
   * Resolves effective device ('cpu' | 'cuda'), toolShortlisting, and multilingual loading
   * once per engine instance when `device` is `'auto'`.
   */
  async getResolvedProfile() {
    if (this._resolvedProfile) return this._resolvedProfile;
    if (this.config.device !== 'auto') {
      this._resolvedProfile = {
        device: this.config.device,
        toolShortlisting: this.config.toolShortlisting,
        loadMultilingual: Boolean(this.config.multilingualModelDir),
      };
      return this._resolvedProfile;
    }

    const hw = await this._hardwareDetector();
    const useCuda = hw.hasCudaGpu && hw.vramMb >= 4096;
    const device: 'cpu' | 'cuda' = useCuda ? 'cuda' : 'cpu';
    const toolShortlisting = this._explicitToolShortlisting ? this.config.toolShortlisting : useCuda;
    const loadMultilingual = Boolean(this.config.multilingualModelDir) && (useCuda || hw.totalRamGb >= 10);

    this.config.toolShortlisting = toolShortlisting;
    this._resolvedProfile = { device, toolShortlisting, loadMultilingual, hardware: hw };
    log.debug(`Laya auto profile: device=${device}, toolShortlisting=${toolShortlisting}, loadMultilingual=${loadMultilingual} (RAM=${hw.totalRamGb}GB, VRAM=${hw.vramMb}MB)`);
    return this._resolvedProfile;
  }

  /**
   * Returns true if Laya is enabled and either has an injected predictor or a valid ONNX model directory.
   */
  isConfigured(): boolean {
    if (this._predictor) return true;
    if (!this.config.enabled) return false;
    const encPath = path.join(path.resolve(this.config.modelDir), 'encoder.onnx');
    return fs.existsSync(encPath);
  }

  async getPredictor(): Promise<LayaPredictor | null> {
    if (this._predictor) return this._predictor;
    if (this._initFailed || !this.isConfigured()) return null;
    const profile = await this.getResolvedProfile();
    const cacheKey = `${path.resolve(this.config.modelDir)}|${profile.loadMultilingual && this.config.multilingualModelDir ? path.resolve(this.config.multilingualModelDir) : ''}|${profile.device}`;
    if (!this._initPromise) {
      let cached = _routerCache.get(cacheKey);
      if (!cached) {
        cached = this._loadRouter(profile).catch((err: any) => {
          this._initFailed = true;
          _routerCache.delete(cacheKey);
          log.debug(`Laya ONNX initialization skipped: ${err?.message || err}`);
          return null;
        });
        _routerCache.set(cacheKey, cached);
      }
      this._initPromise = cached;
    }
    this._predictor = await this._initPromise;
    return this._predictor;
  }

  private async _loadRouter(profile: { device: 'cpu' | 'cuda'; loadMultilingual: boolean }): Promise<LayaPredictor> {
    const laya = await import('laya-ts');
    const enDir = path.resolve(this.config.modelDir);
    const enAgent = await laya.Agent.load(enDir, { device: profile.device });

    const router = new laya.Router({ default: 'english' });
    router.attach('english', enAgent);

    if (profile.loadMultilingual && this.config.multilingualModelDir) {
      const mlDir = path.resolve(this.config.multilingualModelDir);
      if (fs.existsSync(path.join(mlDir, 'encoder.onnx'))) {
        const mlAgent = await laya.Agent.load(mlDir, { device: profile.device });
        router.attach('multilingual', mlAgent);
      }
    }

    return router;
  }

  /**
   * A. Classify prompt complexity ('simple' | 'moderate' | 'complex').
   */
  async classifyComplexity(chatParams: Record<string, any> = {}): Promise<'simple' | 'moderate' | 'complex' | null> {
    if (!this.config.complexityRouting) return null;
    const predictor = await this.getPredictor();
    if (!predictor) return null;

    const messages = Array.isArray(chatParams.messages) ? chatParams.messages : [];
    const last = messages[messages.length - 1];
    const userMsg = [...messages].reverse().find((m) => m.role === 'user');
    const state = {
      prompt: String(userMsg?.content || ''),
      lastRole: String(last?.role || ''),
      lastMessagePreview: last?.role === 'tool' ? String(last?.content || '').slice(0, 600) : '',
      turnCount: messages.length,
    };

    const out = await predictor.predict(state, {
      complexity: {
        type: 'choice',
        instructions: 'How much reasoning does this engineering task require?',
        criteria: {
          simple: 'quick lookup, status check, greeting, or single-step Q&A',
          moderate: 'standard single-file edit, routine command, or normal bugfix',
          complex: 'multi-file refactor, architecture, debugging stack traces, security audit, or error recovery',
        },
      },
    });

    const choice = out?.answers?.complexity?.choice;
    if (choice === 'simple' || choice === 'moderate' || choice === 'complex') {
      return choice;
    }
    return null;
  }

  /**
   * B. Assess whether a tool call is safe to auto-approve or requires human confirmation.
   */
  async assessToolRisk(
    toolName: string,
    args: Record<string, any> = {},
    context = ''
  ): Promise<{ safeToAutoApprove: boolean; riskScore: number; reason: string } | null> {
    if (!this.config.riskGating) return null;
    const predictor = await this.getPredictor();
    if (!predictor) return null;

    const out = await predictor.predict(
      { tool: toolName, args, userContext: String(context || '').slice(0, 400) },
      {
        is_destructive: {
          type: 'noul',
          instructions: 'Could this tool call modify, delete, overwrite data, or send sensitive information externally?',
        },
      }
    );

    const riskScore = Number(out?.answers?.is_destructive?.noul ?? 1);
    const safeToAutoApprove = Number.isFinite(riskScore) && riskScore < this.config.riskThreshold;
    return {
      safeToAutoApprove,
      riskScore,
      reason: safeToAutoApprove
        ? `Laya risk score ${riskScore.toFixed(3)} < ${this.config.riskThreshold}`
        : `Laya risk score ${riskScore.toFixed(3)} >= ${this.config.riskThreshold}`,
    };
  }

  /**
   * C. Shortlist the most relevant tools for a prompt when the tool list exceeds `k`.
   */
  async shortlistTools<T extends { name: string; description?: string }>(
    prompt: string,
    tools: T[],
    k = this.config.toolShortlistK
  ): Promise<T[]> {
    if (!this.config.toolShortlisting || !Array.isArray(tools) || tools.length <= k || k <= 0) {
      return tools;
    }
    const predictor = await this.getPredictor();
    if (!predictor) return tools;

    // Score each tool's relevance in batches via noul or choice; keep top-k.
    const scored = await Promise.all(
      tools.map(async (tool) => {
        try {
          const out = await predictor.predict(
            { prompt: String(prompt || '').slice(0, 500), tool: tool.name, description: tool.description || '' },
            {
              relevant: {
                type: 'noul',
                instructions: 'Is this tool likely needed to complete the user request?',
              },
            }
          );
          return { tool, score: Number(out?.answers?.relevant?.noul ?? 0.5) };
        } catch {
          return { tool, score: 0.5 };
        }
      })
    );

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((item) => item.tool);
  }

  /**
   * D1. Triage a tool failure before triggering OMSelfHealer.
   */
  async triageToolFailure(
    toolName: string,
    errorText: string,
    args: Record<string, any> = {}
  ): Promise<'transient_network' | 'bad_tool_args' | 'code_bug' | null> {
    if (!this.config.selfHealTriage) return null;
    const predictor = await this.getPredictor();
    if (!predictor) return null;

    const out = await predictor.predict(
      { tool: toolName, args, error: String(errorText || '').slice(0, 800) },
      {
        cause: {
          type: 'choice',
          instructions: 'What is the most likely root cause of this tool failure?',
          criteria: {
            transient_network: 'temporary timeout, rate limit, or network connection error',
            bad_tool_args: 'invalid arguments, missing file path, or bad user input',
            code_bug: 'syntax error, TypeError, ReferenceError, or broken implementation code',
          },
        },
      }
    );

    const choice = out?.answers?.cause?.choice;
    if (choice === 'transient_network' || choice === 'bad_tool_args' || choice === 'code_bug') {
      return choice;
    }
    return null;
  }

  /**
   * D2. Semantic assertion check for OMEvalRunner.
   */
  async evaluateAssertion(
    prompt: string,
    answer: string,
    assertion: string
  ): Promise<{ ok: boolean; score: number } | null> {
    const predictor = await this.getPredictor();
    if (!predictor) return null;

    const out = await predictor.predict(
      {
        prompt: String(prompt || '').slice(0, 500),
        answer: String(answer || '').slice(0, 1500),
        criterion: assertion,
      },
      {
        passes: {
          type: 'noul',
          instructions: 'Does the answer satisfy the stated evaluation criterion?',
        },
      }
    );

    const score = Number(out?.answers?.passes?.noul ?? 0);
    return {
      ok: Number.isFinite(score) && score >= 0.5,
      score,
    };
  }
}
