import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  bridgePidFile,
  readPidFile,
  removePidFile,
  writePidFile,
} = require("../bridge-runtime-state.js");
const {
  bridgeLauncher,
  performUpdateTransaction,
  readPackageVersion,
  writeStatus,
} = require("../bridge-updater-helpers.js");

function temporaryDirectory(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tethercode-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("PID state is replaced atomically and only removed by its owner", (t) => {
  const root = temporaryDirectory(t, "pid");

  writePidFile(root, 101);
  writePidFile(root, 202);

  assert.equal(readPidFile(root), 202);
  assert.equal(removePidFile(root, 101), false);
  assert.equal(readPidFile(root), 202);
  assert.equal(removePidFile(root, 202), true);
  assert.equal(readPidFile(root), null);
  assert.deepEqual(
    fs.readdirSync(root).filter((entry) => entry.includes(".tmp")),
    []
  );
});

test("updater status is an atomic JSON replacement", (t) => {
  const root = temporaryDirectory(t, "status");
  const statusPath = path.join(root, ".bridge-update-status.json");

  writeStatus(statusPath, { state: "scheduled", jobId: "job-1" });
  writeStatus(statusPath, { state: "stopped", jobId: "job-1", recoverable: true });

  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(status.state, "stopped");
  assert.equal(status.recoverable, true);
  assert.equal(typeof status.updatedAt, "string");
  assert.deepEqual(
    fs.readdirSync(root).filter((entry) => entry.includes(".tmp")),
    []
  );
});

test("canonical updater relaunch uses background lifecycle", () => {
  const launcher = bridgeLauncher(path.resolve("published-package"));

  assert.equal(
    launcher.scriptPath,
    path.resolve("published-package", "scripts", "start-bridge-secure.js")
  );
  assert.deepEqual(launcher.args, ["--background"]);
});

test("installed package version is read before update", (t) => {
  const root = temporaryDirectory(t, "package");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "5.2.3" }));

  assert.equal(readPackageVersion(root), "5.2.3");
});

test("failed upgraded startup reinstalls and launches exact previous version", async () => {
  const installs = [];
  const statuses = [];
  let launchCount = 0;

  const result = await performUpdateTransaction({
    targetVersion: "6.0.0",
    previousVersion: "5.2.3",
    installVersion: async (version) => installs.push(version),
    launchBridge: async () => {
      launchCount += 1;
      if (launchCount === 1) {
        throw new Error("updated bridge unhealthy");
      }
    },
    setStatus: (state) => statuses.push(state),
  });

  assert.deepEqual(installs, ["6.0.0", "5.2.3"]);
  assert.deepEqual(statuses, ["upgrading", "starting", "rollingBack", "startingPrevious"]);
  assert.equal(result.state, "recovered");
  assert.equal(result.runningVersion, "5.2.3");
  assert.match(result.message, /5\.2\.3 was restored and restarted/);
});

test("rollback failure reports stopped recoverable state without claiming recovery", async () => {
  const installs = [];

  const result = await performUpdateTransaction({
    targetVersion: "6.0.0",
    previousVersion: "5.2.3",
    installVersion: async (version) => {
      installs.push(version);
      if (version === "5.2.3") {
        throw new Error("registry unavailable");
      }
    },
    launchBridge: async () => {
      throw new Error("updated bridge unhealthy");
    },
    setStatus: () => {},
  });

  assert.deepEqual(installs, ["6.0.0", "5.2.3"]);
  assert.equal(result.state, "stopped");
  assert.equal(result.runningVersion, null);
  assert.equal(result.recoverable, true);
  assert.equal(
    result.recoveryCommand,
    "npm install -g tethercode@5.2.3 && tethercode init"
  );
  assert.doesNotMatch(result.message, /was restored|restarted successfully/);
});

test("recovery launch failure after reinstall still reports stopped", async () => {
  const installs = [];

  const result = await performUpdateTransaction({
    targetVersion: "6.0.0",
    previousVersion: "5.2.3",
    installVersion: async (version) => installs.push(version),
    launchBridge: async () => {
      throw new Error("bridge unhealthy");
    },
    setStatus: () => {},
  });

  assert.deepEqual(installs, ["6.0.0", "5.2.3"]);
  assert.equal(result.state, "stopped");
  assert.equal(result.recoverable, true);
  assert.match(result.failure, /rollback: bridge unhealthy/);
});
