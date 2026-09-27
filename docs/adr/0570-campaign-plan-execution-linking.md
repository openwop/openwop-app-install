# ADR 0570 — Campaign plan→execution linking: channel nodes connect to the features that run them

Status: Proposed
Date: 2026-08-14
Feature: campaign-studio + campaigns (composes email, ads, funnels — no new toggle)
Origin: UX_UPGRADE-campaigns R2 — CS-R2-2, "the sharpest gap … our email/ads
features exist and channel nodes never connect — the ADR headline." CS-SP-5
(asset→channel free-text linking) and CS-SP-6 (order-derived edges) were
deferred INTO this ADR as its structural components.

## Context

A Campaign Studio plan is a board of channel nodes (email / ads / content /
…) with budgets, copy, and stages — and it is TERMINAL. The email feature
runs real sends (with `sourceBriefId` already on its campaign rows,
`emailService.ts:196`), the ads feature dispatches real briefs, funnels
measure real journeys; none of them can be reached FROM a plan node. Every
comparator's core loop is plan → launch → results-on-the-plan.

## Boundaries audit

- **The seam already half-exists**: email's `createCampaign` accepts
  `sourceBriefId` (the ADR 0334 brief lineage); the studio's channel node has
  the channel `type` enum the R2 pass hardened (typed enum failures, pack
  1.0.1). What is missing is the LINK FIELD on the channel node and the
  hand-off surface.
- **Single owners**: email sends belong to `features/email`; ads dispatch to
  the ads feature; the studio must LINK (store a target id + read status),
  never re-implement dispatch. The money-truth and egress-approval lanes of
  those features apply untouched.
- **Doc wire**: the campaign doc schema is validator + pack + agent-tool
  governed (the CS-SP-3 currency lesson: any doc-shape change touches all
  three + a pack republish — the registry-republish rule).
- **Chains doctrine**: a multi-channel LAUNCH sequence (publish email, then
  ads, gated on approval) is a workflow — a chain pack, never in-tree
  orchestration.

## Decision (proposed)

1. **Doc shape (additive)**: a channel node gains
   `execution?: { kind: 'email-campaign' | 'ads-brief' | 'funnel'; id: string }`
   — validated closed-world (kind enum + non-empty id), absent for unlinked
   channels. Validator + AJV + pack + agent tool updated together; pack
   version bump + registry republish (the recorded rule).
2. **Linking UX**: the channel panel offers "Link to…" with a PICKER over the
   real feature's rows (email campaigns / ads briefs in the SAME org — no
   free text, closing CS-SP-5's family), plus "Create from this channel" which
   deep-links the target feature's create surface seeded from the node
   (subject/copy/budget), returning with the minted id — the
   `sourceBriefId`/staged-draft precedent, not a new mechanism.
3. **Status read-back**: the plan board renders each linked channel's LIVE
   status chip (email: draft/sending/sent + counts; ads: dispatch state) via
   the owning feature's existing read routes — read-only projection, one
   request per linked channel capped by the board's size, failed read ≠
   unlinked (the failure family).
4. **Edges (CS-SP-6)**: linking does NOT change edge semantics in this ADR;
   order-derived edges stay. A later execution-sequencing pass (chain-pack
   lane) may consume the links.
5. **Agent lane**: the Strategist's get-design/render tools carry the new
   field read-only in Phase 1 (the agent can SEE links, not mint them);
   agent-driven linking needs its own consent posture — named, deferred.

## Alternatives weighed

- **Free-text reference on the node** — rejected: CS-SP-5's exact defect
  class (unvalidated links rot silently).
- **The studio dispatching directly** — rejected: forks the money/egress
  owners; the studio links and reads, the owning features act.
- **A chain pack only (no doc link)** — rejected as Phase 1: a chain can
  sequence launches but the plan board still could not SHOW what a channel
  became; the link field is the substrate the chain lane composes later.

## Open questions

1. Funnel linking in Phase 1 or later? (Assume later — email + ads first;
   the kind enum is additive.)
2. Does the status chip poll or read-on-open? (Assume read-on-open + manual
   refresh — the dashboard's read-budget lesson.)

## RFC verdict

Host work only — doc shape + host-extension routes + packs. No OpenWOP wire.

## Phased implementation record

| Phase | Scope | Status |
|---|---|---|
| 1 | doc field (validator+AJV+pack+agent, republish) + picker linking + status chips (email, ads) | not started |
| 2 | create-from-channel seeding round-trip | not started |
| 3 | chain-pack launch sequencing + agent-driven linking posture | not started |
