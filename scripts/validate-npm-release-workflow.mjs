import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(root, '.github/workflows/npm-release.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const workflow = parse(workflowSource);

function assert(condition, message) {
  if (!condition) {
    throw new Error(`NPM release workflow validation failed: ${message}`);
  }
}

const publish = workflow.jobs?.publish;
assert(workflow.on?.push?.branches?.includes('main'), 'main pushes must retain build coverage');
assert(workflow.on?.push?.tags?.includes('v*'), 'version tags must trigger releases');
assert(workflow.on?.workflow_dispatch, 'manual releases must remain available');
assert(workflow.jobs?.release_metadata, 'release ownership metadata job is required');
assert(workflow.jobs?.build_bridge_binaries?.needs === 'release_metadata', 'builds must wait for tag validation');
assert(publish?.if === "needs.release_metadata.outputs.publish_allowed == 'true'", 'publish job must use the release ownership gate');
assert(publish?.environment?.name === 'npm-publish', 'publish job must use the protected npm environment');
assert(publish?.concurrency?.['cancel-in-progress'] === false, 'an active package publish must not be cancelled');
assert(publish?.concurrency?.group?.includes('outputs.package_name'), 'publish concurrency must include the package name');
assert(publish?.concurrency?.group?.includes('outputs.package_version'), 'publish concurrency must include the package version');

const jobsContainingPublish = Object.entries(workflow.jobs ?? {})
  .filter(([, job]) => JSON.stringify(job).includes('npm publish'))
  .map(([name]) => name);
assert(jobsContainingPublish.length === 1 && jobsContainingPublish[0] === 'publish', 'npm publish must have exactly one gated owner');

process.stdout.write('NPM release workflow is valid and single-owner.\n');
