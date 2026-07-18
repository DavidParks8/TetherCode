# Setup and Operations

This guide is the detailed companion to the top-level `README.md`.

For bridge-driven provider UI payloads such as Codex goals, see `docs/bridge-ui-surfaces.md`.

## Choosing Harnesses

The setup wizard now lets you choose which harnesses the phone should control.

If you want Codex, OpenCode, and Cursor:

```bash
clawdex init --engines codex,opencode,cursor
```

From a source checkout, the equivalent command is:

```bash
npm run setup:wizard -- --engines codex,opencode,cursor
```

That writes `BRIDGE_ENABLED_ENGINES=codex,opencode,cursor` into `.env.secure`, so the bridge starts the selected backends and the mobile app can control them from one UI. The bridge reports configured harnesses separately from backends that started successfully; the mobile app only offers available backends for new chats. When Cursor is selected, `clawdex init` uses the bundled `cursor-app-server`, asks for a Cursor account API key from Cursor Dashboard > Integrations > User API Keys, and saves it in `.env.secure`. Cursor documents this under CLI authentication: https://docs.cursor.com/en/cli/reference/authentication

If you want only one harness, use `--engine codex`, `--engine opencode`, or `--engine cursor`.

Cursor usage limits are not exposed by Cursor's public API today. The app shows key status, key metadata, runtime state, and models from Cursor; plan or weekly usage details remain in Cursor.

## Onboarding Output Cues

After `clawdex init`, expected sequence:

1. Secure config is written or reused
2. The bridge starts in the background
3. The wizard prints the bridge URL, token, and pairing QR for mobile onboarding
4. Bridge logs are written to `.bridge.log`

Published npm releases bundle prebuilt bridge binaries for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-armv7l`, and `win32-x64`. On those hosts, normal bridge startup does not require a Rust compile.

`clawdex init` does not run a project-local `npm install` for the published CLI path. The only required npm install there is `npm install -g clawdex-mobile@latest`.

Published CLI installs are bridge-only. They do not include the Expo workspace or mobile app source files.

A clean source checkout does not contain a bundled bridge binary. The setup wizard detects
`services/rust-bridge/Cargo.toml`, installs/checks the Cargo and C toolchains, and builds the bridge
with `cargo build --locked --release`. Set `CLAWDEX_BRIDGE_FORCE_SOURCE_BUILD=true` before setup to
force this path even when a packaged binary exists; setup persists that choice in `.env.secure`.

## Manual Secure Setup (No Wizard)

### 1) Install dependencies

```bash
npm install
```

### 2) Generate secure runtime config

```bash
npm run secure:setup
```

To generate multi-harness config instead:

```bash
BRIDGE_ENABLED_ENGINES=codex,opencode,cursor npm run secure:setup
```

Creates/updates:

- `.env.secure` (bridge runtime config + token)
- `apps/mobile/.env` (repo checkout only, for local mobile dev builds)

### 3) Start bridge

```bash
npm run secure:bridge
```

If you want a one-off multi-harness launch without rewriting `.env.secure`:

```bash
BRIDGE_ENABLED_ENGINES=codex,opencode,cursor npm run secure:bridge
```

When multiple harnesses are selected, the bridge starts each backend and merges chat lists while still routing each thread by engine.

### 4) Pair from the mobile app

Open the installed mobile app on your phone, then scan the bridge QR. If needed, enter the bridge URL manually (for example `http://100.x.y.z:8787` or `http://192.168.x.y:8787`). The chosen bridge URL is stored on-device and can be changed later in Settings.

### In-app Bridge Maintenance

For secure-launcher installs, the mobile Settings screen can trigger bridge maintenance safely.

- Open `Settings > Bridge Maintenance`
- Tap `Restart bridge safely` to stop the current bridge and relaunch it through `scripts/start-bridge-secure.js`
- The app will disconnect briefly while the detached helper waits for bridge health to recover

Published `clawdex-mobile` CLI installs also expose `Update bridge`.

- `Update bridge` stops the current bridge, runs `npm install -g clawdex-mobile@latest`, and starts the bridge again
- If the upgrade step fails, the helper attempts to restart the previous bridge automatically

