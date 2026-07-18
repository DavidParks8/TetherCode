# Engineering Improvement Checklist

Last updated: July 18, 2026

## Purpose

This is the active burn-down list for reliability, security, protocol, runtime, and maintainability work. Each checkbox is intended to be owned by one agent in one focused change. Agents should update this file in the same commit as completed work and include tests unless the item explicitly says otherwise.

Historical plans under `docs/plans/` are not the source of truth for this work.

## Working Rules

- Do not add or preserve backward-compatibility paths unless a checklist item explicitly requires one. Prefer the current contract and remove legacy fallbacks in touched code.
- Keep Rust and mobile contracts synchronized when an RPC changes.
- Do not restart a running bridge during automated verification.
- Prefer integration coverage for transport, concurrency, lifecycle, and security boundaries.
- Do not combine unrelated checklist items in one change.
- Mark an item complete only after its listed acceptance criteria pass.

## Milestone 1: Protocol And Realtime Foundations

- [x] **1. Preserve structured RPC errors in mobile.** Add a typed mobile RPC error carrying `code`, `message`, `data`, and `method`; stop reducing bridge errors to strings; update compatibility checks to use structured fields; add transport and client tests. Acceptance: callers can distinguish unsupported parameters from transport/backend failures without message matching.
- [x] **2. Publish protocol identity and stream identity.** Add a protocol version and random bridge boot/stream ID to capabilities, connection state, replay responses, and replayable notifications; mirror the contract in mobile types. Acceptance: mobile can unambiguously detect bridge restart and incompatible protocol versions.
- [x] **3. Replace mobile replay with an ordered synchronization state machine.** Buffer live events during replay, merge by event ID, emit strictly increasing events, detect gaps, and trigger snapshot convergence after stream changes or replay truncation. Acceptance: randomized live/replay interleavings cannot regress event order or skip known gaps.
- [x] **4. Make WebSocket reconnect ownership deterministic.** Track and cancel reconnect timers, retry sockets that close before opening, pause connections while backgrounded, and reconnect/replay on foreground. Acceptance: tests cover pre-open failure, repeated backoff, disconnect cancellation, and foreground recovery.
- [x] **5. Add WebSocket resource limits.** Configure frame/message limits, per-client and global in-flight request limits, bounded pending requests, and explicit overload errors. Acceptance: oversized frames and request floods fail without unbounded task or memory growth.
- [x] **6. Generate or validate cross-language RPC contracts.** Establish one versioned schema source or checked contract fixtures for method names, request/response DTOs, notifications, and errors. Acceptance: CI detects incompatible Rust/TypeScript contract drift.

## Milestone 2: Backend Supervision And Thread Coordination

- [x] **7. Extract backend lifecycle supervision from `main.rs`.** Introduce a focused backend runtime module with `starting`, `ready`, `degraded`, `restarting`, and `dead` states, bounded restart backoff, and clean child teardown. Acceptance: fake-backend tests cover startup failure, runtime exit, restart, and shutdown without leaked processes.
- [x] **8. Add bridge-side app-server request deadlines and cancellation.** Time out forwarded requests, remove requests for disconnected clients, fail internal and external waiters on backend exit, and cap pending maps. Acceptance: no request can remain pending indefinitely.
- [x] **9. Make health and capabilities truthful under partial failure.** Report per-engine lifecycle, restart count, pending requests, and degradation; return healthy engines when an optional engine fails. Acceptance: `/health`, status, capabilities, and aggregate lists reflect backend death and recovery.
- [x] **10. Replace shared queue coordination with per-thread actors.** Give each thread one serialized owner for active turn, approvals, user input, queued messages, and dispatch. Acceptance: concurrent sends start exactly one turn and queue subsequent messages deterministically.
- [x] **11. Reconcile thread actors after lag and restart.** Validate completion turn IDs, recover state from snapshots after notification lag, bound queue size, and define queue persistence/restart behavior. Acceptance: stale completion or dropped notification cannot dispatch over an active turn.
- [x] **12. Split remaining Rust bridge domains into modules.** Extract auth/config, RPC routing/contracts, replay, live sync, push, preview, attachments, and health from `main.rs` without behavior changes. Acceptance: module boundaries have narrow interfaces and existing Rust checks pass.

## Milestone 3: Host Security And Resource Policy

