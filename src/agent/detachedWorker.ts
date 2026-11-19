import fs from 'node:fs';
import { OMAgent } from '../agent.js';
import { loadCheckpoint, saveCheckpoint } from './checkpoint.js';

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile || !fs.existsSync(jobFile)) {
    console.error(`[OMDetachedWorker] Job file not found: ${jobFile}`);
    process.exit(1);
  }

  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const agent = new OMAgent({
    sessionId: job.sessionId,
    provider: job.provider,
    model: job.model,
    systemPrompt: job.systemPrompt,
    maxSteps: job.maxSteps,
    workspaceDir: job.workspaceDir,
    memoryDir: job.memoryDir,
    skillsDir: job.skillsDir
  });

  await agent.init();

  const resumeCheckpoint = job.resume ? loadCheckpoint(agent.config.memoryDir, job.sessionId) : null;

  // Handle graceful SIGTERM by checkpointing paused state
  const handleSignal = async () => {
    try {
      const latest = loadCheckpoint(agent.config.memoryDir, job.sessionId);
      if (latest && latest.status === 'running') {
        saveCheckpoint(agent.config.memoryDir, {
          ...latest,
          status: 'paused',
          pauseReason: 'sigterm',
          pid: null
        });
      }
      await agent.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  try {
    const res = await agent.run(job.prompt, {
      maxSteps: job.maxSteps,
      detached: true,
      logFile: job.logFile,
      resumeCheckpoint,
      budgets: job.budgets,
      swarmId: job.swarmId,
      parentSessionId: job.parentSessionId,
      workspaceMode: job.workspaceMode
    });
    if (res.paused) {
      console.log(`[OMDetachedWorker] Session ${job.sessionId} paused (reason=${res.pauseReason}, steps=${res.totalSteps})`);
    } else {
      console.log(`[OMDetachedWorker] Session ${job.sessionId} completed (steps=${res.totalSteps}, success=${res.success})`);
    }
  } catch (err: any) {
    console.error(`[OMDetachedWorker] Session ${job.sessionId} failed: ${err?.message || err}`);
    process.exitCode = 1;
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error('[OMDetachedWorker] Fatal error:', err);
  process.exit(1);
});
