# AGENTS

## Purpose

This repo is a monorepo for controlling ACP-compatible coding agents from a phone.

- Primary product path:
  - `apps/mobile`: Expo React Native client
  - `services/rust-bridge`: ACP agent manager plus terminal/git/attachment helpers
  - `bin/tethercode.js` + `scripts/*`: operator CLI and setup/runtime automation

The bridge is intended for trusted/private networks only. Do not treat this repo as internet-safe by default.

## Read First

Use the existing docs as the source of truth instead of duplicating them in code comments or PR notes.

- Quick start and command map: `README.md`
- Setup, secure env flow, verification, smoke tests, API summary: `docs/setup-and-operations.md`
- Troubleshooting and recovery commands: `docs/troubleshooting.md`
- Realtime/replay constraints: `docs/realtime-streaming-limitations.md`
- Push notifications (bridge-sent turn/approval alerts): `docs/push-notifications.md`
- EAS and native build/release notes: `docs/eas-builds.md`
- Open-source and notice obligations: `docs/open-source-license-requirements.md`

## Repo Map

### Active code

- `apps/mobile`
  - `App.tsx`: app shell, drawer navigation, persisted settings
  - `src/api/*`: bridge client, websocket transport, typed contracts
  - `src/screens/*`: main UI surfaces
  - `src/components/*`: chat UI pieces
  - `ios/*`: active Expo native iOS project
  - `plugins/withAndroidCleartextTraffic.js`: Android manifest patch for local/insecure bridge access
- `services/rust-bridge`
  - `src/main.rs`: Axum server and bridge composition root
  - `src/acp/manager.rs`: installed ACP agent and session lifecycle manager
  - `src/acp/runtime.rs`: typed ACP transport, interactions, and canonical events
  - `src/services/git.rs`: git helpers
  - `src/services/terminal.rs`: terminal execution helpers
- `scripts/*`
  - secure setup/start helpers, Expo bootstrap, service stop/cleanup, version sync
- `.github/workflows/*`
  - build/test, npm bridge release, and protected EAS mobile release

### Generated/vendor paths to avoid editing by hand

- `node_modules/*`
- `.expo/*`
- `apps/mobile/ios/Pods/*`

## Current Architecture

### Mobile app

- The mobile app is a custom shell, not React Navigation based.
- `apps/mobile/App.tsx` creates exactly one `HostBridgeWsClient` and one `HostBridgeApiClient`, persists app settings, owns the custom drawer, and switches screens via local state.
- The primary screens are:
  - `src/screens/MainScreen.tsx`
  - `src/screens/GitScreen.tsx`
  - `src/screens/SettingsScreen.tsx`
  - `src/screens/OnboardingScreen.tsx`
  - `src/screens/PrivacyScreen.tsx`
  - `src/screens/TermsScreen.tsx`
- `src/screens/TerminalScreen.tsx` exists but is not currently routed from `App.tsx`.
- `src/screens/MainScreen.tsx` is very large and is the main product surface. Treat edits there surgically.

### Bridge/runtime

- The supported backend is `services/rust-bridge`.
- The bridge exposes:
  - `GET /health`
  - `GET /rpc` for WebSocket JSON-RPC
  - `GET /local-image` for mobile image rendering of local/absolute paths
- The Rust bridge reads the validated local ACP manifest, starts installed agents, negotiates capabilities, and maps ACP sessions/events into the bridge contract.
- Bridge-native RPC methods include attachments upload, terminal exec, git operations, approvals, user-input resolution, and event replay.

### Realtime model

- Mobile realtime is hybrid:
  - canonical ACP events projected to AG-UI WebSocket notifications
  - replay buffer recovery via `bridge/events/replay`
  - ACP session snapshots for convergence after gaps or bridge restarts
- If work touches missing live updates, read `docs/realtime-streaming-limitations.md` before changing the bridge or mobile sync loop.

## Primary Workflows

### Preferred operator flow

- Published CLI:
  - `tethercode init`
  - `tethercode stop`
- Monorepo equivalents:
  - `npm run setup:wizard`
  - `npm run stop:services`

### Root scripts

From repo root:

