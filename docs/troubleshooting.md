# Troubleshooting

## Desktop App Does Not Open

Verify the bundle and launch it directly:

```bash
codesign --verify --deep --strict apps/desktop/dist/TetherCode.app
open apps/desktop/dist/TetherCode.app
```

Local builds are ad-hoc signed. Downloaded public builds additionally require Apple notarization.

## Operator Is Unavailable

The native shell expects:

```text
TetherCode.app/Contents/Resources/bin/tethercode
TetherCode.app/Contents/Resources/bin/tethercode-bridge
```

Rebuild or reinstall the app if either file is missing. The app does not fall back to npm, Node.js,
or shell scripts.

## Agent Is Not Found

Use the native file picker or inspect discovery directly:

```bash
npm run operator -- discover-agent --agent-id opencode
```

Install the ACP-capable agent independently, then select its executable. TetherCode setup registers
and hashes an existing executable; it does not install packages.

## Tailscale Has No Address

Open Tailscale and confirm it is connected:

```bash
tailscale ip -4
```

Alternatively choose **Local network** and enter the Mac's LAN IPv4 address.

## Bridge Will Not Start

Inspect status and logs:

```bash
npm run operator -- status --workspace /path/to/repository --human
open /path/to/repository/.bridge.log
```

Common causes:

- the registered agent executable moved or changed after setup
- the configured host/port is already in use
- `.env.secure` or `.tethercode/agents.json` is missing or invalid
- Tailscale/LAN connectivity changed

Rerun setup after moving or upgrading an agent so its canonical path and SHA-256 digest are refreshed.

## Stop or Restart After Config Damage

The Rust operator verifies its private ownership record independently of current config. It can stop
a live owned bridge even when `.env.secure` is missing or corrupt:

```bash
npm run operator -- stop --workspace /path/to/repository
```

Repair setup before starting again.

## Phone Cannot Connect

- Use the bridge URL shown by the desktop app.
- Keep the Mac and phone on the same LAN/VPN or Tailscale network.
- Do not use `localhost` on a physical phone.
- Confirm the bearer token or scan the current pairing QR.
- Keep the bridge private; do not expose it on the public internet.

## Expo Cannot Find Secure Configuration

Configure the bridge through the desktop app or Rust operator first, then run:

```bash
npm run mobile
```

The Expo script reads `.env.secure` from the repository workspace.
