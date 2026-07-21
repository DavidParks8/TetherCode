# Setup and Operations

TetherCode's desktop app owns bridge setup and lifecycle. The bridge is not distributed through npm.
The macOS app contains a native SwiftUI/AppKit shell, the Rust `tethercode` operator, and the Rust
bridge.

## macOS Setup

Build and open the app from a source checkout:

```bash
npm ci
npm run desktop:build:macos
open apps/desktop/dist/TetherCode.app
```

In the app:

1. Choose the workspace the bridge may access.
2. Choose an installed ACP executable. OpenCode is discovered automatically in standard paths.
3. Select Tailscale or local-network access.
4. Confirm the host and bridge port.
5. Select **Set Up and Start**.
6. Scan the pairing QR from the mobile app.

The app uses native file panels, forms, buttons, menus, pickers, alerts, and launch-at-login APIs.
Styling and materials come from AppKit/SwiftUI on the installed macOS release.

Tailscale mode requires the Tailscale app to be installed and connected. Local mode detects common
macOS interfaces; a concrete LAN IP can also be entered manually.

## What Setup Writes

Rust setup registers an existing executable; it does not download or execute package-manager code.
It writes:

- `.env.secure`: private bridge configuration and bearer token
- `.tethercode/agents.json`: typed ACP manifest with canonical executable path and SHA-256 digest

Both are written through restrictive-mode temporary files and atomic rename. A previous bridge
token is preserved when setup is rerun.

For OpenCode, the default ACP argument is `acp`. Other agents may require a different argument list.

## Agent Integrity

Native setup records the lowercase SHA-256 digest of the selected executable. The Rust bridge
rechecks that digest immediately before constructing the SDK process transport, so a moved or
modified executable fails closed and must be registered again.

The bridge also retains compatibility with typed `tethercode-tree-v1` manifests. When such a
manifest is loaded, it independently recomputes the complete controlled installation tree. The
receipt is deterministic JSON Lines and excludes only `.tethercode-install.json` to avoid
self-reference. Validation rejects more than 100,000 entries, more than 2 GiB of regular-file
content, paths over 4,096 UTF-8 bytes, receipts over 32 MiB, escaping or broken symlinks,
hardlinked regular files, special files, and non-UTF-8 paths.

## Rust Operator

The app calls the bundled operator with JSON output. The same commands are available from a source
checkout:

```bash
npm run operator -- discover-agent --agent-id opencode
npm run operator -- setup --workspace /path/to/repository \
  --network tailscale --agent-id opencode --agent-args acp
npm run operator -- start --workspace /path/to/repository
npm run operator -- status --workspace /path/to/repository --human
npm run operator -- restart --workspace /path/to/repository
npm run operator -- stop --workspace /path/to/repository
```

`setup` accepts:

- `--network local|tailscale`
- `--host <ip-or-hostname>`; optional when the platform backend can discover it
- `--port <port>`; defaults to `8787`, with preview on the adjacent port
- `--agent-id <id>`
- `--display-name <name>`
- `--agent-executable <path>`; optional when the agent is discoverable
- `--agent-args '<space-separated arguments>'`

## Process Ownership

The desktop operator serializes start/stop/restart with a private per-workspace file lease. It stores
a versioned ownership record containing:

- PID
- OS process start time
- canonical bridge executable
- canonical workspace
- secure-config SHA-256

The legacy `.bridge.pid` file is only a compatibility mirror and never authorizes a signal by itself.
A live owned process remains stoppable when health is temporarily unavailable or `.env.secure` is
missing/corrupt.

## Runtime Configuration

Important `.env.secure` values:

- `BRIDGE_NETWORK_MODE`
- `BRIDGE_HOST`, `BRIDGE_PORT`
- `BRIDGE_PREVIEW_HOST`, `BRIDGE_PREVIEW_PORT`
- `BRIDGE_CONNECT_URL`, `BRIDGE_PREVIEW_CONNECT_URL`
- `BRIDGE_AUTH_TOKEN`
- `BRIDGE_ALLOW_QUERY_TOKEN_AUTH`
- `ACP_AGENT_MANIFEST`, `ACP_AGENT_ROOTS`
- `ACP_INITIALIZE_TIMEOUT_MS`
- `BRIDGE_WORKDIR`

Inbound WebSocket frames and reassembled messages default to a 32 MiB limit. Upload, Git,
filesystem, replay, queue, and preview surfaces have additional bounded byte or collection limits;
rejected requests and truncated responses include explicit resource metadata.

The bridge is for authenticated private networks only. Do not expose it directly to the public
internet. Query-token authentication exists for mobile compatibility; bearer authentication remains
preferred.

## Bridge API Summary

- `GET /health`: unauthenticated minimal availability only
- `GET /rpc`: authenticated WebSocket JSON-RPC
- `GET /status`: authenticated operational status
- `GET /local-image`: authenticated descriptor-relative image access beneath the allowed workspace
- `POST /attachments`: bearer-authenticated streamed upload with a 20 MiB file limit

Browser preview uses its separately configured listener rather than another route on the main bridge
listener. The versioned mobile RPC inventory is `contracts/bridge-rpc/v2/manifest.json`; the Rust
allowlist remains authoritative at runtime.

## Development

Start Expo independently after the desktop app has configured the bridge:

```bash
npm run mobile
```

The Expo bootstrap reads `.env.secure` to choose a reachable packager hostname. Real phones must use
a LAN or Tailscale bridge URL, not localhost.

## Distribution

`npm run desktop:build:macos` creates:

- `apps/desktop/dist/TetherCode.app`
- `apps/desktop/dist/TetherCode-<version>-<arch>.zip`

The build fails if the app contains Node, npm, npx, JavaScript, npm manifests, `node_modules`, or
Slint artifacts. Local builds are ad-hoc signed. Public distribution requires project-owned Apple
Developer signing and notarization.

Windows and Linux need separate native shells over the Rust operator. A WinUI shell is required on
Windows to inherit Mica and future WinUI styling from the OS.
