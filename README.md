# Clawdex Mobile

<p align="center">
  <img src="https://raw.githubusercontent.com/Mohit-Patil/clawdex-mobile/main/screenshots/social/clawdex-social-poster-1200x675.png" alt="Clawdex social banner" width="100%" />
</p>

Run ACP-compatible coding agents from your phone. `clawdex-mobile` ships the bridge CLI plus bundled Rust bridge binaries for supported hosts, and the mobile app pairs to that bridge over Tailscale or local LAN.

This project is for trusted/private networking by default. Keep the bridge on a private network, leave bridge auth enabled, and do not expose it directly to the public internet.

## What You Get

- Mobile chat for agents published in the Agent Client Protocol registry
- Live run updates over WebSocket
- Approval and clarification flows in-app
- Attachments, terminal, and Git actions
- One mobile shell backed by a private host bridge

## Quick Start

Before you start:

- Node.js 22.13+
- npm 10+
- `git`

Install the mobile app:

- Android APK: <https://www.getclawdex.com/android-beta/>
- iOS: <https://apple.co/4rNAHRF>

Install the CLI and start the bridge:

```bash
npm install -g clawdex-mobile@latest
clawdex init
```

Then open the mobile app and connect using the printed bridge URL/token or pairing QR.
`clawdex init` now writes config, starts the bridge in the background, and returns you to the shell. Bridge logs go to `.bridge.log`.

The npm package is bridge-only. It does not install Expo or the mobile source tree. On supported macOS, Linux, and Windows hosts it uses bundled bridge binaries, so normal startup does not compile Rust.
The current interactive setup helpers are still macOS/Linux-oriented.

Typical operator flow:

```bash
npm install -g clawdex-mobile@latest
clawdex init
clawdex stop
```

## ACP Agent Setup

Setup downloads the registry from `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, installs exact agent versions under `.clawdex/agents`, and atomically writes `.clawdex/agents.json`. The workspace-local `.clawdex/` directory is ignored by Git and excluded from the npm package. Runtime reads only that local manifest and never uses `npx`, `uvx`, or registry network resolution.

```bash
npm install -g clawdex-mobile@latest
clawdex init --agents alpha-agent,beta-agent --preferred-agent alpha-agent
```

Fresh interactive setup prefers the registry ID `opencode`; if it is absent from the fetched registry, setup fails clearly. Use `--agent <id>` for one agent or `--agents <id,...> --preferred-agent <id>` for several.

Distribution priority is verified platform binary, then npm package, then uv tool. Unsigned binaries require `--trust-unverified`; npm lifecycle scripts are disabled by default and require `--trust-install-scripts`. `--distribution binary|npx|uvx` provides an explicit override. `--registry-url` is available for tests and controlled administration and must use credential-free HTTPS.

Setup follows only bounded credential-free HTTPS redirects and never permits an HTTPS downgrade. Registry-SHA-256 binary installs are reused only after their registry-derived fingerprint, executable hash, and artifact integrity evidence are recomputed. Npm installs are reused only after a bounded `clawdex-tree-v1` receipt rehashes the complete isolated prefix, including first-party modules, transitive dependencies, package metadata, lockfile, modes, directories, and contained bin symlinks; Rust independently verifies that tree immediately before spawn. Uv tools verify every integrity-bearing `RECORD` artifact. Unsigned binaries require `--trust-unverified` and refresh on every setup. Any mismatch or refresh is built in a unique staging directory and atomically swapped under an install lock; a failed rebuild leaves the previously published manifest and install directory untouched.

Registry `env` values become literal defaults. Host environment values are not copied into the manifest; explicit `HostReference` entries are limited by the Rust runtime allowlist.

## Monorepo Development

If you are working from source:

```bash
npm install
npm run setup:wizard
npm run mobile
```

For one-step restarts that switch the bridge network mode, reuse the existing token, start the
bridge in the background, and then launch Expo:

```bash
npm run stack:lan
npm run stack:tailscale
```

`stack:lan` is the local network path, so it also covers the same-device LAN/VLAN case.

For a specific registry agent ID:

```bash
npm run setup:wizard -- --agent alpha-agent
```

Use `npm run setup:wizard -- --no-start` if you only want to write config.

## Main Commands

- `clawdex init [--agent <id>] [--agents <id,...> --preferred-agent <id>] [--no-start]`
- `clawdex stop`
- `clawdex upgrade` / `clawdex update`
- `clawdex version`
- `npm run setup:wizard`
- `npm run secure:bridge`
- `npm run mobile`
- `npm run stack:lan`
- `npm run stack:tailscale`
- `npm run ios`
- `npm run android`
- `npm run stop:services`
- `npm run teardown`

## Docs

- Setup + operations: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/setup-and-operations.md>
- Troubleshooting: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/troubleshooting.md>
- Realtime sync limits/mitigations: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/realtime-streaming-limitations.md>
- Push notifications and payload privacy: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/push-notifications.md>
- EAS builds: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/eas-builds.md>
- Open-source/license notes: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/open-source-license-requirements.md>
