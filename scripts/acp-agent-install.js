#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const tar = require("tar");
const unbzip2Stream = require("unbzip2-stream");
const yauzl = require("yauzl");
const { z } = require("zod");
const {
  DEFAULT_REGISTRY_URL,
  fetchRegistry,
  parseInstallerArgs,
  parseRegistry,
  requestHttpsResponse,
  selectDistribution,
  validateHttpsUrl,
} = require("./acp-agent-registry");

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 20_000;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TREE_FILES = 100_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TREE_PATH_BYTES = 4_096;
const MAX_TREE_RECEIPT_BYTES = 32 * 1024 * 1024;
const MAX_DEPENDENCY_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_DEPENDENCY_PACKAGES = 20_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSTALLER_POLICY_VERSION = 4;
const INSTALL_LOCK_TIMEOUT_MS = 30_000;
const INSTALL_LOCK_STALE_MS = 5 * 60_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TREE_RECEIPT_ALGORITHM = "tethercode-tree-v1";
const TREE_RECEIPT_EXCLUSIONS = [".tethercode-install.json"];
const DEPENDENCY_PLAN_PATH = ".tethercode-dependency-plan";
const UV_INDEX_URL = "https://pypi.org/simple";
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRANSACTION_ENTRY_NAMES = ["agents", "agents.json", "registry-provenance.json"];
const TEST_CRASH_EXIT_CODE = 86;

const dependencyPlanSchema = z.object({
  format: z.enum(["npm-package-lock-v3", "uv-requirements-v1"]),
  path: z.literal(DEPENDENCY_PLAN_PATH),
  sha256: z.string().regex(SHA256_PATTERN),
  packageCount: z.number().int().positive().max(MAX_DEPENDENCY_PACKAGES),
  authority: z.enum(["locally-resolved", "registry-supplied", "package-supplied"]),
}).strict();

const treeEntrySchema = z.discriminatedUnion("type", [
  z.object({
    path: z.string().min(1).max(MAX_TREE_PATH_BYTES),
    type: z.literal("directory"),
    mode: z.string().regex(/^0[0-7]{3}$/),
  }).strict(),
  z.object({
    path: z.string().min(1).max(MAX_TREE_PATH_BYTES),
    type: z.literal("file"),
    mode: z.string().regex(/^0[0-7]{3}$/),
    size: z.number().int().nonnegative().max(MAX_TREE_BYTES),
    sha256: z.string().regex(SHA256_PATTERN),
  }).strict(),
  z.object({
    path: z.string().min(1).max(MAX_TREE_PATH_BYTES),
    type: z.literal("symlink"),
    target: z.string().min(1).max(MAX_TREE_PATH_BYTES),
  }).strict(),
]);
const treeReceiptSchema = z.object({
  algorithm: z.literal(TREE_RECEIPT_ALGORITHM),
  exclusions: z.tuple([z.literal(".tethercode-install.json")]),
  entryCount: z.number().int().nonnegative().max(MAX_TREE_FILES),
  totalBytes: z.number().int().nonnegative().max(MAX_TREE_BYTES),
  receiptBytes: z.number().int().nonnegative().max(MAX_TREE_RECEIPT_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
  entries: z.array(treeEntrySchema).max(MAX_TREE_FILES),
}).strict();

const literalEnvironmentSchema = z.record(
  z.string(),
  z.object({ kind: z.literal("literal"), value: z.string() }).strict()
);
const expectedInstallSchema = z.object({
  policyVersion: z.literal(INSTALLER_POLICY_VERSION),
  registryUrl: z.string().url(),
  agentId: z.string(),
  version: z.string(),
  distribution: z.enum(["binary", "npx", "uvx"]),
  platformKey: z.string().nullable(),
  package: z.string().nullable(),
  cmd: z.string().nullable(),
  args: z.array(z.string()),
  env: z.record(z.string()),
  archive: z.string().nullable(),
  sha256: z.string().regex(SHA256_PATTERN).nullable(),
  trustUnverified: z.boolean(),
  trustInstallScripts: z.boolean(),
  dependencyLockSha256: z.string().regex(SHA256_PATTERN).nullable(),
  expectedTreeSha256: z.string().regex(SHA256_PATTERN).nullable(),
}).strict();
const installRecordSchema = z.object({
  policyVersion: z.literal(INSTALLER_POLICY_VERSION),
  fingerprint: z.string().regex(SHA256_PATTERN),
  expected: expectedInstallSchema,
  executable: z.string().min(1),
  argv: z.array(z.string()),
  environment: literalEnvironmentSchema,
  provenance: z.string(),
  verifiedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  integrity: z.object({
    executableSha256: z.string().regex(SHA256_PATTERN),
    binaryShape: z.enum(["single-file", "archive-tree"]).nullable(),
    artifact: z.object({
      path: z.string().min(1),
      sha256: z.string().regex(SHA256_PATTERN),
    }).strict().nullable(),
    npm: z.object({
      packageName: z.string(),
      packageSpec: z.string(),
      packageVersion: z.string(),
      lockIntegrity: z.string().min(1),
      lockResolved: z.string().min(1),
      binName: z.string().min(1),
      binPath: z.string().min(1),
      packageJsonSha256: z.string().regex(SHA256_PATTERN),
      packageLockSha256: z.string().regex(SHA256_PATTERN),
      plan: dependencyPlanSchema,
    }).strict().nullable(),
    uv: z.object({
      packageSpec: z.string(),
      normalizedName: z.string().min(1),
      packageVersion: z.string().min(1),
      executableName: z.string().min(1),
      metadataPath: z.string().min(1),
      metadataSha256: z.string().regex(SHA256_PATTERN),
      recordPath: z.string().min(1),
      recordSha256: z.string().regex(SHA256_PATTERN),
      entryPointsPath: z.string().min(1),
      entryPointsSha256: z.string().regex(SHA256_PATTERN),
      receiptSha256: z.string().regex(SHA256_PATTERN),
      plan: dependencyPlanSchema,
    }).strict().nullable(),
    tree: treeReceiptSchema.nullable(),
  }).strict(),
}).strict();
const transactionEntrySchema = z.object({
  name: z.enum(TRANSACTION_ENTRY_NAMES),
  destination: z.string().min(1),
  staged: z.string().min(1),
  backup: z.string().min(1),
  hadPrevious: z.boolean(),
  phase: z.enum(["pending", "backingUp", "publishing", "published"]),
}).strict();
const transactionJournalSchema = z.object({
  version: z.literal(2),
  transactionId: z.string().regex(TRANSACTION_ID_PATTERN),
  state: z.enum(["prepared", "publishing", "committed"]),
  stagingRoot: z.string().min(1),
  backupRoot: z.string().min(1),
  entries: z.array(transactionEntrySchema).min(1).max(TRANSACTION_ENTRY_NAMES.length),
}).strict();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function strongNpmIntegrity(value) {
  return typeof value === "string" && value.split(/\s+/).some((token) => {
    const match = token.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return false;
    try {
      return Buffer.from(match[1], "base64").length === 64;
    } catch {
      return false;
    }
  });
}

function exactVersion(value) {
  return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function validateNpmLock(packageLock, packageName, packageVersion, trustInstallScripts = false) {
  if (packageLock?.lockfileVersion !== 3 || !packageLock.packages || Array.isArray(packageLock.packages)) {
    throw new Error("npm resolution must produce package-lock v3");
  }
  const entries = Object.entries(packageLock.packages);
  if (entries.length < 2 || entries.length > MAX_DEPENDENCY_PACKAGES + 1) {
    throw new Error("npm dependency graph is empty or exceeds the package limit");
  }
  const root = packageLock.packages[""];
  if (!root || root.dependencies?.[packageName] !== packageVersion ||
      Object.keys(root.dependencies || {}).length !== 1) {
    throw new Error("npm lock root does not contain the single exact registry package");
  }
  for (const [location, entry] of entries) {
    if (location === "") continue;
    if (!location.startsWith("node_modules/") || entry.link || !exactVersion(entry.version)) {
      throw new Error(`npm lock entry '${location}' is not an exact registry package`);
    }
    let resolved;
    try {
      resolved = validateHttpsUrl(entry.resolved, `npm lock entry '${location}' resolved URL`);
    } catch (error) {
      throw new Error(error.message);
    }
    if (!resolved.hostname || !strongNpmIntegrity(entry.integrity)) {
      throw new Error(`npm lock entry '${location}' lacks strong sha512 integrity`);
    }
    if (entry.hasInstallScript && !trustInstallScripts) {
      throw new Error(`npm lock entry '${location}' requires an untrusted lifecycle script`);
    }
  }
  const top = packageLock.packages[`node_modules/${packageName}`];
  if (top?.version !== packageVersion) {
    throw new Error("npm lock does not contain the exact requested package identity");
  }
  return entries.length - 1;
}

function parseUvRequirements(value, packageSpec) {
  if (Buffer.byteLength(value) > MAX_DEPENDENCY_PLAN_BYTES) throw new Error("uv dependency plan exceeds the byte limit");
  const logicalLines = value.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const requirements = [];
  for (const line of logicalLines) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("--")) {
      const index = line.match(/^--(?:index-url|extra-index-url)\s+(\S+)$/)?.[1];
      if (!index) throw new Error(`uv dependency plan contains unsupported directive '${line}'`);
      validateHttpsUrl(index, "uv dependency index URL");
      continue;
    }
    if (/\s@\s|(?:^|\s)(?:git|hg|svn|bzr)\+|(?:^|\s)(?:file|http):/i.test(line)) {
      throw new Error("uv dependency plan contains a mutable VCS, path, or insecure source");
    }
    const identity = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)(?:\s|$)/);
    if (!identity || !pythonPackageIdentity(`${identity[1]}==${identity[2]}`)) {
      throw new Error(`uv dependency plan entry is not exact: '${line}'`);
    }
    const hashes = [...line.matchAll(/--hash=sha256:([a-fA-F0-9]{64})(?:\s|$)/g)].map((match) => match[1].toLowerCase());
    if (hashes.length === 0) throw new Error(`uv dependency plan entry '${identity[1]}' has no sha256 artifact hash`);
    requirements.push({ name: normalizedPythonName(identity[1]), version: identity[2], hashes });
  }
  if (requirements.length === 0 || requirements.length > MAX_DEPENDENCY_PACKAGES) {
    throw new Error("uv dependency graph is empty or exceeds the package limit");
  }
  const top = pythonPackageIdentity(packageSpec);
  if (!requirements.some((entry) => entry.name === top.normalizedName && entry.version === top.version)) {
    throw new Error("uv dependency plan does not contain the exact requested package identity");
  }
  return requirements;
}

