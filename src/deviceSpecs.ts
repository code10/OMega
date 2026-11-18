import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GpuInfo {
  name: string;
  vendor: string;
  vramTotalMb: number;
  vramUsedMb: number | null;
  vramFreeMb: number | null;
  utilizationPct: number | null;
  temperatureC: number | null;
  driverVersion: string | null;
  cudaCapable: boolean;
}

export interface NpuInfo {
  detected: boolean;
  devices: Array<{ name: string; status: string }>;
}

export interface DeviceSpecsSnapshot {
  timestamp: string;
  system: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    uptimeSec: number;
    nodeVersion: string;
  };
  cpu: {
    model: string;
    arch: string;
    logicalCores: number;
    speedMhz: number;
    loadAvg: number[];
  };
  ram: {
    totalGb: number;
    usedGb: number;
    freeGb: number;
    usedPct: number;
  };
  gpus: GpuInfo[];
  npu: NpuInfo;
  engine: {
    provider: string;
    model: string;
    target: string;
    routing: {
      enabled: boolean;
      totalCalls: number;
      retries: number;
      fallbacks: number;
      complexityRoutes: number;
      estimatedCostUsd: number;
    };
    systemOne: {
      enabled: boolean;
      configured: boolean;
      configuredDevice: string;
      resolvedDevice: string;
      model: string;
      dtype: string;
      complexityRouting: boolean;
      riskGating: boolean;
      riskThreshold: number;
      toolShortlisting: boolean;
      toolShortlistK: number;
      selfHealTriage: boolean;
    };
    memory: {
      embeddingUrl: string;
      embeddingModel: string;
      memoryDir: string;
      workspaceDir: string;
    };
    selfHeal: {
      enabled: boolean;
      maxHealAttempts: number;
    };
  };
}

async function queryNvidiaSmi(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,driver_version',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 2000, windowsHide: true }
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, total, used, free, util, temp, driver] = line.split(',').map((s) => s.trim());
        const toNum = (v: string | undefined) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        return {
          name: name || 'NVIDIA GPU',
          vendor: 'NVIDIA',
          vramTotalMb: toNum(total) ?? 0,
          vramUsedMb: toNum(used),
          vramFreeMb: toNum(free),
          utilizationPct: toNum(util),
          temperatureC: toNum(temp),
          driverVersion: driver || null,
          cudaCapable: true,
        };
      });
  } catch {
    return [];
  }
}

async function queryWindowsAdaptersAndNpu(): Promise<{ gpus: GpuInfo[]; npu: NpuInfo }> {
  if (process.platform !== 'win32') {
    return { gpus: [], npu: { detected: false, devices: [] } };
  }
  const psScript = `
    $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object Name, AdapterCompatibility, AdapterRAM, DriverVersion);
    $npus = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\\b(NPU|Neural|AI Boost|Movidius|VPU|Hexagon)\\b' } | Select-Object Name, Status);
    @{ gpus = $gpus; npus = $npus } | ConvertTo-Json -Depth 3 -Compress
  `.trim();
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 3000, windowsHide: true }
    );
    const parsed = JSON.parse(stdout || '{}');
    const rawGpus = Array.isArray(parsed.gpus) ? parsed.gpus : parsed.gpus ? [parsed.gpus] : [];
    const rawNpus = Array.isArray(parsed.npus) ? parsed.npus : parsed.npus ? [parsed.npus] : [];

    const gpus: GpuInfo[] = rawGpus
      .filter((g: any) => g && g.Name)
      .map((g: any) => {
        const ramBytes = Number(g.AdapterRAM || 0);
        const vramTotalMb = Number.isFinite(ramBytes) && ramBytes > 0 ? Math.round(ramBytes / (1024 * 1024)) : 0;
        const name = String(g.Name);
        return {
          name,
          vendor: String(g.AdapterCompatibility || (name.toLowerCase().includes('nvidia') ? 'NVIDIA' : name.toLowerCase().includes('amd') ? 'AMD' : name.toLowerCase().includes('intel') ? 'Intel' : 'Unknown')),
          vramTotalMb,
          vramUsedMb: null,
          vramFreeMb: null,
          utilizationPct: null,
          temperatureC: null,
          driverVersion: g.DriverVersion ? String(g.DriverVersion) : null,
          cudaCapable: name.toLowerCase().includes('nvidia'),
        };
      });

    const npuDevices = rawNpus
      .filter((n: any) => n && n.Name)
      .map((n: any) => ({ name: String(n.Name), status: String(n.Status || 'OK') }));

    return {
      gpus,
      npu: { detected: npuDevices.length > 0, devices: npuDevices },
    };
  } catch {
    return { gpus: [], npu: { detected: false, devices: [] } };
  }
}

