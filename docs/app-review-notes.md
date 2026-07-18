# App Review Notes (Template)

Use this file as the source for App Store Connect "Notes for Review" and internal submission prep.

Related references:

- `docs/eas-builds.md`
- `docs/push-notifications.md`
- `docs/realtime-streaming-limitations.md`

## Submission Snapshot

- App name: Clawdex
- Version / build: [fill in]
- Date prepared: [fill in]
- Primary reviewer contact: [name + email + phone]
- Time zone for live support: [time zone]

## What The App Does

Clawdex is a companion app for a bridge running on infrastructure the user controls.
The iPhone and iPad app connects to that bridge and lets the user:

- Start new coding-agent runs and continue existing threads
- Monitor run progress and respond to clarifications
- Review approvals, Git status, and diffs
- Create Git commits on the connected host
- Execute explicitly enabled terminal commands on the connected host
- Attach files or images from the workspace or device

The app does not provide a public multi-tenant shell service.

## Secure Test Setup For Review

Provide a dedicated review bridge on an isolated private network. Do not expose the bridge, its
WebSocket, browser preview, status endpoint, or attachment endpoint directly to the public internet.
Do not use a public HTTP tunnel or reverse proxy as a substitute for private networking.

Recommended deployment:

1. Create a short-lived review-only network and sanitized workspace with no production source,
   credentials, personal conversations, or unrelated services.
2. Put the review bridge behind a standards-based VPN gateway, such as IKEv2, or a dedicated private
   overlay that Apple App Review can enroll in. The VPN gateway may accept internet connections; the
   bridge itself must have only a private address and a host/cloud firewall rule that accepts the
   bridge and preview ports from the review VPN subnet or interface only.
3. Require a random, review-only `BRIDGE_AUTH_TOKEN` in addition to VPN membership. Keep
   `BRIDGE_ALLOW_INSECURE_NO_AUTH=false`. Scope `BRIDGE_WORKDIR` to the sanitized workspace and leave
   terminal execution disabled unless a walkthrough step requires one safe policy.
4. Test the exact production build from a device that is not already on the operator's LAN: enroll
   through the reviewer VPN path, connect to the private bridge URL, and complete the walkthrough.
5. In App Store Connect review notes, provide the temporary VPN configuration/enrollment steps,
   VPN credentials, private bridge URL, bridge token, availability window, and a live support
   contact. Avoid dependencies on an employee account or production identity. If enrollment needs a
   profile or attachment that does not fit in review notes, coordinate delivery through App Review's
   secure attachment or Resolution Center flow.
6. Keep the isolated host and VPN available for the stated review window. Revoke VPN access, rotate
   the bridge token, and destroy or shut down the review environment when review is complete.

Self-host setup is not the primary reviewer path because it asks the reviewer to provision a host.
If App Review specifically requests it, provide these commands as a fallback:

```bash
npm install -g clawdex-mobile@latest
clawdex init
```

## Reviewer Walkthrough

1. Connect the review device to the supplied review VPN/private overlay.
2. Launch the app on iPhone or iPad.
3. On `Connect Your Bridge`, enter the supplied private bridge URL and bridge token.
4. Tap `Test Connection`, then continue.
5. Start a new run or open an existing review thread.
6. Send a prompt and confirm that a response is received.
7. Open the Git screen and verify status/diff rendering in the sanitized repository.
8. If prompted, review and approve or deny an action.
9. To attach an image, use the add action in the composer and choose a non-sensitive image from the
   device.

## Security And Privacy Notes For Review

- Bridge token authentication is required by default and is defense in depth, not a replacement for
  the private VPN/overlay boundary.
- Any remote execution occurs only on the isolated review infrastructure controlled by the review
  account owner.
- Generic terminal execution is deny-all by default and can only be enabled through argument-aware
  server policies; Git uses separate hardened bridge operations.
- In-app Privacy and Terms screens remain accessible from Settings.

## Push Notifications

- The review bridge sends pushes for final top-level turn completion and approval requests. The
  mobile WebSocket is intentionally suspended while the app is backgrounded, so the always-on bridge
  observes those runtime events and sends the push.
- Runtime triggers are `turn/completed` and `bridge/approval.requested`. Device registration uses
  authenticated RPC methods `bridge/push/register`, `bridge/push/unregister`, and `bridge/push/list`.
- Delivery path: review bridge -> Expo Push Notification Service -> APNs on iOS (or FCM on Android).
  Push delivery therefore requires outbound HTTPS from the bridge, but never inbound public access
  to the bridge.
- Expo receives the device push token, visible notification title/body, and data containing event
  type, notification ID, bridge profile ID, registration ID, thread ID, and approval ID when
  applicable. A completion body may contain the last non-empty assistant-reply line, collapsed and
  capped at 140 characters. An approval body, or a completion without a preview, contains the
  sanitized review project folder name. Prompts, code, diffs, and tool output are not sent.
- Notifications are controllable in Settings with a master opt-out and per-event toggles.
- Approval notifications include Approve/Deny actions. Selecting one foregrounds the app and resolves
  the approval through the matching profile's authenticated bridge WebSocket; it is not a
  background network mutation.
- To exercise notifications, send a sufficiently long run from the app and background it before
  completion. Use a review-only prompt whose possible reply preview is safe to send through push
  providers.

## App Privacy / Data Safety Answers

When notifications are enabled, declare the data that transits Expo and APNs/FCM:

- Other user content: an optional assistant reply preview of at most 140 characters and the review
  project folder name used in generic notification text.
- Device or other identifiers: the Expo push token plus notification, bridge-profile, device
  registration, thread, and approval identifiers used for routing, deep linking, and safe approval
  handling.
- Linked to identity: No, unless the submitter's separate configuration makes it so.
- Used for tracking: No.
- Purpose: App functionality (delivering notifications the user enabled).
- Optional: Yes; the user can opt out in Settings.

## Guideline Positioning Notes

- The app accesses user-controlled infrastructure rather than a shared cloud shell.
- The bridge and private-network dependency are disclosed during onboarding and in review notes.
- Reviewers receive temporary review credentials and do not need to create a product account.

## What To Provide In App Store Connect

- Privacy Policy URL: [required final URL]
- Support URL: [required final URL]
- Review VPN/overlay enrollment instructions: [temporary review access]
- Review VPN credentials or one-time enrollment: [temporary credentials]
- Private review bridge URL: [private VPN/overlay URL]
- Review bridge token: [short-lived token distinct from VPN credentials]
- Review environment availability window: [time range + time zone]
- Support contact reachable during review: [contact details]

## Open Source License Requirements

- Ensure release/app-review artifacts follow `docs/open-source-license-requirements.md`.
- Keep third-party notices available for review/legal requests.

## Final Pre-Submit Checklist

- [ ] Privacy Policy URL is live, matches the in-app link, and discloses push-provider transit.
- [ ] Support URL is live and matches the listing.
- [ ] The dedicated review VPN/overlay works from outside the operator LAN.
- [ ] Firewall verification confirms the bridge and preview ports are reachable only through the
  review VPN/overlay, not directly from the public internet.
- [ ] Review VPN credentials, private bridge URL, and short-lived bridge token work in the submitted
  App Store build.
- [ ] The review workspace and notification test content contain no production or personal data.
- [ ] Revocation/token-rotation and review-environment shutdown owners are assigned.
- [ ] Review notes in App Store Connect were refreshed for the current version.
- [ ] Build is attached to the App Store version.
- [ ] `asc validate` returns no blocking errors.
