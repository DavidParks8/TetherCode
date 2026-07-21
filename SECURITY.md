# Security Policy

## Supported Scope

`tethercode` is intended for trusted/private networks only.
It is not designed to be exposed directly to the public internet.

Security reports are especially valuable for:

- bridge authentication and authorization issues
- terminal execution or git mutation bypasses
- attachment or local file exposure
- token leakage
- cross-origin or preview-shell vulnerabilities
- unsafe defaults that could expose a private bridge externally

## Reporting a Vulnerability

Please do not file public GitHub issues for security-sensitive reports.

Instead:

1. Use the repository's GitHub private vulnerability reporting form.
2. Include a clear summary, impact, reproduction steps, affected versions, and any suggested
   mitigation.

We will acknowledge the report as soon as practical and work toward a fix and coordinated disclosure.

## Security Notes for Users

- Prefer bearer-token auth.
- Prefer a short-lived random bearer token even for local debugging.
- `BRIDGE_ALLOW_INSECURE_NO_AUTH=true` is restricted to literal loopback listeners. No-auth browser access to RPC, status, and local images accepts only the listener origin or exact `BRIDGE_NO_AUTH_ALLOWED_ORIGINS`; origin-less native/operator clients remain supported.
- Never allow wildcard or `null` browser origins.
- Do not expose the bridge directly to the public internet.
- Desktop setup registers an ACP executable already installed by the user. It canonicalizes and hashes the executable before atomically writing `.tethercode/agents.json`; it never resolves or executes npm, npx, uvx, shell installer, registry, or floating package sources.
- Treat `.tethercode/` as local executable state, not source data. It is ignored by Git. Rerun setup after moving or upgrading an agent so its canonical path and SHA-256 digest are refreshed.
- ACP agent processes do not inherit the bridge environment. Runtime clears the child environment, restores only `PATH`, `HOME`, `TMPDIR`, and `LANG` as a safe baseline, then applies validated manifest entries. Host references are limited to `CODEX_PATH`, `HOME`, `PATH`, and `XDG_CONFIG_HOME`. `BRIDGE_AUTH_TOKEN`, `EXPO_ACCESS_TOKEN`, and names matching token, key, secret, or password patterns are denied even as literals. Agent authentication has no broad default exception and requires a narrowly approved policy change.
- Private Rust metadata writes set mode `0600` before publication, sync the temporary file, atomically rename relative to an open no-follow parent descriptor on Unix/macOS, and sync the parent directory before reporting success. Parent-sync failures propagate even when the replacement is already visible.
- Credentialed Git network operations run with a cleared environment and controlled credential helper, ignore system/global configuration, reject repository, worktree, and included proxy/TLS/helper/URL-rewrite overrides, and force TLS verification with HTTPS as the only allowed transport. Process-level Git/curl proxy, CA, and TLS override variables cause the operation to fail closed. Credentials are never included in command output.
- Local-image reads and attachment creation/finalization are descriptor-relative on Unix platforms. Every path component is opened without following symlinks beneath the retained `BRIDGE_WORKDIR` directory descriptor; image files must be regular, single-link files, and attachment staging plus atomic rename remain bound to retained directory descriptors with file and directory synchronization. These sensitive operations fail closed on unsupported non-Unix platforms.
- Review environment and runtime guidance in `docs/setup-and-operations.md` and `docs/troubleshooting.md`.
