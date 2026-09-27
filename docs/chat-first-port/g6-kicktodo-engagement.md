# KickTodo Engagement (unit G6) — chat-first port review

**Scope:** `backend/typescript/src/features/kicktodo-engagement` + `frontend/react/src/features/kicktodo-engagement` (ADR 0425 — opt-in leaderboard, deterministic awards, variant-effectiveness reads). Single-feature mode.

**Headline:** This feature is almost entirely legitimate page-shaped read/consent surface with no chat-first port owed — but it carries two dead capabilities the ADR claims are shipped: an orphaned workflow read-node (`engagement-summary`) that no run or agent ever ignites, and a consumerless `/effectiveness` REST endpoint that no page, node, client, or agent reads. Neither is a bespoke-chat substitution; both are THEATER (declared capability, no execution/read path).

---

## Contract scouting (file:line evidence)

**What is declared:**
- Feature package declares NO agent and NO workflow of its own. It registers only REST routes + a check-in observer + a read surface (`feature.ts:15-31`). `requiredPacks: feature.kicktodo.nodes@1.21.0` (`feature.ts:30`).
- One workflow read-node is declared for this feature in the shared kicktodo node pack: `feature.kicktodo.nodes.engagement-summary`, `role:"read"` (`packs/feature.kicktodo.nodes/pack.json:198-206`; body `packs/feature.kicktodo.nodes/index.mjs:316-329`), reached via `ctx.features['kicktodo-engagement']` (`index.mjs:305-313`), which is the read-only surface `buildKicktodoEngagementSurface` (`surface.ts:10-16`).
- Six REST routes: `opt-in` GET/POST, `opt-out` POST, `leaderboard` GET, `awards` GET, `effectiveness` GET (`routes.ts:36-99`).

**What actually creates runs / ignites the declared orchestration:**
- **Nothing runs `engagement-summary`.** Repo-wide grep for `engagement-summary` / `engagementSummary` outside the pack's own `index.mjs`/`pack.json` returns zero hits — no `builtinWorkflows.ts`, no workflow JSON, no other node references it. It is an orphaned node (Ignition test fail).
- The node is a `role:"read"` node and appears in NO agent `toolAllowlist`. The kicktodo agents (`packs/feature.kicktodo.agents/pack.json`) allowlist only `openwop:kicktodo.today/progress/circles/candidates/factory.run` — none is an engagement/leaderboard tool. So the cross-cutting "node typeId in an allowlist gets dropped at dispatch" pattern does **not** bite here (the node is never even offered), but the node is dead either way.

**Agent tool allowlists vs what the tools can do:**
- The feature registers **no** `registerFeatureAgentTool` (grep clean across `kicktodo-engagement`). Leaderboard/awards/effectiveness are invisible to the ONE chat. No toothless-persona problem because there is no persona — but also no chat expression at all for the "how am I doing / who's ahead" ask that is naturally conversational.

**Owners instantiated vs shadowed (RIDES grep):**
- Check-in signal: RIDES `registerCheckInObserver(onCheckIn)` (`feature.ts:17`, `engagementService.ts:219-222`) — core notifies, engagement derives; never writes core rows (Boundaries audit in ADR 0425 confirmed).
- Subject erasure: RIDES the single owner `registerSubjectEraser(eraseEngagementSubject)` (`engagementService.ts:249-257`).
- Variant bucketing: RIDES `resolveOne('kicktodo-engagement', …)` — the existing toggle-variant system, no stored assignment row (`routes.ts:92-96`, `engagementService.ts:227-240`).
- No shared "leaderboard/awards/consent" platform owner exists to shadow — these are genuinely new domain rows, so there is **no PARALLEL architecture here.**

