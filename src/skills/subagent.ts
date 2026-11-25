import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SkillContext, SkillDefinition } from '../types.js';

/**
 * Sub-agent delegation skill: allows spawning an isolated child OMAgent
 * for scoped research, verification, or parallelizable subtasks.
 */
export const subagentSkills: SkillDefinition[] = [
  {
    name: 'spawn_subagent',
    description: 'Spawn an isolated child agent with its own conversation history to complete a focused sub-task (e.g. research, file analysis, or verification) without polluting the main context.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Clear, self-contained task prompt for the sub-agent'
        },
        maxSteps: {
          type: 'number',
          description: 'Maximum ReAct steps for the sub-agent (default: 6, max: 12)'
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional allowlist of tool names the sub-agent may use (e.g. ["read_file", "search_files"]). Omit to inherit safe tools.'
        },
        isolateWorkspace: {
          type: 'boolean',
          description: 'When true, runs the sub-agent inside an isolated temporary workspace copy.'
        },
        gitWorktree: {
          type: 'boolean',
          description: 'When true and workspace is a git repo, runs the sub-agent inside an isolated git worktree.'
        }
      },
      required: ['task']
    },
    execute: async ({ task, maxSteps = 6, allowedTools, isolateWorkspace = false, gitWorktree = false }: Record<string, any>, context: SkillContext = {}) => {
      const parentAgent = context.agent;
      if (!parentAgent) {
        return { success: false, error: 'spawn_subagent requires an active parent OMAgent in context' };
      }

      // Prevent unbounded recursive subagent spawning
      const depth = (context.subagentDepth || 0) + 1;
      if (depth > 2) {
        return { success: false, error: 'Maximum sub-agent nesting depth (2) reached' };
      }

      const AgentClass = parentAgent.constructor;
      const safeSteps = Math.min(Math.max(1, Number(maxSteps) || 6), 12);
      const subagentId = `${parentAgent.sessionId}_sub_${Date.now().toString(36)}`;

      let targetWorkspace = parentAgent.config.workspaceDir;
      let tempWorkspace = null;
      let worktreePath = null;
      if (gitWorktree && parentAgent.git?.isGitRepo?.()) {
        worktreePath = path.join(os.tmpdir(), `omega-wt-${Date.now().toString(36)}`);
        const wt = parentAgent.git.createWorktree(worktreePath, `om-sub-${Date.now().toString(36)}`);
        targetWorkspace = wt.worktreePath;
      } else if (isolateWorkspace && targetWorkspace && fs.existsSync(targetWorkspace)) {
        tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-subagent-'));
        fs.cpSync(targetWorkspace, tempWorkspace, {
          recursive: true,
          filter: (src) => {
            const base = path.basename(src);
            return base !== 'node_modules' && base !== '.git' && base !== '.om_snapshots' && base !== 'memory';
          }
        });
        targetWorkspace = tempWorkspace;
      }

      const child = new (AgentClass as new (options?: Record<string, any>) => any)({
        ...parentAgent.options,
        provider: parentAgent.config.provider,
        model: parentAgent.config.model,
        providerInstance: parentAgent.provider,
        maxSteps: safeSteps,
        memoryDir: parentAgent.config.memoryDir,
        workspaceDir: targetWorkspace,
        skillsDir: parentAgent.config.skillsDir,
        sessionId: subagentId
      });

      // Forward child telemetry to parent's activity stream for live dashboard visibility
      const forward = (eventType: string) => (payload: Record<string, any>) => {
        const enriched = { subagentId, depth, eventType, ...payload };
        parentAgent.emit?.('subagent_activity', enriched);
        parentAgent._recordActivity?.(`subagent_${eventType}`, enriched);
      };
      const onThought = forward('thought');
      const onToolStart = forward('tool_start');
      const onToolEnd = forward('tool_end');
      const onError = forward('error');
      child.on('thought', onThought);
      child.on('tool_start', onToolStart);
      child.on('tool_end', onToolEnd);
      child.on('error', onError);

      // Copy registered skills, filtering out spawn_subagent at max depth or applying allowlist
      child.skills.skills.clear();
      const allowSet = Array.isArray(allowedTools) && allowedTools.length > 0 ? new Set(allowedTools) : null;
      for (const skill of parentAgent.skills.list()) {
        if (skill.name === 'spawn_subagent' && depth >= 2) continue;
        if (allowSet && !allowSet.has(skill.name)) continue;
        child.skills.register(skill, skill.source);
      }

      try {
        const res = await child.run(task, { maxSteps: safeSteps, subagentDepth: depth, signal: context.signal });
        return {
          success: Boolean(res.success),
          subagentId,
          isolatedWorkspace: Boolean(tempWorkspace || worktreePath),
          gitWorktree: Boolean(worktreePath),
          answer: res.content,
          stepsTaken: res.steps?.length || 0,
          usage: res.usage
        };
      } finally {
        child.off('thought', onThought);
        child.off('tool_start', onToolStart);
        child.off('tool_end', onToolEnd);
        child.off('error', onError);
        await child.close?.();
        if (worktreePath) {
          try {
            parentAgent.git?.removeWorktree?.(worktreePath, true);
          } catch (_) {
            // ignore cleanup errors
          }
        }
        if (tempWorkspace) {
          try {
            fs.rmSync(tempWorkspace, { recursive: true, force: true });
          } catch (_) {
            // ignore cleanup errors
          }
        }
      }
    }
  },
  {
    name: 'run_pipeline',
    description: 'Run a 3-stage role-based subagent pipeline: Researcher (read-only codebase exploration) -> Coder (isolated implementation) -> Reviewer (independent diff & test critique).',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The engineering task to research, implement, and review' },
        researcherModel: { type: 'string', description: 'Optional fast/cheap model override for the Researcher stage' },
        coderModel: { type: 'string', description: 'Optional strong model override for the Coder stage' },
        reviewerModel: { type: 'string', description: 'Optional independent model override for the Reviewer stage' },
        gitWorktree: { type: 'boolean', description: 'Run Coder + Reviewer in an isolated git worktree (default: false)' },
        keepWorktree: { type: 'boolean', description: 'Keep the worktree on disk after pipeline finishes for manual diff/merge review (default: false)' },
        maxStepsPerStage: { type: 'number', description: 'Max ReAct steps per stage (default: 6, max: 12)' }
      },
      required: ['task']
    },
    execute: async (
      {
        task,
        researcherModel,
        coderModel,
        reviewerModel,
        gitWorktree = false,
        keepWorktree = false,
        maxStepsPerStage = 6
      }: Record<string, any>,
      context: SkillContext = {}
    ) => {
      const parentAgent = context.agent;
      if (!parentAgent) {
        return { success: false, error: 'run_pipeline requires an active parent OMAgent in context' };
      }
      const depth = (context.subagentDepth || 0) + 1;
      if (depth > 2) {
        return { success: false, error: 'Maximum sub-agent nesting depth (2) reached' };
      }

      const AgentClass = parentAgent.constructor as new (options?: Record<string, any>) => any;
      const safeSteps = Math.min(Math.max(1, Number(maxStepsPerStage) || 6), 12);
      const pipelineId = `${parentAgent.sessionId}_pipe_${Date.now().toString(36)}`;

      const RESEARCHER_TOOLS = new Set([
        'repo_map', 'read_file', 'search_files', 'list_dir', 'file_outline',
        'go_to_definition', 'find_references', 'get_diagnostics', 'git_status', 'git_diff'
      ]);
      const REVIEWER_TOOLS = new Set([
        'read_file', 'search_files', 'list_dir', 'get_diagnostics', 'get_workspace_diagnostics',
        'git_status', 'git_diff', 'exec_command'
      ]);

      let targetWorkspace = parentAgent.config.workspaceDir;
      let worktreeInfo: { worktreePath: string; branch: string } | null = null;
      if (gitWorktree && parentAgent.git?.isGitRepo?.()) {
        const wtDir = path.join(os.tmpdir(), `omega-pipe-${Date.now().toString(36)}`);
        worktreeInfo = parentAgent.git.createWorktree(wtDir, `om-pipe-${Date.now().toString(36)}`);
        targetWorkspace = worktreeInfo.worktreePath;
      }

      const runStage = async (
        role: 'researcher' | 'coder' | 'reviewer',
        stagePrompt: string,
        allowSet: Set<string> | null,
        modelOverride?: string
      ) => {
        const useModel = modelOverride || parentAgent.config.model;
        const reuseProvider = !modelOverride || modelOverride === parentAgent.config.model;
        const child = new AgentClass({
          ...parentAgent.options,
          provider: parentAgent.config.provider,
          model: useModel,
          ...(reuseProvider ? { providerInstance: parentAgent.provider } : {}),
          maxSteps: safeSteps,
          memoryDir: parentAgent.config.memoryDir,
          workspaceDir: targetWorkspace,
          skillsDir: parentAgent.config.skillsDir,
          sessionId: `${pipelineId}_${role}`,
          selfHeal: { enabled: false }
        });

        child.skills.skills.clear();
        for (const skill of parentAgent.skills.list()) {
          if (skill.name === 'spawn_subagent' || skill.name === 'run_pipeline') continue;
          if (allowSet && !allowSet.has(skill.name)) continue;
          child.skills.register(skill, skill.source);
        }

        parentAgent.emit?.('subagent_activity', { subagentId: `${pipelineId}_${role}`, role, eventType: 'stage_start', model: useModel });
        try {
          const res = await child.run(stagePrompt, { maxSteps: safeSteps, subagentDepth: depth, signal: context.signal });
          return {
            role,
            model: useModel,
            success: Boolean(res.success),
            answer: res.content,
            stepsTaken: res.steps?.length || 0,
            usage: res.usage
          };
        } finally {
          await child.close?.();
        }
      };

      try {
        const research = await runStage(
          'researcher',
          `[Role: Researcher (Read-Only)]\nExplore the codebase for the task below. Identify exact files, symbols, dependencies, and edge cases. Do NOT edit files.\n\nTask: ${task}`,
          RESEARCHER_TOOLS,
          researcherModel
        );

        const coder = await runStage(
          'coder',
          `[Role: Coder]\nImplement the task below using the Researcher's brief. Apply minimal, surgical edits and verify with diagnostics/tests.\n\nTask: ${task}\n\nResearcher Brief:\n${research.answer}`,
          null,
          coderModel
        );

        const reviewer = await runStage(
          'reviewer',
          `[Role: Independent Reviewer]\nInspect git_diff, diagnostics, and tests for the changes made by the Coder. Start your response with either "VERDICT: APPROVED" or "VERDICT: CHANGES_REQUESTED" followed by concise findings.\n\nTask: ${task}\n\nCoder Summary:\n${coder.answer}`,
          REVIEWER_TOOLS,
          reviewerModel
        );

        const approved = /VERDICT:\s*APPROVED/i.test(String(reviewer.answer || ''));
        return {
          success: research.success && coder.success && reviewer.success,
          pipelineId,
          approved,
          worktree: worktreeInfo && keepWorktree ? worktreeInfo : undefined,
          stages: { researcher: research, coder, reviewer }
        };
      } finally {
        if (worktreeInfo && !keepWorktree) {
          try {
            parentAgent.git?.removeWorktree?.(worktreeInfo.worktreePath, true);
          } catch {
            // ignore cleanup errors
          }
        }
      }
    }
  }
];

