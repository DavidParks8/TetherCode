# macOS Desktop App

This is the Mac-only replacement path for asking users to operate the `clawdex` npm package directly.

The product shape is:

- a native SwiftUI menu-bar app named Clawdex
- a bundled `codex-rust-bridge` binary in `Clawdex.app/Contents/Resources`
- first-run setup for work folder, phone-reachable host, port, token, and mobile defaults
- a Settings window for connection, enabled engines, approval mode, transcript visibility, appearance, and advanced pairing options
- menu-bar status for bridge health, connected phone clients, and the pairing QR
- no public internet exposure; the bridge remains private-network software

## Runtime Model

The desktop app owns the bridge process. It launches the Rust bridge with the same environment contract used by the npm package today:

- `BRIDGE_HOST`
- `BRIDGE_PORT`
- `BRIDGE_CONNECT_URL`
- `BRIDGE_AUTH_TOKEN`
- `BRIDGE_ALLOW_QUERY_TOKEN_AUTH`
- `BRIDGE_WORKDIR`
- `BRIDGE_ACTIVE_ENGINE`
- `BRIDGE_ENABLED_ENGINES`

The Settings window persists the same connection details shown in the menu bar. Engine changes are passed to the bridge on the next start through `BRIDGE_ACTIVE_ENGINE` and `BRIDGE_ENABLED_ENGINES`; mobile-facing defaults are also included in the pairing QR payload so the phone can consume them during pairing.

The npm package stays useful for source checkout development and non-Mac operators, but Mac users should eventually install the desktop app and pair their phone from the menu bar.

## Status Contract

The bridge exposes an authenticated `GET /status` endpoint and matching `bridge/status/read` RPC. Alongside connection and engine lifecycle state, the response includes a bounded `operational` snapshot documented in `docs/setup-and-operations.md`.

```json
{
  "status": "ok",
  "at": "2026-05-14T00:00:00Z",
  "uptimeSec": 12,
  "connectedClients": 1,
  "devices": [
    {
      "clientId": 1,
      "clientType": "unknown",
      "clientName": "Unknown device",
      "connectedAt": "2026-05-14T00:00:00Z",
      "lastSeenAt": "2026-05-14T00:00:01Z"
    }
  ]
}
```

Mobile can later pass `clientType=mobile&clientName=<device>` when opening `/rpc` so the menu bar shows friendly device names instead of generic clients.

## Build

Development run:

```sh
npm run desktop:mac
```

App bundle:

```sh
npm run desktop:mac:bundle
```

The bundle script builds the Rust bridge in release mode, builds the SwiftUI app, and writes `dist/macos/Clawdex.app`.

Sign the app bundle:

```sh
npm run desktop:mac:sign
```

The signing script signs the bundled Rust bridge first, then the Swift executable, then the outer `.app`. It prefers a `Developer ID Application` identity when one is installed and falls back to `Apple Development` for local testing. Public distribution needs a `Developer ID Application` certificate plus Apple notarization; an `Apple Development` signature validates locally but is not the final Gatekeeper-friendly release path.

Notarize and staple the app:

```sh
npm run desktop:mac:notarize
```

This expects a notary keychain profile named `clawdex-notary`. The script submits a ZIP to Apple, waits for acceptance, staples the ticket to `dist/macos/Clawdex.app`, verifies Gatekeeper acceptance, and writes `dist/macos/Clawdex-notarized.zip` for distribution.

## Next Slices

1. Add notarized `.dmg` distribution for the signed `.app`.
2. Add Launch at Login and a user-controlled auto-start switch.
3. Pass mobile device metadata during WebSocket connection.
4. Teach mobile onboarding to apply every optional pairing default.
5. Move network selection from raw host fields to Local Network and Tailscale choices.
6. Add update checks for both app and bundled bridge.