**Executor/chassis constraints bounding a port:** none needed — nothing here suspends/resumes, no child-run gate visibility, no canvas trait. The two read surfaces are pure projections.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Join leaderboard (opt-in + display name) | `StateCard` form → POST `/opt-in` (`EngagementPage.tsx:97-116`, `routes.ts:46-53`) | **PAGE-LEGIT** | Keep; consent action, honest disclosure copy, no shared owner to ride |
| Leave leaderboard (opt-out, immediate) | ghost button → POST `/opt-out` (`EngagementPage.tsx:122`, `routes.ts:54-62`) | **PAGE-LEGIT** | Keep; immediate filtered-on-read revocation |
| View standings (closed k≥3 projection) | ordered list, `getLeaderboard()` (`EngagementPage.tsx:118-138`, `engagementService.ts:127-148`) | **PAGE-LEGIT** | Keep; read-only, honesty loop closes, below-floor stated plainly |
| View my awards | chips, `getAwards()` (`EngagementPage.tsx:143-158`, `engagementService.ts:213-215`) | **PAGE-LEGIT** | Keep; read-only, designed empty state (KTUX-5) |
| Earn awards (auto-derive on check-in) | `onCheckIn`→`evaluateAwards`, deterministic ids (`engagementService.ts:176-222`) | **RIDES** | Leave; idempotent, rides `registerCheckInObserver` |
| DSAR erasure of engagement rows | `eraseEngagementSubject` (`engagementService.ts:249-257`) | **RIDES** | Leave; single subjectErasure owner, tenant-scoped |
| Read leaderboard/awards from a workflow | `engagement-summary` node + `ctx.features` surface (`index.mjs:316-329`, `surface.ts:10-16`) | **THEATER** | Orphaned read-node: zero igniter (no workflow, no agent allowlist). Ignite it OR delete node + surface |
| Accountability-effectiveness experiments | GET `/effectiveness` (`routes.ts:84-98`, `engagementService.ts:227-240`) | **THEATER** | Consumerless endpoint: no client, no page, no node, no agent. Build the operator read OR stop claiming it |

**VERDICTS: R=2 A=0 P=0 T=2 PL=4**

---

## Port tests (per non-trivial capability)

- **engagement-summary node (THEATER):** Ignition test FAIL — no `startWorkflowRun` path, no builtin workflow, no agent `toolAllowlist` entry reaches it (grep-confirmed). Composition test N/A (it is a read node, no parallel-engine logic). Honesty-loop FAIL against ADR 0425 P5 which records it as "landed" — it is landed as dead code. It is a `role:"read"` node, so the "allowlisted node typeId silently dropped at dispatch" trap does not apply (it is never offered); the failure is simpler — nothing consumes it.
- **/effectiveness (THEATER):** Honesty-loop test FAIL — ADR 0425 headline claims "accountability-effectiveness experiments" as a shipped P3 capability, but no surface reads it: `grep effectiveness frontend/react/src` is empty; no client function exists in `kicktodoEngagementClient.ts` (it exposes only optIn/leave/leaderboard/awards). An operator cannot see variant effectiveness anywhere. Authority-parity is fine (gated + tenant-scoped) but it gates a door to an empty room.
- **Leaderboard / awards / opt-in (PAGE-LEGIT):** Interface test → reading/consent, correctly page-shaped. Honesty-loop passes — every displayed state (`belowFloor`, `you`, counts, "No awards yet") has a real read behind it (`engagementService.ts:127-148,213-215`). Lifecycle test passes — deterministic tenant-scoped keys (`::` composite, `engagementService.ts:37,49,64`), erasure covers all three stores, retention deliberately omitted with a stated reason (`engagementService.ts:259-264`).
- **Award derivation (RIDES):** Lifecycle/idempotency pass — deterministic `awardId = kind::enrollmentId` (`engagementService.ts:55,187-191`), re-evaluation never duplicates; timezone-correct streak bucketing (ENG-1 fix, `engagementService.ts:154-172`).
- **Card-mechanism test:** N/A — nothing renders in chat; no card is produced. (If the deferred chat read below is built, the answer is a **typed registered renderer** for the standings/awards summary — app-known shape, i18n-critical, trusted producer — not A2UI.)

---

## Blockers (from scouting) — each with the honest alternative

