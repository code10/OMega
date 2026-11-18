import { byId, escapeHtml } from './utils.js';

function renderRows(rows: Array<[string, string]>): string {
  return rows
    .map(
      ([k, v]) =>
        `<div class="config-row"><span class="config-key">${escapeHtml(k)}</span><span class="config-val">${escapeHtml(v)}</span></div>`
    )
    .join('');
}

function formatVram(mb: number): string {
  if (!mb || mb <= 0) return 'Shared / N/A';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB (${mb} MB)` : `${mb} MB`;
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function initDeviceSpecs() {
  const refreshBtn = byId<HTMLButtonElement>('refreshDeviceSpecsBtn');
  const cpuVal = byId('devCpuVal');
  const cpuSub = byId('devCpuSub');
  const gpuVal = byId('devGpuVal');
  const gpuSub = byId('devGpuSub');
  const npuVal = byId('devNpuVal');
  const npuSub = byId('devNpuSub');
  const ramVal = byId('devRamVal');
  const ramSub = byId('devRamSub');
  const layaBadge = byId('devLayaBadge');
  const coreEngineTable = byId('devCoreEngineTable');
  const hardwareTable = byId('devHardwareTable');

  async function loadDeviceSpecs(): Promise<void> {
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const res = await fetch('/api/device-specs');
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to load device specs');
      }

      const { cpu, ram, gpus, npu, system, engine } = data;
      const primaryGpu = (gpus || []).find((g: any) => g.cudaCapable) || gpus?.[0] || null;

      if (cpuVal) cpuVal.textContent = `${cpu.logicalCores} Cores (${cpu.arch})`;
      if (cpuSub) cpuSub.textContent = `${cpu.model}${cpu.speedMhz ? ` · ${cpu.speedMhz} MHz` : ''}`;

      if (gpuVal) gpuVal.textContent = primaryGpu ? formatVram(primaryGpu.vramTotalMb) : 'None';
      if (gpuSub) gpuSub.textContent = primaryGpu ? `${primaryGpu.name}${primaryGpu.cudaCapable ? ' · CUDA' : ''}` : 'No discrete GPU detected';

      if (npuVal) npuVal.textContent = npu?.detected ? `${npu.devices.length} Detected` : 'Not Detected';
      if (npuSub) npuSub.textContent = npu?.detected ? npu.devices.map((d: any) => d.name).join(', ') : 'No dedicated NPU found';

      if (ramVal) ramVal.textContent = `${ram.usedGb} / ${ram.totalGb} GB`;
      if (ramSub) ramSub.textContent = `${ram.freeGb} GB free (${100 - ram.usedPct}% available)`;

      if (layaBadge) {
        const sysOne = engine.systemOne;
        layaBadge.textContent = sysOne.configured
          ? `● System 1 Active (${sysOne.resolvedDevice.toUpperCase()})`
          : '○ System 1 Disabled';
      }

      if (coreEngineTable) {
        const sysOne = engine.systemOne;
        coreEngineTable.innerHTML = renderRows([
          ['Active LLM Provider', `${engine.provider} / ${engine.model} (${engine.target})`],
          ['ModelRouter', `${engine.routing.enabled ? 'Enabled' : 'Disabled'} · ${engine.routing.totalCalls} calls · ${engine.routing.complexityRoutes} complexity routes · ${engine.routing.fallbacks} fallbacks`],
          ['OMega System 1 Engine', sysOne.configured ? `Active (${sysOne.configuredDevice} → ${sysOne.resolvedDevice}, ${sysOne.dtype})` : 'Disabled'],
          ['System 1 Model', sysOne.model],
          ['System 1 Capabilities', `Complexity Routing: ${sysOne.complexityRouting ? 'On' : 'Off'} · Risk Gating: ${sysOne.riskGating ? `On (< ${sysOne.riskThreshold})` : 'Off'} · Tool Shortlisting: ${sysOne.toolShortlisting ? `On (top ${sysOne.toolShortlistK})` : 'Off'} · Self-Heal Triage: ${sysOne.selfHealTriage ? 'On' : 'Off'}`],
          ['Self-Heal Immune System', engine.selfHeal.enabled ? `Enabled (max ${engine.selfHeal.maxHealAttempts} attempts)` : 'Disabled'],
          ['Memory & Embeddings', `${engine.memory.embeddingModel} (${engine.memory.embeddingUrl}) · ${engine.memory.memoryDir}`],
        ]);
      }

      if (hardwareTable) {
        const gpuRows: Array<[string, string]> = (gpus || []).length > 0
          ? gpus.map((g: any, i: number) => [
              `GPU ${i + 1} (${g.vendor})`,
              `${g.name} · VRAM: ${formatVram(g.vramTotalMb)}${g.vramUsedMb !== null ? ` (${g.vramUsedMb} MB used)` : ''}${g.utilizationPct !== null ? ` · Util: ${g.utilizationPct}%` : ''}${g.temperatureC !== null ? ` · ${g.temperatureC}°C` : ''}${g.driverVersion ? ` · Driver ${g.driverVersion}` : ''}`,
            ])
          : [['GPU', 'No GPU controllers reported']];

        const npuRows: Array<[string, string]> = npu?.detected
          ? npu.devices.map((d: any, i: number) => [`NPU ${i + 1}`, `${d.name} (${d.status})`])
          : [['NPU', 'Not detected on this system']];

        hardwareTable.innerHTML = renderRows([
          ['Host & OS', `${system.hostname} · ${system.platform} ${system.release} (${system.arch}) · Uptime ${formatUptime(system.uptimeSec)}`],
          ['Node.js Runtime', system.nodeVersion],
          ['CPU', `${cpu.model} · ${cpu.logicalCores} logical cores${cpu.speedMhz ? ` @ ${cpu.speedMhz} MHz` : ''}`],
          ['System RAM', `${ram.totalGb} GB total · ${ram.usedGb} GB used (${ram.usedPct}%) · ${ram.freeGb} GB free`],
          ...gpuRows,
          ...npuRows,
        ]);
      }
    } catch (err: any) {
      if (coreEngineTable) {
        coreEngineTable.innerHTML = renderRows([['Error', err?.message || 'Failed to load device specs']]);
      }
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  refreshBtn?.addEventListener('click', () => {
    void loadDeviceSpecs();
  });

  return { loadDeviceSpecs };
}
