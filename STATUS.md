# Project Status

Last reviewed: July 20, 2026

## Maintained Runtime

```text
Native desktop shell -> Rust operator -> authenticated Rust bridge -> installed ACP agent
                                      ^
Expo mobile app -> authenticated private-network WebSocket/HTTP
```

- macOS shell: `apps/desktop/macos/TetherCodeApp.swift` using SwiftUI/AppKit
- Operator CLI: Rust `tethercode` binary under `apps/desktop`
- Bridge: `services/rust-bridge`
- Mobile: `apps/mobile`

The desktop app bundles the Rust operator and bridge. The bridge is not published through npm and
there is no JavaScript operator. Setup registers and hashes an ACP executable already installed by
the user.

The mobile app supports reconnect/replay recovery, approvals, user input, push notifications, Git,
constrained terminal operations, attachments, and browser preview. Host bridge lifecycle is local
to the desktop operator and is not exposed as a mobile update/restart RPC.

## Styling

The macOS app uses standard OS controls and inherits styling/materials from SwiftUI/AppKit on the
installed OS, including Liquid Glass where provided by macOS. Windows requires a future native WinUI
shell to inherit Mica and later Windows styling.

## Security Boundary

Keep the authenticated bridge on a private LAN, VPN, or Tailscale network. Generic terminal
execution is deny-all unless explicit argument-aware policies are configured.

## Trackers

- [Setup and operations](docs/setup-and-operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Realtime limitations](docs/realtime-streaming-limitations.md)