Source checkouts expose only the restart action because repo-specific update logic is not safe to automate generically from mobile.

Maintenance keeps the package/source root separate from the invocation workspace root. Launcher
scripts come from the package root, while `.env.secure`, PID, log, and updater status files remain in
the directory where `clawdex init` or the source-checkout command was invoked. Restart and update
persist both roots explicitly, so neither path is inferred from the bridge executable location.

## Local Mobile Development Only

If you are developing the mobile app from this repo, start Expo separately:

```bash
npm run mobile
```

`npm run mobile` uses `scripts/start-expo.sh`, which sets `REACT_NATIVE_PACKAGER_HOSTNAME` from your secure config so QR resolution is predictable.

If you want one command that switches the bridge between LAN/VLAN and Tailscale, preserves your
existing bridge token and enabled harnesses, restarts the bridge in the background, and then opens
Expo:

```bash
npm run stack:lan
npm run stack:tailscale
```

Both wrappers call `scripts/start-mobile-stack.sh`. Pass `--expo ios` or `--expo android` if you
want the same flow but to open a native Expo run command instead of the default `mobile` mode.

## Advanced Knobs

Optional environment variables:

- `CLAWDEX_SETUP_VERBOSE=true` — show full installer output
- `CLAWDEX_BRIDGE_FORCE_SOURCE_BUILD=true` — ignore a bundled bridge binary and build the included Rust sources with Cargo; setup persists this in `.env.secure`
- `EXPO_AUTO_REPAIR=true` — auto-repair React Native runtime on `npm run mobile`
- `EXPO_CLEAR_CACHE=true` — force `expo start --clear` via `npm run mobile`

## Local Browser Preview

The mobile app includes a `Browser` screen that can open loopback-only web apps from the bridge
machine inside the app itself.

Typical examples:

- `localhost:3000`
- `127.0.0.1:5173`
- `3000`

How it works:

- The app creates one cryptographically random, 30-minute preview session owned by its current
  bridge WebSocket connection. Opening another preview replaces it; leaving Browser or disconnecting
  closes it.
- The bridge serves a dedicated preview origin on a separate port
- HTTP requests, subresources, cookies, and WebSocket/HMR traffic are proxied from the phone to
  the bridge host's loopback target
- Browser runtime calls to other loopback origins on the host are also rewritten through the
  preview origin for `fetch`, XHR, `EventSource`, `WebSocket`, and form submissions

Current scope:

- Supports `http://` and `https://` loopback targets only
- Intended for local web dev servers such as Next.js, Vite, CRA, or simple static servers
- Separate local frontend/backend ports can work together inside the preview as long as the app
  reaches the backend through normal browser APIs or form posts
- Hard-coded absolute localhost asset URLs outside those browser APIs may still need a same-origin
  dev proxy in the app itself
- Does not preview native React Native simulator/device UI directly

For a concise list of supported cases and known limitations, see
`docs/browser-preview-limitations.md`.

## Teardown / Cleanup

```bash
npm run teardown
```

Can:

- stop the bridge
- also stop local Expo if you started it from this repo
- remove generated artifacts (`.env.secure`, `.bridge.log`, `.expo.log`, pid files)
- optionally reset `apps/mobile/.env` from `.env.example`
- optionally run `tailscale down`

Non-interactive mode:

```bash
npm run teardown -- --yes
```

## Environment Reference

### Bridge runtime (`.env.secure`, generated)

