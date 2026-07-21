# TetherCode

TetherCode lets you monitor and control ACP-compatible coding agents from an Expo mobile app. A
self-hosted Rust bridge runs beside your repositories and carries chat, approval, terminal, Git,
attachment, and browser-preview traffic over a private LAN, VPN, or Tailscale connection.

The bridge is designed for trusted private networks. Keep authentication enabled and never expose
it directly to the public internet.

## Repository Layout

- `apps/mobile`: Expo and React Native client
- `services/rust-bridge`: Axum bridge and ACP process manager
- `bin/tethercode.js`: operator CLI
- `scripts`: setup, runtime, contract, version, and release automation
- `contracts`: versioned bridge RPC fixtures

## Develop From Source

Requirements:

- Node.js 22.13 or newer
- npm 10 or newer
- Rust 1.97.1
- Git

```bash
npm ci
npm run setup:wizard
npm run mobile
```

The setup wizard installs exact ACP agent distributions beneath `.tethercode/agents`, writes
`.tethercode/agents.json`, and starts the authenticated bridge unless `--no-start` is supplied.
The mobile app then connects with the printed URL, token, or pairing QR code.

Use a real LAN or Tailscale address when connecting a physical device. `localhost` refers to the
phone itself, not the bridge host.

## Operator Commands

After the `tethercode` package is published, the packaged bridge can be installed globally:

```bash
npm install -g tethercode
tethercode init
tethercode stop
```

Source-checkout equivalents:

```bash
npm run setup:wizard
npm run secure:bridge
npm run stack:lan
npm run stack:tailscale
npm run stop:services
```

## Quality Gates

```bash
npm run lint
npm run typecheck
npm run build
npm run test
npm run coverage:check
npm run coverage:rust
```

GitHub Actions runs repository policy and contract validation, mobile lint/typecheck/tests/coverage
plus an Expo export, and Rust formatting/checks/clippy/tests/coverage. npm and EAS distribution are
separate protected workflows and never run automatically from pull requests.

## Distribution Status

TetherCode uses new package, bundle, protocol, and local-storage identities. Expo, Apple, Google,
Firebase, npm trusted publishing, and store credentials must be connected to accounts owned by
this project before the first distribution. The app contains no payment SDK, tip jar, subscription,
or predecessor payment configuration.

See [EAS builds](docs/eas-builds.md) and
[open-source obligations](docs/open-source-license-requirements.md) before publishing mobile builds.

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

TetherCode is distributed under the [MIT License](LICENSE). The license retains required upstream
copyright attribution.
