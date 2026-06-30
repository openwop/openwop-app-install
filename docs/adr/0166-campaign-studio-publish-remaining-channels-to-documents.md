# ADR 0166 — Campaign Studio: publish ad / creative / social channels as document handoffs

| Field | Value |
|---|---|
| **Status** | implemented (Phase 1, 2026-06-28) |
| **Date** | 2026-06-28 |
| **Feature(s)** | `campaign-channels` (ADR 0157) publish nodes over the `documents` (ADR 0033/0057) feature surface |
| **Depends on** | ADR 0162 (publish last-mile pattern + the `pickDraft`/`resolveOrgId` helpers), 0157 (channel generators), 0014 (`ctx.features` surface), 0058 (chat-drivability) |
| **RFC gate** | None — host work composing the existing `documents` surface + node packs. **No new RFC.** |

## Context

ADR 0162 wired two of the five channels to real, first-party entities: `landing_page` →
a draft CMS page, `email_sequence` → draft email campaigns. It explicitly left the other
three as a non-goal: *"no first-party 'live entity' target exists for them in-app yet."*
This ADR closes that gap **honestly**.

An evaluation of the source app (MyndHyve) confirmed the shape of the gap:

- **`ad_variants`** — MyndHyve has a *real* outbound ad-publishing subsystem (Meta / Google
  / TikTok, ~1,600 LOC of authenticated platform clients + OAuth refresh). openwop-app has
  **no outbound platform dispatch** — `campaign-connectors` (ADR 0159) is inbound-only and
  honest-off. Porting real ad dispatch is a large, credential-bearing, **RFC-gated** effort
  (a new outbound connector-reach capability) — deliberately out of scope here.
- **`social_posts`** — MyndHyve has **no** organic social posting either (ad-only). There is
  no real outbound target anywhere.
- **`creative_briefs`** — an internal artifact (briefs for designers); no platform target.

The project's hard rule is to **behave honestly** — never advertise a capability it doesn't
honor. So rather than ship a fake "publish to ads/social", these three channels publish to
the one real, working target that exists today: a **durable `documents` document** — a
reviewable, exportable *campaign handoff packet* the user (or their agency) acts on.

## Decision

**Three `role:"action"` publish nodes in `feature.campaign-channels.nodes` map each draft to
a Markdown document via the existing `ctx.features.documents` surface** — mirroring the
ADR 0162 pattern (map in the node, write through the owning surface, wire as Strategist
tools). No new store, no faked platform dispatch.

1. **`publish-ad-variants`** → a `campaign-ad-copy` document: one Markdown section per
   platform set, a table of each variant (headline / description / CTA).
2. **`publish-creative-briefs`** → a `campaign-creative-briefs` document: one section per
   brief (format, scene, composition, messaging context).
3. **`publish-social-posts`** → a `campaign-social-calendar` document: posts grouped by
   platform, each with content + hashtags.

Each node reuses the pack's existing `pickDraft` + `resolveOrgId` helpers (ADR 0162), maps
the draft to Markdown, then writes through **one owned surface method**,
`documents.createDraftDocument({ orgId, kind, title, content, idemBase })`, which
encapsulates the whole two-step (the `/architect` fix #3 — matching `cms.createDraftPage` /
`email.createDraftCampaign`). Returns `{ document, version }`.

