import fs from 'node:fs';
import path from 'node:path';

/**
 * Community Quickstart Scaffolder (`npx omega-harness init [dir]`)
 *
 * Scaffolds a ready-to-run OMega Agent workspace with:
 * - Secure `.env.example` and `.env` (with 0o600 permissions where supported)
 * - `.gitignore` protecting `.env` and session secrets
 * - `om.config.json` with multi-model routing & fallback configuration
 * - Starter custom JavaScript tool skill (`skills/hello-tool.js`)
 * - Starter Markdown workflow skill (`skills/code-review/SKILL.md`)
 * - Initialized `memory/MEMORY.md`
 */
export async function runInitCommand(options: Record<string, any> = {}) {
  const targetDir = path.resolve(options.targetDir || process.cwd());
  const force = Boolean(options.force);
  const silent = Boolean(options.silent);

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const writeSafe = (relPath: string, content: string, mode?: number) => {
    const fullPath = path.join(targetDir, relPath);
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    if (fs.existsSync(fullPath) && !force) {
      skippedFiles.push(relPath);
      return false;
    }
    fs.writeFileSync(fullPath, content, 'utf8');
    if (mode) {
      try {
        fs.chmodSync(fullPath, mode);
      } catch (_) {}
    }
    createdFiles.push(relPath);
    return true;
  };

  // 1. .env.example
  const envExampleContent = `# ============================================================================
# OMega (omega-harness) — Secure Environment Configuration
# Never commit your .env file to version control!
# ============================================================================

# Active Provider: auto | local | gemini | openai | anthropic | deepseek | kimi | qwen | glm | vllm | lmstudio
OM_PROVIDER=auto
# OM_MODEL=auto

# Cloud Provider API Keys
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Optional Local Model Overrides (auto-scanned on any PC when left unset)
# LOCAL_MODEL_PATH=/path/to/local-model
# LOCAL_MODELS_DIR=/path/to/models-folder
VLLM_BASE_URL=http://127.0.0.1:8000/v1
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1

# Web Dashboard Port
OM_GATEWAY_PORT=3000
`;
  writeSafe('.env.example', envExampleContent);

  // 2. .env (created from template with restrictive file permissions if not present)
  writeSafe('.env', envExampleContent, 0o600);

  // 3. .gitignore (ensure .env is protected)
  const gitignorePath = path.join(targetDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    writeSafe('.gitignore', `node_modules/\n.env\n.env.local\nmemory/sessions/*.json\n*.log\n`);
  } else {
    try {
      const existingGitignore = fs.readFileSync(gitignorePath, 'utf8');
      if (!existingGitignore.includes('.env')) {
        fs.appendFileSync(gitignorePath, `\n.env\n`, 'utf8');
        createdFiles.push('.gitignore (updated with .env)');
      }
    } catch (_) {}
  }

  // 4. om.config.json
  const defaultConfig = {
    name: 'OMega Agent',
    version: '1.0.0',
    provider: 'auto',
    model: 'auto',
    systemPrompt: 'You are OM, a fast, proactive, and capable local-first AI agent. Use your tools proactively to inspect files, execute commands, remember facts, and accomplish tasks step-by-step.',
    maxSteps: 15,
    temperature: 0.2,
    memoryDir: './memory',
    skillsDir: './skills',
    workspaceDir: '.',
    routing: {
      enabled: true,
      maxRetries: 1,
      autoHandoffOnContextLimit: true,
      fallbackChain: [
        { provider: 'gemini', model: 'gemini-3.5-flash' },
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }
      ]
    },
    security: {
      requireConfirmationForShell: false,
      allowedCommands: [],
      deniedCommands: ['format', 'rm -rf /', 'del /f /s /q C:\\*']
    },
    gateway: {
      port: 3000,
      host: '127.0.0.1',
      openBrowser: false
    }
  };
  writeSafe('om.config.json', JSON.stringify(defaultConfig, null, 2) + '\n');

  // 5. Template JavaScript Tool Skill: skills/hello-tool.js
  const templateToolSkill = `/**
 * Template Custom Tool Skill for OMega
 * Drop any .js file in ./skills/ and OMega auto-registers it at startup.
 */
export const skill = {
  name: 'project_summary',
  description: 'Generate a quick summary of project metadata or greet a developer.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Topic or component name to summarize' }
    },
    required: ['topic']
  },
  async execute({ topic }, context) {
    return {
      success: true,
      topic,
      workspace: context.config?.workspaceDir || '.',
      timestamp: new Date().toISOString(),
      message: \`Project summary inspected for topic: "\${topic}"\`
    };
  }
};
`;
  writeSafe(path.join('skills', 'hello-tool.js'), templateToolSkill);

  // 6. Template Markdown Workflow Skill: skills/code-review/SKILL.md
  const templateWorkflowSkill = `---
name: code-review
description: Structured security, performance, and maintainability code review workflow
triggers: [user, model]
---

# Code Review Playbook

When invoked via \`/code-review\`, follow these steps systematically:
1. Inspect modified or target files using \`read_file\` or \`search_files\`.
2. Check for security issues (hardcoded secrets in code, command injection, unsafe path traversal).
3. Verify error handling and fallback resilience.
4. Provide a concise, prioritized Markdown checklist of findings and concrete fixes.
`;
  writeSafe(path.join('skills', 'code-review', 'SKILL.md'), templateWorkflowSkill);

  // 7. Initial MEMORY.md
  const initialMemory = `# OM Long-Term Memory
This file stores persistent facts, user preferences, and important context across sessions.

## User & Environment
- Agent: OMega (omega-harness)
- Workspace initialized: ${new Date().toISOString()}

## Learned Facts & Notes
*(OM appends new facts here as it works and indexes them with local vector embeddings)*
`;
  writeSafe(path.join('memory', 'MEMORY.md'), initialMemory);

  if (!silent) {
    console.log(`\n\x1b[1m\x1b[96m✨ OMega Agent Workspace Initialized!\x1b[0m`);
    console.log(`\x1b[90mDirectory:\x1b[0m ${targetDir}\n`);
    if (createdFiles.length > 0) {
      console.log(`\x1b[32mCreated files:\x1b[0m`);
      for (const f of createdFiles) {
        console.log(`  + ${f}`);
      }
    }
    if (skippedFiles.length > 0) {
      console.log(`\x1b[33mPreserved existing files (use --force to overwrite):\x1b[0m`);
      for (const f of skippedFiles) {
        console.log(`  • ${f}`);
      }
    }
    console.log(`
\x1b[1mSecurity & Quickstart Guide:\x1b[0m
  1. \x1b[36mConfigure API Keys (Optional):\x1b[0m
     Edit \x1b[1m.env\x1b[0m to add GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.
     \x1b[2m(Note: .env is automatically added to .gitignore so your keys stay private.)\x1b[0m
  2. \x1b[36mLaunch Interactive CLI:\x1b[0m
     \x1b[1mnpx omega-harness\x1b[0m  (or \x1b[1mom\x1b[0m)
  3. \x1b[36mLaunch Live Web Dashboard:\x1b[0m
     \x1b[1mnpx omega-harness gateway\x1b[0m
`);
  }

  return {
    success: true,
    targetDir,
    createdFiles,
    skippedFiles
  };
}

