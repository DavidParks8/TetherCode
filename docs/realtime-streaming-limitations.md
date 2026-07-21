# Realtime Streaming Limitations And Mitigations

Last reviewed: July 19, 2026

## Current Architecture

1. The mobile app connects to the Rust bridge WebSocket at `/rpc`.
2. The Rust bridge starts installed agents from the validated local `ACP_AGENT_MANIFEST`.
3. `AgentManager` owns agent transports and session routing.
4. ACP session notifications become typed `CanonicalEvent` values.
5. The bridge projects canonical events into AG-UI envelopes and replayable control notifications.

The bridge does not discover remote agents at runtime. The Node installer validates the remote ACP
registry, installs exact agent distributions, and atomically writes the local manifest. Rust consumes
only that local manifest.

## Live Delivery And Replay

- Canonical ACP events are the internal authority for queue coordination, push delivery, and AG-UI
  projection.
- Outward WebSocket notifications receive monotonically increasing `eventId` values and are stored
  in a bounded replay buffer.
- `protocolVersion` and the per-process `streamId` let mobile distinguish a reconnect from a bridge
  restart.
- Mobile requests `bridge/events/replay` after reconnect, buffers concurrent live notifications,
  and emits numbered events in contiguous order.
- A stream change, replay eviction, or detected gap triggers ACP session snapshot convergence.
- Snapshot convergence is stream-wide: mobile freezes post-watermark delivery, expands its recovery
   set with `thread/loaded/list`, and refreshes every bridge-loaded or locally tracked thread plus
   queues, pending approvals, pending user inputs, and negotiated agent descriptors before it
   acknowledges the watermark. A failed refresh keeps the barrier in place and retries without a
   partial acknowledgement.

Historical threads that are neither loaded by the bridge nor tracked by mobile are not loaded only
because replay history was evicted. They have no live state in the current event stream and remain
available through the normal thread list and open-thread flow.

Replay is process-local. A full bridge restart creates a new stream and discards the old replay
buffer and in-memory message queues. Installed agent manifests and agent-owned durable sessions are
not deleted by that restart.

## Known Limits

1. Only events emitted by the ACP agent session owned by this bridge can be delivered live.
2. Work started through an unrelated agent process or client is not tailed from backend-specific
   files and is not synthesized into the canonical channel.
3. Slow or disconnected clients can miss live delivery after the bounded replay window is evicted;
   snapshot convergence restores durable session state, but transient deltas may no longer exist.
4. Queue state is intentionally in memory and does not survive a full bridge process restart.
5. Agent capabilities vary. Steering, session resume/load, permissions, and elicitations are exposed
   only when negotiated or supported by the selected agent.

## Operational Guidance

1. Start work through Clawdex when live mobile updates are required.
2. Use `bridge/events/replay` for reconnect gaps and treat `streamId` changes as snapshot boundaries.
3. Check `bridge/status/read` for agent lifecycle, negotiated capability, replay, queue, push, and
   request diagnostics.
4. Repair agent installation or the local manifest when an agent is unavailable; do not add a
   second backend-specific control plane to the Rust bridge.
5. Keep the bridge on a trusted private network with authentication enabled.

## Testing

- `npm run test:acp` covers fake ACP transports, session lifecycle, interactions, canonical events,
  steering, cancellation, and manager recovery.
- `npm run test -w apps/mobile` covers WebSocket replay ordering, stream changes, and snapshot
  convergence behavior.
- `npm run contract:check` validates the checked mobile/Rust bridge contract fixtures.
