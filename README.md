# TetherCode

TetherCode controls ACP-compatible coding agents from a phone. The desktop app owns an authenticated
Rust bridge beside your repositories; the Expo mobile app connects over a trusted LAN, VPN, or
Tailscale network.

The bridge is private-network software. Keep authentication enabled and never expose it directly to
the public internet.

## Product Layout

- `apps/desktop`: Rust `tethercode` operator plus the native macOS SwiftUI/AppKit shell
- `services/rust-bridge`: Axum bridge and ACP process manager
- `apps/mobile`: Expo and React Native client
- `contracts`: versioned bridge RPC fixtures
- `scripts`: development, contract, version, coverage, and app-bundle automation

There is no npm bridge package and no JavaScript operator CLI. npm is used only for the mobile and
repository development toolchain. The macOS app bundles both Rust executables:

```text
TetherCode.app
├── Contents/MacOS/TetherCode                  # native SwiftUI/AppKit shell
└── Contents/Resources/bin/
    ├── tethercode                             # Rust operator CLI
    └── tethercode-bridge                      # Rust bridge
```

## macOS App

Build and open the self-contained app:

```bash
npm ci
npm run desktop:build:macos
open apps/desktop/dist/TetherCode.app
```

The app provides native menu-bar lifecycle, first-time setup, bridge start/stop/restart,
authenticated status, pairing QR, logs, workspace selection, and launch-at-login.

The shell uses standard SwiftUI and AppKit controls, menus, forms, materials, panels, and SF
Symbols. It does not draw or freeze a custom theme. Appearance is inherited from the installed
macOS version, so changes such as Liquid Glass are supplied by the OS without a TetherCode update.
The equivalent guarantee on Windows will require a native WinUI shell so Mica and future Windows
styling come from Windows itself.

First-time setup registers an ACP executable already installed on the Mac, such as OpenCode. The
Rust operator hashes that executable and atomically writes `.tethercode/agents.json` and
`.env.secure`. It does not invoke npm, npx, Node.js, shell setup scripts, or floating package
resolution.

## Rust Operator

For direct terminal operation from a source checkout:

```bash
npm run operator -- discover-agent --agent-id opencode
npm run operator -- setup --workspace "$PWD" --network local --host 192.168.1.20 \
  --agent-id opencode --agent-args acp
npm run operator -- start --workspace "$PWD"
npm run operator -- status --workspace "$PWD" --human
npm run operator -- restart --workspace "$PWD"
npm run operator -- stop --workspace "$PWD"
```

The installed app's operator is at:

```text
TetherCode.app/Contents/Resources/bin/tethercode
```

The operator is the only bridge process-control authority. It serializes transitions with a
workspace lock and verifies PID, process start time, executable, workspace, and config identity
before signaling a process.

## Mobile Development

Requirements: Node.js 22.13+, npm 10+, Rust 1.97.1, and Git.

```bash
npm ci
npm run mobile
```

Use a LAN or Tailscale bridge address on physical devices. `localhost` on a phone refers to the
phone, not the Mac running the bridge.

## Quality Gates

```bash
npm run lint
npm run typecheck
npm run test
npm run contract:check
npm run coverage:check
npm run coverage:rust
npm run desktop:build:macos
```

GitHub Actions validates repository policy, RPC contracts, mobile quality/coverage, Rust bridge
quality/coverage, and a signed macOS app bundle. Mobile EAS distribution remains a separate
protected workflow. There is no npm publication workflow for the bridge.

## Documentation

- [Setup and operations](docs/setup-and-operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Realtime streaming limitations](docs/realtime-streaming-limitations.md)
- [Push notifications](docs/push-notifications.md)
- [Browser preview limitations](docs/browser-preview-limitations.md)
- [Privacy policy](docs/privacy-policy.md)
- [Terms of service](docs/terms-of-service.md)
- [Security policy](SECURITY.md)

## License

TetherCode is distributed under the [MIT License](LICENSE).
