import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(root, '.github/workflows/npm-release.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const workflow = parse(workflowSource);
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(`NPM release workflow validation failed: ${message}`);
  }
}

const publish = workflow.jobs?.publish;
const quality = workflow.jobs?.quality;
assert(!workflow.on?.push?.branches, 'main pushes must use the Build and Test workflow, not release');
assert(workflow.on?.push?.tags?.includes('v*'), 'version tags must trigger releases');
assert(workflow.on?.workflow_dispatch, 'manual releases must remain available');
assert(workflow.jobs?.release_metadata, 'release ownership metadata job is required');
assert(quality?.['runs-on'] === 'macos-26', 'release quality must use the same pinned Rust coverage runner as CI');
const qualitySteps = quality?.steps ?? [];
const qualityNodeStep = qualitySteps.find((step) => step.name === 'Setup Node.js');
assert(qualityNodeStep?.with?.['node-version'] === '22.13.1', 'release quality Node.js must match CI exactly');
const qualityNightlyStep = qualitySteps.find((step) => step.name === 'Setup pinned nightly Rust');
assert(qualityNightlyStep?.with?.toolchain === 'nightly-2026-07-15', 'release Rust coverage nightly must be pinned');
const llvmCovStep = qualitySteps.find((step) => step.name === 'Install cargo-llvm-cov');
assert(llvmCovStep?.uses === 'taiki-e/install-action@v2.83.4', 'cargo-llvm-cov installer action must be pinned');
assert(llvmCovStep?.with?.tool === 'cargo-llvm-cov@0.8.7', 'cargo-llvm-cov version must match CI exactly');
assert(llvmCovStep?.with?.fallback === 'none', 'cargo-llvm-cov must not use an unpinned fallback');
const qualityCommands = qualitySteps.map((step) => step.run ?? '').join('\n');
for (const command of [
  'npm run contract:check',
  'npm run test:release',
  'npm run payment:check',
  'npm run lint -w @tethercode/mobile',
  'npm run typecheck -w @tethercode/mobile',
  'npm run test:coverage -w @tethercode/mobile',
  'cargo fmt --check',
  'cargo check --locked --all-targets --all-features',
  'cargo clippy --locked --all-targets --all-features -- -D warnings',
  'cargo test --locked --all-targets --all-features -- --test-threads=1',
  'npm run coverage:rust',
]) {
  assert(qualityCommands.includes(command), `release quality must run ${command}`);
}
assert(workflow.jobs?.build_bridge_binaries?.needs === 'release_metadata', 'builds must wait for tag validation');
assert(Array.isArray(publish?.needs) && publish.needs.includes('quality'), 'publish must require release quality in the same workflow execution');
const releaseMetadataSteps = workflow.jobs.release_metadata.steps ?? [];
const releaseCheckoutStep = releaseMetadataSteps.find((step) => step.name === 'Checkout');
assert(releaseCheckoutStep?.with?.['fetch-depth'] === 0, 'release ownership must check out complete history');
assert(
  releaseMetadataSteps.some((step) => step.name === 'Fetch release branch' && step.run === 'git fetch --no-tags origin main:refs/remotes/origin/main'),
  'release ownership must refresh origin/main before validating ancestry'
);
assert(publish?.if === "needs.release_metadata.outputs.publish_allowed == 'true'", 'publish job must use the release ownership gate');
assert(publish?.environment?.name === 'npm-publish', 'publish job must use the protected npm environment');
assert(publish?.concurrency?.['cancel-in-progress'] === false, 'an active package publish must not be cancelled');
assert(publish?.concurrency?.group?.includes('outputs.package_name'), 'publish concurrency must include the package name');
assert(publish?.concurrency?.group?.includes('outputs.package_version'), 'publish concurrency must include the package version');

const publishNodeStep = publish?.steps?.find((step) => step.name === 'Setup Node.js');
assert(publishNodeStep?.with?.['node-version'] === '22.22.2', 'publish Node.js must be pinned to the trusted-publishing runtime');
const publishNpmStep = publish?.steps?.find((step) => step.name === 'Install npm for trusted publishing');
assert(publishNpmStep?.run === 'npm install -g npm@11.18.0', 'publish npm must be pinned to a compatible trusted-publishing release');
const publishInstallIndex = publish.steps.findIndex((step) => step.name === 'Install dependencies' && step.run === 'npm ci');
const publishAuditIndex = publish.steps.findIndex((step) => step.name === 'Audit production dependencies' && step.run === 'npm run security:check');
const artifactDownloadIndex = publish.steps.findIndex((step) => step.name === 'Download packaged bridge binaries');
assert(
  publishInstallIndex >= 0 && publishAuditIndex > publishInstallIndex && artifactDownloadIndex > publishAuditIndex,
  'the live production audit must run after install and before publish artifact preparation'
);

const jobsContainingPublish = Object.entries(workflow.jobs ?? {})
  .filter(([, job]) => JSON.stringify(job).includes('npm publish'))
  .map(([name]) => name);
assert(jobsContainingPublish.length === 1 && jobsContainingPublish[0] === 'publish', 'npm publish must have exactly one gated owner');

for (const file of ['scripts/acp-agent-install.js', 'scripts/acp-agent-registry.js']) {
  assert(packageJson.files?.includes(file), `published package must include ${file}`);
}
for (const dependency of ['tar', 'unbzip2-stream', 'yauzl', 'zod']) {
  assert(packageJson.dependencies?.[dependency], `published package must include runtime dependency ${dependency}`);
}

const publishStep = publish?.steps?.find((step) => step.name === 'Publish to npm (OIDC trusted publishing)');
assert(publishStep, 'publish step is required');
assert(
  publishStep.env?.NPM_DIST_TAG === '${{ steps.publish_target.outputs.publish_tag }}',
  'the npm dist-tag must enter the publish step through the environment'
);
assert(
  publishStep.run === 'npm publish --access public --tag "$NPM_DIST_TAG"',
  'the publish command must not interpolate workflow data into shell source'
);

const publishTargetStep = publish?.steps?.find((step) => step.name === 'Resolve publish target');
assert(
  publishTargetStep?.run?.startsWith('node scripts/resolve-npm-publish-target.mjs\n'),
  'publish target resolution must use the tested JavaScript policy'
);

process.stdout.write('NPM release workflow is valid and single-owner.\n');
