#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { OMAgent } from '../dist/agent.js';
import { startGateway } from '../dist/gateway/server.js';
import { runInitCommand } from '../dist/cli/init.js';
import { SessionReplay } from '../dist/replay.js';
import { OMDaemon } from '../dist/daemon.js';
import { AgentManager } from '../dist/gateway/agentManager.js';
import { OMEvalRunner } from '../dist/eval.js';
import { OMSelfImprover } from '../dist/selfImprove.js';
import { OMTrainingPipeline } from '../dist/training.js';

// ANSI terminal colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  skyBlue: '\x1b[38;2;238;179;70m',
  cyan: '\x1b[38;2;222;148;34m',
  magenta: '\x1b[35m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

// Track output lines emitted after the banner so we can update the banner in-place
let linesSinceBanner = null;
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);

function countRenderedLines(args) {
  const str = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const cols = output.columns || 80;
  const rawLines = str.split('\n');
  let total = 0;
  for (const line of rawLines) {
    const visible = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    total += Math.max(1, Math.ceil((visible.length || 1) / cols));
  }
  return total;
}

console.log = (...args) => {
  if (linesSinceBanner !== null) {
    linesSinceBanner += countRenderedLines(args);
  }
  origConsoleLog(...args);
};

console.error = (...args) => {
  if (linesSinceBanner !== null) {
    linesSinceBanner += countRenderedLines(args);
  }
  origConsoleError(...args);
};

// Track whether the banner is pinned at the top of the current screen
let bannerAtTop = false;

function printBanner(config, skillsCount, clearFirst = false) {
  if (clearFirst && output.isTTY) {
    output.write('\x1b[2J\x1b[H');
    bannerAtTop = true;
    linesSinceBanner = 0;
  }
  origConsoleLog(`
${C.bold}${C.skyBlue}  ██████╗ ${C.cyan}███╗   ███╗${C.reset}    ${C.bold}${C.skyBlue}OM — AI Agent Framework${C.reset}
${C.bold}${C.skyBlue} ██╔═══██╗${C.cyan}████╗ ████║${C.reset}    ${C.gray}Local-first operator runtime${C.reset}
${C.bold}${C.skyBlue} ██║   ██║${C.cyan}██╔████╔██║${C.reset}
${C.bold}${C.skyBlue} ██║   ██║${C.cyan}██║╚██╔╝██║${C.reset}    ${C.gray}Provider:${C.reset}  ${C.skyBlue}${config.provider}${C.reset} [${config.model}]
${C.bold}${C.skyBlue} ╚██████╔╝${C.cyan}██║ ╚═╝ ██║${C.reset}    ${C.gray}Skills:${C.reset}    ${C.skyBlue}${skillsCount} loaded${C.reset}
${C.bold}${C.skyBlue}  ╚═════╝ ${C.cyan}╚═╝     ╚═╝${C.reset}    ${C.gray}Memory:${C.reset}    ${C.dim}${config.memoryDir}${C.reset}
`);
}

/**
 * Update the Provider and Skills lines directly in the top banner in-place without corrupting layout
 */
function updateBannerInPlace(config, skillsCount) {
  if (!output.isTTY || !bannerAtTop) return;
  const rows = output.rows || 30;
  // Only update in place if the terminal hasn't scrolled the top banner off-screen
  if ((linesSinceBanner || 0) + 10 >= rows) return;

  const providerLine = `${C.bold}${C.skyBlue} ██║   ██║${C.cyan}██║╚██╔╝██║${C.reset}    ${C.gray}Provider:${C.reset}  ${C.skyBlue}${config.provider}${C.reset} [${config.model}]`;
  const skillsLine = `${C.bold}${C.skyBlue} ╚██████╔╝${C.cyan}██║ ╚═╝ ██║${C.reset}    ${C.gray}Skills:${C.reset}    ${C.skyBlue}${skillsCount} loaded${C.reset}`;
  // Row 5 is Provider, Row 6 is Skills when banner is at the top of the screen
  output.write(
    `\x1b[s` +
    `\x1b[5;1H\x1b[2K${providerLine}` +
    `\x1b[6;1H\x1b[2K${skillsLine}` +
    `\x1b[u`
  );
}

