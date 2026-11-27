import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type HardwareTier = 'cpu-only' | 'gpu-entry' | 'gpu-mid' | 'gpu-high' | 'gpu-workstation';
export type HardwareAccelerator = 'cuda' | 'metal' | 'rocm' | 'directml' | 'cpu';

export interface HardwareProfile {
  tier: HardwareTier;
  tierLabel: string;
  summary: string;
  hasGpu: boolean;
  accelerator: HardwareAccelerator;
  unifiedMemory: boolean;
  gpuCount: number;
  gpuNames: string[];
  totalVramGb: number;
  maxGpuVramGb: number;
  totalRamGb: number;
  freeRamGb: number;
  logicalCores: number;
  cpuModel: string;
  platform: string;
  arch: string;
  recommendedMaxParamsB: number;
  recommendedRuntime: 'lmstudio' | 'vllm' | 'om';
}

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
  unifiedMemory?: boolean;
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
  hardwareProfile: HardwareProfile;
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
    $regVram = @{};
    Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object {
      $desc = $_.'DriverDesc';
      $qw = $_.'HardwareInformation.qwMemorySize';
      if ($desc -and $qw -is [Int64] -and $qw -gt 0) { $regVram[$desc.ToLower()] = $qw }
    };
    $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {
      $name = $_.Name;
      $vram = [Int64]($_.AdapterRAM);
      if ($name -and $regVram.ContainsKey($name.ToLower())) {
        $regVal = [Int64]$regVram[$name.ToLower()];
        if ($regVal -gt $vram) { $vram = $regVal }
      }
      [PSCustomObject]@{ Name = $name; AdapterCompatibility = $_.AdapterCompatibility; AdapterRAM = $vram; DriverVersion = $_.DriverVersion }
    });
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

async function queryMacGpus(totalRamBytes: number): Promise<GpuInfo[]> {
  if (process.platform !== 'darwin') return [];
  const isAppleSilicon = process.arch === 'arm64';
  const unifiedUsableMb = Math.round((totalRamBytes * 0.75) / (1024 * 1024));

  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPDisplaysDataType', '-json'], {
      timeout: 2500
    });
    const parsed = JSON.parse(stdout || '{}');
    const items = Array.isArray(parsed.SPDisplaysDataType) ? parsed.SPDisplaysDataType : [];
    const gpus: GpuInfo[] = [];
    for (const item of items) {
      const name = String(item.sppci_model || item._name || (isAppleSilicon ? 'Apple Silicon GPU' : 'macOS GPU'));
      const vendorRaw = String(item.spdisplays_vendor || item.sppci_vendor || '');
      const vendor = /apple/i.test(name) || /apple/i.test(vendorRaw)
        ? 'Apple'
        : /amd|radeon/i.test(name) ? 'AMD' : /nvidia/i.test(name) ? 'NVIDIA' : /intel/i.test(name) ? 'Intel' : (vendorRaw || 'Unknown');
      const isUnified = isAppleSilicon && vendor === 'Apple';
      let vramMb = 0;
      if (isUnified) {
        vramMb = unifiedUsableMb;
      } else {
        const vramStr = String(item.spdisplays_vram || item.spdisplays_vram_shared || '');
        const gbMatch = vramStr.match(/([\d.]+)\s*GB/i);
        const mbMatch = vramStr.match(/([\d.]+)\s*MB/i);
        if (gbMatch) vramMb = Math.round(Number(gbMatch[1]) * 1024);
        else if (mbMatch) vramMb = Math.round(Number(mbMatch[1]));
      }
      gpus.push({
        name,
        vendor,
        vramTotalMb: vramMb,
        vramUsedMb: null,
        vramFreeMb: null,
        utilizationPct: null,
        temperatureC: null,
        driverVersion: null,
        cudaCapable: false,
        unifiedMemory: isUnified
      });
    }
    if (gpus.length > 0) return gpus;
  } catch {
    // Fallback below for Apple Silicon
  }

  if (isAppleSilicon) {
    return [{
      name: 'Apple Silicon GPU (Metal Unified Memory)',
      vendor: 'Apple',
      vramTotalMb: unifiedUsableMb,
      vramUsedMb: null,
      vramFreeMb: null,
      utilizationPct: null,
      temperatureC: null,
      driverVersion: null,
      cudaCapable: false,
      unifiedMemory: true
    }];
  }
  return [];
}

