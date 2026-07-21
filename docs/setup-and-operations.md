# Setup and Operations

This guide is the detailed companion to the top-level `README.md`.

For bridge-driven provider UI payloads such as agent goals, see `docs/bridge-ui-surfaces.md`.

## Choosing ACP Agents

Setup accepts any agent ID in the ACP registry. Fresh setup uses `opencode` as the preferred registry ID; it does not fall back to a different agent when that ID is unavailable.

```bash
tethercode init --agents alpha-agent,beta-agent --preferred-agent alpha-agent
```

From a source checkout, the equivalent command is:

```bash
npm run setup:wizard -- --agents alpha-agent,beta-agent --preferred-agent alpha-agent
```

The installer fetches the registry over bounded, timed HTTPS during setup only. Redirects are limited to 301, 302, 303, 307, and 308 with a fixed hop limit, loop detection, one cumulative timeout/body budget, and credential-free HTTPS validation at every hop; HTTPS downgrades and invalid or missing `Location` headers are rejected. It validates the registry with Zod, rejects empty, traversal, control-character, `.` and `..` agent IDs before deriving paths, chooses a verified current-platform binary before npm and uv alternatives, and installs exact versions under `.tethercode/agents/<id>/<version>`. Optional agent icons may be absent or a credential-free HTTPS URL of at most 2,048 UTF-8 bytes with no fragment. A malformed optional icon does not invalidate the registry list, but selection of that entry fails before installation. Runtime is network-free and starts only canonical executables from the generated manifest.

Use `--agent <id>` for one agent. `--distribution binary|npx|uvx` overrides automatic selection. `--registry-url <https-url>` is intended only for tests or controlled administration.

Binary archives are bounded by compressed size, expanded size, and entry count; absolute paths, traversal, symlinks, and hardlinks are rejected. A binary without a registry SHA-256 requires `--trust-unverified`.

Npm packages use two isolated phases. Before any package code is installed, the installer writes a minimal `package.json` containing one exact dependency and runs resolution-only `npm install --package-lock-only --ignore-scripts --package-lock=true --save-exact`. It accepts only lockfile version 3 with the exact root spec, a bounded graph, exact versions for every package, credential-free HTTPS tarball URLs, and valid SHA-512 SRI for every non-root entry. Links and Git, file, workspace, VCS, HTTP, missing-integrity, and untrusted lifecycle-script entries are rejected. The canonical lock is saved as `.tethercode-dependency-plan`, hashed, and recorded in provenance before installation. Package code is then installed only with `npm ci`; scripts remain disabled unless `--trust-install-scripts` is explicit, and any lock rewrite fails the transaction.

Uv packages require an exact normalized package name and version. Before creating the environment, `uv pip compile --generate-hashes` creates a bounded requirements plan. Every entry must have an exact version and at least one SHA-256 artifact hash; indexes must be credential-free HTTPS; VCS, path, direct mutable URL, HTTP, and unhashed sources are rejected. The saved plan is hashed before a controlled virtual environment is created, and installation uses only `uv pip sync --require-hashes`. The console executable is resolved from the selected distribution's `entry_points.txt`, and matching `METADATA` plus integrity-bearing `RECORD` files are required for the selected package and every installed dependency. Any plan rewrite fails the transaction.

The live ACP registry schema currently publishes exact top-level `npx` and `uvx` specs, but it does not publish transitive locks, lock digests, artifact hash sets, or expected installation-tree digests. When a future authoritative registry/package plan is available, it must take precedence over local resolution and its advertised digest must match. With today's schema, separate clean installs at different times may resolve different authenticated transitive plans. `registry-provenance.json` records each plan digest, marks `resolutionPolicy` as `plan-before-install`, and explicitly sets `crossTimeReproducible` to `false`. A published installation is frozen, auditable, and runtime-verified against its own saved plan and tree receipt; it is not claimed to be cross-time reproducible or cryptographically reproducible beyond those inputs.

