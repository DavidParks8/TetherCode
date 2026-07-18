import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { hasBridgeSource, readEnvFile } = require("../start-bridge-secure.js");
const { parseArgs } = require("../bridge-self-update.js");

test("a clean source tree is a valid bridge runtime source", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdex-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, "services", "rust-bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "services", "rust-bridge", "Cargo.toml"), "[package]\n");

  assert.equal(hasBridgeSource(root), true);
  assert.equal(hasBridgeSource(path.join(root, "missing")), false);
});

test("secure env parsing retains the source-force setting", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdex-env-"));
  const envPath = path.join(root, ".env.secure");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(envPath, "BRIDGE_HOST=127.0.0.1\nCLAWDEX_BRIDGE_FORCE_SOURCE_BUILD=true\n");

  assert.equal(readEnvFile(envPath).CLAWDEX_BRIDGE_FORCE_SOURCE_BUILD, "true");
});

test("maintenance requires and resolves package and workspace roots", () => {
  const parsed = parseArgs([
    "--action",
    "restart",
    "--job-id",
    "job-1",
    "--bridge-pid",
    "123",
    "--version",
    "current",
    "--status-path",
    "status.json",
    "--log-path",
    "updater.log",
    "--started-at",
    "2026-07-18T00:00:00Z",
    "--package-root",
    "package",
    "--workspace-root",
    "workspace",
  ]);

  assert.equal(parsed.packageRoot, path.resolve("package"));
  assert.equal(parsed.workspaceRoot, path.resolve("workspace"));
  assert.throws(
    () =>
      parseArgs([
        "--job-id",
        "job-1",
        "--bridge-pid",
        "123",
        "--status-path",
        "status.json",
      ]),
    /missing updater arguments/
  );
});
