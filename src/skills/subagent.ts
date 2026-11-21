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
  }
];

