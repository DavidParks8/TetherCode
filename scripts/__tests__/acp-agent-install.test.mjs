import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const registryLibrary = require("../acp-agent-registry.js");
const installer = require("../acp-agent-install.js");
const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/acp-registry.json", import.meta.url), "utf8")
);
const treeReceiptFixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/tree-receipt-v1.json", import.meta.url), "utf8")
);
const iconPolicyFixture = JSON.parse(
  fs.readFileSync(new URL("../../contracts/agent-icon-policy.json", import.meta.url), "utf8")
);

test("canonical installation tree receipt matches the cross-language fixture", () => {
  const receipt = installer.encodeTreeEntries(treeReceiptFixture.entries);
  assert.equal(receipt.toString(), treeReceiptFixture.receipt);
  assert.equal(crypto.createHash("sha256").update(receipt).digest("hex"), treeReceiptFixture.sha256);
});

test("registry selection enforces the shared icon policy without invalidating the registry list", () => {
  for (const policyCase of iconPolicyFixture.cases) {
    assert.equal(registryLibrary.isValidAgentIcon(policyCase.value), policyCase.valid, policyCase.name);
  }
  assert.equal(registryLibrary.isValidAgentIcon(`https://example.test/${"x".repeat(iconPolicyFixture.maximumBytes)}`), false);

  const value = structuredClone(fixture);
  value.agents[0].icon = "data:image/png;base64,AAAA";
  const registry = registryLibrary.parseRegistry(value);
  assert.equal(registry.agents.length, fixture.agents.length);
  assert.throws(
    () => registryLibrary.selectDistribution(registry.agents[0], { platformKey: "darwin-aarch64" }),
    /invalid optional icon URL/
  );
  assert.doesNotThrow(() => registryLibrary.selectDistribution(registry.agents[1], { platformKey: "darwin-aarch64" }));
});

function fakeRequest(body, headers = {}) {
  return (_url, options, callback) => {
    if (typeof options === "function") callback = options;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => error && request.emit("error", error);
    queueMicrotask(() => {
      const response = Readable.from([body]);
      response.statusCode = 200;
      response.headers = headers;
      callback(response);
    });
    return request;
  };
}

function binaryFixture(body = Buffer.from("#!/bin/sh\nexit 0\n")) {
  const registry = structuredClone(fixture);
  registry.agents[0].distribution.binary["darwin-aarch64"].sha256 = crypto
    .createHash("sha256").update(body).digest("hex");
  return { body, registry };
}

function binaryInstallOptions(workspace, body, registry, extra = {}) {
  return {
    workspace,
    registry,
    registryUrl: "https://registry.example.test/registry.json",
    agentIds: ["mixed-agent"],
    preferredAgentId: "mixed-agent",
    downloadOptions: { request: fakeRequest(body, { "content-length": String(body.length) }) },
    ...extra,
  };
}

function sri(value) {
  return `sha512-${crypto.createHash("sha512").update(value).digest("base64")}`;
}

function npmMock(staging, args, packageSpec = "@example/mixed-agent@2.3.4") {
  const packageName = "@example/mixed-agent";
  const version = "2.3.4";
  if (args[0] === "install") {
    assert.ok(args.includes("--package-lock-only"));
    assert.ok(args.includes("--ignore-scripts"));
    assert.equal(fs.existsSync(path.join(staging, "node_modules")), false, "resolution must not install package code");
    fs.writeFileSync(path.join(staging, "package-lock.json"), JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { [packageName]: version } },
        [`node_modules/${packageName}`]: {
          version,
          resolved: `https://registry.npmjs.org/${packageName}/-/${packageName.split("/").at(-1)}-${version}.tgz`,
          integrity: sri("mixed-agent"),
        },
        "node_modules/dependency-one": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/dependency-one/-/dependency-one-1.0.0.tgz",
          integrity: sri("dependency-one"),
        },
      },
    }));
    return;
  }
  assert.equal(args[0], "ci");
  assert.ok(args.includes("--ignore-scripts"));
  const packageRoot = path.join(staging, "node_modules", "@example", "mixed-agent");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  const dependencyRoot = path.join(staging, "node_modules", "dependency-one");
  fs.mkdirSync(dependencyRoot, { recursive: true });
  fs.mkdirSync(path.join(staging, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageName,
    version,
    bin: { mixed: "bin/cli.js" },
  }));
  fs.writeFileSync(path.join(packageRoot, "bin", "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(path.join(packageRoot, "lib.js"), "export const firstParty = true;\n");
  fs.writeFileSync(path.join(dependencyRoot, "package.json"), JSON.stringify({ name: "dependency-one", version: "1.0.0" }));
  fs.writeFileSync(path.join(dependencyRoot, "index.js"), "module.exports = true;\n");
  if (process.platform !== "win32") fs.symlinkSync("../@example/mixed-agent/bin/cli.js", path.join(staging, "node_modules", ".bin", "mixed"));
  assert.equal(packageSpec, `${packageName}@${version}`);
}

function uvRecordHash(value) {
  return `sha256=${crypto.createHash("sha256").update(value).digest("base64url")}`;
}

function uvMock(commandOptions, args, options = {}) {
  const staging = commandOptions.cwd;
  if (args[0] === "pip" && args[1] === "compile") {
    assert.ok(args.includes("--generate-hashes"));
    assert.equal(fs.existsSync(path.join(staging, "tools")), false, "resolution must precede environment creation");
    const output = args[args.indexOf("--output-file") + 1];
    fs.writeFileSync(output, [
      `python-agent==0.4.0 --hash=sha256:${"1".repeat(64)}`,
      `dependency-one==1.2.0 --hash=sha256:${"2".repeat(64)}`,
      "",
    ].join("\n"));
    return;
  }
  const environmentRoot = path.join(staging, "tools");
  const binRoot = path.join(environmentRoot, "bin");
  if (args[0] === "venv") {
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(path.join(binRoot, "python"), "#!/bin/sh\n", { mode: 0o755 });
    return;
  }
  assert.deepEqual(args.slice(0, 3), ["pip", "sync", "--require-hashes"]);
  const sitePackages = path.join(environmentRoot, "lib", "python3.13", "site-packages");
  const executable = options.executable || "python-agent";
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(path.join(binRoot, executable), "#!/bin/sh\n", { mode: 0o755 });
  for (const distribution of [
    { name: options.name || "python-agent", version: options.version || "0.4.0", entryPoints: `[console_scripts]\n${options.mapping || executable} = python_agent:main\n`, module: "python_agent.py" },
    { name: "dependency-one", version: "1.2.0", entryPoints: "", module: "dependency_one.py" },
  ]) {
    const distInfo = path.join(sitePackages, `${distribution.name.replaceAll("-", "_")}-${distribution.version}.dist-info`);
    const metadata = `Metadata-Version: 2.1\nName: ${distribution.name}\nVersion: ${distribution.version}\n`;
    const moduleValue = `${distribution.name} = True\n`;
    fs.mkdirSync(distInfo, { recursive: true });
    fs.writeFileSync(path.join(distInfo, "METADATA"), metadata);
    fs.writeFileSync(path.join(sitePackages, distribution.module), moduleValue);
    if (distribution.entryPoints) fs.writeFileSync(path.join(distInfo, "entry_points.txt"), distribution.entryPoints);
    if (!options.missingRecord || distribution.name !== (options.name || "python-agent")) {
      const prefix = `${distribution.name.replaceAll("-", "_")}-${distribution.version}.dist-info`;
      const rows = [
        `${prefix}/METADATA,${uvRecordHash(metadata)},${Buffer.byteLength(metadata)}`,
        `${distribution.module},${uvRecordHash(moduleValue)},${Buffer.byteLength(moduleValue)}`,
      ];
      if (distribution.entryPoints) rows.push(`${prefix}/entry_points.txt,${uvRecordHash(distribution.entryPoints)},${Buffer.byteLength(distribution.entryPoints)}`);
      rows.push(`${prefix}/RECORD,,`);
      fs.writeFileSync(path.join(distInfo, "RECORD"), `${rows.join("\n")}\n`);
    }
  }
}

async function treeSnapshot(root) {
  const snapshot = {};
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = "directory";
        await visit(entryPath);
      } else {
        snapshot[relative] = (await fsp.readFile(entryPath)).toString("base64");
      }
    }
  }
  if (fs.existsSync(root)) await visit(root);
  return snapshot;
}

