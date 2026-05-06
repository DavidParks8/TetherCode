#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function resolveRootDir() {
  return path.resolve(__dirname, "..");
}

function resolveWorkspaceDir() {
  const candidates = [
    process.env.CLAWDEX_WORKSPACE_ROOT,
    process.env.INIT_CWD,
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }
    return path.resolve(candidate);
  }

  return resolveRootDir();
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
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
}

function commandExists(command) {
  if (typeof command === "string" && command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function parseArgs(argv) {
  return {
    noStart: argv.includes("--no-start"),
    prepareOnly: argv.includes("--prepare-only"),
    force: argv.includes("--force"),
  };
}

function parseEngineList(value) {
  const raw = typeof value === "string" && value.trim() ? value : "codex";
  const engines = [];
  for (const entry of raw.split(",")) {
    const engine = entry.trim().toLowerCase();
    if (!engine) {
      continue;
    }
    if (!["codex", "opencode", "cursor"].includes(engine)) {
      console.error(`error: unsupported Codespaces engine '${engine}'. Use codex, opencode, or cursor.`);
      process.exit(1);
    }
    if (!engines.includes(engine)) {
      engines.push(engine);
    }
  }
  return engines.length > 0 ? engines : ["codex"];
}

function ensureCodespacesContext({ force }) {
  if (force) {
    return;
  }

  if (String(process.env.CODESPACES || "").trim().toLowerCase() === "true") {
    return;
  }

  console.log("Codespaces bootstrap skipped because this shell is not running inside GitHub Codespaces.");
  process.exit(0);
}

function runSetup(rootDir, workspaceDir) {
  const enabledEngines = parseEngineList(
    process.env.CLAWDEX_CODESPACES_ENGINES || process.env.BRIDGE_ENABLED_ENGINES || "codex"
  );
  const setupEnv = {
    ...process.env,
  };

  delete setupEnv.BRIDGE_NETWORK_MODE;
  delete setupEnv.BRIDGE_HOST_OVERRIDE;
  delete setupEnv.BRIDGE_ACTIVE_ENGINE;
  delete setupEnv.BRIDGE_ENABLED_ENGINES;

  setupEnv.INIT_CWD = rootDir;
  setupEnv.CLAWDEX_WORKSPACE_ROOT = workspaceDir;
  setupEnv.BRIDGE_NETWORK_MODE = "codespaces";
  setupEnv.BRIDGE_HOST_OVERRIDE = "127.0.0.1";
  setupEnv.BRIDGE_ACTIVE_ENGINE = enabledEngines[0];
  setupEnv.BRIDGE_ENABLED_ENGINES = enabledEngines.join(",");

  console.log(`Preparing .env.secure for GitHub Codespaces (${setupEnv.BRIDGE_ENABLED_ENGINES})...`);
  const result = runCommand(path.join(rootDir, "scripts", "setup-secure-dev.sh"), [], {
    cwd: workspaceDir,
    env: setupEnv,
    shell: false,
  });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureCodexCliInstalled(secureEnv) {
  const codexBinary = readNonEmptyEnv(secureEnv, "CODEX_CLI_BIN") || "codex";
  if (commandExists(codexBinary)) {
    return;
  }

  console.log("Codex CLI not found in this codespace. Installing via npm...");
  const installResult = runCommand("npm", ["install", "-g", "@openai/codex"], {
    cwd: resolveWorkspaceDir(),
    env: process.env,
  });
  if ((installResult.status ?? 1) !== 0) {
    console.error("error: failed to install Codex CLI automatically.");
    process.exit(installResult.status ?? 1);
  }

  if (!commandExists(codexBinary)) {
    console.error(`error: Codex CLI still not found after install attempt: ${codexBinary}`);
    process.exit(1);
  }

  console.log("Codex CLI installed.");
}

function ensureNpmGlobalBinary({ binary, packageName, label }) {
  if (commandExists(binary)) {
    return;
  }

  console.log(`${label} not found in this codespace. Installing via npm...`);
  const installResult = runCommand("npm", ["install", "-g", packageName], {
    cwd: resolveWorkspaceDir(),
    env: process.env,
  });
  if ((installResult.status ?? 1) !== 0) {
    console.error(`error: failed to install ${label} automatically.`);
    process.exit(installResult.status ?? 1);
  }

  if (!commandExists(binary)) {
    console.error(`error: ${label} still not found after install attempt: ${binary}`);
    process.exit(1);
  }

  console.log(`${label} installed.`);
}

function ensureSelectedEngineTools(secureEnv) {
  const enabledEngines = parseEngineList(readNonEmptyEnv(secureEnv, "BRIDGE_ENABLED_ENGINES") || "codex");
  if (enabledEngines.includes("codex")) {
    ensureCodexCliInstalled(secureEnv);
  }
  if (enabledEngines.includes("opencode")) {
    ensureNpmGlobalBinary({
      binary: readNonEmptyEnv(secureEnv, "OPENCODE_CLI_BIN") || "opencode",
      packageName: "opencode-ai",
      label: "OpenCode CLI",
    });
  }
  if (enabledEngines.includes("cursor")) {
    ensureNpmGlobalBinary({
      binary: readNonEmptyEnv(secureEnv, "CURSOR_APP_SERVER_BIN") || "cursor-app-server",
      packageName: "@clawdex/cursor-app-server",
      label: "Cursor app server",
    });
  }
}

function prepareBridgeBinary(rootDir, workspaceDir, secureEnv) {
  console.log("Prebuilding bridge binary for faster Codespaces startup...");
  const prepareEnv = {
    ...process.env,
    ...secureEnv,
    CLAWDEX_WORKSPACE_ROOT: workspaceDir,
    INIT_CWD: process.env.INIT_CWD || workspaceDir,
  };
  const result = runCommand(
    process.execPath,
    [path.join(rootDir, "scripts", "start-bridge-secure.js"), "--prepare-only"],
    {
      cwd: workspaceDir,
      env: prepareEnv,
    }
  );

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function startBridge(rootDir, workspaceDir) {
  console.log("Starting bridge in background for this codespace...");
  const result = runCommand(
    process.execPath,
    [path.join(rootDir, "scripts", "start-bridge-secure.js"), "--background"],
    {
      cwd: workspaceDir,
      env: {
        ...process.env,
        CLAWDEX_WORKSPACE_ROOT: workspaceDir,
        INIT_CWD: process.env.INIT_CWD || workspaceDir,
      },
    }
  );

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureCodespacesContext(options);

  const rootDir = resolveRootDir();
  const workspaceDir = resolveWorkspaceDir();
  const secureEnvPath = path.join(workspaceDir, ".env.secure");

  runSetup(rootDir, workspaceDir);

  if (!fs.existsSync(secureEnvPath)) {
    console.error(`error: expected secure env at ${secureEnvPath}`);
    process.exit(1);
  }

  const secureEnv = readEnvFile(secureEnvPath);
  if (options.noStart || String(process.env.CLAWDEX_CODESPACES_SKIP_START || "").trim().toLowerCase() === "true") {
    console.log("Codespaces bootstrap configured bridge env only. Bridge auto-start skipped.");
    return;
  }

  ensureSelectedEngineTools(secureEnv);
  if (options.prepareOnly) {
    prepareBridgeBinary(rootDir, workspaceDir, secureEnv);
    console.log("Codespaces bootstrap prepared Codex and the bridge binary without starting the bridge.");
    return;
  }
  startBridge(rootDir, workspaceDir);
}

main();