| Variable | Purpose |
|---|---|
| `BRIDGE_NETWORK_MODE` | bridge connectivity mode (`tailscale` or `local`) |
| `BRIDGE_HOST` | bind host for rust bridge |
| `BRIDGE_PORT` | bridge port (default `8787`) |
| `BRIDGE_PREVIEW_HOST` | independent browser preview bind host (runtime default `127.0.0.1`; secure LAN/Tailscale setup explicitly uses `BRIDGE_HOST`) |
| `BRIDGE_PREVIEW_PORT` | browser preview port for proxied localhost web apps (default `BRIDGE_PORT + 1`) |
| `BRIDGE_CONNECT_URL` | externally reachable bridge base URL used for pairing/QR output |
| `BRIDGE_PREVIEW_CONNECT_URL` | externally reachable browser preview base URL |
| `BRIDGE_AUTH_TOKEN` | required auth token |
| `BRIDGE_ALLOW_INSECURE_NO_AUTH` | local debugging escape hatch; without a token, startup requires a literal loopback `BRIDGE_HOST` |
| `BRIDGE_NO_AUTH_ALLOWED_ORIGINS` | optional comma-separated exact browser origins allowed in no-auth mode; wildcards and `null` are rejected |
| `BRIDGE_ALLOW_QUERY_TOKEN_AUTH` | query-token auth fallback |
| `CODEX_CLI_BIN` | codex executable |
| `BRIDGE_ACTIVE_ENGINE` | preferred backend for unqualified bridge requests; it must be one of the enabled harnesses |
| `BRIDGE_ENABLED_ENGINES` | configured harnesses to start (`codex`, `opencode`, `cursor`, or a comma-separated mix); runtime availability is reported separately after startup |
| `OPENCODE_CLI_BIN` | opencode executable for dual-engine startup |
| `CURSOR_APP_SERVER_BIN` | Cursor app-server executable, usually the `cursor-app-server` binary bundled with `clawdex-mobile` |
| `CURSOR_API_KEY` | Cursor account API key used by the Cursor SDK harness; create it from Cursor Dashboard > Integrations > User API Keys, then provide it to `clawdex init` when Cursor is selected. See https://docs.cursor.com/en/cli/reference/authentication |
| `CURSOR_MODEL` | optional Cursor model id for non-interactive host defaults; normal mobile chats send the selected model |
| `BRIDGE_OPENCODE_HOST` | loopback host for spawned opencode server |
| `BRIDGE_OPENCODE_PORT` | loopback port for spawned opencode server |
| `BRIDGE_OPENCODE_SERVER_USERNAME` | basic-auth username passed to opencode server |
| `BRIDGE_OPENCODE_SERVER_PASSWORD` | basic-auth password passed to opencode server |
| `BRIDGE_WORKDIR` | absolute, canonical root for host path access and attachment storage |
| `BRIDGE_ALLOW_OUTSIDE_ROOT_CWD` | allow canonical existing paths outside `BRIDGE_WORKDIR` for terminal, Git, workspace browsing, mentions, and local images |
| `BRIDGE_WS_MAX_FRAME_BYTES` | maximum inbound WebSocket frame size (default 32 MiB) |
| `BRIDGE_WS_MAX_MESSAGE_BYTES` | maximum reassembled inbound WebSocket message size (default 32 MiB) |
| `BRIDGE_WS_PER_CLIENT_IN_FLIGHT` | maximum concurrent RPC requests per WebSocket client (default `16`) |
| `BRIDGE_WS_GLOBAL_IN_FLIGHT` | maximum concurrent client RPC requests bridge-wide (default `128`) |

Resource-limit values are strict positive integers. Requests above concurrency limits receive retryable JSON-RPC error `-32005`; oversized frames/messages are closed by the WebSocket transport before JSON parsing.

Payload/storage limits are centralized in `services/rust-bridge/src/resource_limits.rs`. Uploads and local images are capped at 20 MiB; Git diff/status, preview buffering, queues, push registrations, UI surfaces, replay notifications/responses, and filesystem listings have bounded byte or collection limits. Rejected RPC payloads return `-32602` with `error: resource_limit_exceeded`, `resource`, `limit`, and `actual`; bounded Git/filesystem/replay responses include explicit truncation metadata. Attachment files are private and collision-safe, and push registry updates use private atomic replacement.

Preview credentials are accepted once from the bootstrap URL, moved into an `HttpOnly`,
`SameSite=Strict` cookie (`Secure` when `BRIDGE_PREVIEW_CONNECT_URL` is HTTPS), and removed by a
same-origin redirect. Preview responses use `Referrer-Policy: no-referrer`, and credential query
parameters are not forwarded to target applications or nested preview frames.

