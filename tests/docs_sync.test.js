import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('README.md badges and config snippet stay in sync with package.json and om.config.json', () => {
  const output = execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'sync-docs.js'), '--check'], {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });
  assert.match(output, /Docs sync check passed/);
});
