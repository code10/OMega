import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { OMGitManager } from './git.js';
import { buildSafeChildEnv, redactSecrets } from './utils/redact.js';
import type { SelfHealConfig } from './types.js';

const execAsync = promisify(exec);

export interface StackFrame {
  raw: string;
  fn?: string;
  filePath: string;
  sourcePath: string;
  relPath: string;
  line: number;
  column: number;
  inWorkspace: boolean;
}

export interface ParsedStackTrace {
  message: string;
  stack: string;
  frames: StackFrame[];
  offendingFile?: string;
  offendingLine?: number;
}

export interface HealIncident {
  error: Error | string;
  source: 'tool_failure' | 'unhandled_error';
  step?: number;
  toolName?: string;
  toolArgs?: Record<string, any>;
  runId?: string;
  subagentDepth?: number;
  signal?: AbortSignal;
}

export interface SelfHealResult {
  healed: boolean;
  skipped?: boolean;
  committed: boolean;
  rolledBack?: boolean;
  commitHash?: string;
  patch: string;
  patchFile?: string;
  offendingFile?: string;
  offendingLine?: number;
  diagnosis?: string;
  subagentId?: string;
  testResult?: {
    passed: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    output: string;
    durationMs: number;
  };
  reason?: string;
}

const DIAGNOSTIC_TOOLS = [
  'read_file',
  'patch_file',
  'write_file',
  'list_dir',
  'search_files',
  'get_diagnostics',
  'git_status',
  'git_diff'
];

/**
 * Autonomous Framework Self-Healing (The Recursive Immune System).
 * Intercepts unhandled errors or tool failures in the ReAct loop, parses the
 * stack trace, spawns a focused diagnostic sub-agent to inspect and patch the
 * offending file, runs the test suite (`npm test`), and commits autonomously if green.
 */
export class OMSelfHealer {
  /**
   * Parse an Error or stack trace string and resolve workspace offending files.
   */
  static parseStackTrace(errorOrStack: Error | string, workspaceDir = process.cwd()): ParsedStackTrace {
    const resolvedWs = path.resolve(workspaceDir || process.cwd());
    const message = errorOrStack instanceof Error
      ? errorOrStack.message
      : String(errorOrStack || 'Unknown error').split(/\r?\n/)[0];
    const stack = errorOrStack instanceof Error
      ? (errorOrStack.stack || `${errorOrStack.name}: ${errorOrStack.message}`)
      : String(errorOrStack || '');

    const frames: StackFrame[] = [];
    const lines = stack.split(/\r?\n/);

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith('at ')) continue;

      // Match: "at fn (loc:line:col)" or "at loc:line:col"
      const parenMatch = trimmed.match(/^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/);
      const bareMatch = !parenMatch ? trimmed.match(/^at\s+(.+):(\d+):(\d+)$/) : null;
      const match = parenMatch || bareMatch;
      if (!match) continue;

      const fn = parenMatch ? match[1] : undefined;
      let rawLoc = parenMatch ? match[2] : match[1];
      const line = Number(parenMatch ? match[3] : match[2]);
      const column = Number(parenMatch ? match[4] : match[3]);

      if (!rawLoc || rawLoc.startsWith('node:')) continue;
      if (rawLoc.startsWith('file://')) {
        try {
          rawLoc = fileURLToPath(rawLoc);
        } catch (_) {
          continue;
        }
      }

      const filePath = path.resolve(rawLoc);
      let sourcePath = filePath;
      const relFromWs = path.relative(resolvedWs, filePath);
      const inWorkspace = !relFromWs.startsWith('..') && !path.isAbsolute(relFromWs);

      // Map compiled dist/*.js back to src/*.ts when present in workspace
      if (inWorkspace) {
        const normalizedRel = relFromWs.replace(/\\/g, '/');
        if (normalizedRel.startsWith('dist/') && normalizedRel.endsWith('.js')) {
          const tsCandidate = path.join(resolvedWs, normalizedRel.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
          if (fs.existsSync(tsCandidate)) {
            sourcePath = tsCandidate;
          }
        }
      }

      const relPath = path.relative(resolvedWs, sourcePath).replace(/\\/g, '/');
      frames.push({
        raw: trimmed,
        fn,
        filePath,
        sourcePath,
        relPath,
        line,
        column,
        inWorkspace
      });
    }

    const candidate = frames.find(
      (f) => f.inWorkspace && !f.relPath.includes('node_modules/') && !f.relPath.endsWith('selfHeal.ts') && !f.relPath.endsWith('selfHeal.js')
    );

