"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { atomicWriteFile } = require("./bridge-runtime-state");

function readPackageVersion(packageRoot) {
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (!version || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
    throw new Error(`unable to determine installed package version from ${manifestPath}`);
  }
  return version;
}

function writeStatus(statusPath, payload) {
  atomicWriteFile(
    statusPath,
    `${JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2)}\n`
  );
}

function bridgeLauncher(packageRoot) {
  return {
    scriptPath: path.join(packageRoot, "scripts", "start-bridge-secure.js"),
    args: ["--background"],
  };
}

function recoveryCommand(previousVersion) {
  return `npm install -g tethercode@${previousVersion} && tethercode init`;
}

async function performUpdateTransaction(options) {
  const {
    targetVersion,
    previousVersion,
    installVersion,
    launchBridge,
    setStatus,
  } = options;

  try {
    setStatus("upgrading", `Installing tethercode@${targetVersion}.`);
    await installVersion(targetVersion);
    setStatus("starting", "Starting the updated bridge through the background launcher.");
    await launchBridge();
    return {
      state: "completed",
      message: `Bridge updated to ${targetVersion} and restarted successfully.`,
      runningVersion: targetVersion,
      recoverable: false,
    };
  } catch (updateError) {
    setStatus(
      "rollingBack",
      `Updated startup failed. Reinstalling tethercode@${previousVersion}.`,
      { failure: errorMessage(updateError) }
    );
    try {
      await installVersion(previousVersion);
      setStatus("startingPrevious", `Starting restored tethercode@${previousVersion}.`, {
        failure: errorMessage(updateError),
      });
      await launchBridge();
      return {
        state: "recovered",
        message: `Bridge update failed. tethercode@${previousVersion} was restored and restarted.`,
        runningVersion: previousVersion,
        recoverable: false,
        failure: errorMessage(updateError),
      };
    } catch (rollbackError) {
      return {
        state: "stopped",
        message: `Bridge update and automatic rollback failed. The bridge is stopped; reinstall tethercode@${previousVersion} and initialize it again.`,
        runningVersion: null,
        recoverable: true,
        recoveryCommand: recoveryCommand(previousVersion),
        failure: `${errorMessage(updateError)}; rollback: ${errorMessage(rollbackError)}`,
      };
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  bridgeLauncher,
  performUpdateTransaction,
  readPackageVersion,
  recoveryCommand,
  writeStatus,
};
