const SENSITIVE_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'QWEN_API_KEY',
  'DASHSCOPE_API_KEY',
  'GLM_API_KEY',
  'ZHIPU_API_KEY',
  'OM_GATEWAY_TOKEN',
  'OM_EMBEDDING_API_KEY'
]);

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._-]{24,}\b/gi
];

/**
 * Redact known API keys, gateway tokens, and common secret token formats from text.
 */
export function redactSecrets(input: string): string {
  if (!input || typeof input !== 'string') return input;
  let out = input;

  for (const key of SENSITIVE_ENV_KEYS) {
    const val = process.env[key];
    if (val && val.length >= 8 && out.includes(val)) {
      out = out.split(val).join(`[REDACTED:${key}]`);
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix) => (prefix ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }

  return out;
}

const SAFE_BASE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SHELL',
  'ComSpec',
  'SystemRoot',
  'WINDIR',
  'OS',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'USER',
  'LOGNAME',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'NODE_ENV',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'GIT_TERMINAL_PROMPT',
  'GIT_PAGER',
  'PAGER'
]);

/**
 * Build a child process environment using a strict safe-key allowlist by default
 * (preventing non-OMega secrets like AWS_SECRET_ACCESS_KEY or GITHUB_TOKEN from leaking)
 * unless inheritSensitiveEnv is explicitly enabled. Explicit overrides are applied last.
 */
export function buildSafeChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string | undefined> = {},
  inheritSensitiveEnv = false,
  extraAllowedKeys: string[] = []
): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = {};
  if (inheritSensitiveEnv) {
    Object.assign(childEnv, baseEnv);
  } else {
    const extraSet = new Set(Array.isArray(extraAllowedKeys) ? extraAllowedKeys : []);
    for (const [k, v] of Object.entries(baseEnv || {})) {
      if (v === undefined) continue;
      if (SENSITIVE_ENV_KEYS.has(k)) continue;
      if (SAFE_BASE_ENV_KEYS.has(k) || extraSet.has(k)) {
        childEnv[k] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined) {
      childEnv[k] = v;
    }
  }
  return childEnv;
}
