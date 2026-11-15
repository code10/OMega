# OM (OMega) — AI Agent Framework

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-49%20passed-success.svg)](tests/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](README.md)

> **OM** is a lightweight, local-first autonomous AI agent runtime built with pure Node.js.  
> It empowers developers to execute self-hosted agents that plan, reason, invoke local system tools and external APIs, maintain persistent Markdown memory, and interact via an interactive terminal REPL or real-time Web dashboard.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Environment Variables (.env)](#environment-variables-env)
  - [Application Settings (om.config.json)](#application-settings-omconfigjson)
- [Model Providers](#model-providers)
- [Interactive CLI & Slash Commands](#interactive-cli--slash-commands)
- [Built-in Skills Catalog](#built-in-skills-catalog)
- [Extending Skills & Workflows](#extending-skills--workflows)
  - [1. JavaScript Tool Modules](#1-javascript-tool-modules)
  - [2. Markdown Agent Workflows (SKILL.md)](#2-markdown-agent-workflows-skillmd)
- [Programmatic API](#programmatic-api)
- [Gateway REST & SSE Endpoints](#gateway-rest--sse-endpoints)
- [Project Layout](#project-layout)
- [Testing](#testing)
- [License](#license)

---

## Overview

Modern agentic frameworks often require complex runtime dependencies, external databases, or heavy Python stacks. **OM** takes a local-first, zero-dependency approach:

- **Zero External Dependencies**: Operates entirely on standard Node.js built-ins (`node:events`, `node:fs`, `node:http`, `node:readline`, `node:process`, `node:crypto`).
- **Local-First & Private**: Works completely offline with local model runners (Ollama, LM Studio, vLLM) or a built-in interactive Mock simulator—no credit cards or API keys required to start.
- **Transparent Markdown Memory**: Context, long-term facts, and daily journals are stored as human-readable Markdown files that you can inspect, edit, or commit to Git.
- **Dual Operator Interfaces**: Access the agent via an ANSI-colored interactive terminal REPL or launch a web-based dashboard with Server-Sent Events (SSE) streaming.

---

## Key Features

- **Autonomous ReAct Loop**: Multi-step reasoning and tool execution engine with configurable step budgets, error recovery, and safety guardrails.
- **Smarter Multi-Model Routing & Failover**: Automatic retry and seamless handoff (`ModelRouter`) from local models (Ollama, LM Studio, vLLM) to cloud providers (Gemini, OpenAI, Anthropic) when a local model fails or hits context window limits.
- **Universal Model Abstraction**: Unified interface across Google Gemini, OpenAI (GPT-4o, o-series), Anthropic Claude, Ollama, LM Studio, vLLM, and Mock engines.
- **Dynamic Skill Registry**: Automatic hot-discovery of custom JavaScript tools (`./skills/*.js`) and structured agent workflows (`./skills/*/SKILL.md`).
- **Comprehensive Built-in Tools**: Shell command execution, file manipulation, surgical patching, directory inspection, web fetching with HTML-to-Markdown conversion, and system telemetry.
- **Enhanced Memory with Local Vector Search**:
  - `memory/MEMORY.md`: Curated, long-term project knowledge and user preferences.
  - `memory/daily/YYYY-MM-DD.md`: Timestamped daily activity ledgers.
  - `memory/sessions/session_<id>.json`: Full execution traces and replay trajectories.
  - `memory/vectors.json`: Lightweight 256-dimensional local vector embeddings enabling semantic search across past sessions, journals, and project knowledge bases (`semantic_search_memory` & `index_knowledge`).
- **Polished Web Dashboard & Live Visibility**: Real-time SSE event streaming, collapsible tool-execution traces with arguments/outputs, failover banners, semantic vector search UI, and live visual activity logs.
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
│ Model Engine │         │ SkillRegistry │ │ MemoryEngine │    │ Gateway Server│
├──────────────┤         ├───────────────┤ ├──────────────┤    ├───────────────┤
│ • Mock       │         │ • Shell       │ │ • MEMORY.md  │    │ • HTTP REST   │
│ • Gemini     │         │ • Filesystem  │ │ • Daily Logs │    │ • SSE Stream  │
│ • OpenAI     │         │ • Web Fetcher │ │ • Sessions   │    │ • Web UI      │
│ • Anthropic  │         │ • System Info │ └──────────────┘    └───────────────┘
│ • Ollama     │         │ • ./skills/*  │
│ • LM Studio  │         │ • SKILL.md    │
└──────────────┘         └───────────────┘
```

---

## Quick Start

### 1. Requirements

- **Node.js** `>= 18.0.0`
- Zero external package installation required (`package.json` uses native modules).

### 2. Initialize a New Project via CLI (`npx omega-agent init`)

Scaffold a ready-to-run workspace with template skills, `om.config.json`, and secure `.env` setup:

```bash
npx omega-agent init my-agent
cd my-agent
```

### 3. Launch Interactive Terminal REPL

OM runs immediately using the built-in Mock provider or local models without any API keys:

```bash
# Launch the interactive CLI
npm start
# or: npx omega-agent
```

### 3. Run a One-Shot Autonomous Command

You can pass a prompt directly to execute headlessly:

```bash
node bin/om.js "Inspect system specs, check memory status, and summarize in notes.txt"
```

### 4. Start the Web Dashboard Gateway

```bash
npm run gateway
# or: node bin/om.js gateway
```

Navigate to **`http://localhost:3000`** in your browser to access the visual agent console, live memory viewer, and model switcher.

---

## Configuration

### Environment Variables (`.env`)

Create a `.env` file in the project root to configure your preferred providers:

```ini
# Default provider: mock, gemini, openai, anthropic, ollama, lmstudio, vllm
OM_PROVIDER=mock

# Optional model override
OM_MODEL=om-mock-turbo

# Cloud Provider API Keys
GEMINI_API_KEY=AIzaSy...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Local Inference Server URLs
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:latest
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
```

### Application Settings (`om.config.json`)

Fine-tune agent behavior, paths, security boundaries, and network ports:

```json
{
  "name": "OM Agent",
  "version": "1.0.0",
  "provider": "mock",
  "model": "om-mock-turbo",
  "maxSteps": 15,
  "temperature": 0.2,
  "memoryDir": "./memory",
  "skillsDir": "./skills",
  "workspaceDir": ".",
  "security": {
    "requireConfirmationForShell": false,
    "allowedCommands": [],
    "deniedCommands": ["format", "rm -rf /", "del /f /s /q C:\\*"]
  },
  "gateway": {
    "port": 3000,
    "host": "127.0.0.1",
    "openBrowser": false
  }
}
```

---

## Model Providers

OM provides seamless abstraction across cloud and self-hosted models:

| Provider | Type | Supported Models | Configuration |
|:---|:---|:---|:---|
| **Mock** | Offline Simulator | `om-mock-turbo` | Built-in (default; zero key required) |
| **Google Gemini** | Cloud API | `gemini-2.5-flash`, `gemini-1.5-pro` | `GEMINI_API_KEY` |
| **OpenAI** | Cloud API | `gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini` | `OPENAI_API_KEY` |
| **Anthropic** | Cloud API | `claude-3-5-sonnet-20241022`, `claude-3-opus` | `ANTHROPIC_API_KEY` |
| **Ollama** | Local / Offline | `llama3.2`, `mistral`, `qwen2.5`, `deepseek-r1` | `OLLAMA_BASE_URL` |
| **LM Studio** | Local / Offline | Any loaded local model (OpenAI-compatible) | `LMSTUDIO_BASE_URL` |
| **vLLM** | Local / High-Throughput | Any served model endpoint | Local API endpoint |

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
| `fetch_page` | `url`, `maxChars?` | Fetch web pages and convert HTML directly to clean Markdown. |
| `http_request` | `url`, `method`, `headers`, `body` | Generic HTTP client for interacting with REST APIs. |
| `save_memory` | `fact`, `category?` | Persist key facts and preferences into `MEMORY.md` and index vector embeddings. |
| `read_memory` | — | Retrieve the complete contents of `MEMORY.md`. |
| `search_memory` | `query`, `topK?` | Hybrid keyword + vector semantic search across memory and daily journals. |
| `semantic_search_memory` | `query`, `topK?`, `sourceFilter?` | Query 256-dim local vector embeddings across sessions, journals, and knowledge bases. |
| `index_knowledge` | `title`, `content` | Chunk and embed project documentation into the local vector store. |
| `get_system_info` | — | Inspect host OS, CPU architecture, RAM, and Node runtime specs. |
| `get_current_time`| — | Retrieve formatted local time, ISO 8601 timestamp, and timezone. |
| `list_models` | `provider?` | Query available models and capabilities for any supported provider. |

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
import { OM } from './src/index.js';

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
| `GET` | `/api/models` | List available models discovered across cloud and local engines. |
| `GET` | `/api/skills` | JSON schema catalog of all registered tools and workflows. |
| `GET` | `/api/skills/:skill/references/:ref` | Fetch reference documentation attached to skills. |
| `POST` | `/api/skills/create` | Programmatically scaffold a new tool or workflow. |
| `GET` | `/api/memory` | Retrieve contents of `MEMORY.md` and today's activity journal. |
| `POST` | `/api/memory` | Update long-term memory (`{ "content": "..." }`). |
| `GET` | `/api/sessions` | List recorded sessions with timestamps and step counts. |
| `GET` | `/api/sessions/:id/export` | Export session transcripts in Markdown or JSON format. |
| `POST` | `/api/sessions/reset-counter` | Clear session histories and reset identifier counter. |
| `GET` | `/api/system-prompt` | Retrieve current agent system prompt directive. |
| `POST` | `/api/chat` | Synchronous execution endpoint returning JSON response. |
| `POST` | `/api/chat/stream` | Server-Sent Events (SSE) streaming thoughts and tool events. |

---

## Project Layout

```
OMega/
├── bin/
│   └── om.js                  # CLI executable and interactive REPL
├── src/
│   ├── index.js               # Library entry point & programmatic exports
│   ├── agent.js               # ReAct loop coordinator (OMAgent)
│   ├── config.js              # Environment and JSON config loader
│   ├── memory.js              # Markdown and session persistence manager
│   ├── modelService.js        # Multi-provider model discovery service
│   ├── gateway/
│   │   ├── server.js          # HTTP REST & SSE Gateway server
│   │   └── public/            # Static assets for the Web Dashboard
│   ├── providers/             # LLM provider implementations
│   │   ├── base.js            # Base provider interface
│   │   ├── gemini.js          # Google Gemini integration
│   │   ├── openai.js          # OpenAI / OpenAI-compatible client
│   │   ├── anthropic.js       # Anthropic Claude client
│   │   ├── ollama.js          # Local Ollama runner client
│   │   └── omega.js           # Built-in OMega local provider
│   └── skills/                # Built-in tool implementations
│       ├── shell.js           # Shell execution
│       ├── filesystem.js      # File reading, writing, patching
│       ├── web.js             # Web fetch and HTML-to-Markdown
│       ├── system.js          # System info and time inspection
│       └── memory.js          # Memory reading and persistence
├── skills/                    # Drop-in custom skills and workflows
├── memory/                    # Persistent storage (MEMORY.md, daily, sessions)
├── tests/                     # Built-in node:test test suite
├── om.config.json             # Framework runtime configuration
└── package.json               # Manifest (ESM, zero external dependencies)
```

---

## Testing & Autonomous Benchmarking

Run the native test and autonomous evaluation suite (covering tool-calling accuracy, multi-step planning, error recovery, local-to-cloud model failover, and vector semantic search):

```bash
npm test
# or run the standalone benchmark suite:
npm run benchmark
```

All 49 test and benchmark suites run in under 2 seconds with zero external test frameworks required.

---

## License

This project is licensed under the [MIT License](LICENSE).  
Designed for developers building self-hosted, hackable, and local-first AI agents.