Install cache metadata is untrusted. Validation requires a strict installer-policy record whose fingerprint binds the selected agent, distribution, platform, version, command, arguments, environment, package/archive source, registry SHA-256, registry URL, and trust flags. The installer rehashes each executable and verifies distribution-specific evidence: verified binary executables are freshly derived from the retained registry-hashed artifact; npm revalidates the complete saved lock and plan digest, every installed package version, root/bin mappings, and metadata hashes; uv revalidates the complete saved hash plan, package identity, console-script mapping, metadata, every `RECORD` artifact hash, and a deterministic environment receipt. Valid signed-binary, npm, and uv installs may be reused; any mismatch triggers a clean staged reinstall. Unsigned binaries require `--trust-unverified` and refresh on every setup.

Npm and uv reuse and runtime launch additionally use the `tethercode-tree-v1` installation receipt over the complete controlled install prefix. Entries are UTF-8 JSON Lines sorted by slash-normalized relative path using raw UTF-8 byte order. Directory entries bind path, type, and four-digit octal permission mode; regular-file entries additionally bind byte size and lowercase SHA-256; symlink entries bind a lexically normalized contained target. The root digest is lowercase SHA-256 of the exact JSONL bytes, including each trailing newline. Absolute, escaping, or broken symlinks, hardlinked regular files, special files, non-UTF-8 paths, more than 100,000 entries, more than 2 GiB of regular-file content, paths over 4,096 UTF-8 bytes, or receipts over 32 MiB fail closed. The only exclusion is `.tethercode-install.json`, the installer-owned cache receipt stored at the install root; it is excluded to avoid self-reference and is never imported or executed. The immutable dependency plan, package code, every transitive dependency, directories, npm lock and bin artifacts, uv virtual-environment metadata and `dist-info`, environment executables, and contained symlinks are included. The plan digest is also included in agent and registry provenance; the tree digest therefore binds plan plus installed bytes into the runtime manifest. On POSIX systems package-manager regular files are made non-writable after installation; verification remains authoritative.

Agent selection is authoritative: a successful invocation publishes exactly the selected agents and removes obsolete install directories. One symlink-safe workspace lock serializes every selection set. The complete set, `agents.json`, and registry provenance are built under one unique staging root, then published through a backup journal and atomic renames. The journal is durably prepared before the first mutation. Each temporary JSON file is exclusively created at mode `0600`, completely written, file-synced, closed, renamed, and followed by a parent-directory sync. Backup and staged-destination renames sync both affected parent directories; committed state is file- and parent-synced before backup or staging cleanup; every cleanup removal is followed by a parent sync; and journal removal is followed by a final journal-parent sync. Staging and backup roots are derived beneath the same canonical `.tethercode` root, and publication rejects differing filesystem device IDs instead of relying on cross-filesystem rename behavior.

Journals use a strict versioned schema and bounded transaction ID. Recovery derives staging, backup, destination, and entry paths from the canonical `.tethercode` root plus that ID; serialized paths must match exactly. The install root and temporary roots must be real directories without symlink components. Invalid journals are quarantined and recovery stops without recursively deleting any untrusted path. A prepared or publishing journal is idempotently rolled back from actual backup/destination presence; a committed journal preserves the published state and idempotently completes cleanup. Any fsync failure propagates and is never reported as durable success, even if a rename is already visible. macOS directory fsync is required and failures are closed; only documented Windows directory-handle unsupported errors are ignored. Consequently an interrupted invocation recovers to one complete old or new selected state, never a merged or mixed manifest. `.tethercode/` is workspace-local, ignored by Git, and excluded from published npm packages.

Every generated agent entry carries the lowercase SHA-256 digest of its actual runtime executable and a typed integrity descriptor. Binary distributions use executable integrity. Npm and uv distributions require a canonical contained install root plus the `tethercode-tree-v1` digest. The Rust bridge independently recomputes the complete installation tree receipt in-process and verifies both the tree and executable immediately before constructing the SDK process transport. The ACP SDK accepts an executable path rather than an already-open file descriptor, so a local actor with permission to replace paths still has a narrow race between verification and the SDK spawn; preventing that residual path-replacement race requires SDK support for descriptor-based execution.

ACP subprocesses start with an empty inherited environment. The bridge restores only the safe host baseline `PATH`, `HOME`, `TMPDIR`, and `LANG` when present, then applies validated manifest literals or approved host references. Approved host references are limited to `CODEX_PATH`, `HOME`, `PATH`, and `XDG_CONFIG_HOME`. Environment names matching bridge/Expo tokens or general token, key, secret, or password patterns are denied even when supplied as manifest literals. There is no default agent-auth secret exception; adding one requires a narrowly named, reviewed policy rather than a broad pattern bypass.