1. **There is no leaderboard/awards platform owner to "ride."** These are net-new domain rows; the correct pattern is exactly what shipped (own the rows, ride the check-in observer + subjectErasure + toggle-variant owners). *Alternative if a chat read is wanted:* do NOT invent a chat-owned leaderboard — expose a read tool + typed renderer over the SAME `engagementService` reads (below).
2. **`engagement-summary` node cannot be ignited without a consumer that does not exist.** *Honest alternative:* either (a) delete the node + `surface.ts` + the pack's `ensureEngagement`/`engagementSummary` (~15 lines) and drop the P5 claim, or (b) give it a real igniter — register `openwop:kicktodo.engagement` as a read tool via `registerFeatureAgentTool` (sharing the `/leaderboard` route's opt-in predicate, failing EMPTY without an acting user) so KickBot can answer "how am I doing / who's ahead" from the ONE chat. Option (b) is the only path that turns a dead node into a chat-first capability; option (a) is the honest minimum.
3. **`/effectiveness` is an operator analytics capability with no operator surface.** *Honest alternative:* either build the missing operator read (a small PAGE-LEGIT admin projection under the KickTodo settings/analytics surface, counts-only, gated) OR delete the route + `effectivenessByVariant` and strike the P3 "experiments" claim from the ADR. Do not leave a gated endpoint standing in for a shipped feature.

---

## Demolition list (with regression pins)

- **If not igniting them:** delete `engagement-summary` node (`packs/feature.kicktodo.nodes/index.mjs:303-329`), `ensureEngagement`, `surface.ts`, the `surface:` line (`feature.ts:31`), and the `/effectiveness` route + `effectivenessByVariant` (`routes.ts:84-98`, `engagementService.ts:227-240`). **Regression pin:** a pack-parity test asserting every node typeId in `feature.kicktodo.nodes/pack.json` is referenced by at least one workflow OR agent allowlist (a resurrected orphan fails); a route-inventory test asserting every `KICKTODO_ENGAGEMENT_ROUTES` path has a client consumer or an explicit `@operator-only` allowlist entry.
- **Nothing else is bespoke.** The join form, standings list, and awards chips are PAGE-LEGIT read/consent surfaces built on the shared `ui/` primitives (`StateCard`/`Notice`/`TextField`/`.surface-card`/`.chip`) — keep them; there is no chat surface to demolish.

---

## New-code inventory (SMALL — only if pursuing the chat-first option 2b)

- ONE read tool `openwop:kicktodo.engagement` via `registerFeatureAgentTool`, sharing the `/leaderboard`+`/awards` opt-in predicate (one helper, route + tool both call it; fails EMPTY without acting user).
- Add that tool id to KickBot's/`plan-builder`'s pack allowlist (never silently to the ADR 0315 baseline).
- ONE typed registered chat renderer for the standings/awards summary (i18n ×4), reusing the existing `LeaderboardView`/`KicktodoAward` shapes.
- No new rows, no new workflow, no new envelope kind, no RFC (host-extension read only).

## Phased plan (gated on real gates)

- **P1 (compliance/honesty first):** decide ignite-vs-delete per blocker 2 and 3. If delete: remove dead node/surface/route, add the two regression pins, correct ADR 0425 P3/P5 records with an inline correction note. Close with `/code-review`.
- **P2 (only if igniting):** register the read tool + typed renderer, allowlist it, add promptCatalogParity + agent-prompt-tool-ids coverage. Close with `/code-review` + `/ux-review`, fixes applied.
- Never demolish before the replacement (if any) works; the delete path has no replacement, so its pins ship with it.

## Deferred honestly

- **Conversational "how am I doing / who's ahead" from the ONE chat** is currently unbuilt (no engagement read tool). This is a real gap, deferred visibly — it is NOT faked today (chat simply has no engagement read), so there is no painted-green surface to unwind; it is a clean add if prioritized.
- **Operator effectiveness reporting** is deferred/unbuilt behind a live-but-consumerless endpoint — the ONE dishonest surface in the unit; must be either built or removed, not left standing.
