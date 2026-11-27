import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { BaseProvider } from './base.js';
import { ModelService } from '../modelService.js';
import { detectSystemHardware } from '../deviceSpecs.js';
import type {
  ModelInfo,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderConstructorOptions
} from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PendingRequest {
  resolve: (res: ProviderChatResult) => void;
  reject: (err: Error) => void;
  onDelta?: (text: string) => void;
}

class StdioSafetensorsWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private reqCounter = 0;

  private findPythonExecutable(): string {
    if (process.env.OMEGA_PYTHON && fs.existsSync(process.env.OMEGA_PYTHON)) {
      return process.env.OMEGA_PYTHON;
    }
    const cwd = process.cwd();
    const candidates = process.platform === 'win32'
      ? [
          path.join(cwd, '.venv', 'Scripts', 'python.exe'),
          path.join(cwd, 'venv', 'Scripts', 'python.exe'),
          'python'
        ]
      : [
          path.join(cwd, '.venv', 'bin', 'python'),
          path.join(cwd, 'venv', 'bin', 'python'),
          'python3',
          'python'
        ];
    for (const c of candidates) {
      if (c === 'python' || c === 'python3' || fs.existsSync(c)) {
        return c;
      }
    }
    return 'python';
  }

  private getWorkerScriptPath(): string {
    const fromDist = path.resolve(__dirname, '..', '..', 'scripts', 'local_worker.py');
    if (fs.existsSync(fromDist)) return fromDist;
    return path.resolve(process.cwd(), 'scripts', 'local_worker.py');
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed && this.readyPromise) {
      return this.readyPromise;
    }

    const pythonBin = this.findPythonExecutable();
    const scriptPath = this.getWorkerScriptPath();
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Local inference worker script not found at ${scriptPath}`);
    }

    const proc = spawn(pythonBin, ['-u', scriptPath], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc = proc;

    let stderrBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const rl = readline.createInterface({ input: proc.stdout });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: any;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }

        if (msg.id === 'init') {
          if (!settled) {
            settled = true;
            if (msg.type === 'ready') {
              resolveReady();
            } else {
              rejectReady(new Error(msg.error || 'Failed to initialize local safetensors worker'));
            }
          }
          return;
        }

        const req = this.pending.get(String(msg.id || ''));
        if (!req) return;

        if (msg.type === 'delta' && typeof msg.text === 'string') {
          req.onDelta?.(msg.text);
        } else if (msg.type === 'done') {
          this.pending.delete(String(msg.id));
          req.resolve({
            content: String(msg.content || ''),
            toolCalls: [],
            usage: msg.usage || undefined
          });
        } else if (msg.type === 'error') {
          this.pending.delete(String(msg.id));
          req.reject(new Error(String(msg.error || 'Local inference failed')));
        }
      });

      proc.on('error', (err) => {
        const wrapped = new Error(`Failed to launch Python local worker (${pythonBin}): ${err.message}`);
        if (!settled) {
          settled = true;
          rejectReady(wrapped);
        }
        for (const [, p] of this.pending) p.reject(wrapped);
        this.pending.clear();
        this.proc = null;
        this.readyPromise = null;
      });

      proc.on('exit', (code) => {
        const detail = stderrBuf.trim() ? `: ${stderrBuf.trim().slice(-300)}` : '';
        const err = new Error(`Local inference worker exited (code ${code})${detail}`);
        if (!settled) {
          settled = true;
          rejectReady(err);
        }
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        this.proc = null;
        this.readyPromise = null;
      });
    });

    return this.readyPromise;
  }

  async chat(params: {
    modelDir: string;
    modelId: string;
    messages: any[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    onDelta?: (text: string) => void;
  }): Promise<ProviderChatResult> {
    await this.ensureStarted();
    if (!this.proc || this.proc.killed) {
      throw new Error('Local inference worker is not running.');
    }
    const id = `req_${++this.reqCounter}`;
    const sanitizedMessages = (params.messages || []).map((m: any) => ({
      role: m?.role || 'user',
      content: typeof m?.content === 'string' ? m.content.slice(0, 64000) : m?.content
    }));
    const payload = {
      id,
      cmd: 'chat',
      model_dir: params.modelDir,
      model_id: params.modelId,
      messages: sanitizedMessages,
      temperature: params.temperature ?? 0.2,
      max_tokens: params.maxTokens ?? 512,
      stream: Boolean(params.stream)
    };

    return new Promise<ProviderChatResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onDelta: params.onDelta });
      this.proc!.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async warmup(params: { modelDir: string; modelId: string }): Promise<void> {
    await this.ensureStarted();
    if (!this.proc || this.proc.killed) return;
    const id = `req_${++this.reqCounter}`;
    const payload = {
      id,
      cmd: 'warmup',
      model_dir: params.modelDir,
      model_id: params.modelId
    };
    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject
      });
      this.proc!.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  shutdown() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin.write(`${JSON.stringify({ id: 'bye', cmd: 'shutdown' })}\n`);
      } catch {}
      try {
        this.proc.kill();
      } catch {}
    }
    this.proc = null;
    this.readyPromise = null;
  }
}

const sharedStdioWorker = new StdioSafetensorsWorker();
process.once('exit', () => sharedStdioWorker.shutdown());

function hasOnnxWeights(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath);
    if (entries.some((f) => f.endsWith('.onnx'))) return true;
    const onnxSub = path.join(dirPath, 'onnx');
    if (fs.existsSync(onnxSub) && fs.statSync(onnxSub).isDirectory()) {
      return fs.readdirSync(onnxSub).some((f) => f.endsWith('.onnx'));
    }
  } catch {}
  return false;
}

/**
 * Zero-port, hardware-adaptive direct local model provider.
 * - Runs ONNX local models directly in-process in Node.js via @huggingface/transformers.
 * - Runs .safetensors local models directly via persistent stdio worker (no HTTP ports).
 * - Automatically adapts to whatever PC hardware it runs on (CPU-only, Apple Silicon MPS, or CUDA GPU).
 */
export class LocalDirectProvider extends BaseProvider {
  config: Record<string, any>;
  private onnxPipelineCache = new Map<string, any>();

  constructor(options: ProviderConstructorOptions & Record<string, any> = {}) {
    super({ ...options, name: 'local', model: options.model || 'auto' });
    this.config = options;
  }

  private async resolveLocalModelDir(): Promise<{ id: string; dir: string }> {
    const installed = await ModelService.listLocalModels({
      config: this.config,
      includeUnsupported: true
    });
    const diskModels = installed.filter((m) => m.localPath && fs.existsSync(m.localPath));
    if (diskModels.length === 0) {
      throw new Error(
        'No local model folders (.safetensors or .onnx) were found on this PC. ' +
        'Place a model folder on your Desktop or ~/models (or set LOCAL_MODELS_DIR).'
      );
    }

    const requested = (this.model || '').trim().toLowerCase();
    const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!requested || requested === 'auto' || requested === 'default' || requested === 'local') {
      const lastUsed = String(this.config?.providers?.local?.model || '').trim().toLowerCase();
      if (lastUsed && lastUsed !== 'auto' && lastUsed !== 'default') {
        const lastMatch = diskModels.find((m) => m.id.toLowerCase() === lastUsed || compact(m.id) === compact(lastUsed));
        if (lastMatch) return { id: lastMatch.id, dir: lastMatch.localPath! };
      }
      const best = diskModels.find((m) => m.hardwareFit?.status !== 'unsupported') || diskModels[0];
      return { id: best.id, dir: best.localPath! };
    }

    const exact = diskModels.find((m) => m.id.toLowerCase() === requested || compact(m.id) === compact(requested));
    if (exact) return { id: exact.id, dir: exact.localPath! };

    const partial = diskModels.find((m) => compact(m.id).includes(compact(requested)));
    if (partial) return { id: partial.id, dir: partial.localPath! };

    throw new Error(
      `Local model '${this.model}' was not found on this PC. ` +
      `Installed local models: ${diskModels.map((m) => m.id).join(', ')}`
    );
  }

  private async runOnnxInProcess(dir: string, options: ProviderChatOptions): Promise<ProviderChatResult> {
    const hw = await detectSystemHardware();
    const device = hw.accelerator === 'cuda' ? 'cuda' : hw.accelerator === 'directml' ? 'dml' : 'cpu';
    let generator = this.onnxPipelineCache.get(dir);
    if (!generator) {
      const transformers: any = await import('@huggingface/transformers');
      generator = await transformers.pipeline('text-generation', dir, {
        device: device === 'cuda' || device === 'dml' ? device : 'cpu',
        local_files_only: true
      });
      this.onnxPipelineCache.set(dir, generator);
    }

    const msgs = (options.messages || []).map((m: any) => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: typeof m.content === 'string' ? m.content : String(m.content ?? '')
    }));
    const out = await generator(msgs, {
      max_new_tokens: options.maxTokens || 512,
      temperature: options.temperature ?? 0.2,
      do_sample: (options.temperature ?? 0.2) > 0,
      return_full_text: false
    });
    const generated = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
    const text = Array.isArray(generated)
      ? String(generated[generated.length - 1]?.content || '')
      : String(generated || '');
    return { content: text.trim(), toolCalls: [] };
  }

  async chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
    const { id, dir } = await this.resolveLocalModelDir();
    if (hasOnnxWeights(dir)) {
      return this.runOnnxInProcess(dir, options);
    }
    return sharedStdioWorker.chat({
      modelDir: dir,
      modelId: id,
      messages: options.messages || [],
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stream: false
    });
  }

  async chatStream(
    options: ProviderChatOptions,
    callbacks?: { onDelta?: (text: string) => void }
  ): Promise<ProviderChatResult> {
    const { id, dir } = await this.resolveLocalModelDir();
    if (hasOnnxWeights(dir)) {
      const res = await this.runOnnxInProcess(dir, options);
      if (res.content) callbacks?.onDelta?.(res.content);
      return res;
    }
    return sharedStdioWorker.chat({
      modelDir: dir,
      modelId: id,
      messages: options.messages || [],
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stream: Boolean(callbacks?.onDelta),
      onDelta: callbacks?.onDelta
    });
  }

  async warmup(): Promise<string> {
    const { id, dir } = await this.resolveLocalModelDir();
    if (hasOnnxWeights(dir)) {
      const hw = await detectSystemHardware();
      const device = hw.accelerator === 'cuda' ? 'cuda' : hw.accelerator === 'directml' ? 'dml' : 'cpu';
      if (!this.onnxPipelineCache.has(dir)) {
        const transformers: any = await import('@huggingface/transformers');
        const generator = await transformers.pipeline('text-generation', dir, {
          device: device === 'cuda' || device === 'dml' ? device : 'cpu',
          local_files_only: true
        });
        this.onnxPipelineCache.set(dir, generator);
      }
      return id;
    }
    await sharedStdioWorker.warmup({ modelDir: dir, modelId: id });
    return id;
  }

  async listModels(options: Record<string, unknown> = {}): Promise<ModelInfo[]> {
    return ModelService.listLocalModels({ config: this.config, ...options });
  }
}
