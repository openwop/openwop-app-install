# ADR 0564 — Invitation decline: a recipient-side `declined` state the inviter can see

Status: implemented (2026-09-02 — P1 backend `d6060067b`, P2–P3 frontend `7933a222b`; Accepted the same day, feature loop 2026-09 iteration 2 — implemented alongside ADR 0622, which adds the `host.orgs.invitation.declined` emit and answers open question 1: no cooldown; a re-mint over a declined row carries `superseded: true` + `previousStatus: 'declined'` on the `created` event)
Date: 2026-08-14
Feature: orgs / invitations (extends ADR 0004 invitations + the R2 invitation pass — no new toggle)
Origin: UX_UPGRADE-invitations IN-G5 → IN-R2-4, deferred twice on an explicit
bar, queued in R2 as "a candidate ADR" once the market evidence corrected.

## Context

Round 1 deferred a Decline action on the grounds that "ignore it" is the safe
default and a button that only navigates away would be theatre. Round 2's
market refresh **falsified the premise**: GitHub and Figma both ship real
recipient-side Decline wherever a server-side pending record exists (ours
does: `OrgInvitation`, `invitationsService.ts:32`). Round 1's bar was kept and
is this ADR's scope discipline: **a real decline = a server `declined` state
the inviter can see — no half version.**

## Boundaries audit

- **Single owner:** `features/orgs/invitationsService.ts` owns the invite
  lifecycle (mint / replace-at-mint / preview / accept / expire+age-out).
  Decline is a new terminal transition in the SAME service — no new store.
- **Row lifecycle constraint:** today a redeemed invite is DELETED at accept,
  and `registerKvAgeOut` reaps rows 30d after `expiresAt` (`:62`). A decline
  the inviter can SEE cannot ride a deleted row — the row must persist in a
  `declined` state until its ordinary age-out. That is a **semantic change to
  the row lifecycle**, which is exactly why R2 refused to bolt it on.
- **Preview/accept gates to reuse:** the token-hash point-get + email-ownership
  gate (`acceptInvitation`) apply verbatim to decline: only the invited address
  may decline, via the capability token, after an explicit click (the IN-G1
  no-redeem-on-load posture applies — decline must be a deliberate act, never
  a link-scanner side effect).
- **Inviter surface:** `InvitesSection` (orgs frontend) already renders
  per-invite status chips (expired, undeliverable — R2 XIN-4). A `declined`
  chip composes the existing list; no new surface.
- **No route collisions:** `POST …/invitations/decline` is a new literal under
  the invitations prefix (grep clean).

## Decision

1. **Model:** add `status?: 'pending' | 'declined'` (absent = pending, the
   older-wire default) + `declinedAt?: string` to `OrgInvitation`. Accept on a
   declined invite → the uniform invalid answer (a declined invite is dead).
   Re-mint to the same (org,email) replaces the declined row (the existing
   replace-at-mint semantics) — re-inviting after a decline is the inviter's
   explicit, visible choice.
2. **Route:** `POST /invitations/decline { token }` — same gate chain as
   accept (invite tenant toggle gate, expiry check, email-ownership check,
   signed-in requirement), flips the row to `declined`, keeps the token-hash
   index intact until age-out (an accepted-then-declined replay stays a
   uniform failure). Idempotent: declining a declined invite returns the same
   200.
3. **Recipient UI:** a secondary "Decline" action beside Accept on the
   preview card, with a confirm step (declining is consequential the other
   way); terminal state copy names the org and the undo path ("ask them to
   re-invite you" — the one actionable next step, the R2 doctrine).
4. **Inviter UI:** the invites list renders a `declined` chip (with
   `declinedAt` in the title), and the row's Revoke action remains (cleanup).
   No notification fan-out in this ADR — the chip is the visibility floor;
   an emitter hook is named as an extension.

## RFC verdict

Host-extension routes under `/v1/host/openwop-app/*` — **no OpenWOP RFC**.

## Alternatives weighed

- **Delete the row on decline** — rejected: the inviter sees a vanished
  invite, indistinguishable from expiry/revocation; the entire point is a
  VISIBLE declined state (the R2 market evidence: GitHub's invitation object
  carries the state).
- **Client-only "dismiss"** — rejected by round-1's own bar (theatre).
- **Notify the inviter (email/notification)** — deferred as an extension via
  the existing `getNotificationEmitter` seam; the chip is the floor.

## Open questions

1. Should a declined invite block IMMEDIATE re-mint (cooldown) to prevent
   invite-spam pressure on the recipient? (Assume no cooldown; the recipient
   can keep declining — but record the consideration.)
2. Does the anti-abuse posture need decline-rate limiting distinct from the
   accept limiter? (Assume the shared invitations limiter suffices.)

## Phased implementation record

| Phase | Scope | Status |
|---|---|---|
| 1 | model + service transition + route (+ tests incl. replay/idempotence) | **done 2026-09-02** (ADR 0622 D4): `status`/`declinedAt` on `OrgInvitation`; `declineInvitation` = the accept gate chain + a `compareAndSwap` on the pending row (the review's concurrency correction — a blind put racing the accept's claim-by-delete would resurrect the row); accept refuses `declined` BEFORE the claim; preview answers `reason: declined`; `POST /orgs/invitations/decline` outside `h`, idempotent 200; `host.orgs.invitation.declined` on the CAS-won transition. `test/orgs-invitation-decline.test.ts` (gate chain, idempotence, decline-vs-accept race ⇒ exactly one outcome, replay after decline = uniform failure) |
| 2 | recipient UI (confirm + terminal state ×4 locales) | in the frontend unit of the same PR (ADR 0622 matrix row 10) |
| 3 | inviter chip + declinedAt (+ tests) | in the frontend unit of the same PR (`listInvitations` already returns `status`/`declinedAt`; `toClientInvite` spreads them — verified over HTTP in the P1 suite) |