- `npm run mobile`
- `npm run ios`
- `npm run android`
- `npm run bridge`
- `npm run secure:setup`
- `npm run secure:bridge`
- `npm run secure:bridge:dev`
- `npm run teardown`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run payment:check`
- `npm run version:sync`

### Important operational details

- `scripts/start-expo.sh` bootstraps Expo, attempts runtime repair if needed, and sets `REACT_NATIVE_PACKAGER_HOSTNAME` from `.env.secure` or Tailscale/LAN discovery.
- `scripts/start-bridge-secure.sh` sources `.env.secure` and runs the Rust bridge in dev or release mode.
- `npm run bridge` is only a shorthand for local development and does not load `.env.secure`.
- Do not restart the running bridge automatically as part of debugging or verification unless the user explicitly asks for a restart.
- Real-device iOS work should be run from `apps/mobile`, not the repo-root `ios/` tree.

## Environment and Config

### Bridge

Canonical examples:

- `services/rust-bridge/.env.example`

Important Rust bridge env knobs:

- `BRIDGE_HOST`
- `BRIDGE_PORT`
- `BRIDGE_WORKDIR`
- `BRIDGE_AUTH_TOKEN`
- `BRIDGE_ALLOW_INSECURE_NO_AUTH`
- `BRIDGE_ALLOW_QUERY_TOKEN_AUTH`
- `BRIDGE_ALLOW_OUTSIDE_ROOT_CWD`
- `BRIDGE_TERMINAL_EXEC_POLICIES`
- `ACP_AGENT_MANIFEST`
- `ACP_AGENT_ROOTS`
- `ACP_INITIALIZE_TIMEOUT_MS`

### Mobile

Canonical example:

- `apps/mobile/.env.example`

Important mobile env knobs:

- `EXPO_PUBLIC_HOST_BRIDGE_TOKEN`
- `EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH`
- `EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE`
- `EXPO_PUBLIC_PRIVACY_POLICY_URL`
- `EXPO_PUBLIC_TERMS_OF_SERVICE_URL`

Current behavior:

- Bridge URL is primarily set in onboarding and persisted in app settings.
- `EXPO_PUBLIC_HOST_BRIDGE_URL` is legacy/fallback behavior, not the main source of truth.

## Editing Rules For This Repo

- Prefer changing active source files under `apps/mobile/src` and `services/rust-bridge/src`.
- Keep bridge contract changes mirrored across:
  - `services/rust-bridge/src/main.rs`
  - `apps/mobile/src/api/types.ts`
  - `apps/mobile/src/api/client.ts`
  - relevant tests and docs
- If you change secure setup/runtime behavior, check:
  - `scripts/setup-wizard.sh`
  - `scripts/setup-secure-dev.sh`
  - `scripts/start-bridge-secure.sh`
  - `scripts/start-expo.sh`
  - `docs/setup-and-operations.md`
  - `docs/troubleshooting.md`
- If you bump app/package versions for an internal or npm release, also sync `services/rust-bridge/Cargo.lock`. The release workflow builds the bridge with `cargo --locked`, so a stale bridge package version in the lockfile will fail every binary job before publish.
- Do not confuse `apps/mobile/ios` with the older repo-root `ios/` directory.
- Do not edit vendored/generated files unless the change is deliberately maintained through a script or checked-in config.

## Testing Expectations

### Automated checks

From repo root:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`

Workspace-specific:

- `npm run -w apps/mobile lint`
- `npm run -w apps/mobile typecheck`
- `npm run -w apps/mobile test`
- `cargo fmt --check` / `cargo check` / `cargo test` in `services/rust-bridge`

### Existing test coverage

- `apps/mobile` has Jest unit tests for API mapping, websocket logic, notification helpers, and small UI helpers
- `services/rust-bridge` has focused ACP transport/manager tests plus inline tests for bridge services
- `npm run test:acp` runs the ACP-focused Rust test target used by CI

### Manual smoke tests

Use `docs/setup-and-operations.md` as the canonical smoke-test runbook. Minimum manual validation for meaningful product changes usually includes:

- onboarding / connection
- creating and running a chat
- approvals or plan-mode flow when relevant
- git actions if git-related code changed
- attachments if those paths changed

## Security Guardrails

- Treat the bridge as private-network only.
- Never expose the current bridge directly to the public internet.
- `BRIDGE_ALLOW_INSECURE_NO_AUTH=true` disables auth and is for local debugging only.
- Bearer auth is preferred; query-token auth exists for mobile compatibility and Android WebSocket fallback.
- `BRIDGE_ALLOW_OUTSIDE_ROOT_CWD` defaults to permissive behavior unless explicitly disabled. Be careful when changing terminal/git cwd logic.
- Terminal execution and git mutation are high-risk surfaces. Any new execution endpoint needs explicit auth and scope review first.

## Common Pitfalls

- Two iOS trees exist. The active mobile app is under `apps/mobile/ios`, not repo-root `ios/`.
- Real devices must use LAN/Tailscale bridge URLs, not localhost.
- `MainScreen.tsx` is very large; broad refactors there are risky.
- Internal release bumps can fail in GitHub Actions if `services/rust-bridge/Cargo.lock` still references the previous `tethercode-bridge` version. When package versions change, verify `cargo check --locked` passes in `services/rust-bridge` before triggering the release workflow.
- Android cleartext bridge access is intentionally enabled by the Expo config plugin for local/private HTTP development.
- Worklets/Reanimated issues are usually cache/install problems, not missing config. `babel.config.js` already includes the required plugin.
- If setup, auth, Expo startup, QR/networking, or interrupt behavior breaks, use `docs/troubleshooting.md` instead of reinventing recovery steps.

## When To Update Docs

Update the relevant docs when changing these areas:

- Setup, env flow, bridge start, or verification:
  - `docs/setup-and-operations.md`
- Runtime recovery steps:
  - `docs/troubleshooting.md`
- Realtime/replay behavior:
  - `docs/realtime-streaming-limitations.md`
- EAS/native build or store release flow:
  - `docs/eas-builds.md`
- Legal/license obligations:
  - `docs/open-source-license-requirements.md`
  - `docs/privacy-policy.md`
  - `docs/terms-of-service.md`

Keep `AGENTS.md` as the repo-wide orientation layer. Keep detailed procedures in `docs/`.
