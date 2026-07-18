import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fail = (message) => {
  throw new Error(`Documentation consistency validation failed: ${message}`);
};

const walkFiles = (directory, extension) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath, extension);
    return entry.name.endsWith(extension) ? [entryPath] : [];
  });

const currentMarkdown = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'STATUS.md',
  'CHANGELOG.md',
  ...walkFiles(path.join(root, 'docs'), '.md')
    .map((file) => path.relative(root, file))
    .filter((file) => !file.startsWith(`docs${path.sep}plans${path.sep}`)),
];

const prohibitedPublicReviewGuidance = [
  /provide a publicly reachable bridge/i,
  /public review bridge url/i,
  /review bridge is reachable from the public internet/i,
  /review bridge url:\s*\[[^\]]*public/i,
  /bridge url:\s*\[[^\]]*public review/i,
];

const assertNoPublicReviewGuidance = (relativeFile, content) => {
  for (const pattern of prohibitedPublicReviewGuidance) {
    if (pattern.test(content)) fail(`${relativeFile} contains prohibited public-bridge review guidance`);
  }
};

for (const relativeFile of currentMarkdown) {
  const content = readFileSync(path.join(root, relativeFile), 'utf8');
  assertNoPublicReviewGuidance(relativeFile, content);

  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(path.join(root, relativeFile)), decodeURI(target));
    if (!existsSync(resolved)) fail(`${relativeFile} has a broken local link: ${match[1]}`);
  }
}

for (const htmlFile of walkFiles(path.join(root, 'site'), '.html')) {
  const content = readFileSync(htmlFile, 'utf8');
  assertNoPublicReviewGuidance(path.relative(root, htmlFile), content);
  for (const match of content.matchAll(/href="([^"]+)"/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(htmlFile), decodeURI(target));
    if (!existsSync(resolved)) fail(`${path.relative(root, htmlFile)} has a broken local link: ${match[1]}`);
  }
}

const appReview = readFileSync(path.join(root, 'docs/app-review-notes.md'), 'utf8');
for (const required of ['VPN', 'BRIDGE_AUTH_TOKEN', 'BRIDGE_ALLOW_INSECURE_NO_AUTH=false', 'Revoke VPN access']) {
  if (!appReview.includes(required)) fail(`app review template is missing: ${required}`);
}

const push = readFileSync(path.join(root, 'docs/push-notifications.md'), 'utf8');
for (const method of ['bridge/push/register', 'bridge/push/unregister', 'bridge/push/list']) {
  if (!push.includes(method)) fail(`push guide is missing method ${method}`);
}
if (/content-free/i.test(push)) fail('push guide incorrectly describes payloads as content-free');

const main = readFileSync(path.join(root, 'services/rust-bridge/src/main.rs'), 'utf8');
const operations = readFileSync(path.join(root, 'docs/setup-and-operations.md'), 'utf8');
const mainRoutes = [...main.matchAll(/\.route\(\s*"(\/(?:rpc|attachments|health|status|local-image))"/g)]
  .map((match) => match[1]);
for (const route of new Set(mainRoutes)) {
  if (!operations.includes(route)) fail(`operations API summary is missing ${route}`);
}

const status = readFileSync(path.join(root, 'STATUS.md'), 'utf8');
for (const staleClaim of ['No push notifications', 'No WebSocket reconnection', 'mac-bridge (Fastify)']) {
  if (status.includes(staleClaim)) fail(`STATUS.md contains stale claim: ${staleClaim}`);
}

const privacy = readFileSync(path.join(root, 'docs/privacy-policy.md'), 'utf8');
const sitePrivacy = readFileSync(path.join(root, 'site/privacy/index.html'), 'utf8');
for (const [name, content] of [['docs privacy policy', privacy], ['site privacy policy', sitePrivacy]]) {
  if (!/Expo Push Notification\s+Service/.test(content) || !/140/.test(content)) {
    fail(`${name} does not disclose push-provider transit and reply preview bounds`);
  }
}

process.stdout.write('Documentation security, contract, and local links are consistent.\n');
