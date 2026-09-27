# ADR 0559 — Funnel resume links (cross-device visitor continuation)

Status: Proposed
Date: 2026-08-13
Origin: UX_UPGRADE-funnels round 3 (/feature-refinement) over the R2 market
note: "a persistent link is a differentiator (top unshipped GHL request)".

## Decision (proposed)

Extend `funnels` (toggle unchanged) with an OPT-IN, per-visitor **resume
link**: after an opt-in step captures an email, the visitor may be sent (via
the existing email lane) a capability-token URL that restores their funnel
session — step position and session identity — on any device.

- **Token model**: the sharing/booking-manage precedent (an unguessable
  capability token, tenant derived from the RESOURCE it names, uniform 404 on
  miss, expiry authored per funnel with a bounded default). NOT an account, NOT
  a cookie — the same class as the CRM public booking-manage token this app
  already ships.
- **What it restores**: step index + the visitor session key the stats lane
  already counts distinctly (VP-R2-1) — so a resumed visitor is the SAME
  visitor in every denominator, not a new view. This is the design's center:
  without it, resume links would corrupt the distinct-visitor counting R2 paid
  for.
- **What it must NOT restore**: form values already submitted (they are
  server-side rows, not session state) or any value the visitor typed but did
  not submit (the device-local Tally-model draft stays device-local — the
  forms R2 privacy stance carries over verbatim).

## The privacy question, framed (open)

A resume token is a bearer credential to "this person is partway through this
funnel" — low sensitivity, but an email-delivered URL is forwardable. Proposed
posture: the token names the SESSION, never the person; opening it shows the
step, not any captured values; revocation = funnel unpublish or expiry.
Operator opt-in per funnel, default OFF.

## Boundaries audit

- Capability tokens: sharing (`/shared/:token`) and CRM booking-manage own the
  pattern — compose the same shape; no new token machinery.
- Email delivery: the existing email lane (opt-in step already captures the
  address); no new sender.
- Session/stats: `funnel.step_viewed` distinct-visitor counting is the single
  owner of visitor identity — the resume token must carry ITS key, not mint a
  parallel identity.
- RFC verdict: **host-ext, no wire** (public route under the existing funnels
  public prefix; capability-token posture per the matrix's row 7).

## Alternatives weighed

- **Magic-link accounts** — rejected: an account system for anonymous funnel
  visitors inverts the feature's whole posture.
- **Longer-lived localStorage only** (status quo) — the R2 stance; kept for
  same-device. This ADR adds only the cross-device case the market note names.
- **Do nothing** — viable; this is a differentiator, not a defect. Hence
  Proposed, default-OFF, and explicitly NOT jumping ahead of defect work.

## Phased plan

| Phase | Scope | Verify |
|---|---|---|
| P1 | Token mint on opt-in completion (per-funnel opt-in setting) + public resume route (uniform 404, expiry) + session-key restoration | backend tests: token miss/expiry/restore; the distinct-visitor invariant pinned |
| P2 | Email template + builder setting surface + viewer "we emailed you a link" notice | frontend tests |
| P3 | Stats: resumed sessions labeled in the day rows (visibility, not new counting) | goldens |

## Open questions

- [ ] Expiry default (proposed 14 days) and whether an operator may extend.
- [ ] Should resuming re-fire `step_viewed` for the restored step? (Proposed:
      no — the distinct-visitor key absorbs it, and a resume is not a view.)
- [ ] Consent copy on the opt-in step naming that a resume email will be sent.
