# Contributing to TetherCode

Read [README.md](README.md), [setup and operations](docs/setup-and-operations.md), and
[troubleshooting](docs/troubleshooting.md) before starting.

## Project Shape

- `apps/mobile`: Expo React Native client
- `apps/desktop`: Rust operator and native platform shells
- `services/rust-bridge`: authenticated Rust bridge
- `scripts`: development and artifact automation

## Development

```bash
npm ci
npm run desktop:build:macos
npm run mobile
```

Useful focused commands:

```bash
npm run operator -- status --workspace "$PWD"
npm run desktop:test
npm run contract:check
npm run lint
npm run typecheck
npm run test
```

The repository pins Rust in `rust-toolchain.toml`.

## Guidelines

- Keep changes scoped.
- Never expose the bridge publicly.
- Mirror bridge contract changes across Rust, mobile, fixtures, tests, and docs.
- Keep bridge setup and lifecycle in Rust; do not add npm/Node/JavaScript operator fallbacks.
- Native shells should use OS controls and styling rather than hard-coded cross-platform themes.
- Do not edit generated paths such as `node_modules`, `.expo`, `target`, `dist`, or Pods.
- Update documentation when setup, runtime, platform, or distribution behavior changes.

Before a pull request, run the relevant quality gates and include screenshots for native UI changes.
Use private vulnerability reporting for security issues; see [SECURITY.md](SECURITY.md).