    return {
      message,
      stack,
      frames,
      offendingFile: candidate?.relPath,
      offendingLine: candidate?.line
    };
  }

  /**
   * Build the diagnostic prompt for the focused self-healing sub-agent.
   */
  static buildDiagnosticPrompt(incident: HealIncident, parsed: ParsedStackTrace): string {
    const sourceLabel = incident.source === 'tool_failure' ? 'Tool Failure' : 'Unhandled Runtime Error';
    const location = parsed.offendingFile
      ? `${parsed.offendingFile}${parsed.offendingLine ? `:${parsed.offendingLine}` : ''}`
      : 'unknown file';
    const compactStack = parsed.stack
      .split(/\r?\n/)
      .slice(0, 6)
      .join('\n')
      .slice(0, 1200);

    const details = [
      `• Trigger: ${sourceLabel}${incident.step !== undefined ? ` (Step ${incident.step})` : ''}`,
      incident.toolName ? `• Failing Tool: ${incident.toolName}` : '',
      incident.toolArgs && Object.keys(incident.toolArgs).length > 0
        ? `• Tool Args: ${JSON.stringify(incident.toolArgs)}`
        : '',
      `• Offending File: ${location}`,
      `• Error: ${parsed.message}`
    ].filter(Boolean);

    return [
      'Self-Healing Diagnostic Session — Autonomous Diagnostic & Self-Patching Sub-Agent',
      `An error occurred during execution${incident.toolName ? ` in ${incident.toolName}` : ''}. Inspect ${location}, apply a minimal fix, and verify it with the test suite.`,
      '',
      'Incident Summary',
      ...details,
      '',
      'Stack Trace',
      compactStack,
      '',
      'Recovery Steps',
      '1. Inspect the offending file using read_file or search_files.',
      '2. Identify the root cause of the failure.',
      '3. Apply a minimal, surgical fix with patch_file or write_file.',
      '4. Summarize the root cause and fix concisely.'
    ].join('\n');
  }

  /**
   * Run the configured test suite (`npm test` by default) inside workspaceDir.
   */
  static async runTestSuite(workspaceDir: string, testCommand = 'npm test') {
    const start = Date.now();
    try {
      const { stdout, stderr } = await execAsync(testCommand, {
        cwd: workspaceDir,
        env: buildSafeChildEnv(process.env),
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      const safeOut = redactSecrets(stdout || '');
      const safeErr = redactSecrets(stderr || '');
      const output = [safeOut, safeErr].filter(Boolean).join('\n').trim();
      return {
        passed: true,
        exitCode: 0,
        stdout: safeOut,
        stderr: safeErr,
        output,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      const stdout = redactSecrets(err.stdout || '');
      const stderr = redactSecrets(err.stderr || err.message || '');
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      return {
        passed: false,
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout,
        stderr,
        output,
        durationMs: Date.now() - start
      };
    }
  }

  /**
   * Intercept an error or tool failure, spawn a diagnostic sub-agent to patch it,
   * capture the git patch, run the test suite, and commit if green (or rollback if red).
   */
  static async heal(agent: any, incident: HealIncident, overrideConfig: SelfHealConfig = {}): Promise<SelfHealResult> {
    if (!agent) {
      return { healed: false, skipped: true, committed: false, patch: '', reason: 'No active agent provided' };
    }

    // Immune system self-tolerance: prevent recursive self-healing inside diagnostic sub-agents
    if (agent._isSelfHealing || (incident.subagentDepth || 0) > 0) {
      return { healed: false, skipped: true, committed: false, patch: '', reason: 'Recursive self-heal prevented' };
    }

    const cfg: SelfHealConfig = {
      enabled: true,
      autoCommit: true,
      testCommand: 'npm test',
      maxSubagentSteps: 6,
      ...agent.config?.selfHeal,
      ...overrideConfig
    };

    const workspaceDir = path.resolve(agent.config?.workspaceDir || process.cwd());
    const parsed = OMSelfHealer.parseStackTrace(incident.error, workspaceDir);
    const git = agent.git instanceof OMGitManager ? agent.git : new OMGitManager(workspaceDir);

    const startPayload = {
      source: incident.source,
      step: incident.step,
      toolName: incident.toolName,
      offendingFile: parsed.offendingFile,
      offendingLine: parsed.offendingLine,
      error: parsed.message
    };
    agent.emit?.('self_heal_start', startPayload);
    agent._recordActivity?.('self_heal_start', startPayload);

    const AgentClass = agent.constructor;
    const safeSteps = Math.min(Math.max(1, Number(cfg.maxSubagentSteps) || 6), 12);
    const subagentId = `${agent.sessionId}_heal_${Date.now().toString(36)}`;

    const child = new AgentClass({
      ...agent.options,
      provider: agent.config.provider,
      model: agent.config.model,
      providerInstance: agent.provider,
      maxSteps: safeSteps,
      memoryDir: agent.config.memoryDir,
      workspaceDir,
      skillsDir: agent.config.skillsDir,
      sessionId: subagentId,
      selfHeal: { enabled: false }
    });
    child._isSelfHealing = true;

    // Scope diagnostic sub-agent to inspection and patching tools only
    child.skills.skills.clear();
    for (const skill of agent.skills.list()) {
      if (DIAGNOSTIC_TOOLS.includes(skill.name)) {
        child.skills.register(skill, skill.source);
      }
    }

    const diagnosticPrompt = OMSelfHealer.buildDiagnosticPrompt(incident, parsed);
    let diagnosis = '';
    try {
      const childRes = await child.run(diagnosticPrompt, {
        maxSteps: safeSteps,
        subagentDepth: 1,
        signal: incident.signal
      });
      diagnosis = childRes?.content || '';
    } catch (subErr: any) {
      const failPayload = { ...startPayload, subagentId, reason: `Diagnostic sub-agent failed: ${subErr.message}` };
      agent.emit?.('self_heal_failed', failPayload);
      agent._recordActivity?.('self_heal_failed', failPayload);
      return {
        healed: false,
        committed: false,
        patch: '',
        subagentId,
        offendingFile: parsed.offendingFile,
        offendingLine: parsed.offendingLine,
        reason: failPayload.reason
      };
    } finally {
      await child.close?.();
    }

    // Capture git patch (or snapshot diff if not a git repo)
    const isRepo = git.isGitRepo();
    let patch = isRepo ? git.getDiff() : '';
    const snapshotDiff = child.lastRunId ? child.snapshots.diff(child.lastRunId) : null;
    const hasChanges = Boolean(patch.trim()) || Boolean(snapshotDiff?.changes?.length);

    if (!hasChanges) {
      const failPayload = { ...startPayload, subagentId, reason: 'Diagnostic sub-agent produced no code changes' };
      agent.emit?.('self_heal_failed', failPayload);
      agent._recordActivity?.('self_heal_failed', failPayload);
      return {
        healed: false,
        committed: false,
        patch: '',
        subagentId,
        offendingFile: parsed.offendingFile,
        offendingLine: parsed.offendingLine,
        diagnosis,
        reason: failPayload.reason
      };
    }

    // Persist patch file if savePatchDir is configured
    let patchFile: string | undefined;
    if (cfg.savePatchDir && patch) {
      const patchDir = path.isAbsolute(cfg.savePatchDir) ? cfg.savePatchDir : path.join(workspaceDir, cfg.savePatchDir);
      fs.mkdirSync(patchDir, { recursive: true });
      patchFile = path.join(patchDir, `${subagentId}.patch`);
      fs.writeFileSync(patchFile, patch, 'utf8');
    }

    // Run test suite (`npm test` by default, or injected testRunner)
    const testCommand = cfg.testCommand || 'npm test';
    const testResult = typeof cfg.testRunner === 'function'
      ? await cfg.testRunner(workspaceDir, testCommand)
      : await OMSelfHealer.runTestSuite(workspaceDir, testCommand);

    const normalizedTestResult = {
      passed: Boolean(testResult.passed),
      exitCode: Number(testResult.exitCode ?? (testResult.passed ? 0 : 1)),
      stdout: testResult.stdout || '',
      stderr: testResult.stderr || '',
      output: testResult.output || '',
      durationMs: testResult.durationMs || 0
    };

    if (!normalizedTestResult.passed) {
      // Roll back unverified patch so the workspace stays clean
      if (child.lastRunId) {
        child.snapshots.rollback(child.lastRunId);
      }
      const failPayload = {
        ...startPayload,
        subagentId,
        rolledBack: true,
        testResult: normalizedTestResult,
        reason: 'Test suite failed after applying diagnostic patch'
      };
      agent.emit?.('self_heal_failed', failPayload);
      agent._recordActivity?.('self_heal_failed', failPayload);
      return {
        healed: false,
        committed: false,
        rolledBack: true,
        patch,
        patchFile,
        subagentId,
        offendingFile: parsed.offendingFile,
        offendingLine: parsed.offendingLine,
        diagnosis,
        testResult: normalizedTestResult,
        reason: failPayload.reason
      };
    }

    // Green tests -> autonomous git commit
    let committed = false;
    let commitHash: string | undefined;
    if (cfg.autoCommit !== false && isRepo) {
      const targetLabel = parsed.offendingFile || incident.toolName || 'runtime';
      const shortErr = parsed.message.replace(/\s+/g, ' ').slice(0, 60);
      const commitMsg = `fix(self-heal): ${shortErr} [${targetLabel}]`;
      const commitRes = git.commit(commitMsg);
      committed = Boolean(commitRes.committed);
      commitHash = commitRes.hash;
    }

    const successPayload = {
      ...startPayload,
      subagentId,
      committed,
      commitHash,
      patchFile,
      testResult: normalizedTestResult
    };
    agent.emit?.('self_heal_success', successPayload);
    agent._recordActivity?.('self_heal_success', successPayload);

    return {
      healed: true,
      committed,
      commitHash,
      patch,
      patchFile,
      subagentId,
      offendingFile: parsed.offendingFile,
      offendingLine: parsed.offendingLine,
      diagnosis,
      testResult: normalizedTestResult
    };
  }
}
