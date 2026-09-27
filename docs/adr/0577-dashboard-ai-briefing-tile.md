# ADR 0577 — Dashboard AI briefing tile (the parked "AI on the surface" call)

Status: implemented (2026-08-15 — approved via the "proceed with all recommendations" directive; P1+P2 shipped, P3 = the human live-verify below. Open questions resolved as assumed: opt-in from the gallery, no auto-created conversations)

## Problem / opportunity

The dashboard round-2 matrix scored ClickUp the AI-dimension leader: its home
surface opens with an AI briefing (ClickUp Brain's home cards; Monday's AI
digest is the same pattern — cited in the R2 catalog; session research budget
exhausted, no fresh sweep). Our dashboard has 47 tiles and zero AI presence —
but the app's doctrine forbids the obvious copy: **no second chat surface, no
bespoke "ask AI" textarea** (CLAUDE.md single-chat rule; the AiAuthorPanel
removal is the precedent).

## Decision — a PROJECTION of a scheduled agent conversation, never a surface

The tile renders the latest assistant turn of a **scheduled agent chat**
(ADR 0125 scheduled-chats), read-only, with one action: **open the
conversation in the ONE chat** (`/?conversation=<id>` — the ADR 0058/0073
deep-link pattern). The differentiator over ClickUp/Monday falls out of the
architecture: their briefing is a dead-end card; ours IS a conversation — the
user opens it and asks the follow-up in place, with the agent's full context.

Mechanics:

- **Config = pick a conversation.** The tile's settings list the tenant's
  scheduled agent chats (or offer "create a Morning Briefing" from an agent
  pack template — persona + cadence pre-filled). No new backend model: the
  tile stores `{conversationId}` in the existing dashboard tile-config row.
- **Render = the conversation store's latest assistant message** (bounded
  excerpt, markdown, provenance chip naming the agent + the run time). A
  failed read is a failed-read state, never an empty briefing (the programme's
  standing family).
- **Refresh posture unchanged:** LazyMount + manual refresh only — the R2
  no-auto-refresh decision (47 tiles × auto-refresh vs the per-IP rate
  budget) binds this tile too; the CADENCE lives in scheduled-chats, where it
  already runs server-side.
- **States:** no scheduled chats ⇒ CTA to create from template (toggle-gated
  on `scheduled-chats` being enabled; if that feature is off, the tile says
  so honestly instead of hiding); conversation deleted ⇒ the tile names it and
  offers re-pick (no dangling projection).
- **Trust:** the excerpt is agent output — rendered through the same
  markdown/trust pipeline as the chat feed (no new renderer; the RFC 0021
  fencing posture is inherited, not re-implemented).

## Boundaries audit

- Chat surface: NONE added — the tile is read-only; input happens in the one
  chat via deep-link. (This is the whole design.)
- Scheduling: OWNED by scheduled-chats; the tile never schedules.
- Dashboard: the tile registers through the existing tile registry (ADR 0375
  personal-home model) — no core edits.

## Alternatives weighed

- **Inline mini-composer on the tile** (the ClickUp shape): rejected — the
  single-chat rule exists because this exact shape fragmented capabilities
  before (AiAuthorPanel).
- **A digest generated on tile load** (no scheduled chat): rejected — a live
  LLM call on dashboard load is replay-unsafe on a recorded path, costs per
  view, and duplicates the scheduler.

## Phased plan

P1 tile + config + projection + states (frontend, one tile module). P2 the
"Morning Briefing" agent-pack template (persona + example schedule). P3 live
verify (light/dark, the excerpt's markdown edge cases).

## Implementation record (2026-08-15)

- P1: `tiles/AiBriefingTile.tsx` (registered `ai-briefing`, category AI,
  opt-in `defaultEnabled:false`, `owningFeatureToggle:'scheduled-agent-chats'`);
  config = `{conversationId}` in a NEW self-scoped `dashboardbriefing` row
  (GET/PUT `/dashboard/briefing`, session-keyed, GDPR-erased) — a correction:
  the "existing tile-config row" this ADR assumed did not exist, so it was
  built on the personal-note precedent. States: unconfigured→picker/CTA,
  gone→re-pick, not-run-yet, failed-read (never an empty briefing), ready
  (provenance chip + `MessageRenderer` excerpt, CSS-bounded).
- P2 correction: scheduled-chat creation is CHAT-FIRST (the
  `openwop:tasks.schedule-recurring` agent tool; the client has no create
  function BY DESIGN), so the "Morning Briefing" CTA stages a composer draft
  and deep-links the ONE chat rather than shipping a bespoke create form or a
  new agent pack.
- Tests: `dashboard-briefing-route.test.ts` (5 — incl. SAME-TENANT two-user
  isolation, which a probe proved necessary: per-user tenants mask a broken
  subject key) + `aiBriefingTile.test.tsx` (6). Five sabotage probes each
  fired a named test.
- P3 (human live-verify, light+dark): the excerpt's markdown edge cases
  (tables/code fences inside the 14rem clamp), the picker with many scheduled
  chats, and the composer-seeded CTA flow end-to-end.

## RFC verdict

None — frontend projection over existing host stores.

## Open questions (for David) — the actual product call

1. Ship at all? (This ADR exists so the answer can be yes/no on a concrete
   design.)
2. Default-on for new workspaces with the template pre-created, or opt-in
   from the tile gallery? (Assumed: opt-in from the gallery; no auto-created
   conversations.)
