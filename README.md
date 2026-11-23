<p align="center">
  <img src="src/gateway/public/om.png" alt="OM Logo" width="72" height="72" />
</p>

# OMega

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-1-blue.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-154%20passed-success.svg)](tests/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](README.md)

**OMega** is a lightweight, local-first Node.js agent harness you control completely—running offline on your hardware or routed across cloud models, with human-in-the-loop approvals, isolated git worktrees, rollback snapshots, and Git-inspectable memory built in.

---

## Quick Start

**Requires:** Node.js `>= 18.0.0`

```bash
npm install
npm run build
```

Or scaffold a new project:

```bash
npx omega-agent init my-agent
cd my-agent
```

Run in any mode (works out of the box with the built-in `om` offline provider—no API keys required):

```bash
npm start                                    # Interactive CLI REPL
node bin/om.js "Summarize system specs"      # One-shot headless run
npm run gateway                              # Web Dashboard at http://127.0.0.1:3000
node bin/om.js daemon                        # Background cron/watch/webhook daemon
node bin/om.js service install               # Install 24/7 native OS service (systemd/launchd/schtasks)
```

---

## Core Capabilities

- **Multi-Model Routing & Local System 1**: `ModelRouter` handles retries, rate-limit/quota cooldowns, and automatic failover across Gemini, OpenAI, Anthropic, DeepSeek, Kimi, Qwen, GLM, Ollama, LM Studio, vLLM, and `om`. `OMSystemOne` (`src/systemOne.ts`) provides hardware-adaptive complexity routing, risk gating, tool shortlisting, and self-heal triage.
- **Autonomous Daemons & Automations UI**: `OMDaemon` runs cron, interval, file-watch, and webhook triggers with deterministic-first checks (0 LLM tokens when passing), isolated git worktrees, step/token guardrails, persistent run logs, Quick Templates, and 1-click diff/merge/discard in the Gateway UI. Install as a native 24/7 OS service via `om service install`.
- **Unified `ExecutionBackend` Seam**: Swap between `LocalExecutionBackend`, `DockerExecutionBackend`, and `SSHExecutionBackend` (`execution` in `om.config.json`) to route filesystem tools, shell commands, persistent terminals, `OMGitManager`, `WorkspaceSnapshotManager`, and TypeScript LSP diagnostics uniformly.
- **Coding-Agent Toolset**: Sandboxed `exec_command`, persistent interactive terminals (`terminal_start`, `terminal_write`, `terminal_read`, `terminal_list`, `terminal_close`), file tools (`read_file`, `write_file`, `patch_file`, `move_file`, `delete_file`, `list_dir`, `search_files`), Git tools, TypeScript AST/LSP tools (`file_outline`, `go_to_definition`, `find_references`, `get_diagnostics`, `get_workspace_diagnostics`), web search/fetch, and Streamable HTTP MCP servers.
- **Desktop GUI, Clipboard & Documents**: Native OS controls (`screen_capture`, `list_windows`, approval-gated `desktop_click` / `desktop_type` / `desktop_hotkey`), `clipboard_read` / `clipboard_write`, `notify_user`, pure Node.js `pdf_read`, and Playwright `markdown_to_pdf`.
- **Git-Inspectable Memory & Vector Search**: Markdown memory (`memory/MEMORY.md`, `memory/daily/YYYY-MM-DD.md`), session trajectories (`memory/sessions/`), local `node:sqlite`/JSON vector search, and zero-token memory distillation.
- **Autonomous Self-Healing & Swarms**: `OMSelfHealer` diagnoses failures, applies minimal patches, verifies with `testCommand`, and rolls back on failure; `spawn_subagent` and `DetachedSwarmManager` support worktree-isolated and process-detached execution with checkpoints.
- **Security & Multi-User Gateway**: Native OS sandboxing (`bwrap`, `win-job`, `sandbox-exec`), HITL approvals, secret redaction, workspace snapshots/rollback, and `local` / `multiuser` JWT + RBAC (`viewer < operator < admin`) with per-tenant isolation.

---

## Configuration

Copy `.env.example` to `.env` to configure provider keys or local endpoints:

```ini
# auto | gemini | openai | anthropic | deepseek | kimi | qwen | glm | ollama | lmstudio | vllm | om
OM_PROVIDER=auto
# OM_MODEL=gemini-3.8-flash

GEMINI_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
DEEPSEEK_API_KEY=...
OLLAMA_BASE_URL=http://127.0.0.1:11434
OM_GATEWAY_PORT=3000
# OM_WORKSPACE_DIR=.
# OM_MEMORY_DIR=./memory
```

Runtime defaults (routing fallback chains, `daemon` triggers, `security` rules, `execution` backend, `systemOne`, `selfHeal`, and `gateway`) live in [`om.config.json`](om.config.json).

---

## Extending OM

### 1. Drop-in JavaScript Tools (`./skills/*.js`)

```javascript
export const skill = {
  name: 'calculate',
  description: 'Evaluate arithmetic expressions',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression']
  },
  execute: async ({ expression }) => {
    const sanitized = expression.replace(/[^0-9+\-*/().]/g, '');
    return { success: true, result: Function(`'use strict'; return (${sanitized})`)() };
  }
};
```

### 2. Markdown Workflows (`./skills/<name>/SKILL.md`)

Add a `SKILL.md` with YAML frontmatter (`name`, `description`, optional `triggers`) and invoke it in chat via `/<name>`.

### 3. Programmatic API

```javascript
import { OM } from './dist/index.js';

const agent = new OM({ provider: 'om', maxSteps: 10 });
await agent.init();

agent.on('tool_start', ({ name }) => console.log('Running:', name));
const res = await agent.run('Check memory and write a summary to notes.txt');
console.log(res.content);
await agent.close();
```

---

## CLI Slash Commands

| Command | Description |
|:---|:---|
| `/help` | Show available commands. |
| `/cloud [model]` / `/local [model]` | Switch between cloud and local inference. |
| `/provider [name] [model]` | Inspect or switch active provider. |
| `/models [provider]` / `/model <name>` | List or switch models. |
| `/skills` / `/memory` / `/journal` | Inspect loaded skills, `MEMORY.md`, or today's log. |
| `/clear` / `/gateway` / `/exit` | Reset context, start Web Gateway, or exit. |

---

## Testing

```bash
npm test                     # Build + unit & integration suite
npm run check:types          # Strict TypeScript check (internal + public)
npm run lint                 # Zero-warning oxlint check across src/
npm run test:e2e             # Playwright UI E2E tests
npm run benchmark            # Autonomous evaluation & benchmark suite
npm run benchmark:eval       # Coding-task scorecard runner (--live for real APIs)
node scripts/security-audit.js  # Dependency, secret & eval() audit
```

All 154 unit & integration tests pass using Node's built-in `node:test` runner (Playwright is used for `test:e2e`).

---

## License

[MIT](LICENSE)