async function persistDependencyPlan(staging, format, content, packageCount, authority = "locally-resolved") {
  if (Buffer.byteLength(content) > MAX_DEPENDENCY_PLAN_BYTES) throw new Error("dependency plan exceeds the byte limit");
  const plan = dependencyPlanSchema.parse({
    format,
    path: DEPENDENCY_PLAN_PATH,
    sha256: sha256Buffer(content),
    packageCount,
    authority,
  });
  await fsp.writeFile(path.join(staging, DEPENDENCY_PLAN_PATH), content, { flag: "wx", mode: 0o600 });
  return plan;
}

async function verifyDependencyPlan(root, plan) {
  const parsed = dependencyPlanSchema.parse(plan);
  const planPath = await canonicalFile(root, path.join(root, parsed.path), "dependency plan");
  const content = await fsp.readFile(planPath);
  if (content.length > MAX_DEPENDENCY_PLAN_BYTES || sha256Buffer(content) !== parsed.sha256) {
    throw new Error("cached dependency plan digest mismatch");
  }
  return content.toString("utf8");
}

async function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), digest);
  return digest.digest("hex");
}

function compareTreeNames(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function normalizedTreePath(root, candidate, label) {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (!relative || relative === "." || relative.startsWith("../") || path.posix.isAbsolute(relative) ||
      relative.includes("\\") || relative.includes("\0") || Buffer.byteLength(relative) > MAX_TREE_PATH_BYTES) {
    throw new Error(`${label} is not a valid contained receipt path`);
  }
  return relative;
}

function encodeTreeEntries(entries) {
  return Buffer.from(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

function treeMode(stat) {
  return process.platform === "win32" ? "0000" : `0${(stat.mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function buildTreeReceipt(root, { exclusions = TREE_RECEIPT_EXCLUSIONS } = {}) {
  const canonicalRoot = await fsp.realpath(root);
  const excluded = new Set(exclusions);
  if (excluded.size !== exclusions.length || exclusions.some((value) => value !== ".tethercode-install.json")) {
    throw new Error("installation tree receipt exclusions are invalid");
  }
  const entries = [];
  let totalBytes = 0;

  async function visit(directory) {
    const names = await fsp.readdir(directory);
    names.sort(compareTreeNames);
    for (const name of names) {
      const entryPath = path.join(directory, name);
      const relative = normalizedTreePath(canonicalRoot, entryPath, "installation tree entry");
      if (excluded.has(relative)) continue;
      const stat = await fsp.lstat(entryPath);
      if (stat.isDirectory()) {
        if (entries.length >= MAX_TREE_FILES) throw new Error("installation tree exceeds the file count limit");
        entries.push({
          path: relative,
          type: "directory",
          mode: treeMode(stat),
        });
        await visit(entryPath);
        continue;
      }
      if (entries.length >= MAX_TREE_FILES) throw new Error("installation tree exceeds the file count limit");
      if (stat.isSymbolicLink()) {
        const rawTarget = await fsp.readlink(entryPath);
        if (path.isAbsolute(rawTarget)) throw new Error(`installation tree symlink '${relative}' has an absolute target`);
        const targetPath = path.resolve(path.dirname(entryPath), rawTarget);
        const target = normalizedTreePath(canonicalRoot, targetPath, `installation tree symlink '${relative}' target`);
        const canonicalTarget = await fsp.realpath(entryPath).catch(() => {
          throw new Error(`installation tree symlink '${relative}' is broken`);
        });
        assertContained(canonicalRoot, canonicalTarget, `installation tree symlink '${relative}' target`);
        entries.push({ path: relative, type: "symlink", target });
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`installation tree file '${relative}' is a hardlink`);
        totalBytes += stat.size;
        if (totalBytes > MAX_TREE_BYTES) throw new Error("installation tree exceeds the byte limit");
        entries.push({
          path: relative,
          type: "file",
          mode: treeMode(stat),
          size: stat.size,
          sha256: await sha256File(entryPath),
        });
      } else {
        throw new Error(`installation tree entry '${relative}' has an unsupported file type`);
      }
    }
  }

  await visit(canonicalRoot);
  entries.sort((left, right) => compareTreeNames(left.path, right.path));
  const encoding = encodeTreeEntries(entries);
  if (encoding.length > MAX_TREE_RECEIPT_BYTES) throw new Error("installation tree receipt exceeds the byte limit");
  return treeReceiptSchema.parse({
    algorithm: TREE_RECEIPT_ALGORITHM,
    exclusions,
    entryCount: entries.length,
    totalBytes,
    receiptBytes: encoding.length,
    sha256: sha256Buffer(encoding),
    entries,
  });
}

async function makeInstallationTreeReadOnly(root) {
  if (process.platform === "win32") return;
  async function visit(directory) {
    for (const name of await fsp.readdir(directory)) {
      const entryPath = path.join(directory, name);
      const stat = await fsp.lstat(entryPath);
      if (stat.isDirectory()) {
        await visit(entryPath);
        await fsp.chmod(entryPath, (stat.mode & 0o555) | 0o200);
      } else if (stat.isFile()) {
        await fsp.chmod(entryPath, stat.mode & 0o555);
      }
    }
  }
  await visit(root);
}

function installExpectation(agent, selected, options) {
  const value = selected.value;
  const dependencyLock = value.packageLock || value.npmShrinkwrap || null;
  return expectedInstallSchema.parse({
    policyVersion: INSTALLER_POLICY_VERSION,
    registryUrl: options.registryUrl,
    agentId: agent.id,
    version: agent.version,
    distribution: selected.kind,
    platformKey: selected.platformKey || null,
    package: value.package || null,
    cmd: value.cmd || null,
    args: value.args || [],
    env: value.env || {},
    archive: value.archive || null,
    sha256: value.sha256?.toLowerCase() || null,
    trustUnverified: Boolean(options.trustUnverified),
    trustInstallScripts: Boolean(options.trustInstallScripts),
    dependencyLockSha256: dependencyLock ? sha256Buffer(canonicalJson(dependencyLock)) : null,
    expectedTreeSha256: value.treeSha256?.toLowerCase() || null,
  });
}

function installFingerprint(expected) {
  return sha256Buffer(JSON.stringify(stableValue(expected)));
}

function expectedProvenance(expected) {
  if (expected.distribution === "binary") {
    return `registry:${expected.registryUrl}#binary:${expected.archive}`;
  }
  if (expected.distribution === "npx") {
    return `registry:${expected.registryUrl}#npx:${expected.package};scripts=${expected.trustInstallScripts ? "trusted" : "disabled"}`;
  }
  return `registry:${expected.registryUrl}#uvx:${expected.package}`;
}

function provenanceWithPlan(expected, plan) {
  return `${expectedProvenance(expected)};plan=sha256:${plan.sha256}`;
}

function assertContained(root, candidate, label = "path") {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes the ACP agent install root`);
  }
  return resolved;
}

function safeArchivePath(root, entryName) {
  const normalized = entryName.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || path.posix.isAbsolute(normalized)) {
    throw new Error(`unsafe archive entry '${entryName}'`);
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`unsafe archive entry '${entryName}'`);
  }
  return assertContained(root, path.join(root, ...parts), "archive entry");
}

async function downloadFile(
  sourceUrl,
  destination,
  { maxBytes = MAX_DOWNLOAD_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxRedirects, request = https.get } = {}
) {
  validateHttpsUrl(sourceUrl, "ACP binary download URL");
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  return requestHttpsResponse(
    sourceUrl,
    { maxBodyBytes: maxBytes, timeoutMs, maxRedirects, request },
    ({ response, request: req, accountChunk }) => new Promise((resolve, reject) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`ACP binary download failed with HTTP ${response.statusCode}`));
        return;
      }
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > maxBytes) {
        response.resume();
        reject(new Error("ACP binary download exceeds the configured size limit"));
        return;
      }
      const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
      const digest = crypto.createHash("sha256");
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        try {
          accountChunk(chunk);
        } catch (error) {
          req.destroy(error);
        }
        digest.update(chunk);
      });
      pipeline(response, output)
        .then(() => resolve({ bytes, sha256: digest.digest("hex") }))
        .catch(reject);
    })
  ).catch(async (error) => {
    await fsp.rm(destination, { force: true });
    throw error;
  });
}

async function extractTar(archivePath, destination, compression) {
  let count = 0;
  let total = 0;
  let violation = null;
  const options = {
    cwd: destination,
    preservePaths: false,
    strict: true,
    filter(entryPath, entry) {
      if (violation) return false;
      count += 1;
      total += entry.size || 0;
      try {
        safeArchivePath(destination, entryPath);
        if (["SymbolicLink", "Link"].includes(entry.type)) {
          throw new Error(`archive links are not allowed: ${entryPath}`);
        }
        if (count > MAX_ARCHIVE_FILES || total > MAX_EXTRACTED_BYTES) {
          throw new Error("archive exceeds extraction limits");
        }
        return true;
      } catch (error) {
        violation = error;
        return false;
      }
    },
  };
  if (compression === "gz") options.gzip = true;
  if (compression === "bz2") {
    await pipeline(fs.createReadStream(archivePath), unbzip2Stream(), tar.x(options));
  } else {
    await tar.x({ ...options, file: archivePath });
  }
  if (violation) throw violation;
}

async function extractZip(archivePath, destination) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true }, (error, value) =>
      error ? reject(error) : resolve(value)
    )
  );
  let count = 0;
  let total = 0;
  await new Promise((resolve, reject) => {
    const fail = (error) => {
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", resolve);
    zip.on("entry", (entry) => {
      try {
        count += 1;
        total += entry.uncompressedSize;
        if (count > MAX_ARCHIVE_FILES || total > MAX_EXTRACTED_BYTES) {
          throw new Error("archive exceeds extraction limits");
        }
        const target = safeArchivePath(destination, entry.fileName);
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) throw new Error(`archive links are not allowed: ${entry.fileName}`);
        if (entry.fileName.endsWith("/")) {
          fsp.mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
          return;
        }
        fsp.mkdir(path.dirname(target), { recursive: true })
          .then(() => new Promise((openResolve, openReject) => zip.openReadStream(entry, (error, stream) => error ? openReject(error) : openResolve(stream))))
          .then((stream) => pipeline(stream, fs.createWriteStream(target, { flags: "wx", mode: unixMode & 0o777 || 0o600 })))
          .then(() => zip.readEntry(), fail);
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

async function detectAndExtract(downloadPath, sourceUrl, destination) {
  const lowerPath = new URL(sourceUrl).pathname.toLowerCase();
  if (lowerPath.endsWith(".zip")) return extractZip(downloadPath, destination);
  if (lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tgz")) return extractTar(downloadPath, destination, "gz");
  if (lowerPath.endsWith(".tar.bz2") || lowerPath.endsWith(".tbz2")) return extractTar(downloadPath, destination, "bz2");
  if (lowerPath.endsWith(".tar")) return extractTar(downloadPath, destination, "none");
  return false;
}

function literalEnvironment(environment = {}) {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [name, { kind: "literal", value }])
  );
}

async function canonicalExecutable(root, executable, { allowChmod = false } = {}) {
  const canonicalRoot = await fsp.realpath(root);
  const canonical = await fsp.realpath(executable);
  assertContained(canonicalRoot, canonical, "resolved executable");
  const stat = await fsp.stat(canonical);
  if (!stat.isFile()) throw new Error("resolved ACP executable is not a file");
  if (process.platform !== "win32" && !(stat.mode & 0o111)) {
    if (!allowChmod) throw new Error("resolved ACP executable is not executable");
    await fsp.chmod(canonical, stat.mode | 0o700);
  }
  return canonical;
}

async function canonicalFile(root, filePath, label = "resolved file") {
  const canonicalRoot = await fsp.realpath(root);
  const canonical = await fsp.realpath(filePath);
  assertContained(canonicalRoot, canonical, label);
  const stat = await fsp.stat(canonical);
  if (!stat.isFile()) throw new Error(`${label} is not a file`);
  return canonical;
}

async function installBinary(agent, distribution, staging, options) {
  const downloadPath = path.join(staging, ".tethercode-artifact");
  const downloaded = await downloadFile(distribution.archive, downloadPath, options.downloadOptions);
  if (distribution.sha256 && downloaded.sha256.toLowerCase() !== distribution.sha256.toLowerCase()) {
    throw new Error(`checksum mismatch for ACP agent '${agent.id}'`);
  }
  if (!distribution.sha256 && !options.trustUnverified) {
    throw new Error(`ACP agent '${agent.id}' binary has no sha256; rerun with --trust-unverified after reviewing its provenance`);
  }
  const extracted = await detectAndExtract(downloadPath, distribution.archive, staging);
  if (extracted === false && !distribution.sha256) {
    throw new Error(`ACP agent '${agent.id}' single-file binary requires a registry sha256`);
  }
  let executable;
  if (extracted === false) {
    executable = assertContained(
      staging,
      path.resolve(staging, distribution.cmd.replaceAll("\\", "/")),
      "binary command"
    );
    await fsp.mkdir(path.dirname(executable), { recursive: true });
    await fsp.copyFile(downloadPath, executable, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await fsp.chmod(executable, 0o700);
  } else {
    executable = assertContained(staging, path.resolve(staging, distribution.cmd.replaceAll("\\", "/")), "binary command");
  }
  const canonical = await canonicalExecutable(staging, executable, { allowChmod: true });
  const executableSha256 = await sha256File(canonical);
  const tree = extracted === false ? null : await buildTreeReceipt(staging);
  return {
    executable: canonical,
    argv: distribution.args,
    environment: literalEnvironment(distribution.env),
    provenance: `registry:${options.registryUrl}#binary:${distribution.archive}`,
    verifiedDigest: `sha256:${executableSha256}`,
    integrity: {
      executableSha256,
      binaryShape: extracted === false ? "single-file" : "archive-tree",
      artifact: { path: ".tethercode-artifact", sha256: downloaded.sha256 },
      npm: null,
      uv: null,
      tree,
    },
  };
}

function packageNameFromSpec(spec) {
  const match = spec.match(/^(@[^/]+\/[^@]+|[^@/]+)@(.+)$/);
  if (!match || !match[2] || match[2] === "latest" || /[~^*xX]/.test(match[2])) {
    throw new Error(`registry npm package must use an exact version: '${spec}'`);
  }
  return match[1];
}

function packageVersionFromSpec(spec) {
  packageNameFromSpec(spec);
  return spec.slice(spec.lastIndexOf("@") + 1);
}

function normalizedPythonName(value) {
  return value.toLowerCase().replace(/[-_.]+/g, "-");
}

function pythonPackageIdentity(spec) {
  const match = spec.match(/^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==([A-Za-z0-9](?:[A-Za-z0-9.!+_-]*[A-Za-z0-9])?)$/);
  if (!match || /(?:latest|[~^*xX])/i.test(match[2])) {
    throw new Error(`registry uv package must use an exact name and version: '${spec}'`);
  }
  return { normalizedName: normalizedPythonName(match[1]), version: match[2] };
}

async function walkFiles(root) {
  const files = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}

function parseMetadataIdentity(value) {
  const name = value.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
  const version = value.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
  if (!name || !version) throw new Error("uv distribution METADATA is missing Name or Version");
  return { normalizedName: normalizedPythonName(name), version };
}

function parseCsvRow(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("uv RECORD contains malformed CSV");
  values.push(value);
  return values;
}

async function inspectUvEnvironment(staging, packageSpec, executableName) {
  const expected = pythonPackageIdentity(packageSpec);
  const canonicalStaging = await fsp.realpath(staging);
  const toolRoot = await fsp.realpath(path.join(staging, "tools"));
  const files = await walkFiles(toolRoot);
  const metadataFiles = files.filter((file) => file.endsWith(`${path.sep}METADATA`) && path.basename(path.dirname(file)).endsWith(".dist-info"));
  if (metadataFiles.length === 0) throw new Error("uv tool install produced no dist-info METADATA");
  const distributions = [];
  let primary = null;
  for (const metadataFile of metadataFiles.sort()) {
    const distInfoRoot = path.dirname(metadataFile);
    const recordFile = path.join(distInfoRoot, "RECORD");
    const entryPointsFile = path.join(distInfoRoot, "entry_points.txt");
    const metadata = await fsp.readFile(metadataFile, "utf8");
    const identity = parseMetadataIdentity(metadata);
    const record = await fsp.readFile(recordFile, "utf8").catch(() => {
      throw new Error(`uv distribution '${identity.normalizedName}' is missing RECORD`);
    });
    const entries = [];
    for (const line of record.split(/\r?\n/).filter(Boolean)) {
      const [recordPath, declaredHash] = parseCsvRow(line);
      if (!recordPath) throw new Error("uv RECORD contains an empty path");
      const artifact = assertContained(toolRoot, path.resolve(path.dirname(distInfoRoot), recordPath), "uv RECORD artifact");
      if (path.resolve(artifact) === path.resolve(recordFile) && !declaredHash) continue;
      const match = declaredHash?.match(/^sha256=([A-Za-z0-9_-]+)$/);
      if (!match) throw new Error(`uv RECORD entry '${recordPath}' lacks a sha256 hash`);
      const canonical = await canonicalFile(toolRoot, artifact, "uv RECORD artifact");
      const actualHex = await sha256File(canonical);
      const actualBase64 = Buffer.from(actualHex, "hex").toString("base64url");
      if (actualBase64 !== match[1]) throw new Error(`uv RECORD hash mismatch for '${recordPath}'`);
      entries.push({ path: path.relative(toolRoot, canonical), sha256: actualHex });
    }
    if (entries.length === 0) throw new Error(`uv distribution '${identity.normalizedName}' has no integrity-bearing RECORD entries`);
    const evidence = {
      ...identity,
      metadataPath: path.relative(canonicalStaging, metadataFile),
      metadataSha256: await sha256File(metadataFile),
      recordPath: path.relative(canonicalStaging, recordFile),
      recordSha256: sha256Buffer(record),
      entries,
    };
    distributions.push(evidence);
    if (identity.normalizedName === expected.normalizedName && identity.version === expected.version) {
      if (primary) throw new Error(`uv package '${packageSpec}' produced duplicate primary metadata`);
      const entryPoints = await fsp.readFile(entryPointsFile, "utf8").catch(() => {
        throw new Error(`uv package '${packageSpec}' is missing entry_points.txt`);
      });
      const consoleScripts = entryPoints.match(/(?:^|\n)\[console_scripts\]\s*\n([\s\S]*?)(?=\n\[|$)/)?.[1] || "";
      const mappedNames = consoleScripts.split(/\r?\n/)
        .map((line) => line.match(/^\s*([^=\s]+)\s*=/)?.[1])
        .filter(Boolean);
      if (!mappedNames.includes(executableName)) {
        throw new Error(`uv executable '${executableName}' is not mapped by the selected package`);
      }
      primary = {
        ...evidence,
        entryPointsPath: path.relative(canonicalStaging, entryPointsFile),
        entryPointsSha256: sha256Buffer(entryPoints),
      };
    }
  }
  if (!primary) throw new Error(`uv package '${packageSpec}' did not install the exact requested identity`);
  return {
    packageSpec,
    normalizedName: expected.normalizedName,
    packageVersion: expected.version,
    executableName,
    metadataPath: primary.metadataPath,
    metadataSha256: primary.metadataSha256,
    recordPath: primary.recordPath,
    recordSha256: primary.recordSha256,
    entryPointsPath: primary.entryPointsPath,
    entryPointsSha256: primary.entryPointsSha256,
    receiptSha256: sha256Buffer(JSON.stringify(stableValue(distributions))),
  };
}

async function uvConsoleScriptName(staging, packageSpec) {
  const expected = pythonPackageIdentity(packageSpec);
  const files = await walkFiles(path.join(staging, "tools"));
  const matches = [];
  for (const metadataFile of files.filter((file) => file.endsWith(`${path.sep}METADATA`))) {
    const identity = parseMetadataIdentity(await fsp.readFile(metadataFile, "utf8"));
    if (identity.normalizedName !== expected.normalizedName || identity.version !== expected.version) continue;
    const entryPoints = await fsp.readFile(path.join(path.dirname(metadataFile), "entry_points.txt"), "utf8").catch(() => "");
    const consoleScripts = entryPoints.match(/(?:^|\n)\[console_scripts\]\s*\n([\s\S]*?)(?=\n\[|$)/)?.[1] || "";
    matches.push(...consoleScripts.split(/\r?\n/).map((line) => line.match(/^\s*([^=\s]+)\s*=/)?.[1]).filter(Boolean));
  }
  if (matches.length !== 1) throw new Error(`uv package '${packageSpec}' did not install the exact requested identity with one console executable`);
  return matches[0];
}

function runChecked(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result;
}

async function installNpx(agent, distribution, staging, options) {
  const packageName = packageNameFromSpec(distribution.package);
  const packageVersion = packageVersionFromSpec(distribution.package);
  const packageJsonPath = path.join(staging, "package.json");
  const packageLockPath = path.join(staging, "package-lock.json");
  await fsp.writeFile(packageJsonPath, canonicalJson({ private: true, dependencies: { [packageName]: packageVersion } }));
  const runCommand = options.runCommand || runChecked;
  const commandOptions = { cwd: staging, env: { ...process.env, npm_config_update_notifier: "false" } };
  const authoritativeLock = distribution.packageLock || distribution.npmShrinkwrap || null;
  if (authoritativeLock) {
    await fsp.writeFile(packageLockPath, canonicalJson(authoritativeLock));
  } else {
    runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts", "--package-lock=true", "--save-exact", "--no-audit", "--no-fund"], commandOptions);
  }
  const packageLock = JSON.parse(await fsp.readFile(packageLockPath, "utf8"));
  const packageCount = validateNpmLock(packageLock, packageName, packageVersion, options.trustInstallScripts);
  const canonicalLock = canonicalJson(packageLock);
  await fsp.writeFile(packageLockPath, canonicalLock);
  const plan = await persistDependencyPlan(
    staging,
    "npm-package-lock-v3",
    canonicalLock,
    packageCount,
    authoritativeLock ? "registry-supplied" : "locally-resolved"
  );
  const lockDigestBeforeInstall = await sha256File(packageLockPath);
  const installArgs = ["ci", "--package-lock=true", "--no-audit", "--no-fund"];
  if (!options.trustInstallScripts) installArgs.push("--ignore-scripts");
  runCommand("npm", installArgs, commandOptions);
  if (await sha256File(packageLockPath) !== lockDigestBeforeInstall) {
    throw new Error("npm ci rewrote the validated dependency plan");
  }
  const packageRoot = path.join(staging, "node_modules", ...packageName.split("/"));
  const installedPackageJsonPath = path.join(packageRoot, "package.json");
  const metadata = JSON.parse(await fsp.readFile(installedPackageJsonPath, "utf8"));
  const lockEntry = packageLock.packages?.[`node_modules/${packageName}`];
  if (packageLock.packages?.[""]?.dependencies?.[packageName] !== packageVersion ||
      metadata.name !== packageName || metadata.version !== packageVersion ||
      lockEntry?.version !== packageVersion || typeof lockEntry.integrity !== "string" ||
      typeof lockEntry.resolved !== "string") {
    throw new Error(`npm package '${distribution.package}' did not produce an exact integrity-bearing lock`);
  }
  const bins = typeof metadata.bin === "string" ? { [packageName.split("/").at(-1)]: metadata.bin } : metadata.bin;
  if (!bins || Object.keys(bins).length !== 1) throw new Error(`npm package '${packageName}' must expose exactly one executable`);
  const [binName, binPath] = Object.entries(bins)[0];
  const entry = assertContained(packageRoot, path.resolve(packageRoot, binPath), "npm executable");
  const canonical = await canonicalExecutable(staging, entry, { allowChmod: true });
  const executableSha256 = await sha256File(canonical);
  await makeInstallationTreeReadOnly(staging);
  const tree = await buildTreeReceipt(staging);
  if (distribution.treeSha256 && tree.sha256 !== distribution.treeSha256.toLowerCase()) {
    throw new Error("npm installation tree does not match the registry authority");
  }
  return {
    executable: canonical,
    argv: distribution.args,
    environment: literalEnvironment(distribution.env),
    provenance: `registry:${options.registryUrl}#npx:${distribution.package};scripts=${options.trustInstallScripts ? "trusted" : "disabled"};plan=sha256:${plan.sha256}`,
    verifiedDigest: `sha256:${executableSha256}`,
    integrity: {
      executableSha256,
      binaryShape: null,
      artifact: null,
      npm: {
        packageName,
        packageSpec: distribution.package,
        packageVersion,
        lockIntegrity: lockEntry.integrity,
        lockResolved: lockEntry.resolved,
        binName,
        binPath,
        packageJsonSha256: await sha256File(installedPackageJsonPath),
        packageLockSha256: await sha256File(packageLockPath),
        plan,
      },
      uv: null,
      tree,
    },
  };
}

async function installUvx(agent, distribution, staging, options) {
  pythonPackageIdentity(distribution.package);
  const requirementsInput = path.join(staging, "requirements.in");
  const requirementsLock = path.join(staging, "requirements.lock");
  const environmentRoot = path.join(staging, "tools");
  const binRoot = process.platform === "win32" ? path.join(environmentRoot, "Scripts") : path.join(environmentRoot, "bin");
  const python = process.platform === "win32" ? path.join(binRoot, "python.exe") : path.join(binRoot, "python");
  const runCommand = options.runCommand || runChecked;
  const commandOptions = { cwd: staging, env: { ...process.env } };
  await fsp.writeFile(requirementsInput, `${distribution.package}\n`, { mode: 0o600 });
  runCommand("uv", ["pip", "compile", "--generate-hashes", "--no-header", "--no-annotate", "--output-file", requirementsLock, requirementsInput], commandOptions);
  const generatedRequirements = await fsp.readFile(requirementsLock, "utf8");
  const requirements = `--index-url ${UV_INDEX_URL}\n${generatedRequirements}`;
  await fsp.writeFile(requirementsLock, requirements);
  const packageCount = parseUvRequirements(requirements, distribution.package).length;
  const plan = await persistDependencyPlan(staging, "uv-requirements-v1", requirements, packageCount);
  const planDigestBeforeInstall = await sha256File(requirementsLock);
  runCommand("uv", ["venv", "--no-project", environmentRoot], commandOptions);
  runCommand("uv", ["pip", "sync", "--require-hashes", "--python", python, requirementsLock], commandOptions);
  if (await sha256File(requirementsLock) !== planDigestBeforeInstall ||
      sha256Buffer(await fsp.readFile(path.join(staging, DEPENDENCY_PLAN_PATH))) !== plan.sha256) {
    throw new Error("uv sync rewrote the validated dependency plan");
  }
  const executableName = await uvConsoleScriptName(staging, distribution.package);
  const canonical = await canonicalExecutable(staging, path.join(binRoot, executableName), { allowChmod: true });
  const uvEvidence = await inspectUvEnvironment(staging, distribution.package, executableName);
  const executableSha256 = await sha256File(canonical);
  await makeInstallationTreeReadOnly(staging);
  const tree = await buildTreeReceipt(staging);
  if (distribution.treeSha256 && tree.sha256 !== distribution.treeSha256.toLowerCase()) {
    throw new Error("uv installation tree does not match the registry authority");
  }
  return {
    executable: canonical,
    argv: distribution.args,
    environment: literalEnvironment(distribution.env),
    provenance: `registry:${options.registryUrl}#uvx:${distribution.package};plan=sha256:${plan.sha256}`,
    verifiedDigest: `sha256:${executableSha256}`,
    integrity: {
      executableSha256,
      binaryShape: null,
      artifact: null,
      npm: null,
      uv: { ...uvEvidence, plan },
      tree,
    },
  };
}

function persistenceBoundary(name, options = {}) {
  options.persistenceHook?.(name);
  if (process.env.TETHERCODE_INSTALL_TEST_CRASH_AT === name) process.exit(TEST_CRASH_EXIT_CODE);
}

async function syncDirectory(directory, options = {}) {
  const io = options.fs || fsp;
  let handle;
  try {
    handle = await io.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const unsupportedOnWindows = process.platform === "win32" &&
      ["EISDIR", "EPERM", "EINVAL", "EBADF", "ENOTSUP"].includes(error.code);
    if (!unsupportedOnWindows) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWriteFile(destination, contents, options = {}) {
  const io = options.fs || fsp;
  await io.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle;
  try {
    handle = await io.open(temporary, "wx", options.mode ?? 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    persistenceBoundary(`${options.boundary || "atomic-write"}:file`, options);
    await handle.close();
    handle = undefined;
    await io.rename(temporary, destination);
    await syncDirectory(path.dirname(destination), options);
    persistenceBoundary(`${options.boundary || "atomic-write"}:parent`, options);
  } catch (error) {
    await handle?.close().catch(() => {});
    await io.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(destination, value, options = {}) {
  await atomicWriteFile(destination, `${JSON.stringify(value, null, 2)}\n`, options);
}

async function durableRename(source, destination, boundary, options = {}) {
  const io = options.fs || fsp;
  await io.rename(source, destination);
  const sourceParent = path.dirname(source);
  const destinationParent = path.dirname(destination);
  await syncDirectory(sourceParent, options);
  persistenceBoundary(`${boundary}:source-parent`, options);
  if (destinationParent !== sourceParent) {
    await syncDirectory(destinationParent, options);
    persistenceBoundary(`${boundary}:destination-parent`, options);
  }
}

async function durableRemove(target, options = {}) {
  const io = options.fs || fsp;
  await io.rm(target, { recursive: true, force: true });
  await syncDirectory(path.dirname(target), options);
  persistenceBoundary(options.boundary || `remove:${path.basename(target)}`, options);
}

async function ensureLocalInstallRoot(workspace) {
  const canonicalWorkspace = await fsp.realpath(workspace);
  let current = canonicalWorkspace;
  for (const segment of [".tethercode"]) {
    current = path.join(current, segment);
    try {
      const stat = await fsp.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`ACP install root component '${current}' must be a real directory`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await fsp.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
        const stat = await fsp.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`ACP install root component '${current}' must be a real directory`);
        }
      }
    }
  }
  return current;
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function verifyInstallRecord(finalRoot, expected) {
  const record = installRecordSchema.parse(await readJson(path.join(finalRoot, ".tethercode-install.json")));
  const fingerprint = installFingerprint(expected);
  if (record.fingerprint !== fingerprint ||
      JSON.stringify(stableValue(record.expected)) !== JSON.stringify(stableValue(expected))) {
    throw new Error("cached ACP install fingerprint does not match the selected registry distribution");
  }
  if (JSON.stringify(record.argv) !== JSON.stringify(expected.args) ||
      JSON.stringify(record.environment) !== JSON.stringify(literalEnvironment(expected.env))) {
    throw new Error("cached ACP install command metadata does not match the registry");
  }
  const dependencyPlan = record.integrity.npm?.plan || record.integrity.uv?.plan;
  const provenance = dependencyPlan ? provenanceWithPlan(expected, dependencyPlan) : expectedProvenance(expected);
  if (record.provenance !== provenance) {
    throw new Error("cached ACP install provenance does not match the registry");
  }
  const executable = await canonicalExecutable(finalRoot, path.join(finalRoot, record.executable));
  if (await sha256File(executable) !== record.integrity.executableSha256) {
    throw new Error("cached ACP executable digest mismatch");
  }
  if (record.verifiedDigest !== `sha256:${record.integrity.executableSha256}`) {
    throw new Error("cached ACP runtime executable digest mismatch");
  }
  if (expected.distribution === "npx" || expected.distribution === "uvx" ||
      record.integrity.binaryShape === "archive-tree") {
    const actualTree = await buildTreeReceipt(finalRoot);
    if (!record.integrity.tree || JSON.stringify(actualTree) !== JSON.stringify(record.integrity.tree)) {
      throw new Error("cached installation tree receipt mismatch");
    }
  } else if (record.integrity.tree) {
    throw new Error("cached binary installation tree provenance is invalid");
  }

  if (expected.distribution === "binary") {
    const artifact = record.integrity.artifact;
    if (!artifact || !record.integrity.binaryShape || record.integrity.npm || record.integrity.uv ||
        (record.integrity.binaryShape === "single-file" && (!expected.sha256 || record.integrity.tree)) ||
        (record.integrity.binaryShape === "archive-tree" && !record.integrity.tree)) {
      throw new Error("cached binary integrity provenance is invalid");
    }
    const artifactPath = await canonicalFile(finalRoot, path.join(finalRoot, artifact.path), "binary artifact");
    const artifactDigest = await sha256File(artifactPath);
    if (artifactDigest !== artifact.sha256 || (expected.sha256 && artifactDigest !== expected.sha256)) {
      throw new Error("cached binary artifact digest mismatch");
    }
    if (expected.sha256) {
      const verificationRoot = `${finalRoot}.verify-${process.pid}-${crypto.randomUUID()}`;
      await fsp.mkdir(verificationRoot, { mode: 0o700 });
      try {
        const extracted = await detectAndExtract(artifactPath, expected.archive, verificationRoot);
        let expectedExecutableDigest;
        if (extracted === false) {
          expectedExecutableDigest = artifactDigest;
        } else {
          const expectedExecutable = assertContained(
            verificationRoot,
            path.resolve(verificationRoot, expected.cmd.replaceAll("\\", "/")),
            "verified binary command"
          );
          expectedExecutableDigest = await sha256File(await canonicalFile(
            verificationRoot,
            expectedExecutable,
            "verified binary executable"
          ));
        }
        if (await sha256File(executable) !== expectedExecutableDigest) {
          throw new Error("cached ACP executable does not match the verified binary artifact");
        }
      } finally {
        await fsp.rm(verificationRoot, { recursive: true, force: true });
      }
    }
  } else if (expected.distribution === "npx") {
    const evidence = record.integrity.npm;
    if (!evidence || record.integrity.binaryShape || record.integrity.artifact || record.integrity.uv ||
        evidence.packageSpec !== expected.package) {
      throw new Error("cached npm integrity provenance is invalid");
    }
    const packageRoot = path.join(finalRoot, "node_modules", ...evidence.packageName.split("/"));
    const packageJsonPath = assertContained(finalRoot, path.join(packageRoot, "package.json"), "npm package metadata");
    const packageLockPath = path.join(finalRoot, "package-lock.json");
    if (await sha256File(packageJsonPath) !== evidence.packageJsonSha256 ||
        await sha256File(packageLockPath) !== evidence.packageLockSha256) {
      throw new Error("cached npm metadata digest mismatch");
    }
    const metadata = await readJson(packageJsonPath);
    const packageLock = await readJson(packageLockPath);
    const planContent = await verifyDependencyPlan(finalRoot, evidence.plan);
    if (planContent !== canonicalJson(packageLock) ||
        validateNpmLock(packageLock, evidence.packageName, evidence.packageVersion, expected.trustInstallScripts) !== evidence.plan.packageCount) {
      throw new Error("cached npm dependency plan does not match the installed lock");
    }
    for (const [location, lockPackage] of Object.entries(packageLock.packages).filter(([location]) => location)) {
      const installedMetadata = await readJson(path.join(finalRoot, location, "package.json")).catch(() => null);
      if ((!installedMetadata && !lockPackage.optional) ||
          (installedMetadata && installedMetadata.version !== lockPackage.version)) {
        throw new Error(`cached npm package metadata mismatch for '${location}'`);
      }
    }
    const lockEntry = packageLock.packages?.[`node_modules/${evidence.packageName}`];
    const bins = typeof metadata.bin === "string"
      ? { [evidence.packageName.split("/").at(-1)]: metadata.bin }
      : metadata.bin;
    if (metadata.name !== evidence.packageName || metadata.version !== evidence.packageVersion ||
        packageLock.packages?.[""]?.dependencies?.[evidence.packageName] !== evidence.packageVersion ||
        lockEntry?.version !== evidence.packageVersion || lockEntry?.integrity !== evidence.lockIntegrity ||
        lockEntry?.resolved !== evidence.lockResolved || Object.keys(bins || {}).length !== 1 ||
        bins?.[evidence.binName] !== evidence.binPath ||
        await fsp.realpath(path.resolve(packageRoot, evidence.binPath)) !== executable) {
      throw new Error("cached npm lock or executable mapping mismatch");
    }
  } else {
    const evidence = record.integrity.uv;
    if (!evidence || record.integrity.binaryShape || record.integrity.artifact || record.integrity.npm ||
        evidence.packageSpec !== expected.package) {
      throw new Error("cached uv integrity provenance is invalid");
    }
    const planContent = await verifyDependencyPlan(finalRoot, evidence.plan);
    if (parseUvRequirements(planContent, evidence.packageSpec).length !== evidence.plan.packageCount) {
      throw new Error("cached uv dependency plan does not match its provenance");
    }
    const inspected = await inspectUvEnvironment(finalRoot, evidence.packageSpec, evidence.executableName);
    inspected.plan = evidence.plan;
    if (JSON.stringify(inspected) !== JSON.stringify(evidence)) {
      throw new Error("cached uv tool metadata mismatch");
    }
  }
  return { ...record, executable };
}

async function acquireInstallLock(lockPath, timeoutMs = INSTALL_LOCK_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (true) {
    try {
      await fsp.mkdir(lockPath, { mode: 0o700 });
      await fsp.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return async () => fsp.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockStat = await fsp.lstat(lockPath);
      if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
        throw new Error("ACP workspace install lock must be a real directory");
      }
      if (Date.now() - lockStat.mtimeMs >= INSTALL_LOCK_STALE_MS) {
        const owner = await readJson(path.join(lockPath, "owner.json")).catch(() => null);
        let ownerAlive = false;
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            ownerAlive = true;
          } catch (ownerError) {
            if (ownerError.code !== "ESRCH") ownerAlive = true;
          }
        }
        if (!ownerAlive) {
          const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`;
          try {
            await fsp.rename(lockPath, stalePath);
            await fsp.rm(stalePath, { recursive: true, force: true });
            continue;
          } catch (recoveryError) {
            if (!["ENOENT", "EEXIST"].includes(recoveryError.code)) throw recoveryError;
          }
        }
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error("timed out waiting for ACP install lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function pathExists(target) {
  return fsp.lstat(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function requireRealDirectory(target, label) {
  const stat = await fsp.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = await fsp.realpath(target);
  if (canonical !== path.resolve(target)) {
    throw new Error(`${label} contains a symlink component`);
  }
  return canonical;
}

async function removeDerivedTransactionRoot(tethercodeRoot, target, expectedName) {
  const expected = path.join(tethercodeRoot, expectedName);
  if (target !== expected) throw new Error("ACP install transaction root mismatch");
  if (!await pathExists(expected)) return;
  await requireRealDirectory(expected, "ACP install transaction root");
  await fsp.rm(expected, { recursive: true, force: true });
}

async function quarantineInvalidJournal(journalPath) {
  const quarantinePath = path.join(
    path.dirname(journalPath),
    `install-transaction.invalid-${crypto.randomUUID()}.json`
  );
  await fsp.rename(journalPath, quarantinePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function validateWorkspaceTransaction(tethercodeRoot, rawJournal) {
  const journal = transactionJournalSchema.parse(rawJournal);
  const stagingRoot = path.join(tethercodeRoot, `.install-staging-${journal.transactionId}`);
  const backupRoot = path.join(tethercodeRoot, `.install-backup-${journal.transactionId}`);
  if (journal.stagingRoot !== stagingRoot || journal.backupRoot !== backupRoot) {
    throw new Error("ACP install transaction roots do not match its transaction ID");
  }
  const names = new Set();
  for (const entry of journal.entries) {
    if (names.has(entry.name)) throw new Error("ACP install transaction contains duplicate entries");
    names.add(entry.name);
    if (entry.destination !== path.join(tethercodeRoot, entry.name) ||
        entry.staged !== path.join(stagingRoot, entry.name) ||
        entry.backup !== path.join(backupRoot, entry.name)) {
      throw new Error(`ACP install transaction paths do not match entry '${entry.name}'`);
    }
  }
  for (const [target, label] of [[stagingRoot, "staging root"], [backupRoot, "backup root"]]) {
    if (await pathExists(target)) await requireRealDirectory(target, `ACP install transaction ${label}`);
  }
  return { ...journal, stagingRoot, backupRoot };
}

async function rollbackWorkspaceTransaction(journalPath, journal) {
  for (const entry of [...journal.entries].reverse()) {
    if (await pathExists(entry.backup)) {
      if (await pathExists(entry.destination)) {
        await durableRemove(entry.destination, { boundary: `rollback-remove:${entry.name}` });
      }
      await durableRename(entry.backup, entry.destination, `rollback-restore:${entry.name}`);
    } else if (!entry.hadPrevious && await pathExists(entry.destination)) {
      await durableRemove(entry.destination, { boundary: `rollback-remove:${entry.name}` });
    }
  }
  if (await pathExists(journal.stagingRoot)) {
    await removeDerivedTransactionRoot(
      path.dirname(journalPath),
      journal.stagingRoot,
      `.install-staging-${journal.transactionId}`
    );
    await syncDirectory(path.dirname(journal.stagingRoot));
  }
  if (await pathExists(journal.backupRoot)) {
    await removeDerivedTransactionRoot(
      path.dirname(journalPath),
      journal.backupRoot,
      `.install-backup-${journal.transactionId}`
    );
    await syncDirectory(path.dirname(journal.backupRoot));
  }
  await durableRemove(journalPath, { boundary: "rollback-cleanup:journal" });
}

async function recoverWorkspaceTransaction(tethercodeRoot) {
  const journalPath = path.join(tethercodeRoot, "install-transaction.json");
  if (!await pathExists(journalPath)) return;
  try {
    await requireRealDirectory(tethercodeRoot, "ACP install root");
    const journalStat = await fsp.lstat(journalPath);
    if (!journalStat.isFile() || journalStat.isSymbolicLink()) {
      throw new Error("ACP install transaction journal must be a real file");
    }
    const journal = await validateWorkspaceTransaction(tethercodeRoot, await readJson(journalPath));
    if (journal.state === "committed") {
      if (await pathExists(journal.stagingRoot)) {
        await removeDerivedTransactionRoot(
          tethercodeRoot,
          journal.stagingRoot,
          `.install-staging-${journal.transactionId}`
        );
        await syncDirectory(tethercodeRoot);
      }
      if (await pathExists(journal.backupRoot)) {
        await removeDerivedTransactionRoot(
          tethercodeRoot,
          journal.backupRoot,
          `.install-backup-${journal.transactionId}`
        );
        await syncDirectory(tethercodeRoot);
      }
      await durableRemove(journalPath, { boundary: "recovery-cleanup:journal" });
      return;
    }
    await rollbackWorkspaceTransaction(journalPath, journal);
  } catch (error) {
    await quarantineInvalidJournal(journalPath);
    throw new Error(`ACP install transaction journal is invalid; refusing unsafe recovery: ${error.message}`);
  }
}

async function publishWorkspaceTransaction(tethercodeRoot, stagingRoot, options = {}) {
  const transactionId = path.basename(stagingRoot).replace(".install-staging-", "");
  if (!TRANSACTION_ID_PATTERN.test(transactionId) ||
      stagingRoot !== path.join(tethercodeRoot, `.install-staging-${transactionId}`)) {
    throw new Error("ACP install transaction staging root is invalid");
  }
  const backupRoot = path.join(tethercodeRoot, `.install-backup-${transactionId}`);
  const names = ["agents", "agents.json", "registry-provenance.json"];
  const journalPath = path.join(tethercodeRoot, "install-transaction.json");
  const journal = {
    version: 2,
    transactionId,
    state: "prepared",
    stagingRoot,
    backupRoot,
    entries: await Promise.all(names.map(async (name) => ({
      name,
      destination: path.join(tethercodeRoot, name),
      staged: path.join(stagingRoot, name),
      backup: path.join(backupRoot, name),
      hadPrevious: await pathExists(path.join(tethercodeRoot, name)),
      phase: "pending",
    }))),
  };
  const [rootStat, stagingStat] = await Promise.all([fsp.stat(tethercodeRoot), fsp.stat(stagingRoot)]);
  if (rootStat.dev !== stagingStat.dev) {
    throw new Error("ACP install transaction roots must be on the same filesystem");
  }
  await atomicWriteJson(journalPath, journal, { ...options, boundary: "journal:prepared" });
  await fsp.mkdir(backupRoot, { mode: 0o700 });
  await syncDirectory(tethercodeRoot, options);
  persistenceBoundary("backup-root:parent", options);
  if ((await fsp.stat(backupRoot)).dev !== rootStat.dev) {
    throw new Error("ACP install transaction roots must be on the same filesystem");
  }
  journal.state = "publishing";
  try {
    for (const entry of journal.entries) {
      entry.phase = "backingUp";
      await atomicWriteJson(journalPath, journal, {
        ...options,
        boundary: `journal:backing-up:${entry.name}`,
      });
      await options.publishHook?.(`before-backup:${entry.name}`);
      if (entry.hadPrevious) {
        await durableRename(entry.destination, entry.backup, `backup:${entry.name}`, options);
      }
      entry.phase = "publishing";
      await atomicWriteJson(journalPath, journal, {
        ...options,
        boundary: `journal:publishing:${entry.name}`,
      });
      await options.publishHook?.(`before-publish:${entry.name}`);
      await durableRename(entry.staged, entry.destination, `publish:${entry.name}`, options);
      entry.phase = "published";
      await atomicWriteJson(journalPath, journal, {
        ...options,
        boundary: `journal:published:${entry.name}`,
      });
      await options.publishHook?.(`after-publish:${entry.name}`);
    }
  } catch (error) {
    await rollbackWorkspaceTransaction(journalPath, journal);
    throw error;
  }
  journal.state = "committed";
  await atomicWriteJson(journalPath, journal, { ...options, boundary: "journal:committed" });
  await options.publishHook?.("after-commit");
  await durableRemove(backupRoot, { ...options, recursive: true, boundary: "cleanup:backup" });
  await durableRemove(stagingRoot, { ...options, recursive: true, boundary: "cleanup:staging" });
  await durableRemove(journalPath, { ...options, boundary: "cleanup:journal" });
}

async function stageAgent(agent, selected, sourceRoot, stagingRoot, options) {
  await fsp.mkdir(path.dirname(stagingRoot), { recursive: true });
  const expected = installExpectation(agent, selected, options);
  try {
    try {
      const cached = await verifyInstallRecord(sourceRoot, expected);
      if (selected.kind !== "binary" || expected.sha256) {
        await fsp.cp(sourceRoot, stagingRoot, {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true,
        });
        return await verifyInstallRecord(stagingRoot, expected);
      }
    } catch {
      // Cache state is untrusted. Rebuild independently before replacing it.
      await fsp.rm(stagingRoot, { recursive: true, force: true });
    }
    await fsp.mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    let resolved;
    if (selected.kind === "binary") resolved = await installBinary(agent, selected.value, stagingRoot, options);
    if (selected.kind === "npx") resolved = await installNpx(agent, selected.value, stagingRoot, options);
    if (selected.kind === "uvx") resolved = await installUvx(agent, selected.value, stagingRoot, options);
    const canonicalStaging = await fsp.realpath(stagingRoot);
    const relativeExecutable = path.relative(canonicalStaging, resolved.executable);
    assertContained(canonicalStaging, resolved.executable, "staged executable");
    const record = installRecordSchema.parse({
      ...resolved,
      policyVersion: INSTALLER_POLICY_VERSION,
      fingerprint: installFingerprint(expected),
      expected,
      executable: relativeExecutable,
    });
    await fsp.writeFile(
      path.join(stagingRoot, ".tethercode-install.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    return await verifyInstallRecord(stagingRoot, expected);
  } catch (error) {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function installAgents(options) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const registryUrl = options.registryUrl || DEFAULT_REGISTRY_URL;
  const registry = options.registry ? parseRegistry(options.registry) : await fetchRegistry(registryUrl);
  const selectedIds = options.agentIds?.length ? options.agentIds : ["opencode"];
  const preferredAgentId = options.preferredAgentId || (selectedIds.length === 1 ? selectedIds[0] : "");
  if (!preferredAgentId || !selectedIds.includes(preferredAgentId)) {
    throw new Error("a preferred ACP agent must be selected when installing multiple agents");
  }
  const byId = new Map(registry.agents.map((agent) => [agent.id, agent]));
  const tethercodeRoot = await ensureLocalInstallRoot(workspace);
  const releaseLock = await acquireInstallLock(path.join(tethercodeRoot, "install.lock"), options.lockTimeoutMs);
  try {
    await recoverWorkspaceTransaction(tethercodeRoot);
    const transactionId = `${process.pid}-${crypto.randomUUID()}`;
    const stagingRoot = path.join(tethercodeRoot, `.install-staging-${transactionId}`);
    const stagedAgentsRoot = path.join(stagingRoot, "agents");
    await fsp.mkdir(stagedAgentsRoot, { recursive: true, mode: 0o700 });
    const manifests = [];
    try {
      for (const agentId of selectedIds) {
        const agent = byId.get(agentId);
        if (!agent) throw new Error(`ACP registry does not contain agent '${agentId}'`);
        const selected = selectDistribution(agent, { override: options.distribution });
        const relativeRoot = path.join(agent.id, agent.version);
        const resolved = await stageAgent(
          agent,
          selected,
          path.join(tethercodeRoot, "agents", relativeRoot),
          path.join(stagedAgentsRoot, relativeRoot),
          { ...options, registryUrl }
        );
        manifests.push({
          enabled: true,
          displayName: agent.name || agent.id,
          icon: agent.icon || null,
          agentId: agent.id,
          executable: path.join(tethercodeRoot, "agents", relativeRoot, resolved.executable.slice(path.join(stagedAgentsRoot, relativeRoot).length + 1)),
          argv: resolved.argv,
          environment: resolved.environment,
          resolvedVersion: agent.version,
          provenance: resolved.provenance,
          verifiedDigest: resolved.verifiedDigest,
          integrity: resolved.integrity.tree ? {
            kind: "tree",
            root: path.join(tethercodeRoot, "agents", relativeRoot),
            treeSha256: `sha256:${resolved.integrity.tree.sha256}`,
          } : { kind: "executable" },
        });
      }
      const manifest = { preferredAgentId, agents: manifests };
      await atomicWriteJson(path.join(stagingRoot, "agents.json"), manifest, {
        ...options,
        boundary: "staging:manifest",
      });
      await atomicWriteJson(path.join(stagingRoot, "registry-provenance.json"), {
        registryUrl,
        registryVersion: registry.version,
        installedAt: new Date().toISOString(),
        agents: selectedIds,
        dependencyPlans: Object.fromEntries(manifests
          .filter((agent) => agent.provenance.includes(";plan=sha256:"))
          .map((agent) => [agent.agentId, agent.provenance.slice(agent.provenance.lastIndexOf(";plan=") + 6)])),
        selectionPolicy: "authoritative",
        resolutionPolicy: "plan-before-install",
        crossTimeReproducible: false,
      }, { ...options, boundary: "staging:provenance" });
      await publishWorkspaceTransaction(tethercodeRoot, stagingRoot, options);
      return manifest;
    } catch (error) {
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

function parseCliArgs(argv) {
  const trustUnverified = argv.includes("--trust-unverified");
  const trustInstallScripts = argv.includes("--trust-install-scripts");
  const filtered = argv.filter((value) => !["--trust-unverified", "--trust-install-scripts"].includes(value));
  return { ...parseInstallerArgs(filtered), trustUnverified, trustInstallScripts };
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    options.workspace = process.env.TETHERCODE_WORKSPACE_ROOT || process.env.INIT_CWD || process.cwd();
    const manifest = await installAgents(options);
    console.log(`Installed ${manifest.agents.length} ACP agent(s); preferred: ${manifest.preferredAgentId}`);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  MAX_ARCHIVE_FILES,
  MAX_DOWNLOAD_BYTES,
  MAX_EXTRACTED_BYTES,
  assertContained,
  atomicWriteFile,
  atomicWriteJson,
  buildTreeReceipt,
  encodeTreeEntries,
  detectAndExtract,
  downloadFile,
  installAgents,
  installExpectation,
  installFingerprint,
  installBinary,
  installNpx,
  installUvx,
  literalEnvironment,
  packageNameFromSpec,
  parseCliArgs,
  publishWorkspaceTransaction,
  recoverWorkspaceTransaction,
  syncDirectory,
  safeArchivePath,
  parseUvRequirements,
  validateNpmLock,
  verifyInstallRecord,
};