function printHelp() {
  const commands = [
    ['/help', 'Show this help message'],
    ['/cloud [model]', 'Switch inference to cloud models (Gemini, GPT, Claude)'],
    ['/local [model]', 'Switch inference to local models (vLLM, LM Studio, OM)'],
    ['/provider [name] [model]', 'View or switch active provider (gemini, openai, anthropic, vllm, lmstudio, om)'],
    ['/models [provider]', 'List available models (e.g. Gemini, Gpt)'],
    ['/model <name>', 'Switch the active model for the current provider'],
    ['/skills', 'List all registered skills and signatures'],
    ['/memory', 'Display contents of long-term MEMORY.md'],
    ['/journal', "Display today's activity journal log"],
    ['/clear', 'Clear screen and conversation clean as new (keeps session)'],
    ['/new', 'Start a brand new conversation session'],
    ['/undo [runId]', 'Rollback workspace file changes from the last (or given) run'],
    ['/fork <step>', 'Fork current session from a specific step into a new branch'],
    ['/compare <prompt>', 'Compare active model vs local om-turbo on the same prompt'],
    ['/distill', 'Distill daily journals & sessions into long-term memory'],
    ['/gateway', 'Launch the OM Web UI Gateway dashboard'],
    ['/exit', 'Exit OM']
  ];
  const padWidth = 26;
  const lines = commands.map(([cmd, desc]) => `  ${C.cyan}${cmd.padEnd(padWidth)}${C.reset}${desc}`).join('\n');
  console.log(`\n${C.bold}Available Slash Commands:${C.reset}\n${lines}\n`);
}