async function assertPublishedStateConsistent(workspace) {
  const tethercodeRoot = path.join(workspace, ".tethercode");
  const manifest = JSON.parse(await fsp.readFile(path.join(tethercodeRoot, "agents.json"), "utf8"));
  const provenance = JSON.parse(await fsp.readFile(path.join(tethercodeRoot, "registry-provenance.json"), "utf8"));
  assert.equal(provenance.selectionPolicy, "authoritative");
  assert.deepEqual(provenance.agents, manifest.agents.map((agent) => agent.agentId));
  const installedIds = (await fsp.readdir(path.join(tethercodeRoot, "agents"))).sort();
  assert.deepEqual(installedIds, [...provenance.agents].sort());
  for (const agent of manifest.agents) {
    assert.equal(await fsp.realpath(agent.executable), agent.executable);
    assert.equal(`sha256:${crypto.createHash("sha256").update(await fsp.readFile(agent.executable)).digest("hex")}`, agent.verifiedDigest);
  }
  return manifest;
}

test("parses current mixed registry shapes and selects verified binary first", () => {
  const registry = registryLibrary.parseRegistry(fixture);
  assert.equal(registry.agents.length, 2);
  assert.equal(
    registryLibrary.selectDistribution(registry.agents[0], { platformKey: "darwin-aarch64" }).kind,
    "binary"
  );
  assert.equal(
    registryLibrary.selectDistribution(registry.agents[0], {
      platformKey: "linux-x86_64",
      override: "npx",
    }).kind,
    "npx"
  );
});

test("rejects malformed registry data and parses arbitrary agent IDs", () => {
  for (const mutate of [
    (value) => (value.agents[0].id = "../bad"),
    (value) => (value.agents[0].id = "."),
    (value) => (value.agents[0].id = ".."),
    (value) => (value.agents[0].distribution.binary["darwin-aarch64"].archive = "http://bad.test/a"),
    (value) => (value.agents[0].distribution.binary["darwin-aarch64"].sha256 = "bad"),
    (value) => (value.agents[0].version = "../bad"),
    (value) => (value.agents[1].distribution.uvx.packageLock = { lockfileVersion: 3 }),
    (value) => value.agents.push(value.agents[0]),
  ]) {
    const value = structuredClone(fixture);
    mutate(value);
    assert.throws(() => registryLibrary.parseRegistry(value));
  }
  assert.deepEqual(
    registryLibrary.parseInstallerArgs(["--agents", "alpha-orbit,beta-lab", "--preferred-agent", "beta-lab"]),
    {
      agentIds: ["alpha-orbit", "beta-lab"],
      preferredAgentId: "beta-lab",
      distribution: "",
      registryUrl: "",
    }
  );
  assert.throws(() => registryLibrary.parseInstallerArgs(["--agents", "a,b"]), /preferred/);
  for (const agentId of [".", ".."]) {
    assert.throws(() => registryLibrary.parseInstallerArgs(["--agent", agentId]), /path-safe/);
    const agent = structuredClone(fixture.agents[0]);
    agent.id = agentId;
    assert.throws(
      () => registryLibrary.selectDistribution(agent, { platformKey: "darwin-aarch64" }),
      /invalid ACP registry agent ID/
    );
  }
});

test("dot-only registry IDs cannot derive install paths or write outside the agent root", async () => {
  for (const agentId of [".", ".."]) {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-dot-id-"));
    const workspace = path.join(parent, "workspace");
    await fsp.mkdir(workspace);
    const registry = structuredClone(fixture);
    registry.agents[0].id = agentId;

    await assert.rejects(
      installer.installAgents({
        workspace,
        registry,
        registryUrl: "https://registry.example.test/registry.json",
        agentIds: [agentId],
        preferredAgentId: agentId,
      }),
      /invalid ACP registry agent ID/
    );
    assert.deepEqual(await fsp.readdir(workspace), []);
    assert.deepEqual(await fsp.readdir(parent), ["workspace"]);
    await fsp.rm(parent, { recursive: true, force: true });
  }
});

