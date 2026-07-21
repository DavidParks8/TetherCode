#!/usr/bin/env node
"use strict";

const https = require("node:https");
const { z } = require("zod");

const DEFAULT_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const MAX_ICON_URL_BYTES = 2_048;
const dependencyLockSchema = z.record(z.unknown());

function isValidAgentId(value) {
  return typeof value === "string" && AGENT_ID_PATTERN.test(value) && value !== "." && value !== "..";
}

const environmentSchema = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
  z.string().max(16 * 1024).refine((value) => !value.includes("\0"))
).default({});
const argsSchema = z
  .array(z.string().min(1).max(16 * 1024).refine((value) => !value.includes("\0")))
  .max(64)
  .default([]);
const commandDistributionSchema = z
  .object({
    package: z.string().min(1).max(2_048),
    args: argsSchema,
    env: environmentSchema,
    packageLock: dependencyLockSchema.optional(),
    npmShrinkwrap: dependencyLockSchema.optional(),
    treeSha256: z.string().regex(SHA256_PATTERN).optional(),
  })
  .passthrough()
  .refine((value) => !(value.packageLock && value.npmShrinkwrap), {
    message: "a command distribution may provide only one authoritative npm lock",
  });
const binaryDistributionSchema = z
  .object({
    archive: z.string().url().refine((value) => new URL(value).protocol === "https:"),
    cmd: z.string().min(1).max(2_048).refine((value) => !value.includes("\0")),
    args: argsSchema,
    env: environmentSchema,
    sha256: z.string().regex(SHA256_PATTERN).optional(),
  })
  .passthrough();
const distributionsSchema = z
  .object({
    binary: z.record(z.string(), binaryDistributionSchema).optional(),
    npx: commandDistributionSchema.optional(),
    uvx: commandDistributionSchema.optional(),
  })
  .strict()
  .refine((value) => value.binary || value.npx || value.uvx, {
    message: "at least one distribution is required",
  });
const registryAgentSchema = z
  .object({
    id: z.string().refine(isValidAgentId, { message: "invalid ACP registry agent ID" }),
    name: z.string().min(1).max(256).optional(),
    version: z.string().regex(VERSION_PATTERN),
    icon: z.string().optional(),
    distribution: distributionsSchema,
  })
  .passthrough();
const registrySchema = z
  .object({
    version: z.string().min(1).max(256),
    agents: z.array(registryAgentSchema).min(1).max(512),
    extensions: z.union([z.array(z.unknown()), z.record(z.unknown())]),
  })
  .passthrough();

function parseRegistry(value) {
  const registry = registrySchema.parse(value);
  const seen = new Set();
  for (const agent of registry.agents) {
    if (seen.has(agent.id)) {
      throw new Error(`duplicate registry agent ID: ${agent.id}`);
    }
    seen.add(agent.id);
    if (agent.distribution.binary) {
      for (const platform of Object.keys(agent.distribution.binary)) {
        if (!/^(darwin|linux|windows)-(aarch64|x86_64)$/.test(platform)) {
          throw new Error(`invalid binary platform '${platform}' for agent '${agent.id}'`);
        }
      }
    }
    if (agent.distribution.uvx?.packageLock || agent.distribution.uvx?.npmShrinkwrap) {
      throw new Error(`npm lock authority is invalid for uvx agent '${agent.id}'`);
    }
  }
  return registry;
}

function validateHttpsUrl(value, label) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  return url;
}

function isValidAgentIcon(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_ICON_URL_BYTES) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function requestHttpsResponse(
  sourceUrl,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    request = https.get,
    headers = {},
  } = {},
  onResponse
) {
  const startedAt = Date.now();
  const visited = new Set();
  let consumedBytes = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeRequest = null;
    const deadline = setTimeout(() => {
      activeRequest?.destroy(new Error("HTTPS response chain timed out"));
      finish(new Error("HTTPS response chain timed out"));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    const accountChunk = (chunk) => {
      consumedBytes += chunk.length;
      if (consumedBytes > maxBodyBytes) {
        throw new Error("HTTPS response chain exceeds the configured size limit");
      }
    };
    const follow = (candidate, redirects) => {
      let url;
      try {
        url = validateHttpsUrl(candidate, "HTTPS request URL");
      } catch (error) {
        finish(error);
        return;
      }
      const normalized = url.toString();
      if (visited.has(normalized)) {
        finish(new Error("HTTPS redirect loop detected"));
        return;
      }
      visited.add(normalized);
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        finish(new Error("HTTPS response chain timed out"));
        return;
      }
      const req = request(url, { headers }, (response) => {
        if (Date.now() - startedAt >= timeoutMs) {
          response.resume();
          finish(new Error("HTTPS response chain timed out"));
          return;
        }
        const statusCode = response.statusCode || 0;
        if (REDIRECT_STATUS_CODES.has(statusCode)) {
          if (redirects >= maxRedirects) {
            response.resume();
            finish(new Error(`HTTPS redirect limit exceeded (${maxRedirects})`));
            return;
          }
          const location = response.headers.location;
          if (typeof location !== "string" || !location.trim()) {
            response.resume();
            finish(new Error("HTTPS redirect response is missing a valid Location header"));
            return;
          }
          let nextUrl;
          try {
            nextUrl = validateHttpsUrl(new URL(location, url), "HTTPS redirect URL");
          } catch (error) {
            response.resume();
            finish(error);
            return;
          }
          response.on("data", (chunk) => {
            try {
              accountChunk(chunk);
            } catch (error) {
              req.destroy(error);
            }
          });
          response.on("end", () => follow(nextUrl, redirects + 1));
          response.on("error", finish);
          response.resume();
          return;
        }
        Promise.resolve(onResponse({ response, request: req, url, accountChunk }))
          .then((value) => finish(null, value), finish);
      });
      activeRequest = req;
      req.setTimeout(remainingMs, () => req.destroy(new Error("HTTPS response chain timed out")));
      req.on("error", finish);
    };
    follow(sourceUrl, 0);
  });
}