async function handleListModels(agent, providerName) {
  let targetProvider = (providerName || agent.config.provider || 'gemini').toLowerCase();
  const displayProvider = (targetProvider === 'openai' || targetProvider === 'chatgpt') ? 'gpt' : targetProvider;
  console.log(`\n${C.skyBlue}> Querying available models for ${C.bold}${displayProvider}${C.reset}...`);
  try {
    const models = await agent.listModels(targetProvider);
    if (!models || models.length === 0) {
      console.log(`\n${C.yellow}! No models returned for provider '${displayProvider}'.${C.reset}\n`);
      return;
    }

    console.log(`\n${C.bold}Available Models for ${C.skyBlue}${displayProvider}${C.reset} (${models.length} models):\n`);

    const activeModel = (agent.config.model || '').toLowerCase().replace(/^models\//, '');
    for (const m of models) {
      const isCurrent = activeModel && (
        m.id.toLowerCase() === activeModel ||
        m.name.toLowerCase() === activeModel ||
        m.id.toLowerCase() === activeModel.replace(/^models\//, '')
      );
      const activeBadge = isCurrent ? ` ${C.green}${C.bold}[ACTIVE]${C.reset}` : '';
      const idStr = `${C.bold}${C.skyBlue}${m.id.padEnd(34)}${C.reset}`;
      const nameStr = m.displayName && m.displayName !== m.id ? `${C.reset}${m.displayName}` : '';

      let limits = '';
      if (m.inputTokenLimit || m.outputTokenLimit) {
        const inTok = m.inputTokenLimit ? `${m.inputTokenLimit >= 1000000 ? `${(m.inputTokenLimit / 1000000).toFixed(1)}M` : `${Math.round(m.inputTokenLimit / 1000)}k`} in` : '';
        const outTok = m.outputTokenLimit ? `${m.outputTokenLimit >= 1000000 ? `${(m.outputTokenLimit / 1000000).toFixed(1)}M` : `${Math.round(m.outputTokenLimit / 1000)}k`} out` : '';
        const parts = [inTok, outTok].filter(Boolean).join(' / ');
        if (parts) limits = ` ${C.dim}(${parts})${C.reset}`;
      }

      console.log(`  * ${idStr} ${nameStr}${limits}${activeBadge}`);
      if (m.description) {
        const desc = m.description.length > 90 ? m.description.slice(0, 87) + '...' : m.description;
        console.log(`    ${C.dim}${desc}${C.reset}`);
      }
    }

    console.log(`\n${C.dim}Tip: Switch model using ${C.skyBlue}/model <name>${C.dim} (e.g. ${C.skyBlue}/model ${models[0]?.id}${C.dim})${C.reset}\n`);
  } catch (err) {
    console.log(`\n${C.red}x Failed to list models: ${err.message}${C.reset}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Subcommand: init (npx omega-agent init [dir] [--force])
  if (args[0] === 'init' || args.includes('--init')) {
    const dirArg = args[1] && !args[1].startsWith('-') ? args[1] : process.cwd();
    const force = args.includes('--force') || args.includes('-f');
    await runInitCommand({ targetDir: dirArg, force });
    return;
  }

  // Subcommand: gateway
  if (args[0] === 'gateway' || args.includes('--gateway')) {
    await startGateway();
    return;
  }

  // Subcommand: models / list-models
  if (args[0] === 'models' || args[0] === 'list-models' || args[0] === 'listmodels' || args.includes('--models')) {
    const providerArg = args[1] && !args[1].startsWith('-') ? args[1] : undefined;
    const agent = new OMAgent();
    await handleListModels(agent, providerArg);
    return;
  }

  // Help flag
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
OM (omega-agent) — AI Agent Framework CLI
Usage:
  npx omega-agent init [dir]   Scaffold a new OMega project, template skills, and secure .env
  om                           Start interactive agent REPL
  om "<instruction>"           Run single task and exit
  om models [provider]         List available models (e.g. Gemini, Gpt)
  om gateway                   Start OM Web UI Gateway dashboard
  om --help                    Show this help
`);
    return;
  }

  // Parse inline flags (e.g. --provider openai)
  const overrides = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) {
      overrides.provider = args[i + 1];
      args.splice(i, 2);
      i--;
    } else if (args[i] === '--model' && args[i + 1]) {
      overrides.model = args[i + 1];
      args.splice(i, 2);
      i--;
    }
  }

  if (args[0] === 'eval') {
    const suitePath = args[1];
    if (!suitePath) {
      console.error(`${C.red}Usage: om eval <suite.json>${C.reset}`);
      process.exit(1);
    }
    const suite = OMEvalRunner.loadSuite(suitePath);
    const report = await OMEvalRunner.runSuite(suite, {
      provider: overrides.provider,
      model: overrides.model
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args[0] === 'distill') {
    const distillAgent = new OMAgent(overrides);
    await distillAgent.init();
    const res = await OMSelfImprover.distill(distillAgent);
    console.log(JSON.stringify(res, null, 2));
    await distillAgent.close();
    return;
  }

  if (args[0] === 'export-training') {
    const tmpAgent = new OMAgent(overrides);
    const outDir = args[1];
    const res = OMTrainingPipeline.exportDataset(tmpAgent.config.memoryDir, outDir);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (args[0] === 'daemon') {
    const daemonAgent = new OMAgent(overrides);
    await daemonAgent.init();
    const daemon = new OMDaemon(daemonAgent).loadFromConfig(daemonAgent.config);
    daemon.on('trigger_run', (rec) => {
      console.log(`${C.green}[Daemon] Trigger '${rec.triggerId}' completed (${rec.finishedAt})${C.reset}`);
    });
    daemon.on('trigger_error', (rec) => {
      console.error(`${C.red}[Daemon] Trigger '${rec.triggerId}' failed: ${rec.error}${C.reset}`);
    });
    await daemon.start();
    const agentManager = new AgentManager(daemonAgent, {
      onUpdate: (ev) => {
        if (ev.type === 'run_finished') {
          console.log(`${C.green}[Persistent Agent] Run '${ev.runId}' finished (${ev.status})${C.reset}`);
        }
      }
    });
    const enabledAgents = Array.from(agentManager.persistentAgents.values()).filter((a) => a.enabled);
    console.log(`${C.skyBlue}[OMega Daemon] Running with ${daemon.triggers.size} trigger(s) and ${enabledAgents.length} persistent agent(s). Press Ctrl+C to stop.${C.reset}`);
    process.on('SIGINT', () => {
      agentManager.dispose();
      daemon.stop();
      process.exit(0);
    });
    return;
  }

  const agent = new OMAgent(overrides);
  await agent.init();

  // Setup streaming event listeners for CLI
  agent.on('thought', ({ step, content }) => {
    console.log(`\n${C.magenta}[Step ${step} Thought]:${C.reset} ${C.dim}${content}${C.reset}`);
  });

  agent.on('tool_start', ({ name, args: tArgs }) => {
    console.log(`\n${C.skyBlue}[Tool Call]: ${C.bold}${name}${C.reset}(${C.dim}${JSON.stringify(tArgs)}${C.reset})`);
  });

  agent.on('tool_end', ({ name, durationMs, result }) => {
    const status = result?.success !== false ? `${C.skyBlue}+ Success${C.reset}` : `${C.red}x Failed${C.reset}`;
    console.log(`${C.gray}   └─ ${status} (${durationMs}ms)`);
  });

  agent.on('fallback', ({ fromProvider, fromModel, toProvider, toModel, reasonType }) => {
    console.log(`\n${C.yellow}[Model Failover]:${C.reset} Handed off from ${C.bold}${fromProvider}/${fromModel}${C.reset} → ${C.skyBlue}${C.bold}${toProvider}/${toModel}${C.reset} (${reasonType})`);
  });

  // If a prompt was provided directly via command line: `om "inspect disk"`
  const directPrompt = args.join(' ').trim();
  if (directPrompt) {
    console.log(`${C.skyBlue}> Executing task:${C.reset} ${directPrompt}`);
    try {
      const res = await agent.run(directPrompt);
      console.log(`\n${C.bold}${C.skyBlue}> Final Answer:${C.reset}\n${res.content}\n`);
    } catch (err) {
      console.error(`${C.red}Error:${C.reset} ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Interactive REPL Mode
  agent.startWatching();
  printBanner(agent.config, agent.skills.list().length, true);
  console.log(`${C.dim}Type your task below, or ${C.reset}${C.skyBlue}/help${C.reset}${C.dim} for commands. Press Ctrl+C to exit.${C.reset}\n`);

  agent.on('config_updated', ({ provider, model, skillsCount: newSkillsCount }) => {
    updateBannerInPlace({ provider, model }, newSkillsCount);
  });

  const rl = readline.createInterface({ input, output });

  while (true) {
    try {
      const line = await rl.question(`${C.bold}${C.skyBlue}om > ${C.reset}`);
      if (linesSinceBanner !== null) {
        linesSinceBanner += 1;
      }
      const trimmed = line.trim();

      if (!trimmed) continue;

      if (trimmed === '/exit' || trimmed === '/quit') {
        agent.stopWatching();
        console.log(`${C.gray}Goodbye!${C.reset}`);
        rl.close();
        break;
      }

      if (trimmed === '/help') {
        printHelp();
        continue;
      }

      // Check for ModelService.ListModels / /models commands
      if (
        /^(?:\/?models|\/?listmodels|\/?list-models|\/?modelservice\.listmodels|modelservice\.listmodels)(?:\s+|$)/i.test(trimmed) ||
        /^\/model\s+list\b/i.test(trimmed)
      ) {
        const parts = trimmed.replace(/^\//, '').split(/\s+/);
        let targetProvider;
        if (parts[0].toLowerCase() === 'model' && parts[1]?.toLowerCase() === 'list') {
          targetProvider = parts[2];
        } else if (parts.length > 1 && parts[1].toLowerCase() !== 'list') {
          targetProvider = parts[1];
        }
        await handleListModels(agent, targetProvider);
        continue;
      }

      const cmdInput = /^(?:provider|provide|model)\b/i.test(trimmed) ? `/${trimmed}` : trimmed;

      if (
        cmdInput.startsWith('/provider') ||
        cmdInput.startsWith('/provide') ||
        /^\/(gemini|google|openai|gpt|chatgpt|anthropic|claude|vllm|lmstudio|om|omega|mock)(\s+|$)/i.test(cmdInput)
      ) {
        const isDirect = !cmdInput.startsWith('/provide');
        const parts = cmdInput.slice(1).split(/\s+/);
        if (!isDirect && parts.length === 1) {
          console.log(`\n${C.bold}Active Provider:${C.reset} ${C.skyBlue}${agent.config.provider}${C.reset} [${C.skyBlue}${agent.config.model}${C.reset}]`);
          console.log(`${C.gray}Available providers:${C.reset} gemini, openai (gpt), anthropic (claude), vllm, lmstudio, om`);
          console.log(`${C.dim}Usage: /provider <name> [model] (or /gemini, /claude, /gpt, /om)${C.reset}\n`);
        } else {
          const newProvider = (isDirect ? parts[0] : parts[1]).toLowerCase();
          const rawModel = (isDirect ? parts.slice(1) : parts.slice(2)).join('-').toLowerCase();
          let newModel = rawModel || undefined;
          if (newModel) {
            if ((newProvider === 'gemini' || newProvider === 'google') && !newModel.startsWith('gemini-')) {
              newModel = `gemini-${newModel}`;
            } else if ((newProvider === 'anthropic' || newProvider === 'claude') && !newModel.startsWith('claude-')) {
              newModel = `claude-${newModel}`;
            } else if ((newProvider === 'openai' || newProvider === 'gpt' || newProvider === 'chatgpt') && !newModel.startsWith('gpt-') && !newModel.startsWith('o1') && !newModel.startsWith('o3')) {
              newModel = `gpt-${newModel}`;
            }
          }
          try {
            agent.setProvider(newProvider, newModel);
            console.log(`${C.skyBlue}+ Switched provider to:${C.reset} ${C.skyBlue}${agent.config.provider}${C.reset} [${C.bold}${agent.config.model}${C.reset}]\n`);
          } catch (err) {
            console.log(`\n${C.red}x ${err.message}${C.reset}\n`);
          }
        }
        continue;
      }

      if (cmdInput.startsWith('/model')) {
        const parts = cmdInput.split(/\s+/);
        if (parts.length === 1) {
          console.log(`\n${C.bold}Active Model:${C.reset} ${C.skyBlue}${agent.config.model}${C.reset} (${C.skyBlue}${agent.config.provider}${C.reset})`);
          console.log(`${C.dim}Usage: /model <model-name> (use /models to see available models)${C.reset}\n`);
        } else {
          const rawModel = parts.slice(1).join('-').toLowerCase();
          let normalizedModel = rawModel;
          if (agent.config.provider === 'gemini' && !rawModel.startsWith('gemini-') && !rawModel.startsWith('models/')) {
            normalizedModel = `gemini-${rawModel}`;
          } else if (agent.config.provider === 'anthropic' && !rawModel.startsWith('claude-')) {
            normalizedModel = `claude-${rawModel}`;
          }
          try {
            agent.setProvider(agent.config.provider, normalizedModel);
            console.log(`${C.skyBlue}+ Switched model to:${C.reset} ${C.bold}${agent.config.model}${C.reset} (${C.skyBlue}${agent.config.provider}${C.reset})\n`);
          } catch (err) {
            console.log(`\n${C.red}x ${err.message}${C.reset}\n`);
          }
        }
        continue;
      }

      if (trimmed === '/skills') {
        const currentSkills = agent.skills.list();
        console.log(`\n${C.bold}Loaded Skills (${currentSkills.length}):${C.reset}`);
        for (const s of currentSkills) {
          console.log(`  ${C.skyBlue}* ${s.name}${C.reset} - ${C.gray}${s.description}${C.reset}`);
        }
        console.log('');
        continue;
      }

      if (trimmed === '/memory') {
        console.log(`\n${C.bold}Long-Term Memory (MEMORY.md):${C.reset}\n`);
        console.log(agent.memory.readLongTermMemory());
        console.log('');
        continue;
      }

      if (trimmed === '/journal') {
        console.log(`\n${C.bold}Today's Activity Journal:${C.reset}\n`);
        console.log(agent.memory.readDailyJournal() || '(No activities logged today yet)');
        console.log('');
        continue;
      }

      if (trimmed === '/clear') {
        agent.clearCurrentSession();
        printBanner(agent.config, agent.skills.list().length, true);
        console.log(`${C.green}Page cleared.${C.reset}\n`);
        continue;
      }

      if (trimmed === '/new') {
        agent.reset();
        printBanner(agent.config, agent.skills.list().length, true);
        console.log(`${C.green}Started new session (${agent.sessionId}).${C.reset}\n`);
        continue;
      }

      if (trimmed === '/distill') {
        const dRes = await OMSelfImprover.distill(agent);
        console.log(`\n${C.green}Distilled ${dRes.sessionsScanned} session(s), added ${dRes.factsAdded} fact(s) to MEMORY.md.${C.reset}\n`);
        continue;
      }

      if (trimmed === '/gateway') {
        rl.close();
        await startGateway();
        break;
      }

      if (trimmed.startsWith('/undo')) {
        const runId = trimmed.split(/\s+/)[1] || agent.lastRunId;
        if (!runId) {
          console.log(`\n${C.yellow}No run snapshot available to undo.${C.reset}\n`);
          continue;
        }
        const rb = agent.snapshots.rollback(runId);
        if (rb.success) {
          console.log(`\n${C.green}Rolled back ${runId}:${C.reset} restored ${rb.restored.length} file(s), deleted ${rb.deleted.length} created file(s).\n`);
        } else {
          console.log(`\n${C.red}x ${rb.error}${C.reset}\n`);
        }
        continue;
      }

      if (trimmed.startsWith('/fork')) {
        const stepNum = Number(trimmed.split(/\s+/)[1]) || 1;
        try {
          const forked = SessionReplay.forkFromStep(agent.memory, agent.sessionId, stepNum);
          agent.resumeSession(forked.sessionId);
          console.log(`\n${C.green}Forked session at step ${stepNum} -> ${forked.sessionId}${C.reset}\n`);
        } catch (err) {
          console.log(`\n${C.red}x ${err.message}${C.reset}\n`);
        }
        continue;
      }

      if (trimmed.startsWith('/compare ')) {
        const cmpPrompt = trimmed.slice('/compare '.length).trim();
        const cmp = await SessionReplay.compareModels(agent.options, cmpPrompt, [
          { provider: agent.config.provider, model: agent.config.model },
          { provider: 'om', model: 'om-turbo' }
        ]);
        console.log(`\n${C.bold}Model Comparison:${C.reset}`);
        for (const r of cmp.results) {
          console.log(`  ${C.skyBlue}${r.provider}/${r.model}${C.reset} (${r.latencyMs}ms, steps: ${r.totalSteps ?? '-'}): ${String(r.answer || r.error).slice(0, 140)}`);
        }
        console.log('');
        continue;
      }

      if (trimmed.startsWith('/')) {
        const slashName = trimmed.replace(/^\//, '').split(/\s+/)[0]?.toLowerCase();
        if (slashName === 'cloud' || slashName === 'local' || agent.skills.has(slashName)) {
          // Run agent with the workflow directive or cloud/local switch
          const res = await agent.run(trimmed);
          console.log(`\n${C.bold}${C.skyBlue}> Answer:${C.reset}\n${res.content}\n`);
          continue;
        }
        console.log(`\n${C.red}x Unknown slash command: ${trimmed}.${C.reset} Type ${C.skyBlue}/help${C.reset} to see available commands.\n`);
        continue;
      }

      // Run Agent
      const res = await agent.run(trimmed);
      console.log(`\n${C.bold}${C.skyBlue}> Answer:${C.reset}\n${res.content}\n`);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('\nOperation cancelled.');
      } else {
        console.error(`\n${C.red}Error: ${err.message}${C.reset}\n`);
      }
    }
  }
}

main().catch((err) => {
  console.error('[Fatal OM Error]', err);
  process.exit(1);
});