test("fresh installer default is an ordinary registry selection", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-default-"));
  const body = Buffer.from("#!/bin/sh\nexit 0\n");
  const sha256 = require("node:crypto").createHash("sha256").update(body).digest("hex");
  const registry = structuredClone(fixture);
  registry.agents[0].id = "opencode";
  registry.agents[0].name = "Default fixture agent";
  registry.agents[0].distribution.binary["darwin-aarch64"].sha256 = sha256;
  try {
    const manifest = await installer.installAgents({
      workspace,
      registry,
      registryUrl: "https://registry.example.test/registry.json",
      downloadOptions: { request: fakeRequest(body, { "content-length": String(body.length) }) },
    });
    assert.equal(manifest.preferredAgentId, "opencode");
    assert.equal(manifest.agents[0].agentId, "opencode");
    assert.equal(manifest.agents[0].displayName, "Default fixture agent");
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("fetches JSON through a local fixture server adapter and enforces response bounds", async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(fixture));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const registry = await registryLibrary.fetchRegistry("https://registry.example.test/registry.json", {
      request: (_url, options, callback) =>
        http.get(`http://127.0.0.1:${address.port}/registry.json`, options, callback),
    });
    assert.equal(registry.version, "1.0.0");
    await assert.rejects(
      registryLibrary.fetchRegistry("https://registry.example.test/registry.json", {
        maxBodyBytes: 10,
        request: (_url, options, callback) =>
          http.get(`http://127.0.0.1:${address.port}/registry.json`, options, callback),
      }),
      /size limit/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("follows bounded credential-free HTTPS redirects including relative locations", async () => {
  const routes = new Map([
    ["/start", { status: 302, location: "/middle", body: "a" }],
    ["/middle", { status: 307, location: "final", body: "b" }],
    ["/final", { status: 200, body: "payload" }],
  ]);
  const request = (url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => error && req.emit("error", error);
    queueMicrotask(() => {
      const route = routes.get(url.pathname);
      const response = Readable.from([Buffer.from(route.body)]);
      response.statusCode = route.status;
      response.headers = route.location ? { location: route.location } : { "content-length": String(route.body.length) };
      callback(response);
    });
    return req;
  };
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-redirect-"));
  try {
    const result = await installer.downloadFile("https://downloads.example.test/start", path.join(temporary, "file"), { request });
    assert.equal(result.bytes, 7);
    assert.equal(await fsp.readFile(path.join(temporary, "file"), "utf8"), "payload");
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("rejects redirect loops, limits, downgrade, credentials, missing locations, cumulative size and timeout", async () => {
  function redirectRequest(routes, delayMs = 0) {
    return (url, _options, callback) => {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = (error) => error && req.emit("error", error);
      setTimeout(() => {
        const route = routes[url.pathname];
        const response = Readable.from([Buffer.from(route.body || "")]);
        response.statusCode = route.status;
        response.headers = route.location ? { location: route.location } : {};
        callback(response);
      }, delayMs);
      return req;
    };
  }
  const cases = [
    [{ "/a": { status: 302, location: "/a" } }, /loop/],
    [{ "/a": { status: 302, location: "/b" }, "/b": { status: 302, location: "/c" }, "/c": { status: 200 } }, /limit/, { maxRedirects: 1 }],
    [{ "/a": { status: 302, location: "http://bad.test/x" } }, /HTTPS/],
    [{ "/a": { status: 302, location: "https://user:pass@bad.test/x" } }, /credentials/],
    [{ "/a": { status: 302 } }, /Location/],
    [{ "/a": { status: 302, location: "/b", body: "123" }, "/b": { status: 200, body: "456" } }, /size limit/, { maxBytes: 5 }],
  ];
  for (const [routes, error, extra = {}] of cases) {
    const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-redirect-bad-"));
    try {
      await assert.rejects(
        installer.downloadFile("https://downloads.example.test/a", path.join(temporary, "file"), {
          request: redirectRequest(routes),
          ...extra,
        }),
        error
      );
    } finally {
      await fsp.rm(temporary, { recursive: true, force: true });
    }
  }
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-redirect-timeout-"));
  try {
    await assert.rejects(
      installer.downloadFile("https://downloads.example.test/a", path.join(temporary, "file"), {
        request: redirectRequest({ "/a": { status: 302, location: "/b" }, "/b": { status: 200, body: "ok" } }, 15),
        timeoutMs: 20,
      }),
      /timed out/
    );
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("rejects traversal and symlink tar archives", { timeout: 3_000 }, async () => {
  assert.throws(() => installer.safeArchivePath("/tmp/root", "../escape"), /unsafe archive/);
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-archive-"));
  try {
    await fsp.writeFile(path.join(temporary, "target"), "data");
    await fsp.symlink("target", path.join(temporary, "link"));
    const archive = path.join(temporary, "links.tar");
    const output = path.join(temporary, "out");
    await fsp.mkdir(output);
    const tar = require("tar");
    await tar.c({ cwd: temporary, file: archive }, ["link"]);
    await assert.rejects(
      installer.detectAndExtract(archive, "https://example.test/links.tar", output),
      /links are not allowed/
    );
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("rejects oversized downloads", { timeout: 3_000 }, async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-download-"));
  try {
    await assert.rejects(
      installer.downloadFile("https://example.test/large", path.join(temporary, "large"), {
        maxBytes: 2,
        request: fakeRequest(Buffer.from("large"), { "content-length": "5" }),
      }),
      /size limit/
    );
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("installs a verified direct binary and emits the exact Rust manifest shape", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-direct-"));
  const body = Buffer.from("#!/bin/sh\nexit 0\n");
  const sha256 = require("node:crypto").createHash("sha256").update(body).digest("hex");
  const registry = structuredClone(fixture);
  registry.agents[0].distribution.binary["darwin-aarch64"].sha256 = sha256;
  try {
    const manifest = await installer.installAgents({
      workspace,
      registry,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["mixed-agent"],
      preferredAgentId: "mixed-agent",
      downloadOptions: { request: fakeRequest(body, { "content-length": String(body.length) }) },
    });
    assert.deepEqual(Object.keys(manifest), ["preferredAgentId", "agents"]);
    assert.deepEqual(Object.keys(manifest.agents[0]), [
      "enabled", "displayName", "icon", "agentId", "executable", "argv", "environment",
      "resolvedVersion", "provenance", "verifiedDigest", "integrity",
    ]);
    assert.deepEqual(manifest.agents[0].integrity, { kind: "executable" });
    assert.equal(manifest.agents[0].environment.ACP_LOG.kind, "literal");
    const canonicalWorkspace = await fsp.realpath(workspace);
    assert.ok(manifest.agents[0].executable.startsWith(path.join(canonicalWorkspace, ".tethercode", "agents")));
    assert.equal(manifest.agents[0].verifiedDigest, `sha256:${sha256}`);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("rejects checksum mismatch and unsigned binaries without explicit trust", async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-digest-"));
  const agent = fixture.agents[0];
  const binary = structuredClone(agent.distribution.binary["darwin-aarch64"]);
  const body = Buffer.from("#!/bin/sh\n");
  try {
    await assert.rejects(
      installer.installBinary(agent, binary, path.join(temporary, "mismatch"), {
        registryUrl: "https://registry.example.test/registry.json",
        downloadOptions: { request: fakeRequest(body, { "content-length": String(body.length) }) },
      }),
      /checksum mismatch/
    );
    delete binary.sha256;
    await assert.rejects(
      installer.installBinary(agent, binary, path.join(temporary, "unsigned"), {
        registryUrl: "https://registry.example.test/registry.json",
        downloadOptions: { request: fakeRequest(body, { "content-length": String(body.length) }) },
      }),
      /trust-unverified/
    );
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("rejects unsigned direct binaries even with explicit trust", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-unsigned-"));
  const body = Buffer.from("#!/bin/sh\nexit 0\n");
  const registry = structuredClone(fixture);
  delete registry.agents[0].distribution.binary["darwin-aarch64"].sha256;
  const options = binaryInstallOptions(workspace, body, registry, {
    distribution: "binary",
    trustUnverified: true,
    downloadOptions: { request: fakeRequest(body) },
  });
  try {
    await assert.rejects(installer.installAgents(options), /single-file binary requires a registry sha256/);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("binary archive tree detects companion content, shape, symlink, and mode tampering", async (t) => {
  if (process.platform === "win32") t.skip("archive mode and symlink receipt semantics are POSIX-specific");
  const source = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-binary-archive-source-"));
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-binary-archive-"));
  const archivePath = path.join(source, "agent.tar");
  const registry = structuredClone(fixture);
  const distribution = registry.agents[0].distribution.binary["darwin-aarch64"];
  distribution.archive = "https://downloads.example.test/agent.tar";
  distribution.cmd = "bin/mixed-agent";
  await fsp.mkdir(path.join(source, "bin"));
  await fsp.mkdir(path.join(source, "lib"));
  await fsp.writeFile(path.join(source, "bin", "mixed-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fsp.writeFile(path.join(source, "lib", "companion.conf"), "mode=stable\n", { mode: 0o644 });
  const tar = require("tar");
  await tar.c({ cwd: source, file: archivePath }, ["bin", "lib"]);
  const archive = await fsp.readFile(archivePath);
  distribution.sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  let downloads = 0;
  const options = binaryInstallOptions(workspace, archive, registry, {
    distribution: "binary",
    downloadOptions: { request: (...args) => { downloads += 1; return fakeRequest(archive)(...args); } },
  });
  const root = path.join(workspace, ".tethercode", "agents", "mixed-agent", "2.3.4");
  const companion = path.join(root, "lib", "companion.conf");
  const mutations = [
    async () => fsp.writeFile(companion, "mode=tampered\n"),
    async () => fsp.writeFile(path.join(root, "lib", "added.conf"), "added\n"),
    async () => fsp.rm(companion),
    async () => { await fsp.rm(companion); await fsp.symlink("../bin/mixed-agent", companion); },
    async () => fsp.chmod(companion, 0o600),
  ];
  try {
    const manifest = await installer.installAgents(options);
    assert.equal(manifest.agents[0].integrity.kind, "tree");
    assert.match(manifest.agents[0].integrity.treeSha256, /^sha256:[a-f0-9]{64}$/);
    for (const mutate of mutations) {
      await fsp.chmod(path.join(root, "lib"), 0o700);
      await fsp.chmod(companion, 0o600).catch(() => {});
      await mutate();
      await installer.installAgents(options);
      assert.equal(await fsp.readFile(companion, "utf8"), "mode=stable\n");
    }
    assert.equal(downloads, mutations.length + 1);
  } finally {
    await fsp.rm(source, { recursive: true, force: true });
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("resolves isolated npm and uv executables using mocked process execution", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-tools-"));
  try {
    const npxRoot = path.join(workspace, "npx");
    await fsp.mkdir(npxRoot, { recursive: true });
    const npx = await installer.installNpx(fixture.agents[0], fixture.agents[0].distribution.npx, npxRoot, {
      registryUrl: "https://registry.example.test/registry.json",
      trustInstallScripts: false,
      runCommand(_command, args) {
        npmMock(npxRoot, args);
      },
    });
    assert.match(npx.executable, /node_modules.*cli\.js$/);

    const uvRoot = path.join(workspace, "uv");
    await fsp.mkdir(uvRoot, { recursive: true });
    const uv = await installer.installUvx(fixture.agents[1], fixture.agents[1].distribution.uvx, uvRoot, {
      registryUrl: "https://registry.example.test/registry.json",
      runCommand(command, args, options) {
        assert.equal(command, "uv");
        uvMock(options, args);
      },
    });
    assert.match(uv.executable, /bin\/python-agent$/);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("dependency plans reject mutable sources, missing integrity, and untrusted lifecycle scripts", () => {
  const validLock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { agent: "1.0.0" } },
      "node_modules/agent": {
        version: "1.0.0",
        resolved: "https://registry.example.test/agent-1.0.0.tgz",
        integrity: sri("agent"),
      },
    },
  };
  assert.equal(installer.validateNpmLock(validLock, "agent", "1.0.0"), 1);
  for (const mutate of [
    (lock) => delete lock.packages["node_modules/agent"].integrity,
    (lock) => { lock.packages["node_modules/agent"].resolved = "http://registry.example.test/agent.tgz"; },
    (lock) => { lock.packages["node_modules/agent"].resolved = "git+https://example.test/agent.git"; },
    (lock) => { lock.packages["node_modules/agent"].resolved = "file:../agent"; },
    (lock) => { lock.packages["node_modules/agent"].resolved = "workspace:*"; },
    (lock) => { lock.packages["node_modules/agent"].link = true; },
    (lock) => { lock.packages["node_modules/agent"].hasInstallScript = true; },
  ]) {
    const lock = structuredClone(validLock);
    mutate(lock);
    assert.throws(() => installer.validateNpmLock(lock, "agent", "1.0.0"));
  }
  assert.throws(() => installer.parseUvRequirements("agent==1.0.0\n", "agent==1.0.0"), /no sha256/);
  for (const source of ["http://example.test/a.whl", "file:../a.whl", "git+https://example.test/a.git", "agent @ https://example.test/a.whl"]) {
    assert.throws(
      () => installer.parseUvRequirements(`${source} --hash=sha256:${"1".repeat(64)}\n`, "agent==1.0.0"),
      /mutable VCS, path, or insecure source/
    );
  }
});

test("frozen installs reject plan rewrites and remove failed staging", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-plan-rewrite-"));
  try {
    const root = path.join(workspace, "npm");
    await fsp.mkdir(root);
    await assert.rejects(
      installer.installNpx(fixture.agents[0], fixture.agents[0].distribution.npx, root, {
        registryUrl: "https://registry.example.test/registry.json",
        runCommand(_command, args) {
          npmMock(root, args);
          if (args[0] === "ci") fs.appendFileSync(path.join(root, "package-lock.json"), " ");
        },
      }),
      /rewrote the validated dependency plan/
    );

    const failedWorkspace = path.join(workspace, "transaction");
    await fsp.mkdir(failedWorkspace);
    await assert.rejects(installer.installAgents({
      workspace: failedWorkspace,
      registry: fixture,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["mixed-agent"],
      preferredAgentId: "mixed-agent",
      distribution: "npx",
      runCommand(_command, args, commandOptions) {
        npmMock(commandOptions.cwd, args);
        if (args[0] === "ci") fs.appendFileSync(path.join(commandOptions.cwd, "package-lock.json"), " ");
      },
    }), /rewrote the validated dependency plan/);
    const tethercodeEntries = await fsp.readdir(path.join(failedWorkspace, ".tethercode"));
    assert.equal(tethercodeEntries.some((name) => name.startsWith(".install-staging-")), false);
    assert.equal(fs.existsSync(path.join(failedWorkspace, ".tethercode", "agents.json")), false);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("saved plan digest is stable for one resolution and surfaces changed resolution", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-plan-digest-"));
  async function resolveAt(root, dependencyVersion) {
    await fsp.mkdir(root);
    const result = await installer.installNpx(fixture.agents[0], fixture.agents[0].distribution.npx, root, {
      registryUrl: "https://registry.example.test/registry.json",
      runCommand(_command, args) {
        npmMock(root, args);
        if (args[0] === "install" && dependencyVersion !== "1.0.0") {
          const lockPath = path.join(root, "package-lock.json");
          const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          lock.packages["node_modules/dependency-one"].version = dependencyVersion;
          lock.packages["node_modules/dependency-one"].resolved = `https://registry.npmjs.org/dependency-one/-/dependency-one-${dependencyVersion}.tgz`;
          lock.packages["node_modules/dependency-one"].integrity = sri(`dependency-one-${dependencyVersion}`);
          fs.writeFileSync(lockPath, JSON.stringify(lock));
        }
      },
    });
    return { plan: result.integrity.npm.plan.sha256, tree: result.integrity.tree.sha256 };
  }
  try {
    const first = await resolveAt(path.join(workspace, "first"), "1.0.0");
    const same = await resolveAt(path.join(workspace, "same"), "1.0.0");
    const changed = await resolveAt(path.join(workspace, "changed"), "1.1.0");
    assert.deepEqual(first, same);
    assert.notEqual(first.plan, changed.plan);
    assert.notEqual(first.tree, changed.tree);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("published provenance explicitly identifies plan digests and cross-time limitation", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-plan-provenance-"));
  try {
    const manifest = await installer.installAgents({
      workspace,
      registry: fixture,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["mixed-agent"],
      preferredAgentId: "mixed-agent",
      distribution: "npx",
      runCommand(_command, args, commandOptions) { npmMock(commandOptions.cwd, args); },
    });
    const provenance = JSON.parse(await fsp.readFile(path.join(workspace, ".tethercode", "registry-provenance.json"), "utf8"));
    assert.equal(provenance.resolutionPolicy, "plan-before-install");
    assert.equal(provenance.crossTimeReproducible, false);
    assert.match(provenance.dependencyPlans["mixed-agent"], /^sha256:[a-f0-9]{64}$/);
    assert.ok(manifest.agents[0].provenance.endsWith(`;plan=${provenance.dependencyPlans["mixed-agent"]}`));
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("registry lock authority skips mutable resolution and tree authority fails closed", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-lock-authority-"));
  const registry = structuredClone(fixture);
  const distribution = registry.agents[0].distribution.npx;
  const lockRoot = path.join(workspace, "lock-fixture");
  await fsp.mkdir(lockRoot);
  npmMock(lockRoot, ["install", "--package-lock-only", "--ignore-scripts"]);
  distribution.packageLock = JSON.parse(await fsp.readFile(path.join(lockRoot, "package-lock.json"), "utf8"));
  await fsp.rm(lockRoot, { recursive: true });
  const commands = [];
  try {
    const manifest = await installer.installAgents({
      workspace,
      registry,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["mixed-agent"],
      preferredAgentId: "mixed-agent",
      distribution: "npx",
      runCommand(_command, args, commandOptions) {
        commands.push(args[0]);
        npmMock(commandOptions.cwd, args);
      },
    });
    assert.deepEqual(commands, ["ci"]);
    assert.match(manifest.agents[0].provenance, /;plan=sha256:/);

    const failedWorkspace = path.join(workspace, "tree-mismatch");
    await fsp.mkdir(failedWorkspace);
    distribution.treeSha256 = "0".repeat(64);
    await assert.rejects(installer.installAgents({
      workspace: failedWorkspace,
      registry,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["mixed-agent"],
      preferredAgentId: "mixed-agent",
      distribution: "npx",
      runCommand(_command, args, commandOptions) { npmMock(commandOptions.cwd, args); },
    }), /tree does not match the registry authority/);
    assert.equal(fs.existsSync(path.join(failedWorkspace, ".tethercode", "agents.json")), false);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("reinstalls on executable, metadata, fingerprint, args, env, or provenance tamper", async () => {
  const mutations = [
    async (root, record) => fsp.writeFile(path.join(root, record.executable), "tampered", { mode: 0o755 }),
    async (root) => fsp.writeFile(path.join(root, ".tethercode-install.json"), "{}"),
    async (root, record) => { record.fingerprint = "0".repeat(64); await fsp.writeFile(path.join(root, ".tethercode-install.json"), JSON.stringify(record)); },
    async (root, record) => { record.argv = ["bad"]; await fsp.writeFile(path.join(root, ".tethercode-install.json"), JSON.stringify(record)); },
    async (root, record) => { record.environment = {}; await fsp.writeFile(path.join(root, ".tethercode-install.json"), JSON.stringify(record)); },
    async (root, record) => { record.provenance = "attacker"; await fsp.writeFile(path.join(root, ".tethercode-install.json"), JSON.stringify(record)); },
    async (root, record) => { record.integrity.artifact.sha256 = "0".repeat(64); await fsp.writeFile(path.join(root, ".tethercode-install.json"), JSON.stringify(record)); },
  ];
  for (const mutate of mutations) {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-tamper-"));
    const { body, registry } = binaryFixture();
    let requests = 0;
    const options = binaryInstallOptions(workspace, body, registry, {
      downloadOptions: { request: (...args) => { requests += 1; return fakeRequest(body)(...args); } },
    });
    try {
      await installer.installAgents(options);
      const root = path.join(workspace, ".tethercode", "agents", "mixed-agent", "2.3.4");
      const record = JSON.parse(await fsp.readFile(path.join(root, ".tethercode-install.json"), "utf8"));
      await mutate(root, record);
      await installer.installAgents(options);
      assert.equal(requests, 2);
    } finally {
      await fsp.rm(workspace, { recursive: true, force: true });
    }
  }
});

test("rejects preseeded installs, serializes concurrent attempts, and rolls back failed reinstall", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-preseed-"));
  const { body, registry } = binaryFixture();
  const root = path.join(workspace, ".tethercode", "agents", "mixed-agent", "2.3.4");
  let requests = 0;
  const options = binaryInstallOptions(workspace, body, registry, {
    downloadOptions: { request: (...args) => { requests += 1; return fakeRequest(body)(...args); } },
  });
  try {
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(path.join(root, "mixed-agent.bin"), "attacker", { mode: 0o755 });
    await fsp.writeFile(path.join(root, ".tethercode-install.json"), JSON.stringify({ executable: "mixed-agent.bin" }));
    await Promise.all([installer.installAgents(options), installer.installAgents(options)]);
    assert.equal(requests, 1);
    assert.equal(await fsp.readFile(path.join(root, "mixed-agent.bin"), "utf8"), body.toString());

    const manifestPath = path.join(workspace, ".tethercode", "agents.json");
    const before = await fsp.readFile(manifestPath, "utf8");
    await fsp.writeFile(path.join(root, "mixed-agent.bin"), "tampered", { mode: 0o755 });
    await assert.rejects(installer.installAgents({
      ...options,
      downloadOptions: { request: fakeRequest(Buffer.from("wrong")) },
    }), /checksum mismatch/);
    assert.equal(await fsp.readFile(manifestPath, "utf8"), before);
    assert.equal(await fsp.readFile(path.join(root, "mixed-agent.bin"), "utf8"), "tampered");
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("rejects a symlink-preseeded local install root", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-root-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-outside-"));
  const { body, registry } = binaryFixture();
  try {
    await fsp.symlink(outside, path.join(workspace, ".tethercode"));
    await assert.rejects(installer.installAgents(binaryInstallOptions(workspace, body, registry)), /real directory/);
    assert.deepEqual(await fsp.readdir(outside), []);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test("reinstalls when npm lock, uv dependency artifact, or executable mapping are tampered", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-tool-tamper-"));
  let npmInstalls = 0;
  let uvInstalls = 0;
  try {
    const npmOptions = {
      workspace,
      registry: fixture,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["mixed-agent"],
      preferredAgentId: "mixed-agent",
      distribution: "npx",
      runCommand(_command, args, commandOptions) {
        if (args[0] === "ci") npmInstalls += 1;
        npmMock(commandOptions.cwd, args);
      },
    };
    await installer.installAgents(npmOptions);
    const npmRoot = path.join(workspace, ".tethercode", "agents", "mixed-agent", "2.3.4");
    const packageLock = JSON.parse(await fsp.readFile(path.join(npmRoot, "package-lock.json"), "utf8"));
    packageLock.packages["node_modules/@example/mixed-agent"].integrity = "sha512-tampered";
    await fsp.chmod(path.join(npmRoot, "package-lock.json"), 0o600);
    await fsp.writeFile(path.join(npmRoot, "package-lock.json"), JSON.stringify(packageLock));
    await installer.installAgents(npmOptions);
    const packageJsonPath = path.join(npmRoot, "node_modules", "@example", "mixed-agent", "package.json");
    const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"));
    packageJson.bin = { other: "bin/other.js" };
    await fsp.chmod(packageJsonPath, 0o600);
    await fsp.writeFile(packageJsonPath, JSON.stringify(packageJson));
    await installer.installAgents(npmOptions);
    assert.equal(npmInstalls, 3);

    const uvOptions = {
      workspace,
      registry: fixture,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["python-agent"],
      preferredAgentId: "python-agent",
      runCommand(_command, args, commandOptions) {
        if (args[0] === "pip" && args[1] === "sync") uvInstalls += 1;
        uvMock(commandOptions, args);
      },
    };
    await installer.installAgents(uvOptions);
    const uvRoot = path.join(workspace, ".tethercode", "agents", "python-agent", "0.4.0");
    const dependency = (await installer.verifyInstallRecord(
      uvRoot,
      installer.installExpectation(fixture.agents[1], registryLibrary.selectDistribution(fixture.agents[1]), uvOptions)
    )).integrity.uv;
    assert.match(dependency.receiptSha256, /^[a-f0-9]{64}$/);
    const dependencyModule = path.join(uvRoot, "tools", "lib", "python3.13", "site-packages", "dependency_one.py");
    await fsp.chmod(dependencyModule, 0o600);
    await fsp.writeFile(dependencyModule, "tampered = True\n");
    await installer.installAgents(uvOptions);
    const entryPoints = path.join(uvRoot, "tools", "lib", "python3.13", "site-packages", "python_agent-0.4.0.dist-info", "entry_points.txt");
    await fsp.chmod(entryPoints, 0o600);
    await fsp.writeFile(entryPoints, "[console_scripts]\nother = python_agent:main\n");
    await installer.installAgents(uvOptions);
    await installer.installAgents(uvOptions);
    assert.equal(uvInstalls, 3);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("uv tree receipt rejects transitive modification, add, delete, symlink substitution, and mode changes", async (t) => {
  if (process.platform === "win32") t.skip("POSIX symlink and mode receipt coverage");
  const cases = [
    async (root) => {
      const file = path.join(root, "tools", "lib", "python3.13", "site-packages", "dependency_one.py");
      await fsp.chmod(file, 0o600);
      await fsp.writeFile(file, "tampered = True\n");
    },
    async (root) => fsp.writeFile(path.join(root, "tools", "added.py"), "added = True\n"),
    async (root) => fsp.rm(path.join(root, "tools", "lib", "python3.13", "site-packages", "dependency_one.py")),
    async (root) => {
      const executable = path.join(root, "tools", "bin", "python-agent");
      await fsp.rm(executable);
      await fsp.symlink("../lib/python3.13/site-packages/python_agent.py", executable);
    },
    async (root) => fsp.chmod(path.join(root, "tools", "lib", "python3.13", "site-packages", "dependency_one.py"), 0o555),
  ];
  for (const mutate of cases) {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-uv-tree-"));
    let installs = 0;
    const options = {
      workspace,
      registry: fixture,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["python-agent"],
      preferredAgentId: "python-agent",
      runCommand(_command, args, commandOptions) {
        if (args[0] === "pip" && args[1] === "sync") installs += 1;
        uvMock(commandOptions, args);
      },
    };
    try {
      await installer.installAgents(options);
      const root = path.join(workspace, ".tethercode", "agents", "python-agent", "0.4.0");
      await mutate(root);
      await installer.installAgents(options);
      assert.equal(installs, 2, "tampered uv tree should be reinstalled");
    } finally {
      await fsp.rm(workspace, { recursive: true, force: true });
    }
  }
});

test("npm tree receipt rejects module, dependency, shape, symlink, mode, and receipt tampering", async (t) => {
  if (process.platform === "win32") t.skip("POSIX symlink and mode receipt coverage");
  const cases = [
    async (root) => {
      const file = path.join(root, "node_modules", "@example", "mixed-agent", "lib.js");
      await fsp.chmod(file, 0o600);
      await fsp.writeFile(file, "tampered first party\n");
    },
    async (root) => {
      const file = path.join(root, "node_modules", "dependency-one", "index.js");
      await fsp.chmod(file, 0o600);
      await fsp.writeFile(file, "tampered dependency\n");
    },
    async (root) => fsp.writeFile(path.join(root, "node_modules", "added.js"), "added\n"),
    async (root) => fsp.rm(path.join(root, "node_modules", "dependency-one", "index.js")),
    async (root) => {
      const link = path.join(root, "node_modules", ".bin", "mixed");
      await fsp.rm(link);
      await fsp.symlink("../dependency-one/index.js", link);
    },
    async (root) => {
      const link = path.join(root, "node_modules", ".bin", "mixed");
      await fsp.rm(link);
      await fsp.symlink("../../../../outside", link);
    },
    async (root) => fsp.chmod(path.join(root, "node_modules", "dependency-one", "index.js"), 0o555),
    async (root) => {
      const metadata = path.join(root, ".tethercode-install.json");
      const record = JSON.parse(await fsp.readFile(metadata, "utf8"));
      record.integrity.tree.sha256 = "0".repeat(64);
      await fsp.writeFile(metadata, JSON.stringify(record));
    },
  ];
  for (const mutate of cases) {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-npm-tree-"));
    let installs = 0;
    const options = {
      workspace,
      registry: fixture,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["mixed-agent"],
      preferredAgentId: "mixed-agent",
      distribution: "npx",
      runCommand(_command, args, commandOptions) {
        if (args[0] === "ci") installs += 1;
        npmMock(commandOptions.cwd, args);
      },
    };
    try {
      await installer.installAgents(options);
      await installer.installAgents(options);
      assert.equal(installs, 1, "valid tree should be reused");
      const root = path.join(workspace, ".tethercode", "agents", "mixed-agent", "2.3.4");
      await mutate(root);
      await installer.installAgents(options);
      assert.equal(installs, 2, "tampered tree should be reinstalled");
    } finally {
      await fsp.rm(workspace, { recursive: true, force: true });
    }
  }
});

test("rejects uv wrong identity and missing integrity metadata", async () => {
  for (const [mockOptions, error] of [
    [{ name: "other-agent" }, /exact requested identity/],
    [{ version: "9.9.9" }, /exact requested identity/],
    [{ missingRecord: true }, /missing RECORD/],
  ]) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-uv-invalid-"));
    try {
      await assert.rejects(
        installer.installUvx(fixture.agents[1], fixture.agents[1].distribution.uvx, root, {
          registryUrl: "https://registry.example.test/registry.json",
          runCommand(_command, args, commandOptions) { uvMock(commandOptions, args, mockOptions); },
        }),
        error
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
  await assert.rejects(
    installer.installUvx(fixture.agents[1], { ...fixture.agents[1].distribution.uvx, package: "python-agent@latest" }, "/tmp/nope", {}),
    /exact name and version/
  );
});

test("reuses exact installs and preserves a working manifest after failure", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-atomic-"));
  const body = Buffer.from("#!/bin/sh\nexit 0\n");
  const sha256 = require("node:crypto").createHash("sha256").update(body).digest("hex");
  const registry = structuredClone(fixture);
  registry.agents[0].distribution.binary["darwin-aarch64"].sha256 = sha256;
  let requests = 0;
  const options = {
    workspace,
    registry,
    agentIds: ["mixed-agent"],
    preferredAgentId: "mixed-agent",
    downloadOptions: { request: (...args) => { requests += 1; return fakeRequest(body)(...args); } },
  };
  try {
    await installer.installAgents(options);
    const manifestPath = path.join(workspace, ".tethercode", "agents.json");
    const before = await fsp.readFile(manifestPath, "utf8");
    await installer.installAgents(options);
    assert.equal(requests, 1);
    await assert.rejects(installer.installAgents({ ...options, agentIds: ["missing"], preferredAgentId: "missing" }), /does not contain/);
    assert.equal(await fsp.readFile(manifestPath, "utf8"), before);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("later-agent staging failure preserves every published byte", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-later-failure-"));
  const { body, registry } = binaryFixture();
  try {
    await installer.installAgents(binaryInstallOptions(workspace, body, registry));
    const before = await treeSnapshot(path.join(workspace, ".tethercode"));
    await assert.rejects(installer.installAgents({
      workspace,
      registry,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds: ["mixed-agent", "python-agent"],
      preferredAgentId: "mixed-agent",
      runCommand() { throw new Error("later install failed"); },
      downloadOptions: { request: fakeRequest(body) },
    }), /later install failed/);
    assert.deepEqual(await treeSnapshot(path.join(workspace, ".tethercode")), before);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("failure during every workspace publish phase restores all prior bytes", async () => {
  const phases = ["agents", "agents.json", "registry-provenance.json"]
    .flatMap((name) => [`before-backup:${name}`, `before-publish:${name}`, `after-publish:${name}`]);
  for (const phase of phases) {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-publish-failure-"));
    const first = binaryFixture(Buffer.from("#!/bin/sh\necho old\n"));
    const second = binaryFixture(Buffer.from("#!/bin/sh\necho new\n"));
    try {
      await installer.installAgents(binaryInstallOptions(workspace, first.body, first.registry));
      const before = await treeSnapshot(path.join(workspace, ".tethercode"));
      await assert.rejects(installer.installAgents(binaryInstallOptions(workspace, second.body, second.registry, {
        publishHook(current) { if (current === phase) throw new Error(`fault at ${phase}`); },
      })), /fault at/);
      assert.deepEqual(await treeSnapshot(path.join(workspace, ".tethercode")), before, phase);
    } finally {
      await fsp.rm(workspace, { recursive: true, force: true });
    }
  }
});

test("concurrent disjoint and overlapping selections serialize into complete authoritative states", async () => {
  for (const selections of [
    [["mixed-agent"], ["python-agent"]],
    [["mixed-agent", "python-agent"], ["python-agent"]],
  ]) {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-concurrent-workspace-"));
    const { body, registry } = binaryFixture();
    const optionsFor = (agentIds) => ({
      workspace,
      registry,
      registryUrl: "https://registry.example.test/registry.json",
      agentIds,
      preferredAgentId: agentIds[0],
      downloadOptions: { request: fakeRequest(body) },
      runCommand(_command, args, commandOptions) { uvMock(commandOptions, args); },
    });
    try {
      await Promise.all(selections.map((selection) => installer.installAgents(optionsFor(selection))));
      const manifest = await assertPublishedStateConsistent(workspace);
      assert.ok(selections.some((selection) => JSON.stringify(selection) === JSON.stringify(manifest.agents.map((agent) => agent.agentId))));
    } finally {
      await fsp.rm(workspace, { recursive: true, force: true });
    }
  }
});

test("next invocation rolls back an interrupted journal before publishing", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-recovery-"));
  const first = binaryFixture(Buffer.from("#!/bin/sh\necho old\n"));
  try {
    await installer.installAgents(binaryInstallOptions(workspace, first.body, first.registry));
    const tethercodeRoot = await fsp.realpath(path.join(workspace, ".tethercode"));
    const before = await treeSnapshot(tethercodeRoot);
    const stagingRoot = path.join(tethercodeRoot, ".install-staging-interrupted");
    const backupRoot = path.join(tethercodeRoot, ".install-backup-interrupted");
    await fsp.mkdir(stagingRoot);
    await fsp.mkdir(backupRoot);
    await fsp.writeFile(path.join(stagingRoot, "agents"), "staged-placeholder");
    await fsp.rename(path.join(tethercodeRoot, "agents"), path.join(backupRoot, "agents"));
    await fsp.writeFile(path.join(tethercodeRoot, "agents"), "partial-new-state");
    await fsp.writeFile(path.join(tethercodeRoot, "install-transaction.json"), JSON.stringify({
      version: 2,
      transactionId: "interrupted",
      state: "publishing",
      stagingRoot,
      backupRoot,
      entries: [{
        name: "agents",
        destination: path.join(tethercodeRoot, "agents"),
        staged: path.join(stagingRoot, "agents"),
        backup: path.join(backupRoot, "agents"),
        hadPrevious: true,
        phase: "publishing",
      }],
    }));
    await assert.rejects(installer.installAgents({
      ...binaryInstallOptions(workspace, first.body, first.registry),
      publishHook(phase) { if (phase === "before-backup:agents") throw new Error("post-recovery fault"); },
    }), /post-recovery fault/);
    assert.deepEqual(await treeSnapshot(tethercodeRoot), before);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("forged recovery journals are quarantined without deleting outside sentinels", async (t) => {
  if (process.platform === "win32") t.skip("symlink and canonical path recovery checks are POSIX-specific");
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-forged-recovery-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-forged-sentinel-"));
  const sentinel = path.join(outside, "sentinel.txt");
  await fsp.mkdir(path.join(workspace, ".tethercode"));
  const tethercodeRoot = await fsp.realpath(path.join(workspace, ".tethercode"));
  await fsp.writeFile(sentinel, "keep-me");

  const transactionId = "forged-transaction";
  const expectedStaging = path.join(tethercodeRoot, `.install-staging-${transactionId}`);
  const expectedBackup = path.join(tethercodeRoot, `.install-backup-${transactionId}`);
  const baseJournal = {
    version: 2,
    transactionId,
    state: "publishing",
    stagingRoot: expectedStaging,
    backupRoot: expectedBackup,
    entries: [{
      name: "agents",
      destination: path.join(tethercodeRoot, "agents"),
      staged: path.join(expectedStaging, "agents"),
      backup: path.join(expectedBackup, "agents"),
      hadPrevious: false,
      phase: "publishing",
    }],
  };
  const cases = [
    { name: "tmp root", mutate: (journal) => { journal.stagingRoot = outside; } },
    { name: "workspace parent", mutate: (journal) => { journal.backupRoot = path.dirname(workspace); } },
    { name: "traversal", mutate: (journal) => { journal.entries[0].backup = path.join(expectedBackup, "..", "..", "sentinel.txt"); } },
    { name: "mismatched id", mutate: (journal) => { journal.transactionId = "different-id"; } },
    { name: "invalid id", mutate: (journal) => { journal.transactionId = "../escape"; } },
  ];

  try {
    for (const testCase of cases) {
      const journal = structuredClone(baseJournal);
      testCase.mutate(journal);
      const journalPath = path.join(tethercodeRoot, "install-transaction.json");
      await fsp.writeFile(journalPath, JSON.stringify(journal));
      await assert.rejects(
        installer.recoverWorkspaceTransaction(tethercodeRoot),
        /invalid; refusing unsafe recovery/,
        testCase.name
      );
      assert.equal(await fsp.readFile(sentinel, "utf8"), "keep-me", testCase.name);
      assert.equal(fs.existsSync(journalPath), false, testCase.name);
      assert.ok(
        (await fsp.readdir(tethercodeRoot)).some((name) => name.startsWith("install-transaction.invalid-")),
        testCase.name
      );
    }

    await fsp.symlink(outside, expectedStaging);
    await fsp.mkdir(expectedBackup);
    await fsp.writeFile(path.join(tethercodeRoot, "install-transaction.json"), JSON.stringify(baseJournal));
    await assert.rejects(
      installer.recoverWorkspaceTransaction(tethercodeRoot),
      /must be a real directory|symlink component/
    );
    assert.equal(await fsp.readFile(sentinel, "utf8"), "keep-me");
    assert.equal(await fsp.realpath(expectedStaging), await fsp.realpath(outside));
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test("next invocation completes cleanup for an interrupted committed transaction", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-committed-recovery-"));
  const { body, registry } = binaryFixture();
  const options = binaryInstallOptions(workspace, body, registry);
  try {
    await assert.rejects(installer.installAgents({
      ...options,
      publishHook(phase) { if (phase === "after-commit") throw new Error("commit cleanup interrupted"); },
    }), /commit cleanup interrupted/);
    const tethercodeRoot = await fsp.realpath(path.join(workspace, ".tethercode"));
    assert.ok(await fsp.stat(path.join(tethercodeRoot, "install-transaction.json")));
    await installer.installAgents(options);
    await assertPublishedStateConsistent(workspace);
    assert.equal(fs.existsSync(path.join(tethercodeRoot, "install-transaction.json")), false);
    assert.equal((await fsp.readdir(tethercodeRoot)).some((name) => name.startsWith(".install-")), false);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("subprocess crashes at every publication persistence boundary recover to one complete state", async () => {
  const entries = ["agents", "agents.json", "registry-provenance.json"];
  const boundaries = [
    "journal:prepared:file", "journal:prepared:parent", "backup-root:parent",
    ...entries.flatMap((name) => [
      `journal:backing-up:${name}:file`, `journal:backing-up:${name}:parent`,
      `backup:${name}:source-parent`, `backup:${name}:destination-parent`,
      `journal:publishing:${name}:file`, `journal:publishing:${name}:parent`,
      `publish:${name}:source-parent`, `publish:${name}:destination-parent`,
      `journal:published:${name}:file`, `journal:published:${name}:parent`,
    ]),
    "journal:committed:file", "journal:committed:parent",
    "cleanup:backup", "cleanup:staging", "cleanup:journal",
  ];
  const child = new URL("./fixtures/acp-install-crash-child.cjs", import.meta.url).pathname;

  for (const boundary of boundaries) {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-crash-boundary-"));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-crash-sentinel-"));
    const sentinel = path.join(outside, "sentinel.txt");
    const tethercodeRoot = path.join(workspace, ".tethercode");
    try {
      await fsp.mkdir(path.join(tethercodeRoot, "agents"), { recursive: true });
      await fsp.writeFile(path.join(tethercodeRoot, "agents", "state.txt"), "old\n");
      await fsp.writeFile(path.join(tethercodeRoot, "agents.json"), `${JSON.stringify({ value: "old" })}\n`);
      await fsp.writeFile(path.join(tethercodeRoot, "registry-provenance.json"), `${JSON.stringify({ value: "old" })}\n`);
      await fsp.writeFile(sentinel, "keep-me");

      const crashed = spawnSync(process.execPath, [child, "publish", workspace], {
        env: { ...process.env, TETHERCODE_INSTALL_TEST_CRASH_AT: boundary },
        encoding: "utf8",
      });
      assert.equal(crashed.status, 86, `${boundary}: ${crashed.stderr}`);
      const recovered = spawnSync(process.execPath, [child, "recover", workspace], {
        env: { ...process.env, TETHERCODE_INSTALL_TEST_CRASH_AT: "" },
        encoding: "utf8",
      });
      assert.equal(recovered.status, 0, `${boundary}: ${recovered.stderr}`);

      const values = [
        (await fsp.readFile(path.join(tethercodeRoot, "agents", "state.txt"), "utf8")).trim(),
        JSON.parse(await fsp.readFile(path.join(tethercodeRoot, "agents.json"), "utf8")).value,
        JSON.parse(await fsp.readFile(path.join(tethercodeRoot, "registry-provenance.json"), "utf8")).value,
      ];
      assert.ok(values.every((value) => value === values[0]), `${boundary}: ${values.join(",")}`);
      assert.ok(["old", "new"].includes(values[0]), boundary);
      assert.equal(await fsp.readFile(sentinel, "utf8"), "keep-me", boundary);
      assert.equal(fs.existsSync(path.join(tethercodeRoot, "install-transaction.json")), false, boundary);
    } finally {
      await fsp.rm(workspace, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  }
});

test("publication persistence boundaries follow prepared, mutate, commit, cleanup ordering", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-persistence-order-"));
  const tethercodeRoot = path.join(await fsp.realpath(workspace), ".tethercode");
  const transactionId = "ordered-publication";
  const stagingRoot = path.join(tethercodeRoot, `.install-staging-${transactionId}`);
  const boundaries = [];
  try {
    await fsp.mkdir(path.join(tethercodeRoot, "agents"), { recursive: true });
    await fsp.writeFile(path.join(tethercodeRoot, "agents", "state.txt"), "old\n");
    await fsp.writeFile(path.join(tethercodeRoot, "agents.json"), "old\n");
    await fsp.writeFile(path.join(tethercodeRoot, "registry-provenance.json"), "old\n");
    await fsp.mkdir(path.join(stagingRoot, "agents"), { recursive: true });
    await fsp.writeFile(path.join(stagingRoot, "agents", "state.txt"), "new\n");
    await fsp.writeFile(path.join(stagingRoot, "agents.json"), "new\n");
    await fsp.writeFile(path.join(stagingRoot, "registry-provenance.json"), "new\n");

    await installer.publishWorkspaceTransaction(tethercodeRoot, stagingRoot, {
      persistenceHook(boundary) { boundaries.push(boundary); },
    });

    const positions = Object.fromEntries(boundaries.map((boundary, index) => [boundary, index]));
    assert.ok(positions["journal:prepared:parent"] < positions["backup:agents:source-parent"]);
    for (const name of ["agents", "agents.json", "registry-provenance.json"]) {
      assert.ok(positions[`backup:${name}:destination-parent`] < positions[`publish:${name}:source-parent`], name);
      assert.ok(positions[`publish:${name}:destination-parent`] < positions[`journal:published:${name}:file`], name);
    }
    assert.ok(positions["journal:published:registry-provenance.json:parent"] < positions["journal:committed:file"]);
    assert.ok(positions["journal:committed:parent"] < positions["cleanup:backup"]);
    assert.ok(positions["cleanup:backup"] < positions["cleanup:staging"]);
    assert.ok(positions["cleanup:staging"] < positions["cleanup:journal"]);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("fsync failures propagate without reporting atomic publication success", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "tethercode-fsync-failure-"));
  const destination = path.join(workspace, "manifest.json");
  let renameCalled = false;
  const failingFs = {
    ...fsp,
    async open(target, flags, mode) {
      const handle = await fsp.open(target, flags, mode);
      if (target.includes(".tmp-")) {
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => { throw Object.assign(new Error("injected fsync failure"), { code: "EIO" }); },
          close: handle.close.bind(handle),
        };
      }
      return handle;
    },
    async rename(...args) {
      renameCalled = true;
      return fsp.rename(...args);
    },
  };
  try {
    await assert.rejects(
      installer.atomicWriteFile(destination, "new\n", { fs: failingFs }),
      /injected fsync failure/
    );
    assert.equal(renameCalled, false);
    assert.equal(fs.existsSync(destination), false);

    const parentSyncFailureFs = {
      ...fsp,
      async open(target, flags, mode) {
        const handle = await fsp.open(target, flags, mode);
        if (target === workspace) {
          return {
            sync: async () => { throw Object.assign(new Error("injected parent fsync failure"), { code: "EIO" }); },
            close: handle.close.bind(handle),
          };
        }
        return handle;
      },
    };
    await assert.rejects(
      installer.atomicWriteFile(destination, "visible-but-not-durable\n", { fs: parentSyncFailureFs }),
      /injected parent fsync failure/
    );
    assert.equal(await fsp.readFile(destination, "utf8"), "visible-but-not-durable\n");
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});