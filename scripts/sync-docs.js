#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.join(ROOT_DIR, 'README.md');
const configPath = path.join(ROOT_DIR, 'om.config.json');
const pkgPath = path.join(ROOT_DIR, 'package.json');

const args = process.argv.slice(2);
const shouldWrite = args.includes('--write');
const strictConfig = args.includes('--strict-config');
const testsFlagIdx = args.indexOf('--tests');
const explicitTestCount = testsFlagIdx !== -1 ? Number(args[testsFlagIdx + 1]) : null;

if (explicitTestCount !== null && (!Number.isInteger(explicitTestCount) || explicitTestCount <= 0)) {
  console.error('Invalid --tests <count> value.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
let readme = fs.readFileSync(readmePath, 'utf8');

const depCount = Object.keys(pkg.dependencies || {}).length;
const errors = [];

const badgeDepsRe = /!\[Dependencies\]\(https:\/\/img\.shields\.io\/badge\/dependencies-(\d+)-blue\.svg\)/;
const badgeTestsRe = /!\[Tests\]\(https:\/\/img\.shields\.io\/badge\/tests-(\d+)%20passed-success\.svg\)/;
const proseTestsRe = /All (\d+) unit & integration tests pass/;
const snippetProviderRe = /(\{\s*"name": "OM Agent",\s*"version": "[^"]+",\s*"provider": ")([^"]+)(",\s*"model": ")([^"]+)(",)/;

const depsMatch = readme.match(badgeDepsRe);
const testsBadgeMatch = readme.match(badgeTestsRe);
const testsProseMatch = readme.match(proseTestsRe);
const snippetMatch = readme.match(snippetProviderRe);

if (shouldWrite) {
  readme = readme.replace(badgeDepsRe, `![Dependencies](https://img.shields.io/badge/dependencies-${depCount}-blue.svg)`);
  if (explicitTestCount !== null) {
    readme = readme.replace(badgeTestsRe, `![Tests](https://img.shields.io/badge/tests-${explicitTestCount}%20passed-success.svg)`);
    readme = readme.replace(proseTestsRe, `All ${explicitTestCount} unit & integration tests pass`);
  }
  readme = readme.replace(snippetProviderRe, `$1${config.provider}$3${config.model}$5`);
  fs.writeFileSync(readmePath, readme, 'utf8');
  console.log('README.md synced with om.config.json and package.json.');
  process.exit(0);
}

if (!depsMatch || Number(depsMatch[1]) !== depCount) {
  errors.push(`README dependencies badge (${depsMatch?.[1]}) !== package.json dependencies count (${depCount})`);
}
if (!testsBadgeMatch || !testsProseMatch || testsBadgeMatch[1] !== testsProseMatch[1]) {
  errors.push(`README tests badge (${testsBadgeMatch?.[1]}) !== README prose test count (${testsProseMatch?.[1]})`);
}
if (explicitTestCount !== null && Number(testsBadgeMatch?.[1]) !== explicitTestCount) {
  errors.push(`README tests badge (${testsBadgeMatch?.[1]}) !== actual test count (${explicitTestCount})`);
}
if (strictConfig && (!snippetMatch || snippetMatch[2] !== config.provider || snippetMatch[4] !== config.model)) {
  errors.push(`README config snippet (${snippetMatch?.[2]}/${snippetMatch?.[4]}) !== om.config.json (${config.provider}/${config.model})`);
}

if (errors.length > 0) {
  console.error('Docs sync check failed:\n- ' + errors.join('\n- '));
  console.error('Run `npm run docs:sync` to update README.md.');
  process.exit(1);
}

console.log('Docs sync check passed.');
