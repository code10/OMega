<p align="center">
  <img src="src/gateway/public/om.png" alt="OM Logo" width="72" height="72" />
</p>

# OM Framework

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-1-blue.svg)](package.json)
[[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-127%20passed-success.svg)](tests/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](README.md)

> Cloud coding agents own your context and require vendor trust. **OM** is a lightweight, auditable autonomous runtime you control completely—running air-gapped on your hardware or routed across your own models, with human-in-the-loop approvals, rollback snapshots, and Git-inspectable memory built in.
---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
  - [1. Requirements](#1-requirements)
  - [2. Initialize a New Project via CLI (`npx omega-agent init`)](#2-initialize-a-new-project-via-cli-npx-omega-agent-init)
  - [3. Launch Interactive Terminal REPL](#3-launch-interactive-terminal-repl)
  - [4. Run a One-Shot Autonomous Command](#4-run-a-one-shot-autonomous-command)
  - [5. Start the Web Dashboard Gateway](#5-start-the-web-dashboard-gateway)
- [Configuration](#configuration)
  - [Environment Variables (`.env`)](#environment-variables-env)
  - [Application Settings (`om.config.json`)](#application-settings-omconfigjson)
- [Model Providers](#model-providers)
- [Interactive CLI & Slash Commands](#interactive-cli--slash-commands)
- [Built-in Skills Catalog](#built-in-skills-catalog)
- [Extending Skills & Workflows](#extending-skills--workflows)
  - [1. JavaScript Tool Modules](#1-javascript-tool-modules)
  - [2. Markdown Agent Workflows (`SKILL.md`)](#2-markdown-agent-workflows-skillmd)
- [Programmatic API](#programmatic-api)
- [Gateway REST & SSE Endpoints](#gateway-rest--sse-endpoints)
- [Autonomous Self-Healing & Detached Execution](#autonomous-self-healing--detached-execution)
- [Security, Sandboxing & Multi-User RBAC](#security-sandboxing--multi-user-rbac)
- [Project Layout](#project-layout)
- [Testing & Autonomous Benchmarking](#testing--autonomous-benchmarking)
- [License](#license)

---

## Overview

Modern agentic frameworks often require complex runtime setups, external databases, or heavy Python stacks. **OM** takes a lightweight Node.js approach:

- **Node.js Core**: Operates on standard Node.js built-ins (`node:events`, `node:fs`, `node:http`, `node:readline`, `node:process`, `node:crypto`, `node:sqlite`) with `@huggingface/transformers` (and optional `onnxruntime-node`) for hardware-adaptive local neural inference (`OMSystemOne`), plus TypeScript (`devDependencies` only) compiled to `dist/`.
- **Private**: Works completely offline with local model runners (Ollama, LM Studio, vLLM) or a built-in interactive Mock simulator—no credit cards or API keys required to start.
- **Markdown Memory**: Context, long-term facts, and daily journals are stored as human-readable Markdown files that you can inspect, edit, or commit to Git.
- **Interfaces**: Access the agent via an ANSI-colored interactive terminal REPL or launch a web-based dashboard with Server-Sent Events (SSE) streaming.

---

## Key Features

- **Autonomous ReAct Loop**: Multi-step reasoning and tool execution engine with configurable step budgets, error recovery, and safety guardrails.
- **Smarter Multi-Model Routing & Failover**: Automatic retry, rate-limit cooldown, and seamless handoff (`ModelRouter`) across local models (Ollama, LM Studio, vLLM) and cloud providers (Gemini, OpenAI, Anthropic, DeepSeek, Kimi, Qwen, GLM) with complexity-based routing and token/cost budgets.
- **Universal Model Abstraction**: Unified interface across Google Gemini, OpenAI, Anthropic Claude, DeepSeek, Kimi (Moonshot), Qwen (DashScope), GLM (Zhipu), Ollama, LM Studio, vLLM, and built-in OM engines.
- **Dynamic Skill Registry & Subagents**: Automatic hot-discovery of custom JavaScript tools (`./skills/*.js`), structured agent workflows (`./skills/*/SKILL.md`), MCP Streamable HTTP tools, and isolated subagents (`spawn_subagent` with optional git worktree isolation).
- **Comprehensive Built-in Tools**: Shell command execution, file manipulation, surgical patching, directory inspection, git operations (`git_status`, `git_diff`, `git_branch`), web fetching with HTML-to-Markdown conversion, and system telemetry.
- **Hardware-Adaptive System 1 (`OMSystemOne`)**: Local neural decision engine (`src/systemOne.ts`) with GPU/CPU auto-detection (`src/deviceSpecs.ts`) for complexity-based routing, risk gating, tool shortlisting, and self-heal triage.
- **Enhanced Memory with Local Vector Search**:
  - `memory/MEMORY.md`: Curated, long-term project knowledge and user preferences.
  - `memory/daily/YYYY-MM-DD.md`: Timestamped daily activity ledgers.
  - `memory/sessions/session_<id>.json`: Full execution traces, session forking, and deterministic replay trajectories.
  - `memory/vectors.json` & `node:sqlite` Vector Store: Local vector embeddings (or HTTP `/v1/embeddings` / Ollama `/api/embed`) enabling semantic search across past sessions, journals, and project knowledge bases (`search_memory` & `index_knowledge`).
- **Polished Web Dashboard & Agent Console**: Real-time SSE event streaming, collapsible tool-execution traces, failover banners, semantic vector search UI, Device Specs telemetry, HITL tool/shell approvals, workspace snapshots/rollback, and one-off/persistent/detached Agent Management (`/api/agents`).
- **Community-Ready CLI Quickstart (`npx omega-agent init`)**: One-command project scaffolder generating template tool/workflow skills, config, and `.gitignore`-protected `.env` files.

---

## Architecture

```
                          ┌───────────────────────────┐
                          │      User Interfaces      │
                          │   CLI REPL / Web Gateway  │
                          └─────────────┬─────────────┘
                                        │
                                        ▼
                          ┌───────────────────────────┐
                          │          OMAgent          │
                          │   (ReAct Loop Controller) │
                          └──────┬─────────────┬──────┘
                                 │             │
        ┌────────────────────────┴─┐         ┌─┴────────────────────────┐
        ▼                          ▼         ▼                          ▼
┌──────────────┐         ┌───────────────┐ ┌──────────────┐    ┌───────────────┐
│ ModelRouter  │         │ SkillRegistry │ │ MemoryEngine │    │ Gateway Server│
├──────────────┤         ├───────────────┤ ├──────────────┤    ├───────────────┤
│ • OM         │         │ • Shell / Git │ │ • MEMORY.md  │    │ • HTTP REST   │
│ • Gemini     │         │ • Filesystem  │ │ • Daily Logs │    │ • SSE Stream  │
│ • OpenAI     │         │ • Web Fetcher │ │ • Sessions   │    │ • Agents UI   │
│ • Anthropic  │         │ • Subagents   │ │ • VectorStore│    │ • Approvals   │
│ • DeepSeek   │         │ • MCP Client  │ │   (JSON/SQL) │    │ • Snapshots   │
│ • Kimi/Qwen  │         │ • ./skills/*  │ └──────────────┘    │ • DeviceSpecs │
│ • GLM/Ollama │         │ • SKILL.md    │                     └───────────────┘
│ • LMStu/vLLM │         └───────────────┘
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ OMSystemOne  │
├──────────────┤
│ • Complexity │
│ • Risk Gate  │
│ • Shortlist  │
│ • Triage     │
└──────────────┘
```

---

## Quick Start

### 1. Requirements

- **Node.js** `>= 18.0.0`
- Install dependencies and build locally with:

```bash
npm install
npm run build
```

### 2. Initialize a New Project via CLI (`npx omega-agent init`)

Scaffold a ready-to-run workspace with template skills, `om.config.json`, and secure `.env` setup:

```bash
npx omega-agent init my-agent
cd my-agent
```

### 3. Launch Interactive Terminal REPL

OM runs immediately using the built-in provider or local models without any API keys:

```bash
# Launch the interactive CLI
npm start
# or: npx omega-agent
```

### 4. Run a One-Shot Autonomous Command

You can pass a prompt directly to execute headlessly:

```bash
node bin/om.js "Inspect system specs, check memory status, and summarize in notes.txt"
```

### 5. Start the Web Dashboard Gateway

```bash
npm run gateway
# or: node bin/om.js gateway
```

Navigate to **`http://localhost:3000`** in your browser to access the visual agent console, live memory viewer, and model switcher.

---

## Configuration

### Environment Variables (`.env`)

Create a `.env` file in the project root (or copy `.env.example`) to configure your preferred providers:

```ini
# Active provider: auto | gemini | openai | anthropic | deepseek | kimi | qwen | glm | ollama | lmstudio | vllm | om
OM_PROVIDER=auto

# Optional default model override
# OM_MODEL=gemini-3.5-flash

# Cloud Provider API Keys
GEMINI_API_KEY=AIzaSy...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
KIMI_API_KEY=sk-...
QWEN_API_KEY=sk-...
GLM_API_KEY=...

# Local Inference Server URLs
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:latest
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
VLLM_BASE_URL=http://127.0.0.1:8000/v1

# Web Gateway & Optional Embeddings / Compaction
OM_GATEWAY_PORT=3000
# OM_EMBEDDING_URL=http://127.0.0.1:11434/api/embed
# OM_EMBEDDING_MODEL=nomic-embed-text
# OM_LLM_COMPACTION=true
```

### Application Settings (`om.config.json`)

Fine-tune agent behavior, routing/failover, paths, security boundaries, provider defaults, and network ports:

```json
{
  "name": "OM Agent",
  "version": "1.0.0",
  "provider": "om",
  "model": "om-v1",
  "maxSteps": 15,
  "temperature": 0.1,
  "memoryDir": "./memory",
  "skillsDir": "./skills",
  "workspaceDir": ".",
  "routing": {
    "enabled": true,
    "maxRetries": 1,
    "autoHandoffOnContextLimit": true,
    "fallbackChain": [
      { "provider": "gemini", "model": "gemini-3-flash-preview" },
      { "provider": "gemini", "model": "gemini-3.1-flash-lite" },
      { "provider": "openai", "model": "gpt-4o" },
      { "provider": "anthropic", "model": "claude-3-5-sonnet-20241022" },
      { "provider": "om", "model": "om-reasoning" }
    ]
  },
  "security": {
    "requireConfirmationForShell": true,
    "requireConfirmationForTools": ["exec_command", "http_request"],
    "allowedCommands": ["git"],
    "deniedCommands": ["format", "rm -rf /", "del /f /s /q C:\\*"]
  },
  "gateway": {
    "port": 3000,
    "host": "127.0.0.1",
    "openBrowser": false,
    "allowSkillCreation": false
  },
  "systemOne": {
    "enabled": true,
    "device": "auto",
    "complexityRouting": true,
    "riskGating": true,
    "toolShortlisting": true,
    "selfHealTriage": true
  },
  "selfHeal": {
    "enabled": true,
    "autoCommit": false,
    "testCommand": "npm test",
    "maxHealAttempts": 1,
    "maxSubagentSteps": 6
  }
}
```

---

## Model Providers

OM provides seamless abstraction across cloud and self-hosted models:

| Provider | Type | Supported Models | Configuration |
|:---|:---|:---|:---|
| **Mock / OM** | Offline Simulator | `om-v1`, `om-turbo`, `om-reasoning` | Built-in (zero key required) |
| **Google Gemini** | Cloud API | `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-2.5-flash` | `GEMINI_API_KEY` |
| **OpenAI** | Cloud API | `gpt-5-mini-2025-08-07`, `gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini` | `OPENAI_API_KEY` |
| **Anthropic** | Cloud API | `claude-3-5-sonnet-20241022`, `claude-3-opus` | `ANTHROPIC_API_KEY` |
| **DeepSeek** | Cloud API | `deepseek-reasoner`, `deepseek-chat` | `DEEPSEEK_API_KEY` |
| **Kimi (Moonshot)** | Cloud API | `kimi-latest` | `KIMI_API_KEY` |
| **Qwen (DashScope)** | Cloud API | `qwen-max`, `qwen-plus` | `QWEN_API_KEY` |
| **GLM (Zhipu)** | Cloud API | `glm-4-flash`, `glm-4-plus` | `GLM_API_KEY` |
| **Ollama** | Local / Offline | `llama3.2`, `mistral`, `qwen2.5`, `deepseek-r1` | `OLLAMA_BASE_URL` |
| **LM Studio** | Local / Offline | Any loaded local model (OpenAI-compatible) | `LMSTUDIO_BASE_URL` |
| **vLLM** | Local / High-Throughput | Any served model endpoint | `VLLM_BASE_URL` / `om.config.json` |

---

## Interactive CLI & Slash Commands

When running in interactive mode (`node bin/om.js`), you can control the agent dynamically using slash commands:

| Command | Arguments | Description |
|:---|:---|:---|
| `/help` | — | Display all available commands and shortcuts. |
| `/cloud` | `[model]` | Switch active provider to cloud inference (Gemini, OpenAI, Claude). |
| `/local` | `[model]` | Switch active provider to local inference (Ollama, Mock). |
| `/provider` | `[name] [model]` | Inspect or switch provider (`gemini`, `openai`, `anthropic`, `ollama`, `mock`). |
| `/models` | `[provider]` | List available models, context window limits, and active tags. |
| `/model` | `<name>` | Switch the active model for the current provider. |
| `/skills` | — | Display all loaded skills and their JSON schemas. |
| `/memory` | — | Print the current contents of `memory/MEMORY.md`. |
| `/journal` | — | Print today's chronological activity log. |
| `/clear` | — | Reset the current conversation context and trajectory. |
| `/gateway` | — | Launch the background Web Gateway dashboard at `http://localhost:3000`. |
| `/exit` | — | Gracefully terminate the OM session. |

---

## Built-in Skills Catalog

The agent ships with a suite of built-in operator skills:

| Skill | Parameters | Description |
|:---|:---|:---|
| `exec_command` | `command`, `cwd?`, `timeoutMs?` | Execute shell commands (PowerShell / Bash) with output capture. |
| `read_file` | `path`, `startLine?`, `endLine?` | Read file contents with optional line-range windowing. |
| `write_file` | `path`, `content` | Create or overwrite files safely on disk. |
| `list_dir` | `path?` | List files and directories with sizes and timestamps. |
| `patch_file` | `path`, `targetText`, `replacementText` | Perform precise, in-place string replacements in files. |
| `search_files` | `query`, `dir?`, `maxResults?` | Recursively search files for keyword or regex matches. |
| `search_web` | `query`, `maxResults?` | Search the web for live information and summaries. |
| `fetch_page` | `url`, `maxChars?` | Fetch web pages and convert HTML directly to clean Markdown. |
| `http_request` | `url`, `method`, `headers`, `body` | Generic HTTP client for interacting with REST APIs. |
| `save_memory` | `fact`, `category?` | Persist key facts and preferences into `MEMORY.md` and index vector embeddings. |
| `read_memory` | — | Retrieve the complete contents of `MEMORY.md`. |
| `search_memory` | `query`, `topK?`, `sourceFilter?` | Hybrid keyword + 256-dim local vector semantic search across memory, sessions, and journals. |
| `index_knowledge` | `title`, `content` | Chunk and embed project documentation into the local vector store. |
| `distill_memory` | `date?`, `prune?` | Run zero-token algorithmic distillation on daily journals and session logs. |
| `get_system_info` | — | Inspect host OS, CPU architecture, RAM, and Node runtime specs. |
| `get_current_time`| — | Retrieve formatted local time, ISO 8601 timestamp, and timezone. |
| `list_models` | `provider?` | Query available models and capabilities for any supported provider. |
| `git_status` | — | Inspect working tree status, branch, and modified/untracked files. |
| `git_diff` | `staged?`, `file?` | View git diff for working tree or staged changes. |
| `git_branch` | `name?`, `checkout?` | List, create, or switch git branches. |
| `spawn_subagent` | `task`, `isolated?`, `gitWorktree?` | Delegate a subtask to an autonomous child agent (with optional git worktree isolation). |

---

## Extending Skills & Workflows

OM supports two modular ways to extend agent capabilities:

### 1. JavaScript Tool Modules

Drop any `.js` file into `./skills/`. OM automatically detects, validates, and registers it on startup:

```javascript
// skills/calculator.js
export const skill = {
  name: 'calculate',
  description: 'Evaluate mathematical expressions safely',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Arithmetic expression (e.g., "12 * 45")' }
    },
    required: ['expression']
  },
  execute: async ({ expression }) => {
    // Implement tool logic
    const sanitized = expression.replace(/[^0-9+\-*/().]/g, '');
    const result = Function(`'use strict'; return (${sanitized})`)();
    return { success: true, result };
  }
};
```

### 2. Markdown Agent Workflows (`SKILL.md`)

Create complex, prompt-guided multi-step workflows by creating a folder in `./skills/<name>/SKILL.md`:

```markdown
---
name: code-review
description: Comprehensive security and quality code reviewer
---

# Code Review Workflow

When activated, perform the following steps:
1. Identify modified files using git or directory listing.
2. Inspect functions for security vulnerabilities (injection, unsanitized input).
3. Validate test coverage and error handling.
4. Output a prioritized markdown report.
```

Trigger workflow skills in conversation or via slash syntax (e.g., `/code-review`).

---

## Programmatic API

Embed OM directly into your Node.js applications:

```javascript
import { OM } from './dist/index.js';

// 1. Initialize the agent
const agent = new OM({
  provider: 'mock', // or 'gemini', 'openai', 'ollama'
  maxSteps: 10
});

await agent.init();

// 2. Subscribe to real-time execution events
agent.on('start', ({ prompt, sessionId }) => {
  console.log(`[Session ${sessionId}] Started task: "${prompt}"`);
});

agent.on('thought', ({ step, content }) => {
  console.log(`[Step ${step}] Thought: ${content}`);
});

agent.on('tool_start', ({ name, args, step }) => {
  console.log(`[Step ${step}] Invoking tool: ${name}`);
});

agent.on('tool_end', ({ name, result, success }) => {
  console.log(`Tool ${name} completed (Success: ${success})`);
});

agent.on('done', (completion) => {
  console.log('\nTask finished:', completion.content);
});

// 3. Execute task
const response = await agent.run('Check available memory and write a summary to system_report.txt');
console.log('Result:', response.content);
```

---

## Gateway REST & SSE Endpoints

When launched via `npm run gateway`, OM serves a lightweight HTTP server on port `3000`:

| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/` | Web Console Dashboard UI. |
| `GET` | `/api/status` | Runtime status, active provider, model, and memory paths. |
| `GET` | `/api/device-specs` | Inspect host hardware specs and `OMSystemOne` engine status. |
| `GET` | `/api/events` | Real-time SSE stream for live provider & skills updates. |
| `GET` | `/api/activity` | Live activity trace history & router stats. |
| `GET` | `/api/models` | List available models discovered across cloud and local engines. |
| `POST` | `/api/provider` | Switch active provider and model dynamically. |
| `GET` / `POST` | `/api/routing` | Inspect or update multi-model routing & fallback chain settings. |
| `POST` | `/api/providers/keys` | Update or clear provider API keys in memory and `.env`. |
| `GET` | `/api/skills` | JSON schema catalog of all registered tools and workflows. |
| `GET` | `/api/skills/:skill/references/:ref` | Fetch reference documentation attached to skills. |
| `POST` | `/api/skills/create` | Programmatically scaffold a new tool or workflow. |
| `GET` | `/api/memory` | Retrieve contents of `MEMORY.md` and today's activity journal. |
| `POST` | `/api/memory` | Update long-term memory (`{ "content": "..." }`). |
| `GET` | `/api/memory/search` | Hybrid keyword + vector semantic search over memory. |
| `POST` | `/api/memory/reindex` | Rebuild local vector embeddings index. |
| `POST` | `/api/memory/distill` | Distill daily insights and promote `SKILL.md` workflows. |
| `GET` | `/api/memory/distill/status` | Check memory distillation status. |
| `POST` | `/api/training/export` | Export SFT/DPO JSONL training datasets. |
| `GET` | `/api/git/status` | Inspect workspace git status. |
| `GET` | `/api/git/diff` | Inspect workspace git diff. |
| `GET` | `/api/agents` | List configured one-off/persistent agents and run history. |
| `POST` | `/api/agents/run` | Execute a one-off or persistent agent task. |
| `POST` | `/api/agents/runs/:id/abort` | Abort an active agent run. |
| `GET` | `/api/agents/runs/:id/diff` | Inspect git diff for an agent run. |
| `POST` | `/api/agents/runs/:id/rollback` | Roll back changes from an agent run. |
| `POST` | `/api/agents/persistent` | Create or update a persistent agent definition. |
| `POST` | `/api/agents/runs/clear` | Clear agent run history. |
| `POST` | `/api/agents/oneoff/clear` | Clear one-off agent runs. |
| `POST` | `/api/agents/persistent/clear` | Clear persistent agent definitions. |
| `POST` | `/api/agents/reset` | Reset agent state and run history. |
| `GET` / `POST` | `/api/agents/detached` | List or spawn detached background swarm workers (`/spawn`, `/:id/resume`, `/:id/fork`, `/:id/stop`). |
| `GET` | `/api/sessions` | List recorded sessions with timestamps and step counts. |
| `POST` | `/api/sessions/switch` | Switch the active session. |
| `POST` | `/api/sessions/:id/fork` | Fork a session from a specific step. |
| `POST` | `/api/sessions/:id/replay` | Replay a session deterministically. |
| `POST` | `/api/compare` | Compare outputs across multiple models/providers on a prompt or session. |
| `GET` | `/api/sessions/:id/export` | Export session transcripts in Markdown or JSON format. |
| `POST` | `/api/clear` | Clear active conversation history without changing `sessionId`. |
| `POST` | `/api/sessions/reset-counter` | Clear session histories and reset identifier counter. |
| `GET` / `POST` | `/api/system-prompt` | Retrieve or update agent system prompt and temperature. |
| `POST` | `/api/chat` | Synchronous execution endpoint returning JSON response. |
| `POST` | `/api/chat/stream` | Server-Sent Events (SSE) streaming thoughts and tool events. |
| `POST` | `/api/chat/abort` | Abort an active agent run. |
| `POST` | `/api/chat/steer` | Inject a live mid-run steering directive. |
| `POST` | `/api/approvals/:id` | Resolve a pending HITL tool/shell confirmation. |
| `GET` | `/api/snapshots` | List workspace snapshots for diffing and rollback. |
| `GET` | `/api/snapshots/:id/diff` | Inspect diff for a specific workspace snapshot. |
| `POST` | `/api/snapshots/:id/rollback` | Roll back workspace to a specific snapshot. |
| `GET` | `/api/daemon/status` | Inspect background daemon and webhook trigger status. |

---

## Autonomous Self-Healing & Detached Execution

- **Hardware-Adaptive System 1 (`OMSystemOne`)**: `src/systemOne.ts` and `src/deviceSpecs.ts` provide local complexity routing, risk gating, tool shortlisting, and self-heal triage with automatic GPU/CPU hardware profiling.
- **Autonomous Self-Healing (`OMSelfHealer`)**: When enabled (`selfHeal.enabled` in `om.config.json`), tool failures or unhandled errors in the ReAct loop can spawn a scoped diagnostic subagent (`src/selfHeal.ts`) to inspect stack traces, apply a minimal patch, verify against `testCommand` (`npm test`), and roll back automatically if tests fail.
- **Detached Swarm & Checkpointing**: Background worker processes (`src/agent/detachedSwarm.ts`, `src/agent/detachedWorker.ts`) and run state checkpoints (`src/agent/checkpoint.ts`) support resilient, multi-worker execution outside the main process.
- **Memory Distillation**: `src/memory/distiller.ts` distills session and daily logs into durable long-term memory and reusable `SKILL.md` workflows.
- **Workspace Isolation**: `workspaceDir` in `om.config.json` (`.`, or `./workspace` for sandboxed runs) controls where agent-generated files are anchored.

---

## Security, Sandboxing & Multi-User RBAC

- **OS & Container Sandboxing (`src/skills/sandbox.ts`)**: `exec_command` supports configurable sandboxing (`off`, `auto`, `os`, `container`) with automatic backend detection across `bwrap`, `wsl-bwrap`, `win-job`, `sandbox-exec`, `docker`, and `podman`, plus resource caps (`memoryMb`, `cpus`, `maxProcesses`, `maxOutputBytes`) and network isolation (`allowNetwork`).
- **Multi-User Authentication & RBAC (`src/gateway/auth.ts`)**: The Web Gateway supports `local` and `multiuser` auth modes with SHA-256 hashed tokens, HS256 JWT verification, and role-based access control (`viewer < operator < admin`).
- **Per-Tenant Storage Isolation (`src/gateway/tenantManager.ts`)**: In multi-user mode, each tenant receives isolated `memoryDir` and `workspaceDir` directories with TTL-based idle instance eviction.
- **HITL Guardrails & Secret Redaction**: Configurable shell/tool approval prompts (`security.requireConfirmationForShell`, `allowedCommands`, `deniedCommands`) and secret redaction (`src/utils/redact.ts`).

---

## Project Layout

```
OMega/
├── .github/
│   └── workflows/
│       └── ci.yml             # Manual CI workflow (typecheck, build, unit & E2E tests)
├── bin/
│   └── om.js                  # CLI executable and interactive REPL
├── src/                       # TypeScript source (compiled to dist/)
│   ├── index.ts               # Library entry point & programmatic exports
│   ├── agent.ts               # ReAct loop coordinator (OMAgent)
│   ├── agent/                 # Compaction, prompt builder, runner, slash commands, checkpoints & detached swarm
│   ├── config.ts              # Environment and JSON config loader
│   ├── deviceSpecs.ts         # Host hardware & OMSystemOne telemetry
│   ├── systemOne.ts           # Hardware-adaptive System 1 decision engine
│   ├── memory.ts              # Markdown and session persistence manager
│   ├── memory/                # Chunker, distiller & session helpers
│   ├── cli/                   # CLI project scaffolder (init.ts)
│   ├── utils/                 # HTTP/SSE stream, logger & secret redaction utilities
│   ├── modelService.ts        # Multi-provider model discovery service
│   ├── daemon.ts              # Background daemon & webhook triggers
│   ├── eval.ts                # Autonomous evaluation runner (OMEvalRunner)
│   ├── git.ts                 # Git status, diff, branch, worktree manager
│   ├── replay.ts              # Deterministic session replay & model comparison
│   ├── selfHeal.ts            # Autonomous framework self-healing (OMSelfHealer)
│   ├── selfImprove.ts         # Tier 1 self-improvement & skill distillation
│   ├── snapshot.ts            # Workspace snapshot & rollback manager
│   ├── tokenizer.ts           # Zero-dependency BPE & model-aware tokenizer
│   ├── training.ts            # Tier 2 SFT/DPO JSONL export & gating
│   ├── mcp/                   # Streamable HTTP MCP client
│   ├── vectorStore/           # Local JSON & node:sqlite vector stores
│   ├── gateway/
│   │   ├── server.ts          # HTTP REST & SSE Gateway server
│   │   ├── auth.ts            # Multi-user JWT/token auth & RBAC (viewer/operator/admin)
│   │   ├── tenantManager.ts   # Per-tenant memory/workspace isolation & TTL eviction
│   │   ├── httpUtils.ts       # Shared HTTP request/response helpers
│   │   ├── agentManager.ts    # One-off & persistent agent orchestration
│   │   ├── routes/            # Modular REST route handlers (agents, config, git, memory, sessions)
│   │   └── public/            # Modular Web Dashboard (app.ts, agents.ts, partials/, styles/)
│   ├── providers/             # LLM provider implementations & ModelRouter
│   │   ├── base.ts            # Base provider interface
│   │   ├── gemini.ts          # Google Gemini integration
│   │   ├── openai.ts          # OpenAI / OpenAI-compatible client (Ollama, LM Studio, vLLM, DeepSeek, Kimi, Qwen, GLM)
│   │   ├── anthropic.ts       # Anthropic Claude client
│   │   ├── omega.ts           # Built-in OMega local/mock provider
│   │   └── router.ts          # Multi-model routing, budgets & failover
│   └── skills/                # Built-in tool implementations
│       ├── sandbox.ts         # OS & container sandboxing (bwrap, win-job, sandbox-exec, docker, podman)
│       ├── shell.ts           # Sandboxed shell execution
│       ├── filesystem.ts      # File reading, writing, patching
│       ├── git.ts             # Git status, diff, branch tools
│       ├── subagent.ts        # Subagent spawning with worktree isolation
│       ├── web.ts             # Web fetch and HTML-to-Markdown
│       ├── system.ts          # System info and time inspection
│       └── memory.ts          # Memory reading and persistence
├── scripts/
│   └── security-audit.js      # Workspace security audit script
├── skills/                    # Drop-in custom skills and workflows
├── memory/                    # Persistent storage (MEMORY.md, daily, sessions)
├── workspace/                 # Default sandboxed workspaceDir for agent outputs
├── tests/                     # Built-in node:test suite, frontend integrity & Playwright E2E tests
├── om.config.json             # Framework runtime configuration
└── package.json               # Manifest (ESM, Node.js >= 18)
```

---

## Testing & Autonomous Benchmarking

Run the TypeScript build and native test/evaluation suite (covering tool-calling accuracy, multi-step planning, error recovery, local-to-cloud model failover, vector semantic search, gateway routes, multi-user RBAC, detached swarms, frontend integrity, and security boundaries):

```bash
npm test
# or run the standalone benchmark suite:
npm run benchmark
# or run type-checking and Playwright UI E2E tests:
npm run check:types
npm run test:e2e
```

All 127 unit & integration tests pass using Node's built-in `node:test` runner with zero external unit-test frameworks required (Playwright is used for `test:e2e`).

---

## License

This project is licensed under the [MIT License](LICENSE).  
Designed for developers building self-hosted, hackable, and local-first AI agents.