- [x] **13. Centralize canonical path policy.** Canonicalize existing root and requested paths, reject symlink escapes, and apply one policy to terminal, Git, filesystem browsing, attachments, mentions, local images, and previews. Acceptance: cross-surface tests cover relative paths, absolute paths, symlink escapes, and outside-root configuration.
- [x] **14. Harden no-auth and browser access.** Refuse no-auth startup on non-loopback listeners, reject untrusted browser origins in no-auth mode, and document a short-lived local-token replacement path. Acceptance: drive-by browser and LAN access tests fail closed.
- [ ] **15. Replace terminal binary allowlisting with explicit execution policy.** Treat an empty configured allowlist as deny-all, disable generic execution by default or define command-specific argument policies, and account for commands such as Git that can launch helpers. Acceptance: configuration cannot accidentally turn a restrictive policy into unrestricted host execution.
- [ ] **16. Apply bounded storage and payload policies.** Limit attachment, image, Git diff, browser preview, queue, push registry, UI surface, and notification payload sizes; use collision-safe private files and atomic persistence. Acceptance: every externally supplied collection or payload has an enforced limit and useful truncation/error metadata.
- [ ] **17. Use secure preview credentials and exposure defaults.** Generate cryptographically random preview secrets, close replaced/stale sessions, enforce response limits before buffering, and separate preview bind exposure from the bridge bind. Acceptance: sessions are unpredictable, bounded, and cleaned up on replacement/unmount.

## Milestone 4: Mobile State And UX Reliability

- [ ] **18. Replace `App.tsx` settings handlers with one persisted app-state store.** Use a canonical reducer/store, versioned migrations, serialized/coalesced writes, typed persistence failures, and explicit bridge-profile switching. Acceptance: rapid unrelated setting changes cannot overwrite one another or complete out of order.
- [ ] **19. Make safe approval behavior the default.** Default fresh installs to normal approvals, require explicit confirmation for YOLO mode, preserve existing explicit choices through migration, and never weaken approval policy after arbitrary resume failure. Acceptance: transport/backend failures cannot alter security policy.
- [ ] **20. Decompose `MainScreen` into testable controllers.** Extract chat synchronization, turn execution, drafts, attachments, approvals/user input, agent threads, and transcript projection while keeping rendering declarative and behavior stable. Acceptance: each controller has focused tests and `MainScreen` no longer owns transport/persistence orchestration directly.
- [ ] **21. Make sends and approvals retry-safe.** Restore or retain drafts after failed sends, preserve attachments, make approval resolution awaitable/retryable, and prevent stale turn completion from resolving the wrong wait. Acceptance: transient failures do not lose user input or permanently disable actions.
- [ ] **22. Make push registration and actions profile-safe.** Retry failed registration, handle token rotation, include immutable bridge/profile identity in action payloads, deduplicate cold/live responses, and cancel deferred handlers. Acceptance: an action cannot resolve against the wrong bridge or run twice.
- [ ] **23. Bound and streamline mobile attachments.** Reject oversized files before base64 reads, resize/compress images, surface limits, and move toward chunked/file-based upload where supported. Acceptance: selecting a large file cannot cause an uncontrolled memory spike.
- [ ] **24. Complete an accessibility pass over core workflows.** Add labels, roles, selected/disabled/expanded states, modal focus/isolation, and live-region announcements to chat, sheets, approvals, Git, browser, onboarding, and settings. Acceptance: core workflows are operable and understandable with VoiceOver/TalkBack.

## Milestone 5: Operations, Release, And Observability

- [ ] **25. Make npm publishing single-owner and race-free.** Publish only from version tags or approved manual runs, use package/version-scoped concurrency, and protect the deployment environment. Acceptance: pushing a release commit and tag cannot launch competing publishes.
- [ ] **26. Repair source-checkout setup and runtime-root discovery.** Support Cargo builds from clean source checkouts and pass the actual workspace/config root explicitly to restart/update services. Acceptance: documented monorepo setup and published CLI setup both locate the correct `.env.secure`.
- [ ] **27. Make self-update restart and rollback real.** Relaunch through the canonical background/PID lifecycle, update state atomically, and restore the previous package when upgraded startup fails. Acceptance: failed update either returns to the known-good version or reports a stopped, recoverable state.
- [ ] **28. Add structured tracing and operational status.** Add request IDs, methods, durations, backend labels, redaction, bounded recent errors, live-sync counters, replay bounds, queue depth, push outcomes, and terminal saturation. Acceptance: operators can diagnose missing live updates and backend degradation without inspecting raw protocol content.
- [ ] **29. Align security and App Review documentation.** Replace the public-bridge review guidance with a secure review deployment model and reconcile push/API/runtime docs with current behavior. Acceptance: no current document recommends violating the private-network threat model.
- [ ] **30. Build a boundary-focused integration test suite.** Run real Axum transport against fake backends and cover auth, origins, reconnect/replay, backend death, concurrent queue sends, timeouts, path confinement, persistence, and cross-language fixtures. Acceptance: these tests run in CI and do not require a developer bridge restart.