No-auth mode cannot listen on wildcard, hostname, LAN, or Tailscale addresses. Origin-less native and operator clients remain allowed on loopback, while `/rpc`, `/status`, and `/local-image` return `403 forbidden_origin` to browser requests unless the origin exactly matches the bridge listener or `BRIDGE_NO_AUTH_ALLOWED_ORIGINS`. Prefer a short-lived random `BRIDGE_AUTH_TOKEN` instead: leave `BRIDGE_ALLOW_INSECURE_NO_AUTH=false`, restart the bridge and client with the temporary token, then rotate or remove it when local debugging ends.

Host paths are canonicalized before use. With `BRIDGE_ALLOW_OUTSIDE_ROOT_CWD=false`, absolute paths, relative paths, and symlinks must resolve within `BRIDGE_WORKDIR`. When enabled, existing paths may resolve outside the root for the listed interactive surfaces, but uploaded attachments always remain in root-owned `.clawdex-mobile-attachments` storage and reject symlink escapes.

### Mobile runtime (`apps/mobile/.env`, generated/updated)

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_HOST_BRIDGE_TOKEN` | token used by local mobile dev builds |
| `EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH` | query-token behavior for WebSocket auth fallback |
| `EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE` | suppress insecure-HTTP warning |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL` | in-app Privacy link |
| `EXPO_PUBLIC_TERMS_OF_SERVICE_URL` | in-app Terms link |
| `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` | RevenueCat public SDK key for iOS tip purchases |
| `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` | RevenueCat public SDK key for Android tip purchases |
| `EXPO_PUBLIC_REVENUECAT_TEST_STORE_API_KEY` | RevenueCat Test Store public SDK key for Expo Go / Store Client tip testing |
| `EXPO_PUBLIC_REVENUECAT_TIPS_OFFERING_ID` | optional RevenueCat offering identifier for the tip jar (`current` if omitted) |

If you enable the optional tip jar:

- Configure 4–5 non-subscription products in RevenueCat and attach them to a dedicated Offering
- Use consumables for repeatable “tip” tiers
- Enable In-App Purchase for the app’s Apple bundle identifier in App Store Connect / Apple Developer
- Use the RevenueCat Test Store SDK key in Expo Go; use the real iOS SDK key only in native builds/TestFlight/App Store builds
- Rebuild the native app after adding `react-native-purchases`

## Production Readiness Checklist

- Keep bridge network-private only by default (Tailscale/private LAN/VPN + host firewall)
- Require bridge auth with `BRIDGE_AUTH_TOKEN`
- Keep `BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true` only on private networks (required for Android WS auth fallback)
- Avoid `BRIDGE_ALLOW_INSECURE_NO_AUTH=true`; it is enforced as loopback-only and a short-lived random token is the safer debugging option
- Scope `BRIDGE_WORKDIR` to minimal required root
- Use strict default approvals on mobile
- Treat `Session`/`Allow similar` approval actions as privileged
- Run bridge under a supervisor with restart policy
- Rotate bridge tokens periodically and on device loss
- Keep `codex`, Node deps, Expo SDK, and OS patches updated

## Verifying Setup

### Bridge health

```bash
source .env.secure
curl "http://$BRIDGE_HOST:$BRIDGE_PORT/health"
```

Expected response contains `"status":"ok"`.

### In-app smoke test

1. Open app and verify Settings reports bridge connected
2. Set `Start Directory` from sidebar (optional)
3. Create a chat and send a prompt
4. Switch to Plan mode and send prompt that triggers clarifying options
5. Verify clarification flow can submit
6. Open Git from header and verify status/diff/commit/push behavior
7. Test attachment menu (`+`) with workspace path + phone file/image
8. Run long task and verify stop button interrupts run and transcript logs stop
9. Open `Browser`, enter `localhost:3000` or another active loopback dev port, and verify the page loads inside the app

## Chat Controls (Workspace, Model, Mode, Approvals)

### Choosing Start Directory

1. Open sidebar
2. Under `Start Directory`, pick either:
   - `Bridge default workspace`
   - a discovered workspace path from existing Codex chats
   - any folder on the bridge host via the built-in folder browser or manual path entry

Behavior:

- Applies to new chats
- Existing chats retain their own workspace unless changed