async function queryLinuxDrmGpus(): Promise<GpuInfo[]> {
  if (process.platform !== 'linux') return [];
  const gpus: GpuInfo[] = [];
  try {
    const drmDir = '/sys/class/drm';
    if (!fs.existsSync(drmDir)) return [];
    const entries = fs.readdirSync(drmDir).filter((e) => /^card\d+$/.test(e));
    for (const card of entries) {
      const devDir = `${drmDir}/${card}/device`;
      const vramPath = `${devDir}/mem_info_vram_total`;
      if (!fs.existsSync(vramPath)) continue;
      const vramBytes = Number(fs.readFileSync(vramPath, 'utf8').trim());
      if (!Number.isFinite(vramBytes) || vramBytes <= 0) continue;
      const vramTotalMb = Math.round(vramBytes / (1024 * 1024));
      let vendorHex = '';
      try {
        vendorHex = fs.readFileSync(`${devDir}/vendor`, 'utf8').trim().toLowerCase();
      } catch {}
      const vendor = vendorHex === '0x1002' ? 'AMD' : vendorHex === '0x10de' ? 'NVIDIA' : vendorHex === '0x8086' ? 'Intel' : 'Unknown';
      let vramUsedMb: number | null = null;
      try {
        const usedBytes = Number(fs.readFileSync(`${devDir}/mem_info_vram_used`, 'utf8').trim());
        if (Number.isFinite(usedBytes) && usedBytes >= 0) {
          vramUsedMb = Math.round(usedBytes / (1024 * 1024));
        }
      } catch {}
      gpus.push({
        name: `${vendor} GPU (${card})`,
        vendor,
        vramTotalMb,
        vramUsedMb,
        vramFreeMb: vramUsedMb !== null ? Math.max(0, vramTotalMb - vramUsedMb) : null,
        utilizationPct: null,
        temperatureC: null,
        driverVersion: null,
        cudaCapable: vendor === 'NVIDIA'
      });
    }
  } catch {
    return [];
  }
  return gpus;
}

const VIRTUAL_GPU_PATTERN = /\b(microsoft basic display|basic render|virtual|vmware|parsec|rdp|citrix|hyper-v|qxl|llvmpipe)\b/i;

/**
 * Classify a machine's hardware capabilities (CPU-only vs GPU VRAM tiers)
 * to guide local model discovery, fit scoring, and runtime recommendations.
 */
