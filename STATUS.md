# Project Status

Last reviewed: July 18, 2026

## Current Runtime

The maintained product path is:

```text
Expo mobile app -> authenticated private-network WebSocket/HTTP -> Rust bridge -> installed ACP agents
```

- Mobile: `apps/mobile`
- Bridge: `services/rust-bridge`
- Operator CLI and launch automation: `bin/clawdex.js` and `scripts/`

The Rust bridge starts installed ACP agents from a validated local manifest and exposes their negotiated capabilities. The mobile app includes reconnect and
replay recovery, approvals and user input, push notifications, Git and constrained terminal
surfaces, attachments, browser preview, and bridge maintenance. CI validates the mobile workspace,
the Rust bridge, focused ACP integration behavior, release policy, and cross-language RPC fixtures.

## Security Boundary

The bridge controls sensitive host operations and is private-network software. Keep it on a private
LAN, VPN, or private overlay, require `BRIDGE_AUTH_TOKEN`, and do not expose it directly to the
public internet. Generic terminal execution is deny-all unless explicit argument-aware policies are
configured.

## Current Trackers

- Active engineering work: `docs/engineering-improvement-checklist.md`
- Realtime constraints: `docs/realtime-streaming-limitations.md`
- Setup and verification: `docs/setup-and-operations.md`
- Troubleshooting: `docs/troubleshooting.md`

Historical plans under `docs/plans/` and versioned release notes are retained as historical records,
not current architecture or operating policy.
