# Push Notifications

Clawdex can notify you on your phone when a top-level agent turn finishes or when
it needs an approval — even when the app is backgrounded or closed. Subagent
turn completions remain visible in the live UI but do not send push notifications.

## Why the bridge sends them

The mobile app can only run JavaScript (and therefore keep its bridge WebSocket
open) while it is foregrounded. The instant it is backgrounded or killed, the
socket closes, so the **phone can never observe a turn completing**. The bridge,
on the other hand, owns the ACP agent sessions and stays alive regardless of
whether any phone is connected. So the bridge is the sender:

```
ACP canonical event ──▶ bridge ──HTTPS POST──▶ Expo push service ──▶ APNs/FCM ──▶ phone
                         ▲
         (phone registered its Expo push token over the authenticated WS)
```

Waking a backgrounded/killed app is only possible through the OS push transports
(APNs on iOS, FCM on Android). Clawdex reaches them via the **Expo Push
Notification Service**. Pushes are deliberately bounded; notification text can
contain a short assistant reply preview or the bridge project folder name as
described below.

## What is sent

The request sent to Expo carries the device push token, visible notification
title/body, and a `data` object. The data object carries:

- the event type (`turn_completed` or `approval_requested`)
- an immutable notification, bridge profile, and device registration identity
- the thread id (in `data`, used for deep-linking when the notification is tapped)
- the approval id for approval requests

Visible notification text carries either:

- for completed turns, a **short preview of the agent's reply**: the last
  non-empty line, whitespace-collapsed and capped at 140 characters; or a generic
  completion message containing the bridge project folder name if no preview is available
- for approvals, a generic message containing the bridge project folder name

This means the Expo push token, routing/deep-link identifiers, project folder
name in generic text, and possibly a snippet of the agent's reply leave your
network via Expo and Apple/Google push infrastructure when notifications are
enabled. Full diffs, prompts, tool output, and the rest of the conversation are
not sent. Approval notifications never include reply content.

## Bridge side

- Push registration RPC methods (over the existing authenticated WS):
  - `bridge/push/register` `{ profileId, registrationId, token, platform, deviceName, events }`
  - `bridge/push/unregister` `{ profileId, registrationId }`
  - `bridge/push/list` → device list (tokens are masked to a short suffix)
- Registrations persist to `.clawdex-push-registry.json` in the bridge working
  directory (gitignored).
- A `PushService` subscribes to the canonical ACP event channel and, on final
  run completion or a permission request, POSTs to
  `https://exp.host/--/api/v2/push/send`. Tokens that Expo reports as
  `DeviceNotRegistered` are pruned automatically. Re-registering the same
  `registrationId` atomically replaces a rotated token; a registration cannot be
  rebound to another `profileId`.
- A top-level completion is also suppressed when the bridge queue immediately
  starts the next queued message. The completion push is sent only when that
  top-level thread reaches a final completion with no queued continuation.
- Optional: set `EXPO_ACCESS_TOKEN` in the bridge environment to send with an
  Expo access token (enhanced security / receipts).
- Expo delivery needs outbound HTTPS from the bridge. It does not require, and
  must not be used to justify, inbound public access to the bridge.

## Mobile side

- **Auto-registration:** notifications are on by default. On the first successful
  bridge connect (after onboarding/pairing), the app shows the OS permission
  dialog once and registers its Expo push token with the bridge — no Settings
  trip required. It re-registers on each connect (tokens rotate) and whenever the
  active bridge changes. Failed registration retries with bounded exponential
  backoff while that profile remains active.
- **Settings → Notifications** is the override: a master switch (opt out / back
  in) plus per-event switches (Turn finished, Approval needed). Opting out
  unregisters the token from the bridge.
- Preferences and per-profile registration identities persist in the canonical
  app-state store. `optedOut` records an explicit user opt-out.
- The shared registration logic lives in `src/pushController.ts`, used by both
  the auto path (`App.tsx`) and the Settings toggle so they cannot drift.
- **Foreground:** while the app is active the banner is suppressed (you are
  already watching, and the result also streams in over the WebSocket).
- **Backgrounded but not quit / killed:** the OS delivers and displays the push.
- Tapping a notification opens the app and navigates to the relevant thread.
- **Approval notifications carry Approve / Deny action buttons** (iOS notification
  category `approval`). The approval push includes the `approvalId`; tapping a
  button foregrounds the app and resolves that approval over the matching
  profile's authenticated bridge WebSocket (`bridge/approvals/resolve`).
  Identity-less, stale-profile, and duplicate cold/live action responses are
  rejected. Deferred timers/listeners are cancelled on profile change or unmount,
  and `resolutionId` makes a transport retry idempotent. The buttons foreground the app on
  purpose: resolving needs the WS, which only runs while the app is active, so a
  fully-background resolve isn't reliable for this transport. The in-app approval
  banner remains as a fallback if the action can't complete.

## Build requirements (standalone apps)

Expo Go handles push credentials for you during development. **Standalone /
store builds need platform credentials configured in EAS:**

- iOS: an APNs key (`eas credentials`, or let EAS manage it).
- Android: an FCM v1 service-account key uploaded to your Expo project.

Push tokens are not available on simulators/emulators — test on a physical
device. The `expo-notifications` config plugin is already declared in
`app.json`.