function fetchRegistry(
  registryUrl = DEFAULT_REGISTRY_URL,
  { timeoutMs = DEFAULT_TIMEOUT_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, request = https.get } = {}
) {
  validateHttpsUrl(registryUrl, "ACP registry URL");
  return requestHttpsResponse(
    registryUrl,
    { timeoutMs, maxBodyBytes, request, headers: { accept: "application/json" } },
    ({ response, request: req, accountChunk }) => new Promise((resolve, reject) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`ACP registry request failed with HTTP ${response.statusCode}`));
        return;
      }
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        response.resume();
        reject(new Error(`ACP registry returned unsupported content type '${contentType || "missing"}'`));
        return;
      }
      const contentLength = Number(response.headers["content-length"] || 0);
      if (contentLength > maxBodyBytes) {
        response.resume();
        reject(new Error("ACP registry response exceeds the configured size limit"));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => {
        try {
          accountChunk(chunk);
        } catch (error) {
          req.destroy(error);
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve(parseRegistry(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    })
  );
}

function registryPlatformKey(platform = process.platform, arch = process.arch) {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
  const cpu = { arm64: "aarch64", x64: "x86_64" }[arch];
  if (!os || !cpu) {
    throw new Error(`unsupported ACP installer platform: ${platform}-${arch}`);
  }
  return `${os}-${cpu}`;
}

function selectDistribution(agent, { platformKey = registryPlatformKey(), override } = {}) {
  if (!isValidAgentId(agent.id)) {
    throw new Error("invalid ACP registry agent ID");
  }
  if (!isValidAgentIcon(agent.icon)) {
    throw new Error(`agent '${agent.id}' has an invalid optional icon URL`);
  }
  const available = agent.distribution;
  if (override) {
    if (!new Set(["binary", "npx", "uvx"]).has(override)) {
      throw new Error(`unsupported distribution override '${override}'`);
    }
    if (override === "binary") {
      const binary = available.binary?.[platformKey];
      if (!binary) {
        throw new Error(`agent '${agent.id}' has no binary for ${platformKey}`);
      }
      return { kind: "binary", value: binary, platformKey };
    }
    if (!available[override]) {
      throw new Error(`agent '${agent.id}' has no ${override} distribution`);
    }
    return { kind: override, value: available[override] };
  }
  if (available.binary?.[platformKey]?.sha256) {
    return { kind: "binary", value: available.binary[platformKey], platformKey };
  }
  if (available.npx) return { kind: "npx", value: available.npx };
  if (available.uvx) return { kind: "uvx", value: available.uvx };
  if (available.binary?.[platformKey]) {
    return { kind: "binary", value: available.binary[platformKey], platformKey };
  }
  throw new Error(`agent '${agent.id}' has no distribution for ${platformKey}`);
}

function parseInstallerArgs(argv) {
  const options = { agentIds: [], preferredAgentId: "", distribution: "", registryUrl: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--agent", "--agents", "--preferred-agent", "--distribution", "--registry-url"].includes(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      index += 1;
      if (flag === "--agent") options.agentIds.push(value);
      if (flag === "--agents") options.agentIds.push(...value.split(",").map((id) => id.trim()));
      if (flag === "--preferred-agent") options.preferredAgentId = value;
      if (flag === "--distribution") options.distribution = value;
      if (flag === "--registry-url") {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Error("--registry-url must be credential-free HTTPS");
        }
        options.registryUrl = url.toString();
      }
      continue;
    }
    throw new Error(`unknown ACP installer option '${flag}'`);
  }
  options.agentIds = [...new Set(options.agentIds.filter(Boolean))];
  if (options.agentIds.some((id) => !isValidAgentId(id))) {
    throw new Error("agent IDs must be path-safe and may contain only letters, numbers, '.', '_' and '-'");
  }
  if (options.preferredAgentId && !options.agentIds.includes(options.preferredAgentId)) {
    throw new Error("--preferred-agent must be included in --agent/--agents");
  }
  if (!options.preferredAgentId && options.agentIds.length > 1) {
    throw new Error("--preferred-agent is required when selecting multiple agents");
  }
  if (!options.preferredAgentId && options.agentIds.length === 1) {
    options.preferredAgentId = options.agentIds[0];
  }
  return options;
}

module.exports = {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_REGISTRY_URL,
  fetchRegistry,
  parseInstallerArgs,
  parseRegistry,
  registryPlatformKey,
  registrySchema,
  requestHttpsResponse,
  isValidAgentId,
  isValidAgentIcon,
  selectDistribution,
  validateHttpsUrl,
};