export function classifyHardwareProfile(input: {
  system: { platform: string; arch: string };
  cpu: { model: string; logicalCores: number };
  ram: { totalGb: number; freeGb: number };
  gpus: GpuInfo[];
}): HardwareProfile {
  const { system, cpu, ram, gpus } = input;
  const totalRamGb = Math.max(0, Math.round((ram.totalGb || 0) * 10) / 10);
  const freeRamGb = Math.max(0, Math.round((ram.freeGb || 0) * 10) / 10);
  const logicalCores = Math.max(1, Number(cpu.logicalCores || 1));

  // Filter out virtual/basic display adapters and tiny <2GB integrated adapters
  const capableGpus = (gpus || []).filter((g) => {
    if (!g || !g.name) return false;
    if (VIRTUAL_GPU_PATTERN.test(g.name)) return false;
    return (g.vramTotalMb || 0) >= 2048 || Boolean(g.unifiedMemory && g.vramTotalMb >= 2048);
  });

  const unifiedMemory = capableGpus.some((g) => Boolean(g.unifiedMemory));
  const totalVramMb = capableGpus.reduce((sum, g) => sum + Math.max(0, g.vramTotalMb || 0), 0);
  const maxGpuVramMb = capableGpus.reduce((max, g) => Math.max(max, g.vramTotalMb || 0), 0);
  const totalVramGb = Math.round((totalVramMb / 1024) * 10) / 10;
  const maxGpuVramGb = Math.round((maxGpuVramMb / 1024) * 10) / 10;
  const hasGpu = capableGpus.length > 0 && totalVramGb >= 2;

  let accelerator: HardwareAccelerator = 'cpu';
  if (hasGpu) {
    if (capableGpus.some((g) => g.cudaCapable || /nvidia/i.test(g.vendor) || /nvidia/i.test(g.name))) {
      accelerator = 'cuda';
    } else if (unifiedMemory || capableGpus.some((g) => /apple/i.test(g.vendor) || /apple/i.test(g.name))) {
      accelerator = 'metal';
    } else if (system.platform === 'linux' && capableGpus.some((g) => /amd|radeon/i.test(g.vendor) || /amd|radeon/i.test(g.name))) {
      accelerator = 'rocm';
    } else {
      accelerator = 'directml';
    }
  }

  let tier: HardwareTier = 'cpu-only';
  let tierLabel = `CPU Only (${totalRamGb} GB RAM)`;
  let recommendedMaxParamsB = 3;
  let recommendedRuntime: 'lmstudio' | 'vllm' | 'om' = 'lmstudio';

  if (hasGpu && totalVramGb >= 32) {
    tier = 'gpu-workstation';
    tierLabel = unifiedMemory
      ? `Workstation Unified Memory (${totalVramGb} GB)`
      : `Workstation GPU (${totalVramGb} GB VRAM)`;
    recommendedMaxParamsB = totalVramGb >= 64 ? 72 : totalVramGb >= 44 ? 70 : 34;
    recommendedRuntime = accelerator === 'cuda' || accelerator === 'rocm' ? 'vllm' : 'lmstudio';
  } else if (hasGpu && totalVramGb >= 16) {
    tier = 'gpu-high';
    tierLabel = unifiedMemory
      ? `High-Memory Unified (${totalVramGb} GB)`
      : `High-VRAM GPU (${totalVramGb} GB VRAM)`;
    recommendedMaxParamsB = totalVramGb >= 22 ? 32 : 16;
    recommendedRuntime = accelerator === 'cuda' || accelerator === 'rocm' ? 'vllm' : 'lmstudio';
  } else if (hasGpu && totalVramGb >= 8) {
    tier = 'gpu-mid';
    tierLabel = unifiedMemory
      ? `Mid-Range Unified (${totalVramGb} GB)`
      : `Mid-Range GPU (${totalVramGb} GB VRAM)`;
    recommendedMaxParamsB = totalVramGb >= 12 ? 14 : 9;
    recommendedRuntime = 'lmstudio';
  } else if (hasGpu && totalVramGb >= 4) {
    tier = 'gpu-entry';
    tierLabel = `Entry GPU (${totalVramGb} GB VRAM)`;
    recommendedMaxParamsB = totalVramGb >= 6 ? 7 : 4;
    recommendedRuntime = 'lmstudio';
  } else {
    tier = 'cpu-only';
    tierLabel = `CPU Only (${totalRamGb} GB RAM)`;
    if (totalRamGb >= 32) recommendedMaxParamsB = 8;
    else if (totalRamGb >= 16) recommendedMaxParamsB = 4;
    else if (totalRamGb >= 8) recommendedMaxParamsB = 3;
    else recommendedMaxParamsB = 1.5;
    recommendedRuntime = totalRamGb >= 6 ? 'lmstudio' : 'om';
  }

  const gpuNames = capableGpus.map((g) => g.name);
  const summary = hasGpu
    ? `${tierLabel} · ${gpuNames.join(', ')} · ${accelerator.toUpperCase()} · ${totalRamGb} GB RAM (${logicalCores} CPU threads)`
    : `${tierLabel} · ${cpu.model} (${logicalCores} threads) · No discrete GPU detected`;

  return {
    tier,
    tierLabel,
    summary,
    hasGpu,
    accelerator,
    unifiedMemory,
    gpuCount: capableGpus.length,
    gpuNames,
    totalVramGb,
    maxGpuVramGb,
    totalRamGb,
    freeRamGb,
    logicalCores,
    cpuModel: cpu.model,
    platform: system.platform,
    arch: system.arch,
    recommendedMaxParamsB,
    recommendedRuntime
  };
}

/**
 * Detect and classify the current host's hardware profile for local model selection.
 */
export async function detectSystemHardware(agent?: any): Promise<HardwareProfile> {
  const specs = await collectDeviceSpecs(agent);
  return specs.hardwareProfile;
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

  const [nvidiaGpus, winInfo, macGpus, linuxDrmGpus] = await Promise.all([
    queryNvidiaSmi(),
    queryWindowsAdaptersAndNpu(),
    queryMacGpus(totalBytes),
    queryLinuxDrmGpus(),
  ]);

  // Merge nvidia-smi live telemetry with OS adapter list without duplicating entries
  const gpus: GpuInfo[] = [...nvidiaGpus];
  for (const extraGpu of [...winInfo.gpus, ...macGpus, ...linuxDrmGpus]) {
    const alreadyPresent = gpus.some((g) => g.name.toLowerCase() === extraGpu.name.toLowerCase());
    if (!alreadyPresent) gpus.push(extraGpu);
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

  const systemInfo = {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSec: Math.round(os.uptime()),
    nodeVersion: process.version,
  };
  const cpuInfo = {
    model: cpus[0]?.model?.trim() || 'Unknown CPU',
    arch: os.arch(),
    logicalCores: cpus.length,
    speedMhz: cpus[0]?.speed || 0,
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
  };
  const ramInfo = {
    totalGb: toGb(totalBytes),
    usedGb: toGb(usedBytes),
    freeGb: toGb(freeBytes),
    usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
  };
  const hardwareProfile = classifyHardwareProfile({
    system: systemInfo,
    cpu: cpuInfo,
    ram: ramInfo,
    gpus,
  });

  return {
    timestamp: new Date().toISOString(),
    system: systemInfo,
    cpu: cpuInfo,
    ram: ramInfo,
    gpus,
    npu: winInfo.npu,
    hardwareProfile,
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