/**
 * Collect hardware (CPU, GPU, NPU, VRAM, RAM) and OMega/Laya core engine specs.
 */
export async function collectDeviceSpecs(agent?: any): Promise<DeviceSpecsSnapshot> {
  const cpus = os.cpus();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const toGb = (b: number) => Math.round((b / (1024 ** 3)) * 10) / 10;

  const [nvidiaGpus, winInfo] = await Promise.all([
    queryNvidiaSmi(),
    queryWindowsAdaptersAndNpu(),
  ]);

  // Merge nvidia-smi live telemetry with OS adapter list without duplicating NVIDIA entries
  const gpus: GpuInfo[] = [...nvidiaGpus];
  for (const wGpu of winInfo.gpus) {
    const alreadyPresent = gpus.some((g) => g.name.toLowerCase() === wGpu.name.toLowerCase());
    if (!alreadyPresent) gpus.push(wGpu);
  }

  let sysOneProfile: any = null;
  if (agent?.systemOne?.getResolvedProfile) {
    try {
      sysOneProfile = await agent.systemOne.getResolvedProfile();
    } catch {
      sysOneProfile = null;
    }
  }

  const sysOneCfg = agent?.config?.systemOne || {};
  const routerStats = agent?.router?.stats || {};

  return {
    timestamp: new Date().toISOString(),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
      nodeVersion: process.version,
    },
    cpu: {
      model: cpus[0]?.model?.trim() || 'Unknown CPU',
      arch: os.arch(),
      logicalCores: cpus.length,
      speedMhz: cpus[0]?.speed || 0,
      loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    },
    ram: {
      totalGb: toGb(totalBytes),
      usedGb: toGb(usedBytes),
      freeGb: toGb(freeBytes),
      usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
    },
    gpus,
    npu: winInfo.npu,
    engine: {
      provider: String(agent?.config?.provider || 'om'),
      model: String(agent?.config?.model || 'om-turbo'),
      target: typeof agent?._getTarget === 'function' ? agent._getTarget() : 'local',
      routing: {
        enabled: Boolean(agent?.config?.routing?.enabled),
        totalCalls: Number(routerStats.totalCalls || 0),
        retries: Number(routerStats.retries || 0),
        fallbacks: Number(routerStats.fallbacks || 0),
        complexityRoutes: Number(routerStats.complexityRoutes || 0),
        estimatedCostUsd: Number(routerStats.estimatedCostUsd || 0),
      },
      systemOne: {
        enabled: Boolean(sysOneCfg.enabled),
        configured: Boolean(agent?.systemOne?.isConfigured?.()),
        configuredDevice: String(sysOneCfg.device || 'auto'),
        resolvedDevice: String(sysOneProfile?.device || sysOneCfg.device || 'cpu'),
        model: String(sysOneProfile?.model || sysOneCfg.model || 'Xenova/all-MiniLM-L6-v2'),
        dtype: String(sysOneProfile?.dtype || sysOneCfg.dtype || 'q8'),
        complexityRouting: Boolean(sysOneCfg.complexityRouting ?? true),
        riskGating: Boolean(sysOneCfg.riskGating ?? true),
        riskThreshold: Number(sysOneCfg.riskThreshold ?? 0.45),
        toolShortlisting: Boolean(sysOneCfg.toolShortlisting ?? true),
        toolShortlistK: Number(sysOneCfg.toolShortlistK ?? 20),
        selfHealTriage: Boolean(sysOneCfg.selfHealTriage ?? true),
      },
      memory: {
        embeddingUrl: String(agent?.config?.embedding?.url || 'local-hash'),
        embeddingModel: String(agent?.config?.embedding?.model || 'default'),
        memoryDir: String(agent?.config?.memoryDir || './memory'),
        workspaceDir: String(agent?.config?.workspaceDir || './workspace'),
      },
      selfHeal: {
        enabled: Boolean(agent?.config?.selfHeal?.enabled),
        maxHealAttempts: Number(agent?.config?.selfHeal?.maxHealAttempts ?? 1),
      },
    },
  };
}
