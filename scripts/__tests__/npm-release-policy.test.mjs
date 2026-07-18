import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveNpmRelease } from '../resolve-npm-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageIdentity = { packageName: packageJson.name, packageVersion: packageJson.version };

test('only the matching version tag owns automatic publishing', () => {
  const release = resolveNpmRelease({
    ...packageIdentity,
    eventName: 'push',
    ref: `refs/tags/v${packageIdentity.packageVersion}`,
    manualPublish: 'false',
  });
  assert.equal(release.publishAllowed, true);
  assert.equal(release.owner, 'version-tag');

  const branch = resolveNpmRelease({
    ...packageIdentity,
    eventName: 'push',
    ref: 'refs/heads/main',
    manualPublish: 'false',
  });
  assert.equal(branch.publishAllowed, false);
  assert.equal(branch.owner, 'build-only');
});

test('a mismatched version tag fails before release builds', () => {
  assert.throws(
    () => resolveNpmRelease({
      ...packageIdentity,
      eventName: 'push',
      ref: `refs/tags/v${packageIdentity.packageVersion}-mismatch`,
      manualPublish: 'false',
    }),
    new RegExp(`expected refs/tags/v${packageIdentity.packageVersion.replaceAll('.', '\\.')}`)
  );
});

test('manual publishing requires the explicit publish request', () => {
  for (const manualPublish of ['false', '']) {
    const release = resolveNpmRelease({
      ...packageIdentity,
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      manualPublish,
    });
    assert.equal(release.publishAllowed, false);
  }

  const release = resolveNpmRelease({
    ...packageIdentity,
    eventName: 'workflow_dispatch',
    ref: 'refs/heads/main',
    manualPublish: 'true',
  });
  assert.equal(release.publishAllowed, true);
  assert.equal(release.owner, 'approved-manual');
});

test('release workflow syntax and ownership policy validate', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-npm-release-workflow.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /single-owner/);
});