Bridge security metadata that uses the Rust private atomic-write helper, including the ACP session index, push registry, and generated Git credential file, is created at mode `0600` before publication, file-synced, renamed relative to an open no-follow parent directory descriptor on Unix/macOS, and followed by a parent-directory sync. A parent sync failure is returned to the caller; a visible rename alone is not reported as durable success.

## Onboarding Output Cues

After `tethercode init`, expected sequence:

1. Secure config is written or reused
2. The bridge starts in the background
3. The wizard prints the bridge URL, token, and pairing QR for mobile onboarding
4. Bridge logs are written to `.bridge.log`

Published npm releases bundle prebuilt bridge binaries for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-armv7l`, and `win32-x64`. On those hosts, normal bridge startup does not require a Rust compile.

`tethercode init` may run a setup-time isolated npm or uv install for the selected registry distribution. It never installs an agent globally.

Published CLI installs are bridge-only. They do not include the Expo workspace or mobile app source files.

A clean source checkout does not contain a bundled bridge binary. The setup wizard detects
`services/rust-bridge/Cargo.toml`, installs/checks the Cargo and C toolchains, and builds the bridge
with `cargo build --locked --release`. Set `TETHERCODE_BRIDGE_FORCE_SOURCE_BUILD=true` before setup to
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

To install multiple agents instead:

```bash
ACP_AGENT_IDS=alpha-agent,beta-agent ACP_PREFERRED_AGENT=alpha-agent npm run secure:setup
```

Creates/updates:

- `.env.secure` (bridge runtime config, local ACP manifest/root, and token)
- `.tethercode/agents.json` (resolved runtime manifest)
- `.tethercode/agents/` (workspace-local exact agent installs)
- `apps/mobile/.env` (repo checkout only, for local mobile dev builds)

### 3) Start bridge

```bash
npm run secure:bridge
```

Startup fails when the local manifest or approved install root is missing. It has no direct-command or network-resolution fallback.

### 4) Pair from the mobile app

Open the installed mobile app on your phone, then scan the bridge QR. If needed, enter the bridge URL manually (for example `http://100.x.y.z:8787` or `http://192.168.x.y:8787`). The chosen bridge URL is stored on-device and can be changed later in Settings.

### In-app Bridge Maintenance

For secure-launcher installs, the mobile Settings screen can trigger bridge maintenance safely.

- Open `Settings > Bridge Maintenance`
- Tap `Restart bridge safely` to stop the current bridge and relaunch it through `scripts/start-bridge-secure.js`
- The app will disconnect briefly while the detached helper waits for bridge health to recover

Published `tethercode` CLI installs also expose `Update bridge`.

- `Update bridge` records the installed package version, stops the current bridge, runs `npm install -g tethercode@latest`, and relaunches through the same background launcher used by `tethercode init`
- The background launcher atomically replaces `.bridge.pid`, waits for health, and removes only its own PID state if startup fails
- If updated startup fails, the helper reinstalls the exact recorded npm package version before trying one recovery launch
- If rollback or recovery launch fails, status is `stopped` and includes a version-pinned recovery command; it never reports recovery based only on restoring environment files

Source checkouts expose only the restart action because repo-specific update logic is not safe to automate generically from mobile.

Maintenance keeps the package/source root separate from the invocation workspace root. Launcher
scripts come from the package root, while `.env.secure`, PID, log, and updater status files remain in
the directory where `tethercode init` or the source-checkout command was invoked. Restart and update
persist both roots explicitly, so neither path is inferred from the bridge executable location.

## Local Mobile Development Only

If you are developing the mobile app from this repo, start Expo separately:

```bash
npm run mobile
```

`npm run mobile` uses `scripts/start-expo.sh`, which sets `REACT_NATIVE_PACKAGER_HOSTNAME` from your secure config so QR resolution is predictable.

If you want one command that switches the bridge between LAN/VLAN and Tailscale, preserves your
existing bridge token and ACP agent manifest, restarts the bridge in the background, and then opens
Expo:

```bash
npm run stack:lan
npm run stack:tailscale
```

Both wrappers call `scripts/start-mobile-stack.sh`. Pass `--expo ios` or `--expo android` if you
want the same flow but to open a native Expo run command instead of the default `mobile` mode.

## Advanced Knobs

Optional environment variables:

- `TETHERCODE_SETUP_VERBOSE=true` — show full installer output
- `TETHERCODE_BRIDGE_FORCE_SOURCE_BUILD=true` — ignore a bundled bridge binary and build the included Rust sources with Cargo; setup persists this in `.env.secure`
- `EXPO_AUTO_REPAIR=true` — auto-repair React Native runtime on `npm run mobile`
- `EXPO_CLEAR_CACHE=true` — force `expo start --clear` via `npm run mobile`

## Operational Diagnostics

The authenticated `GET /status` endpoint and `bridge/status/read` RPC expose the same live operational snapshot. In the app, open `Settings > Connections > Connection tools` to view it.

The snapshot includes request completions/failures/timeouts, ACP agent lifecycle and negotiated capabilities, replay event and byte bounds plus evictions/client drops, message queue depth, push ticket/receipt outcomes, terminal concurrency/saturation, and up to 32 recent operational errors. Recent errors contain only timestamps, generated request IDs, method names, backend labels, and stable error kinds. Logs use structured JSON metadata and deliberately omit request parameters, prompts, tokens, backend response bodies, and raw protocol or stderr lines.

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
| `ACP_AGENT_MANIFEST` | absolute path to `.tethercode/agents.json` |
| `ACP_AGENT_ROOTS` | path-delimited absolute roots that may contain resolved agent executables |
| `ACP_INITIALIZE_TIMEOUT_MS` | positive ACP initialize timeout in milliseconds (default `15000`) |
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

Host paths are canonicalized before use. With `BRIDGE_ALLOW_OUTSIDE_ROOT_CWD=false`, absolute paths, relative paths, and symlinks must resolve within `BRIDGE_WORKDIR`. When enabled, existing paths may resolve outside the root for the listed interactive surfaces, but uploaded attachments always remain in root-owned `.tethercode-attachments` storage and reject symlink escapes.

### Mobile runtime (`apps/mobile/.env`, generated/updated)

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_HOST_BRIDGE_TOKEN` | token used by local mobile dev builds |
| `EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH` | query-token behavior for WebSocket auth fallback |
| `EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE` | suppress insecure-HTTP warning |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL` | in-app Privacy link |
| `EXPO_PUBLIC_TERMS_OF_SERVICE_URL` | in-app Terms link |

TetherCode does not ship with a payment SDK, tip jar, subscription, offering, or inherited store
product configuration. Any future monetization requires a separate reviewed implementation and
new provider accounts owned by this project.

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
- Keep installed ACP agents, Node dependencies, Expo SDK, and OS patches updated

## Verifying Setup

### Bridge health

```bash
source .env.secure
curl "http://$BRIDGE_HOST:$BRIDGE_PORT/health"
```

Expected response contains `"status":"ok"` or `"status":"degraded"` with HTTP
200 when at least one configured agent is ready. It returns HTTP 503 with
`"status":"unhealthy"` when no configured agent is ready. `/health` is the one
unauthenticated, minimal availability endpoint; use authenticated `/status` or
`bridge/status/read` for operational detail.

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
  - a discovered workspace path from existing agent sessions
   - any folder on the bridge host via the built-in folder browser or manual path entry

Behavior:

- Applies to new chats
- Existing chats retain their own workspace unless changed

### Model and Slash Commands

The Agent mode picker and available commands follow capabilities reported by the selected ACP agent. Workspace-defined modes, when advertised, apply to the next turn.

Supported mobile slash commands:

- `/help`
- `/new`
- `/model [model-id]`
- `/plan [on|off|prompt]`
- `/status`
- `/rename <new-name>`
- `/compact`
- `/review`
- `/fork`
- `/diff`

