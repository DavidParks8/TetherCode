import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveNpmRelease({
  eventName,
  ref,
  manualPublish,
  packageName,
  packageVersion,
  releaseCommitOnMain = false,
}) {
  if (!packageName || !packageVersion) {
    throw new Error('package.json must include name and version');
  }

  const expectedTagRef = `refs/tags/v${packageVersion}`;
  if (eventName === 'push' && ref.startsWith('refs/tags/')) {
    if (ref !== expectedTagRef) {
      throw new Error(`Release tag ${ref} does not match ${packageName}@${packageVersion}; expected ${expectedTagRef}`);
    }
    if (!releaseCommitOnMain) {
      throw new Error(`Release tag ${ref} must point to a commit reachable from origin/main`);
    }
    return { packageName, packageVersion, publishAllowed: true, owner: 'version-tag' };
  }

  if (eventName === 'workflow_dispatch' && manualPublish === 'true') {
    if (ref !== 'refs/heads/main') {
      throw new Error(`Manual publishing is only allowed from refs/heads/main; received ${ref || '(empty ref)'}`);
    }
    return { packageName, packageVersion, publishAllowed: true, owner: 'approved-manual' };
  }

  return { packageName, packageVersion, publishAllowed: false, owner: 'build-only' };
}

function currentCommitIsOnMain(root) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(`Could not verify release ancestry: ${(result.stderr || result.stdout).trim() || `git exited ${result.status}`}`);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const eventName = process.env.RELEASE_EVENT_NAME ?? '';
  const ref = process.env.RELEASE_REF ?? '';
  const release = resolveNpmRelease({
    eventName,
    ref,
    manualPublish: process.env.RELEASE_MANUAL_PUBLISH ?? 'false',
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    releaseCommitOnMain: eventName === 'push' && ref.startsWith('refs/tags/')
      ? currentCommitIsOnMain(root)
      : false,
  });
  const output = [
    `package_name=${release.packageName}`,
    `package_version=${release.packageVersion}`,
    `publish_allowed=${String(release.publishAllowed)}`,
    `release_owner=${release.owner}`,
  ].join('\n');

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
