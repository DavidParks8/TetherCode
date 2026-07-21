import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewedAdvisories = new Map([
  [1121797, 'linkify-it'],
]);

const loadReport = () => {
  if (process.argv[2]) {
    return JSON.parse(readFileSync(path.resolve(root, process.argv[2]), 'utf8'));
  }

  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!result.stdout.trim()) {
    throw new Error(`npm audit produced no JSON: ${result.stderr.trim() || 'unknown error'}`);
  }
  return JSON.parse(result.stdout);
};

const report = loadReport();
const vulnerabilities = report.vulnerabilities ?? {};
const found = new Map();
const critical = [];

for (const vulnerability of Object.values(vulnerabilities)) {
  for (const advisory of Array.isArray(vulnerability.via) ? vulnerability.via : []) {
    if (!advisory || typeof advisory !== 'object') continue;
    if (advisory.severity !== 'high' && advisory.severity !== 'critical') continue;
    found.set(advisory.source, advisory.name);
    if (advisory.severity === 'critical') {
      critical.push([advisory.source, advisory.name]);
    }
  }
}

const unexpected = [...found].filter(
  ([id, name]) => reviewedAdvisories.get(id) !== name
);
const stale = [...reviewedAdvisories].filter(
  ([id, name]) => found.get(id) !== name
);
const fixable = [...new Set(found.values())].filter(
  (name) => vulnerabilities[name]?.fixAvailable !== false
);

if (critical.length > 0 || unexpected.length > 0 || stale.length > 0 || fixable.length > 0) {
  const details = [
    critical.length > 0
      ? `critical: ${critical.map(([id, name]) => `${name}#${id}`).join(', ')}`
      : null,
    unexpected.length > 0
      ? `unexpected: ${unexpected.map(([id, name]) => `${name}#${id}`).join(', ')}`
      : null,
    stale.length > 0
      ? `stale exceptions: ${stale.map(([id, name]) => `${name}#${id}`).join(', ')}`
      : null,
    fixable.length > 0 ? `fix now available: ${fixable.join(', ')}` : null,
  ].filter(Boolean);
  throw new Error(`Production dependency audit requires review (${details.join('; ')})`);
}

process.stdout.write(
  `Production dependency audit passed with ${found.size} reviewed high-severity advisories and no critical advisories.\n`
);
