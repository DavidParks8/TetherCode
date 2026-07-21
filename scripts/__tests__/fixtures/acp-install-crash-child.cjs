"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const installer = require("../../acp-agent-install.js");

async function writeState(root, value) {
  await fs.mkdir(path.join(root, "agents"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, "agents", "state.txt"), `${value}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(root, "agents.json"), `${JSON.stringify({ value })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(root, "registry-provenance.json"), `${JSON.stringify({ value })}\n`, { mode: 0o600 });
}

async function main() {
  const [mode, workspace] = process.argv.slice(2);
  const tethercodeRoot = path.join(await fs.realpath(workspace), ".tethercode");
  if (mode === "publish") {
    const transactionId = `crash-${process.pid}`;
    const stagingRoot = path.join(tethercodeRoot, `.install-staging-${transactionId}`);
    await writeState(stagingRoot, "new");
    await installer.publishWorkspaceTransaction(tethercodeRoot, stagingRoot);
    return;
  }
  if (mode === "recover") {
    await installer.recoverWorkspaceTransaction(tethercodeRoot);
    return;
  }
  throw new Error(`unknown crash fixture mode '${mode}'`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