Commands that require an existing chat or an unsupported capability are hidden until available.
`/new` keeps the current chat agent selected.

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
npm version patch --ignore-scripts=false
git push --atomic origin main --follow-tags
```

The `npm version` lifecycle synchronizes workspace, Expo, Cargo manifest, and lockfile versions before creating the release commit and tag. The atomic push prevents a tag from reaching the remote if the `main` update is rejected. Automation verifies metadata, tag/version consistency, and that the tagged commit is reachable from `origin/main` before building or publishing to npm.
The `main` push still builds every bridge target but cannot publish. Only an exact `v<package.json version>` tag on `main`, or a manual run from `main` with `publish_package` explicitly selected and the `npm-publish` environment approved, can enter the publish job. Every publish also depends on the release workflow's own strict contract, lint, typecheck, test, mobile branch coverage, and Rust branch coverage job; a successful check from another workflow run cannot substitute for it. Publishes for the same package and version share one non-cancelling concurrency group, so the release commit and tag cannot compete.

Use `npm run test:release` to validate workflow YAML and the release ownership guard locally. CI runs the same focused policy suite on pull requests.

## API Summary (Rust Bridge)

### Endpoints

- `GET /health`: unauthenticated minimal availability (`ok`, `degraded`, or `unhealthy`); no
  operational detail or project content
- `GET /rpc`: authenticated WebSocket JSON-RPC; bearer auth is preferred and query-token auth is a
  private-network compatibility fallback when explicitly enabled
- `GET /status`: authenticated full bridge/backend/operational status
- `GET /local-image`: authenticated, descriptor-relative local image response beneath
  `BRIDGE_WORKDIR` (maximum `20 MiB`; symlinks and hardlinks rejected)
- `POST /attachments`: bearer-authenticated `multipart/form-data`; one streamed file, maximum
  `20 MiB`; staging, synchronization, and final rename use retained directory descriptors

Browser preview uses its separately configured listener and a short-lived, owner-scoped session
bootstrap rather than adding another route to the main bridge listener.

### Forwarded RPC methods

The bridge forwards an explicit allowlist, not arbitrary `thread/*` or `turn/*` methods. It includes
the mobile account/auth reads and actions, model/agent/app/skill/config catalogs, supported config
writes, review start, thread lifecycle/history operations, and turn start/steer/interrupt. The
versioned inventory in `contracts/bridge-rpc/v2/manifest.json` is the checked contract for methods
the mobile client invokes; `services/rust-bridge/src/rpc.rs` is the complete runtime allowlist.

`thread/read` ACP snapshots expose monotonic timeline sequences and per-collection truncation
metadata. `thread/snapshot/page` accepts the opaque `threadId`, one opaque `beforeCursor` or
`afterCursor`, and a limit clamped to 100. It returns typed message/reasoning/tool history from a
per-session journal bounded to 1,024 entries and 4 MiB. `unavailableCount` and
`earliestAvailableSequence` explicitly report history that has already been evicted; cursors never
claim that evicted content is retrievable.

`thread/list` always merges the durable session index with native ACP list results and loaded
sessions. Its `diagnostics` array reports partial native discovery caused by empty or duplicate-only
pages, repeated cursors, the 32-page budget, or the 2,048-session cap; durable IDs remain present in
all of those cases.

The durable session index stores each ACP identity with its canonical workspace directory. The
current schema is version 2; older index files are ignored rather than migrated without a trusted
workspace path. A `thread/read` or `thread/snapshot/page` request for a durable but unloaded session
reconstructs it once through `session/resume` when negotiated, otherwise `session/load`. Concurrent
reads share that reconstruction, while already-loaded reads stay local. Before reconstruction the
bridge re-canonicalizes the stored directory, verifies that it still exists and satisfies
`BRIDGE_ALLOW_OUTSIDE_ROOT_CWD`, and rejects stale or out-of-policy paths without launching the
agent.

Session-index writes are atomic and transactional. A failed write leaves the previous file and
in-memory durable set unchanged. New or explicitly resumed ACP sessions remain safely loaded in the
current bridge process, but the acknowledging RPC returns an explicit persistence error; a later
session listing or event flush retries the pending durable write.

### Bridge-native RPC methods

The checked inventory is `contracts/bridge-rpc/v2/manifest.json`. Major groups are:

- Health/runtime: `bridge/health/read`, `bridge/status/read`, `bridge/capabilities/read`, and
  `bridge/runtime/read`
- Push registration: `bridge/push/register`, `bridge/push/unregister`, and `bridge/push/list`
- Replay and coordination: `bridge/events/replay`, `bridge/thread/create`,
  `bridge/thread/list/stream/*`, and `bridge/thread/queue/*`
- Host surfaces: `bridge/workspaces/list`, `bridge/fs/list`, `bridge/terminal/exec`, and
  `bridge/git/*`
- Interaction: `bridge/approvals/*`, `bridge/userInput/resolve`, and `bridge/ui/*`
- Browser and maintenance: browser-preview, agent-maintenance, restart, and
  `bridge/update/start`

All of these methods are available only after the WebSocket connection passes bridge authentication.

### ACP integration tests

Run `npm run test:acp` from the repository root. The focused Rust target exercises fake ACP
transports, capability negotiation, session lifecycle and routing, permission and elicitation flows,
canonical event projection, steering, cancellation, and manager recovery. It does not read bridge
runtime state, bind configured bridge ports, or stop/restart a developer bridge. CI runs it in the
Rust bridge job in addition to the full Rust suite.

### Mobile branch coverage

Run `npm run coverage:check` from the repository root. CI enforces at least 86% branch coverage
across the active mobile logic layer: persisted state, profiles, bridge transport/API mapping,
realtime synchronization controllers, navigation logic, and pure product helpers. Declarative screen
rendering, styles, generated files, and native projects remain covered by component, build, and
manual UI checks rather than the logic branch threshold.

### Rust branch coverage

Run `npm run coverage:rust` from the repository root. The first run requires the pinned coverage
toolchain and reporter:

```bash
rustup toolchain install nightly-2026-07-15 --profile minimal --component llvm-tools-preview
cargo install cargo-llvm-cov@0.8.7 --locked
```

CI and the local command enforce at least 86% branch coverage over all Rust production source.
Inline `#[cfg(test)]` modules are test infrastructure; the production paths they exercise remain
included. The command writes JSON and HTML reports under `services/rust-bridge/target/llvm-cov/`.

### Host execution policy

- `bridge/terminal/exec` is deny-all by default. Opt in with `BRIDGE_TERMINAL_EXEC_POLICIES=pwd,ls,cat`; an unset or empty value enables nothing.
- Each terminal policy validates arguments: `pwd` takes none, `ls` accepts only `-a`, `-A`, `-l`, `-h`, and `-1` plus canonicalized paths, and `cat` accepts only canonicalized files.
- Generic `git` terminal commands are always forbidden. Before diff, stage, commit, branch mutation, or push, `bridge/git/*` safely inventories effective system, global, local, worktree, `include.path`, and active `includeIf` configuration with origins and scopes. It fails closed on unreadable includes, executable filters, diff and merge drivers, hooks, fsmonitor, SSH commands, credential helpers, shell aliases, editors, and transport weakening. The inspection command clears inherited command environment and applies command-scope helper, hook, and protocol defenses, so validation cannot execute the configuration it is examining.
- Repository operations then use a separate hardened runner that ignores system/global Git configuration, disables hooks and external commands, resets credential helpers, forces TLS verification, clears command-scope proxies, and denies all protocols except HTTPS. Credentialed Git network operations additionally reject effective `http.*`, proxy, CA, `core.gitProxy`, and `url.*.insteadOf` transport overrides. Ambient Git/curl proxy, CA, and TLS override variables fail closed before credentials can be used.
- The bridge-owned GitHub credential store is passed directly to hardened Git commands; installation no longer changes the user's global Git configuration.
- Local images and uploaded attachments do not rely on canonicalize-then-open pathname checks. On Unix platforms the bridge retains a `BRIDGE_WORKDIR` directory descriptor, traverses components with no-follow directory opens, checks regular-file metadata from the opened image descriptor, creates upload files relative to a retained staging descriptor, and renames plus synchronizes within retained directories. Symlink-component swaps cannot redirect reads or writes outside the root; local images also reject hardlinks. These operations fail closed on unsupported non-Unix platforms.

### Notifications (examples)

- `turn/*`, `item/*`
- `bridge/approval.*`
- `bridge/userInput.*`
- `bridge/ui.*`
- `bridge/terminal/completed`
- `bridge/git/updated`
- `bridge/connection/state`