**Replay-safety + no orphan container** — `createDraftDocument` (in `documents/surface.ts`):
1. **Guards content first** — empty/whitespace content returns `{ error: empty_content }`
   *before* any write, so a node can never leave a contentless container (the `/architect`
   orphan-container fix #2). Nodes also fail-closed on a zero-item draft before mapping.
2. **Deterministic `documentId`** = `doc:<runId:nodeId>` → `createDocument`, which gains an
   optional `documentId` short-circuit placed **above** the per-org cap check (mirroring
   `createPage`'s `pageId`; the cap-on-replay fix #4). `createDocument` minted a random
   `doc:<uuid>` before — a re-run/fork would have duplicated the container.
3. **`addVersion`** with `idempotencyKey = <runId:nodeId>` (already idempotency-keyed).

So the whole two-step converges with no duplicate entity on re-execute-after-failure or on
fork. Tenant comes from the surface `scope` (never args); `orgId` is node-supplied.

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Target | A `documents` document (handoff packet), NOT platform dispatch | The only real, working target today; honest (nothing faked). Real ad dispatch is a separate RFC-gated effort. |
| Owner | The `documents` service is the single writer; nodes call `ctx.features.documents` | Same single-source-of-truth seam as ADR 0162; no second store. |
| Node vs surface | Channel→Markdown mapping in the node; the write in the surface | The mapping is channel-specific; the write is generic. |
| Replay idempotency | Deterministic `documentId` (new `createDocument` short-circuit) + `addVersion` idempotencyKey | A re-run/fork reuses the entity — the ADR 0162 idempotency precedent. |
| Tenant isolation | `tenantId` from `scope` (surface closure); `orgId` node-supplied | Matches every write surface; cross-tenant guard. |
| `kind` vocabulary | `campaign-ad-copy` / `campaign-creative-briefs` / `campaign-social-calendar` (kebab tags) | `asKind` accepts any `[a-z0-9-]` tag; descriptive + filterable in the docs UI. |

### Non-goals

- Real outbound ad/social dispatch (Meta/Google/TikTok platform APIs) — a large, RFC-gated
  follow-on (the MyndHyve `AdPublishService` port + an outbound connector reach). Documented,
  not built here.
- A new "Publish" FE surface — the Strategist chat + the existing documents UI cover it.

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1** | `documentsService.createDocument` optional deterministic `documentId` short-circuit + surface pass-through · `publish-ad-variants` / `publish-creative-briefs` / `publish-social-posts` nodes (draft→Markdown mappers) + Strategist allowlist += 3 · unit/pack tests (mappers; fail-closed; real-surface delegation; draft-status; replay idempotency; tenant isolation) | backend tsc + tests; boot registers the three nodes |

Single phase (contained). `/architect` before · `/code-review` after. `/ux-review` N/A
(no new UI; the documents render through the existing documents surface).

## Alternatives considered

1. **Honest-off connector dispatch stubs** (return `connector_not_configured`). Rejected as
   the primary path — a placeholder that publishes nothing; the documents handoff is a real,
   working deliverable now.
2. **Port MyndHyve's real ad publishing.** Rejected for this ADR — a large credential-bearing
   outbound capability that needs an RFC; tracked as the documented follow-on.
3. **A new `publish` store.** Rejected — duplicates `documents`; the cardinal parallel-surface
   violation.

## Consequences

- All five channels now have a publish path (CMS / email from ADR 0162; ad / creative /
  social as document handoffs here) — the Campaign Studio "last mile" is complete + honest.
- `createDocument` gains deterministic-id support, available to any future replay-safe
  document writer.
- Establishes documents as the honest handoff target for channels without a first-party
  platform integration, until the RFC-gated outbound reach lands.

## Implementation log

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | `documentsService.createDocument` gained an optional deterministic `documentId` short-circuit (above the cap check). `documents/surface.ts` gained `createDraftDocument` (content guard → deterministic `createDocument` → idempotency-keyed `addVersion`, all owned; the `/architect` fix #3) + forwards `documentId` on the existing `createDocument` (fix #1). `feature.campaign-channels.nodes` gained `publish-ad-variants` / `publish-creative-briefs` / `publish-social-posts` `role:"action"` nodes (draft→Markdown mappers, reusing `pickDraft`/`resolveOrgId`, fail-closed on a zero-item draft, deterministic `runId:nodeId` idem keys). Strategist tool-allowlist + prompt updated. **`campaign-channels-publish-docs.test.ts` 7/7** (mappers; fail-closed; empty-draft; real-surface delegation; DRAFT status; replay idempotency — one container, one version; tenant isolation; empty-content guard → no orphan). tsc clean; full backend suite green except the 2 env-only WASI reds. `/architect` (GO-with-fixes — all 4 applied) · `/code-review`. |
