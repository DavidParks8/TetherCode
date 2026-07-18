import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveNpmRelease({ eventName, ref, manualPublish, packageName, packageVersion }) {
  if (!packageName || !packageVersion) {
    throw new Error('package.json must include name and version');
  }

  const expectedTagRef = `refs/tags/v${packageVersion}`;
  if (eventName === 'push' && ref.startsWith('refs/tags/')) {
    if (ref !== expectedTagRef) {
      throw new Error(`Release tag ${ref} does not match ${packageName}@${packageVersion}; expected ${expectedTagRef}`);
    }
    return { packageName, packageVersion, publishAllowed: true, owner: 'version-tag' };
  }

  if (eventName === 'workflow_dispatch' && manualPublish === 'true') {
    return { packageName, packageVersion, publishAllowed: true, owner: 'approved-manual' };
  }

  return { packageName, packageVersion, publishAllowed: false, owner: 'build-only' };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = resolveNpmRelease({
    eventName: process.env.RELEASE_EVENT_NAME ?? '',
    ref: process.env.RELEASE_REF ?? '',
    manualPublish: process.env.RELEASE_MANUAL_PUBLISH ?? 'false',
    packageName: packageJson.name,
    packageVersion: packageJson.version,
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
