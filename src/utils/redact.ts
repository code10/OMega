const SENSITIVE_ENV_KEYS = [
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
  'OM_GATEWAY_TOKEN'
];

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
    out = out.replace(pattern, (match, prefix) => (prefix ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }

  return out;
}