### Model and Slash Commands

The Agent mode picker includes built-in modes for every harness. When OpenCode
is active, it also lists custom agents exposed by the current workspace's
`/agent` catalog and applies the selected agent to the next turn.

Supported mobile slash commands:

- `/help`
- `/new`
- `/model [model-id]`
- `/plan [on|off|prompt]` (uses the OpenCode plan/build agents)
- `/status`
- `/rename <new-name>`
- `/compact` (Codex and OpenCode)
- `/review` (Codex only)
- `/fork`
- `/diff`

`/goal` is Codex-only. Commands that require an existing chat are hidden until a chat is open.
`/new` keeps the current chat engine selected.

### Plan Mode and Clarifications

- Plan mode is sent through `turn/start` via structured `collaborationMode`
- App can auto-switch to plan mode on plan events or when server requests it
- Structured clarifications open a dedicated modal
- Numbered plain-text options are rendered as tappable fallback choices

### Approval UX

Approval banner actions:

- `Deny`
- `Allow once`
- `Session`
- `Allow similar` (when available)

Approval events are surfaced via `bridge/approval.requested` and `bridge/approval.resolved`.

## NPM Release Automation

Workflow: `.github/workflows/npm-release.yml`

Publishing uses npm trusted publishing (OIDC), so no `NPM_TOKEN` repo secret is used.

Repository setup:

- Create the `npm-publish` deployment environment.
- Add required reviewers to protect manual releases and restrict deployment branches/tags to the intended release sources. The workflow applies this environment to every npm publish job; GitHub repository settings own the reviewer policy.
- Configure npm trusted publishing for `.github/workflows/npm-release.yml` and the `npm-publish` environment.

Typical release flow (from `main`):

```bash
npm version patch
git push origin main --follow-tags
```

Automation verifies tag/version consistency and publishes to npm.
The `main` push still builds every bridge target but cannot publish. Only an exact `v<package.json version>` tag, or a manual run with `publish_package` explicitly selected and the `npm-publish` environment approved, can enter the publish job. Publishes for the same package and version share one non-cancelling concurrency group, so the release commit and tag cannot compete.

Use `npm run test:release` to validate workflow YAML and the release ownership guard locally. CI runs the same focused policy suite on pull requests.

## API Summary (Rust Bridge)

### Endpoints

- `GET /health`
- `GET /rpc` (WebSocket JSON-RPC)
- `POST /attachments` (authenticated `multipart/form-data`; one streamed file, maximum `20 MB`)

### Forwarded methods

- `thread/*`
- `turn/*` (includes `turn/interrupt`)
- `review/start`
- `model/list`
- `skills/list`
- `app/list`

### Bridge RPC methods

- `bridge/health/read`
- `bridge/terminal/exec`
- `bridge/git/status`
- `bridge/git/diff`
- `bridge/git/commit`
- `bridge/git/push`
- `bridge/approvals/list`
- `bridge/approvals/resolve`
- `bridge/userInput/resolve`
- `bridge/ui/present`
- `bridge/ui/update`
- `bridge/ui/dismiss`
- `bridge/ui/resolve`

### Host execution policy

- `bridge/terminal/exec` is deny-all by default. Opt in with `BRIDGE_TERMINAL_EXEC_POLICIES=pwd,ls,cat`; an unset or empty value enables nothing.
- Each terminal policy validates arguments: `pwd` takes none, `ls` accepts only `-a`, `-A`, `-l`, `-h`, and `-1` plus canonicalized paths, and `cat` accepts only canonicalized files.
- Generic `git` terminal commands are always forbidden. `bridge/git/*` uses a separate hardened runner that ignores system/global Git configuration, disables hooks, external diff/filter helpers and unsafe transports, and rejects non-HTTPS or credential-bearing remotes before network operations.
- The bridge-owned GitHub credential store is passed directly to hardened Git commands; installation no longer changes the user's global Git configuration.

### Notifications (examples)

- `turn/*`, `item/*`
- `bridge/approval.*`
- `bridge/userInput.*`
- `bridge/ui.*`
- `bridge/terminal/completed`
- `bridge/git/updated`
- `bridge/connection/state`
