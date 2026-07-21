#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { removePidFile } = require("./bridge-runtime-state");
const {
  bridgeLauncher,
  performUpdateTransaction,
  readPackageVersion,
  writeStatus,
} = require("./bridge-updater-helpers");

function parseArgs(argv) {
  const parsed = {
    action: "update",
    jobId: "",
    bridgePid: 0,
    version: "latest",
    statusPath: "",
    logPath: "",
    packageRoot: "",
    workspaceRoot: "",
    startedAt: new Date().toISOString(),
  };

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || typeof value !== "string") {
      throw new Error("invalid updater arguments");
    }

    switch (flag) {
      case "--action":
        parsed.action = value;
        break;
      case "--job-id":
        parsed.jobId = value;
        break;
      case "--bridge-pid":
        parsed.bridgePid = Number.parseInt(value, 10);
        break;
      case "--version":
        parsed.version = value;
        break;
      case "--status-path":
        parsed.statusPath = value;
        break;
      case "--log-path":
        parsed.logPath = value;
        break;
      case "--started-at":
        parsed.startedAt = value;
        break;
      case "--package-root":
        parsed.packageRoot = path.resolve(value);
        break;
      case "--workspace-root":
        parsed.workspaceRoot = path.resolve(value);
        break;
      default:
        throw new Error(`unknown updater flag: ${flag}`);
    }
  }

  if (
    !parsed.jobId ||
    !parsed.bridgePid ||
    !parsed.statusPath ||
    !parsed.packageRoot ||
    !parsed.workspaceRoot
  ) {
    throw new Error("missing updater arguments");
  }

  if (parsed.action !== "update" && parsed.action !== "restart") {
    throw new Error(`unsupported bridge maintenance action: ${parsed.action}`);
  }

  return parsed;
}

function readEnvFile(filePath) {
  const contents = fs.readFileSync(filePath, "utf8");
  const nextEnv = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    nextEnv[key] = value;
  }

  return nextEnv;
}

function readNonEmptyEnv(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? -1}`));
    });
  });
}

function killBridgeProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillBridgeProcess(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    if (result.error && result.error.code !== "ENOENT") {
      throw result.error;
    }
    return;
  }

  process.kill(pid, "SIGKILL");
}

function listMatchingPids(pattern) {
  const result = spawnSync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        command: match[2],
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.pid) && pattern.test(entry.command))
    .map((entry) => entry.pid);
}

async function waitForBridgeExit(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(250);
  }

  try {
    forceKillBridgeProcess(pid);
  } catch (error) {
    throw new Error(
      `bridge process did not stop and could not be force-stopped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(250);
  }

  throw new Error("bridge process did not exit in time");
}

async function startBridge(packageRoot, workspaceRoot, statusPath, payload, message) {
  writeStatus(statusPath, {
    ...payload,
    state: "starting",
    message,
  });
  const launcher = bridgeLauncher(packageRoot);
  await runCommand(process.execPath, [launcher.scriptPath, ...launcher.args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CLAWDEX_PACKAGE_ROOT: packageRoot,
      CLAWDEX_WORKSPACE_ROOT: workspaceRoot,
      INIT_CWD: workspaceRoot,
    },
  });
}

async function stopCurrentBridge(statusPath, payload, bridgePid, workspaceRoot) {
  writeStatus(statusPath, {
    ...payload,
    state: "stopping",
    message: "Stopping the current bridge process.",
  });
  killBridgeProcess(bridgePid);
  await waitForBridgeExit(bridgePid);
  removePidFile(workspaceRoot, bridgePid);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { packageRoot, workspaceRoot } = args;
  const previousVersion = readPackageVersion(packageRoot);
  const baseStatus = {
    jobId: args.jobId,
    targetVersion: args.action === "restart" ? args.version || "current" : args.version,
    previousVersion,
    startedAt: args.startedAt,
    logPath: args.logPath || null,
  };

  writeStatus(args.statusPath, {
    ...baseStatus,
    state: "scheduled",
    message:
      args.action === "restart"
        ? "Bridge restart scheduled."
        : `Bridge update scheduled for ${args.version}.`,
  });
  try {
    await sleep(800);
    await stopCurrentBridge(args.statusPath, baseStatus, args.bridgePid, workspaceRoot);

    if (args.action === "restart") {
      try {
        await startBridge(
          packageRoot,
          workspaceRoot,
          args.statusPath,
          baseStatus,
          "Starting the bridge process."
        );
        writeStatus(args.statusPath, {
          ...baseStatus,
          state: "completed",
          message: "Bridge restarted successfully.",
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        writeStatus(args.statusPath, {
          ...baseStatus,
          state: "stopped",
          message:
            error instanceof Error
              ? error.message
              : "Bridge restart failed. The bridge is stopped and can be started with clawdex init.",
          recoverable: true,
          recoveryCommand: "clawdex init",
          completedAt: new Date().toISOString(),
        });
        process.exitCode = 1;
      }
      return;
    }

    const result = await performUpdateTransaction({
      targetVersion: args.version,
      previousVersion,
      installVersion: async (version) => {
        await runCommand(npmCommand(), ["install", "-g", `clawdex-mobile@${version}`], {
          cwd: workspaceRoot,
          env: process.env,
        });
      },
      launchBridge: async () => {
        await startBridge(
          packageRoot,
          workspaceRoot,
          args.statusPath,
          baseStatus,
          "Starting the bridge through the canonical background launcher."
        );
      },
      setStatus: (state, message, extra = {}) => {
        writeStatus(args.statusPath, { ...baseStatus, ...extra, state, message });
      },
    });
    writeStatus(args.statusPath, {
      ...baseStatus,
      ...result,
      completedAt: new Date().toISOString(),
    });
    if (result.state === "stopped") {
      process.exitCode = 1;
    }
  } catch (error) {
    const previousBridgeStillRunning = isProcessAlive(args.bridgePid);
    writeStatus(args.statusPath, {
      ...baseStatus,
      state: previousBridgeStillRunning ? "unchanged" : "stopped",
      message: previousBridgeStillRunning
        ? `Bridge maintenance did not proceed; clawdex-mobile@${previousVersion} is still running.`
        : `Bridge maintenance failed. The bridge is stopped; reinstall clawdex-mobile@${previousVersion} and initialize it again.`,
      runningVersion: previousBridgeStillRunning ? previousVersion : null,
      recoverable: !previousBridgeStillRunning,
      recoveryCommand: previousBridgeStillRunning
        ? null
        : `npm install -g clawdex-mobile@${previousVersion} && clawdex init`,
      failure: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
    process.exitCode = 1;
  }
}

module.exports = { parseArgs };

if (require.main === module) {
  void main();
}
