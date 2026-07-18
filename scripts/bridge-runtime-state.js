"use strict";

const fs = require("node:fs");
const path = require("node:path");

function atomicWriteFile(filePath, contents) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, contents, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function bridgePidFile(rootDir) {
  return path.join(rootDir, ".bridge.pid");
}

function readPidFile(rootDir) {
  try {
    const raw = fs.readFileSync(bridgePidFile(rootDir), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writePidFile(rootDir, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("bridge pid must be a positive integer");
  }
  atomicWriteFile(bridgePidFile(rootDir), `${pid}\n`);
}

function removePidFile(rootDir, expectedPid = null) {
  const pidPath = bridgePidFile(rootDir);
  if (expectedPid !== null && readPidFile(rootDir) !== expectedPid) {
    return false;
  }

  try {
    fs.unlinkSync(pidPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

module.exports = {
  atomicWriteFile,
  bridgePidFile,
  readPidFile,
  removePidFile,
  writePidFile,
};
