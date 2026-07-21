import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const checker = path.join(root, 'scripts/check-production-audit.mjs');

function runChecker(vulnerabilities) {
  const directory = mkdtempSync(path.join(tmpdir(), 'clawdex-production-audit-'));
  const reportPath = path.join(directory, 'audit.json');
  writeFileSync(reportPath, JSON.stringify({ vulnerabilities }));
  const result = spawnSync(process.execPath, [checker, reportPath], {
    cwd: root,
    encoding: 'utf8',
  });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

const reviewed = {
  'linkify-it': {
    via: [{ source: 1121797, name: 'linkify-it', severity: 'high' }],
    fixAvailable: false,
  },
};

test('production audit accepts only the reviewed high-severity advisories', () => {
  const result = runChecker(reviewed);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 reviewed high-severity advisories/);
});

test('production audit rejects new, stale, or newly fixable advisories', () => {
  const unexpected = runChecker({
    ...reviewed,
    dangerous: {
      via: [{ source: 9999999, name: 'dangerous', severity: 'critical' }],
      fixAvailable: false,
    },
  });
  assert.notEqual(unexpected.status, 0);
  assert.match(unexpected.stderr, /unexpected: dangerous#9999999/);

  const stale = runChecker({});
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale exceptions: linkify-it#1121797/);

  const fixable = runChecker({
    ...reviewed,
    'linkify-it': { ...reviewed['linkify-it'], fixAvailable: true },
  });
  assert.notEqual(fixable.status, 0);
  assert.match(fixable.stderr, /fix now available: linkify-it/);

  const escalated = runChecker({
    ...reviewed,
    'linkify-it': {
      ...reviewed['linkify-it'],
      via: reviewed['linkify-it'].via.map((advisory) => ({
        ...advisory,
        severity: 'critical',
      })),
    },
  });
  assert.notEqual(escalated.status, 0);
  assert.match(escalated.stderr, /critical: linkify-it#1121797/);
});
