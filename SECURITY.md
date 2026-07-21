# Security Policy

## Supported Scope

`clawdex-mobile` is intended for trusted/private networks only.
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

1. Use GitHub private vulnerability reporting if available for the repository.
2. If needed, email `mohitpatil973@gmail.com` with:
   - a clear summary
   - impact
   - reproduction steps
   - affected versions or commit range
   - any suggested mitigation

We will acknowledge the report as soon as practical and work toward a fix and coordinated disclosure.

## Security Notes for Users

- Prefer bearer-token auth.
- Prefer a short-lived random bearer token even for local debugging.
- `BRIDGE_ALLOW_INSECURE_NO_AUTH=true` is restricted to literal loopback listeners. No-auth browser access to RPC, status, and local images accepts only the listener origin or exact `BRIDGE_NO_AUTH_ALLOWED_ORIGINS`; origin-less native/operator clients remain supported.
- Never allow wildcard or `null` browser origins.
- Do not expose the bridge directly to the public internet.
- ACP registry access occurs only during setup. Redirects are bounded, loop-detected, credential-free HTTPS at every hop, and cannot downgrade to HTTP. Runtime consumes `.clawdex/agents.json` and local executables; do not configure runtime command resolution through `npx`, `uvx`, or floating package versions.
- Treat `.clawdex/` as local executable state, not source data. It is ignored by Git and excluded from the npm package. Installer cache records are untrusted. Registry-SHA-256 binary reuse requires recomputed registry fingerprints, executable hashes, and artifact evidence. Npm and uv resolution happens in isolated transaction staging before package code is installed. The installer requires a complete bounded plan with exact versions, credential-free HTTPS sources, and strong artifact hashes; persists and hashes that plan; then installs only with `npm ci` or `uv pip sync --require-hashes`. A plan rewrite, missing hash, mutable VCS/path/workspace source, insecure URL, identity mismatch, or untrusted npm lifecycle script fails closed. Cache reuse revalidates the plan, installed metadata, and the complete bounded `clawdex-tree-v1` receipt, with only the self-referential `.clawdex-install.json` cache record excluded. Rust recomputes the same tree immediately before spawn. Uv installs additionally verify all integrity-bearing `RECORD` artifacts. Unsigned binaries require explicit trust on every setup. Mismatches reinstall through locked unique staging and atomic replacement; lifecycle scripts remain disabled unless explicitly trusted.
- The current ACP registry distribution schema supplies exact top-level npm/uv versions but no transitive lock, lock digest, artifact hash set, or expected installation-tree digest. Therefore two clean installs resolved at different times can authenticate different transitive plans if upstream package metadata changed. Each successfully published installation is frozen, digest-identified, auditable, and runtime-verified, but this is not cross-time reproducibility and is not a cryptographic claim beyond the registry input, generated plan, package-manager integrity metadata, and resulting local tree receipt.
- ACP agent processes do not inherit the bridge environment. Runtime clears the child environment, restores only `PATH`, `HOME`, `TMPDIR`, and `LANG` as a safe baseline, then applies validated manifest entries. Host references are limited to `CODEX_PATH`, `HOME`, `PATH`, and `XDG_CONFIG_HOME`. `BRIDGE_AUTH_TOKEN`, `EXPO_ACCESS_TOKEN`, and names matching token, key, secret, or password patterns are denied even as literals. Agent authentication has no broad default exception and requires a narrowly approved policy change.
- Installer recovery treats journal paths as assertions, not authority. It validates a bounded transaction ID, derives staging and backup roots beneath the canonical `.clawdex` install root, requires exact entry paths and real non-symlink roots, and quarantines malformed journals. Recursive cleanup is limited to those derived transaction directories. Publication rejects transaction roots on different filesystem device IDs. Before mutation, a restrictive-mode atomic journal is file- and parent-synced in prepared state. Every backup and publish rename syncs its affected parent directories; manifest and provenance publication are durable before commit; committed journal state is durably recorded before cleanup; and every cleanup or journal removal is followed by a parent sync. Prepared transactions roll back and committed transactions finish cleanup idempotently after interruption. Fsync failures fail closed and are not reported as success after a merely visible rename. macOS directory fsync is required; only documented unsupported Windows directory-handle errors are ignored.
- Private Rust metadata writes set mode `0600` before publication, sync the temporary file, atomically rename relative to an open no-follow parent descriptor on Unix/macOS, and sync the parent directory before reporting success. Parent-sync failures propagate even when the replacement is already visible.
- Prefer registry binaries with SHA-256 digests. Unsigned binaries and npm lifecycle scripts require explicit trust flags and should be reviewed before installation.
- `--registry-url` is for tests or controlled administration only and must remain credential-free HTTPS.
- Credentialed Git network operations run with a cleared environment and controlled credential helper, ignore system/global configuration, reject repository, worktree, and included proxy/TLS/helper/URL-rewrite overrides, and force TLS verification with HTTPS as the only allowed transport. Process-level Git/curl proxy, CA, and TLS override variables cause the operation to fail closed. Credentials are never included in command output.
- Local-image reads and attachment creation/finalization are descriptor-relative on Unix platforms. Every path component is opened without following symlinks beneath the retained `BRIDGE_WORKDIR` directory descriptor; image files must be regular, single-link files, and attachment staging plus atomic rename remain bound to retained directory descriptors with file and directory synchronization. These sensitive operations fail closed on unsupported non-Unix platforms.
- Review environment and runtime guidance in `docs/setup-and-operations.md` and `docs/troubleshooting.md`.
