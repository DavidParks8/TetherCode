# Bridge UI Surfaces

Bridge UI surfaces are the stable way for the bridge to show new provider or harness details in the mobile app without adding provider-specific React Native screens.

Use this contract when an ACP agent adds a workflow concept, status object, or action prompt that can be represented with existing primitives. Examples include quota warnings, compaction notices, model-switch suggestions, background task status, and agent-specific warnings.

Do not send arbitrary HTML, JavaScript, React component names, or provider-native payloads to mobile. The bridge owns provider-specific translation. Mobile owns rendering these safe primitives.

## Notifications

The bridge broadcasts surfaces over the existing JSON-RPC notification stream:

- `bridge/ui.present`: show a new surface.
- `bridge/ui.update`: replace an existing surface with the same `id`.
- `bridge/ui.dismiss`: remove a surface.
- `bridge/ui.resolved`: emitted after mobile resolves an action.

Notifications are replayable through `bridge/events/replay` like other bridge notifications.

## Bridge RPC Methods

The bridge also exposes RPC helpers. These are useful for bridge-internal adapters, tests, and future provider integrations:

- `bridge/ui/present`
- `bridge/ui/update`
- `bridge/ui/dismiss`
- `bridge/ui/resolve`

`bridge/ui/present` and `bridge/ui/update` accept a full `BridgeUiSurface`. `bridge/ui/dismiss` accepts `{ "id": "...", "threadId": "..." }`. `bridge/ui/resolve` accepts `{ "id": "...", "threadId": "...", "turnId": "...", "actionId": "..." }`.

## Surface Schema

```ts
type BridgeUiSurface = {
  id: string;
  threadId: string;
  turnId?: string | null;
  kind?: string | null;
  presentation: 'workflowCard' | 'modal' | 'banner';
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle?: string | null;
  bodyMarkdown?: string | null;
  blocks?: BridgeUiBlock[];
  actions?: BridgeUiAction[];
  dismissible?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};
```

Supported block primitives:

```ts
type BridgeUiBlock =
  | { type: 'text'; text: string }
  | { type: 'markdown'; markdown: string }
  | {
      type: 'checklist';
      items: Array<{
        label: string;
        status?: 'pending' | 'inProgress' | 'completed';
        detail?: string;
      }>;
    }
  | {
      type: 'keyValue';
      items: Array<{ label: string; value: string }>;
    }
  | { type: 'code'; text: string; language?: string | null }
  | {
      type: 'progress';
      label: string;
      value: number;
      max: number;
      detail?: string | null;
    };
```

Supported actions:

```ts
type BridgeUiAction = {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
  dismissesSurface?: boolean;
};
```

## Presentation Guidance

- Use `workflowCard` for turn-scoped details that should sit near the existing plan card.
- Use `modal` for blocking or user-decision details.
- Use `banner` for compact warnings or status updates near the composer.
- Keep `title` short and user-facing.
- Put provider-specific raw data in `code` only when it helps the user act.
- Keep `kind` stable for semantic grouping, for example `goal`, `quota`, `compaction`, or `provider-warning`.

## Implemented ACP Plan Example

The Rust bridge maps an ACP `plan` session update into `CanonicalEvent::Plan`. The AG-UI projector emits that event as a `CUSTOM` event named `tethercode.dev/plan`, preserving the bridge thread and active run correlation when one exists. Mobile renders the entries with its existing plan surface; no agent-specific parser or component is required.

The projected AG-UI event shape is:

```json
{
  "type": "CUSTOM",
  "threadId": "v1.YWNwLWFnZW50.c2Vzc2lvbi0x",
  "runId": "v1.YWNwLWFnZW50.c2Vzc2lvbi0x::turn::7",
  "name": "tethercode.dev/plan",
  "value": {
    "entries": [
      {
        "content": "Implement the session index",
        "priority": "High",
        "status": "InProgress"
      }
    ]
  },
  "timestamp": 1784505600000
}
```

For a local smoke test of the generic renderer only, open a chat in the mobile app and run:

```bash
npm run bridge:ui:demo
```

That sends a sample workflow card to the latest chat. Use `npm run bridge:ui:demo -- --modal` or `npm run bridge:ui:demo -- --banner` to test the other presentations. Use `npm run bridge:ui:demo -- --thread <thread-id>` when the latest chat is not the one visible on the phone.

## Rules For Future Integrations

- Add provider-specific parsing in the bridge adapter, not in mobile UI.
- Map provider-specific terms into the stable block primitives above.
- Do not add new block types unless the existing primitives cannot represent the workflow.
- Keep action IDs stable because mobile sends them back through `bridge/ui/resolve`.
- Include `threadId`; the mobile app scopes surfaces to the active chat.
- Include `turnId` when the surface belongs to a specific turn.
