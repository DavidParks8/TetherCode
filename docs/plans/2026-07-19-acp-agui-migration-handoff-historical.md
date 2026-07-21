# HISTORICAL / COMPLETED: ACP and AG-UI Runtime Migration Handoff

Completed and archived: July 19, 2026

This document records the completed ACP and AG-UI migration. It is historical context only, not a
kickoff prompt, implementation plan, operating guide, or source of truth. Do not use it to infer the
current architecture or supported agent set.

The migration replaced provider-specific runtime control paths with the Rust bridge's ACP session
runtime and normalized outward events through the canonical event and AG-UI projection layers. The
implemented runtime includes installed-agent manifest discovery, ACP process and session lifecycle,
long-lived prompt handling, typed notifications, interaction resolution, cancellation, steering,
replay, and snapshot convergence.

Current policy and architecture supersede every instruction from the original handoff:

- `AGENTS.md` defines repository ownership, active source paths, and required validation.
- `README.md` and `docs/setup-and-operations.md` define current setup and operation.
- `docs/realtime-streaming-limitations.md` defines the current ACP, canonical event, AG-UI, replay,
  and snapshot model.
- `docs/troubleshooting.md` defines current recovery procedures.
- `STATUS.md` records current project status.

The original handoff's statements that ACP was unimplemented, that no ACP modules existed, and that
Codex and OpenCode were future migration targets became false when the migration completed. Its
provider-removal checklist, dirty-worktree baseline, kickoff prompt, proposed module structure, and
intermediate test totals are intentionally not preserved as current instructions. Repository history
retains the detailed implementation-era text when archaeological context is needed.
