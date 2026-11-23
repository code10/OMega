#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

console.log('--- OMega Security Audit ---');
let failures = 0;

// 1. Dependency Audit (production dependencies, high/critical)
console.log('[1/4] Running npm audit --omit=dev --audit-level=high...');
try {
  execSync('npm audit --omit=dev --audit-level=high', { stdio: 'inherit' });
} catch {
  console.error('[FAIL] High/critical production dependency vulnerabilities found.');
  failures += 1;
}

// 2. Hardcoded Secret Scanning across src/ and bin/
console.log('[2/4] Scanning src/ and bin/ for hardcoded secrets...');
const SECRET_PATTERNS = [
  { name: 'OpenAI/Anthropic key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GitHub PAT', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sourceFiles = [...walkFiles('src'), ...walkFiles('bin')];
for (const file of sourceFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) {
      console.error(`[FAIL] Potential hardcoded ${name} found in ${file}`);
      failures += 1;
    }
  }
}

// 3. Dangerous Dynamic Code Execution Check (eval / new Function)
console.log('[3/4] Checking for eval() / new Function()...');
for (const file of sourceFiles) {
  const content = fs.readFileSync(file, 'utf8');
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(content)) {
    console.error(`[FAIL] Dynamic code execution (eval/new Function) found in ${file}`);
    failures += 1;
  }
}

// 4. Configuration Check
console.log('[4/4] Checking om.config.json...');
if (fs.existsSync('om.config.json')) {
  const config = JSON.parse(fs.readFileSync('om.config.json', 'utf8'));
  if (config.debug === true) {
    console.warn('[WARN] Debug mode is enabled in om.config.json. Disable for production.');
  }
}

if (failures > 0) {
  console.error(`--- Audit Failed (${failures} issue(s)) ---`);
  process.exit(1);
}
console.log('--- Audit Passed (0 issues) ---');
