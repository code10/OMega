import { execSync } from 'child_process';
import fs from 'fs';

console.log('--- OMega Security Audit ---');

// 1. Dependency Audit
console.log('[1/4] Running npm audit...');
try {
    execSync('npm audit', { stdio: 'inherit' });
} catch (e) {
    console.log('Dependency vulnerabilities found.');
}

// 2. Secret Scanning (Basic)
console.log('[2/4] Scanning for potential hardcoded secrets...');
const sensitivePatterns = [/API_KEY/i, /SECRET/i, /PASSWORD/i, /TOKEN/i];
const filesToScan = ['src/config.ts', 'src/gateway/server.ts', '.env.example'];

filesToScan.forEach(file => {
    if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf8');
        sensitivePatterns.forEach(pattern => {
            if (pattern.test(content)) {
                console.warn(`[!] Potential secret pattern found in ${file}`);
            }
        });
    }
});

// 3. Dangerous Function Check
console.log('[3/4] Checking for dangerous function usage...');
const dangerousFunctions = ['exec', 'eval', 'spawn'];
const filesToCheck = ['src/agent.ts', 'src/skills/shell.ts'];

filesToCheck.forEach(file => {
    if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf8');
        dangerousFunctions.forEach(func => {
            if (content.includes(func)) {
                console.warn(`[!] Dangerous function '${func}' used in ${file}. Ensure proper sanitization.`);
            }
        });
    }
});

// 4. Configuration Check
console.log('[4/4] Checking configuration...');
if (fs.existsSync('om.config.json')) {
    const config = JSON.parse(fs.readFileSync('om.config.json', 'utf8'));
    if (config.debug === true) {
        console.warn('[!] Debug mode is enabled in om.config.json. Disable for production.');
    }
}

console.log('--- Audit Complete ---');