## Completion Log

Record notable decisions or intentionally deferred acceptance criteria here when checking off work.

- Item 1: `RpcRequestError` now preserves JSON-RPC error identity. Compatibility retries require structured `-32602` invalid-params errors, and backend failures no longer trigger resume fallbacks or approval-policy changes.
- Item 2: Protocol version `1` and a random per-process `streamId` now identify capabilities, connections, replay responses, and notifications. Mobile resets event cursors on stream changes and rejects unsupported protocol versions.
- Item 3: Mobile now buffers live events during replay, emits numbered events only in contiguous order, replays live gaps, and emits `bridge/events/snapshotRequired` when stream changes or replay truncation require persisted-state convergence.
- Item 4: Mobile now owns exactly one reconnect timer, retries pre-open failures with bounded backoff, invalidates stale socket/replay callbacks, and suspends the WebSocket outside the active app lifecycle.
- Unscheduled reliability fix: Mobile now keeps a bounded, profile-scoped disk cache of recent chat snapshots. Cold launch renders the last selected transcript immediately and revalidates it in the background without surfacing transient startup RPC failures over usable cached content.
- Item 5: RPC and preview WebSockets now enforce 32 MiB frame/message limits. Client RPC admission is capped at 16 requests per socket and 128 globally; excess requests receive structured retryable `-32005` overload errors, and forwarded permits remain held until backend completion.
- Item 6: `contracts/bridge-rpc/v1/manifest.json` is the checked protocol inventory for bridge/mobile methods, notifications, errors, and representative envelopes. Node, Jest, Rust, and a dedicated CI job validate it.
- Item 7: Backend lifecycle state and bounded restart backoff now live in `backend_runtime.rs`. App-server and OpenCode startup failures explicitly terminate and await children, and runtime exit/shutdown transitions lifecycle state instead of leaking unmanaged processes.
- Item 8: Forwarded and internal app-server requests now have bridge-side 20-second deadlines. Disconnect removes that client's pending requests, backend exit fails both external/internal registries, and initialization cleans up waiters on write failure or timeout.
- Item 9: Health/status now report `ok`, `degraded`, or `unhealthy` with per-engine lifecycle, restart, pending-request, and error details. `/health` returns 503 only when no configured engine is ready; capabilities exclude non-ready engines and onboarding accepts degraded private bridges.
- Item 10: Each thread queue now has one mutex-backed actor owner. Send, steer, cancel, and automatic dispatch operations serialize through that owner, making occupancy inspection and turn reservation atomic per thread.
- Item 11: Queue actors validate completion turn IDs, reconcile authoritative execution/blocker state after notification lag, fail closed when reconciliation fails, and cap each thread at 100 queued messages. Queues survive backend replacement within one bridge process but are intentionally not persisted across a full bridge restart.
- Item 12: Rust bridge configuration/auth, RPC parsing and forwarding contracts, replay storage, rollout discovery policy, push registry/policy, preview session/discovery state, attachment persistence, and health DTO/aggregation now live in focused modules. Cross-domain transport orchestration remains in `main.rs`; the extracted modules expose only crate-local data and service interfaces.
- Item 13: `PathPolicy` canonicalizes the bridge root and existing host paths for terminal, Git, filesystem browsing, forwarded `cwd`, mentions, local images, and local-image previews. Confinement rejects symlink escapes unless outside-root access is configured; attachment directories remain root-owned regardless of that setting.
- Item 14: No-auth startup now requires a literal IPv4 or IPv6 loopback listener. RPC, status, and local-image reject malformed, `null`, duplicate, or cross-site browser origins with a stable `403 forbidden_origin`; origin-less clients, the listener origin, and explicitly configured exact origins remain allowed.
