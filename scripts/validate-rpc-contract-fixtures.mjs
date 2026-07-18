import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'contracts/bridge-rpc/v1/manifest.json'), 'utf8'));
const rust = [
  'services/rust-bridge/src/main.rs',
  'services/rust-bridge/src/rpc.rs',
  'services/rust-bridge/src/config.rs',
].map((file) => readFileSync(path.join(root, file), 'utf8')).join('\n');
const client = readFileSync(path.join(root, 'apps/mobile/src/api/client.ts'), 'utf8');
const ws = readFileSync(path.join(root, 'apps/mobile/src/api/ws.ts'), 'utf8');
const mobileSource = `${client}\n${ws}`;

const fail = (message) => {
  throw new Error(`RPC contract validation failed: ${message}`);
};
const uniqueSorted = (values) => [...new Set(values)].sort();
const assertUniqueSortedStrings = (name, values) => {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) {
    fail(`${name} must contain non-empty strings`);
  }
  if (JSON.stringify(values) !== JSON.stringify(uniqueSorted(values))) {
    fail(`${name} must be unique and sorted`);
  }
};

if (manifest.fixtureFormatVersion !== 1 || manifest.protocolVersion !== 1) {
  fail('unsupported manifest or protocol version');
}
assertUniqueSortedStrings('bridgeMethods', manifest.bridgeMethods);
assertUniqueSortedStrings('mobileForwardedMethods', manifest.mobileForwardedMethods);
assertUniqueSortedStrings('notifications', manifest.notifications);

const rustProtocol = Number(rust.match(/const BRIDGE_PROTOCOL_VERSION: u32 = (\d+);/)?.[1]);
const mobileProtocol = Number(ws.match(/static readonly PROTOCOL_VERSION = (\d+);/)?.[1]);
if (rustProtocol !== manifest.protocolVersion || mobileProtocol !== manifest.protocolVersion) {
  fail('protocol version constants do not match the manifest');
}

for (const method of manifest.bridgeMethods) {
  if (!rust.includes(`"${method}"`)) fail(`Rust bridge method missing: ${method}`);
}
for (const method of manifest.mobileForwardedMethods) {
  if (!client.includes(`'${method}'`) && !client.includes(`"${method}"`)) {
    fail(`mobile forwarded method missing: ${method}`);
  }
  if (!rust.includes(`"${method}"`)) fail(`Rust forwarded method missing: ${method}`);
}
const mobileRequestMethods = uniqueSorted(
  [...mobileSource.matchAll(/\.request(?:<[^;]*?>)?\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
);
const declaredMethods = new Set([...manifest.bridgeMethods, ...manifest.mobileForwardedMethods]);
for (const method of mobileRequestMethods) {
  if (!declaredMethods.has(method)) fail(`mobile request is undeclared: ${method}`);
}
for (const method of manifest.notifications) {
  if (!rust.includes(`"${method}"`)) fail(`Rust notification missing: ${method}`);
}
for (const { code, name } of manifest.errors) {
  if (!Number.isInteger(code) || typeof name !== 'string') fail('invalid error entry');
  if (!rust.includes(String(code))) fail(`Rust error code missing: ${String(code)}`);
}

const fixtures = manifest.fixtures;
if (fixtures.capabilities.protocolVersion !== manifest.protocolVersion) fail('capability fixture version');
if (fixtures.notification.protocolVersion !== manifest.protocolVersion) fail('notification fixture version');
if (!manifest.notifications.includes(fixtures.notification.method)) fail('notification fixture method');
if (!manifest.errors.some((entry) => entry.code === fixtures.overloadError.error.code)) fail('error fixture code');
if (fixtures.resourceLimitError.error.data.actual <= fixtures.resourceLimitError.error.data.limit) fail('resource limit fixture boundary');
if (!fixtures.browserPreviewSession.expiresAt || !fixtures.browserPreviewSession.bootstrapPath.includes('sid=') || !fixtures.browserPreviewSession.bootstrapPath.includes('st=')) fail('browser preview session fixture');
if (!fixtures.truncatedGitDiff.truncated || fixtures.truncatedGitDiff.returnedBytes > fixtures.truncatedGitDiff.maxBytes) fail('git truncation fixture');
if (!fixtures.truncatedFilesystemList.truncated || fixtures.truncatedFilesystemList.totalEntries <= fixtures.truncatedFilesystemList.maxEntries) fail('filesystem truncation fixture');
if (!fixtures.submission.submissionId || !fixtures.submission.threadId) fail('submission fixture');

process.stdout.write('RPC contract fixtures are valid.\n');
