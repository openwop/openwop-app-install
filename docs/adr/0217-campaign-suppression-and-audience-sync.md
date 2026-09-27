# ADR 0217 — Campaign Studio: suppression list + segment→ad-platform audience sync

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `crm` (`suppressionService` + routes), `email` (send-path subtraction), `campaign-connectors` (`audienceService`, surface, route, node), `host/adsAdapter.ts` (`syncAudience` + gate) |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5C **C3** (E2: no suppression lists, no audience sync). The segments half of C3 landed with the CRM branch (**ADR 0211** — saved segments + email `segmentId` audiences); this ADR ships the remainder. |
| **RFC gate** | **None** — host-ext routes/fields; the ad-platform legs ride the ADR 0167 broker seam. |

## Context

The gap analysis graded audiences **D**: segments now exist (ADR 0211), but nothing subtracts a do-not-contact overlay from marketing sends, and audiences can't reach paid channels. The research doc's E2 acceptance criteria are explicit: consent-lacking profiles are excluded from sync and send; suppression changes propagate to connected platforms.

## Decision

1. **`crm:suppression` — ONE do-not-contact overlay** (`crm/suppressionService.ts`): email-keyed (lower-cased), reason-coded (`unsubscribed|bounced|complaint|manual`), tenant-wide. Distinct from consent (the subject's recorded *choice*): suppression is the *operational* overlay that stays enforced even with the consent toggle off — fail-closed for known-bad addresses. Only `manual` rows are operator-removable; system reasons lift only via a subject re-opt-in (the honesty rule). Routes: `GET/POST /crm/suppressions`, `DELETE /crm/suppressions/:email`.
2. **Every marketing egress subtracts it:** `emailService.sendCampaign` skips suppressed recipients (`skipped:'suppressed'` in the send ledger, beside the consent skip) and `buildAudienceUpload` excludes them from ad uploads.
3. **Audience sync = build + gated dispatch:**
   - `campaign-connectors/audienceService.buildAudienceUpload(tenantId, segmentId)`: segment members (ADR 0211 read) → no-email / consent (`isAllowed(…, 'marketing')` per contact) / suppression exclusions → normalize + **SHA-256** (the Meta Custom Audiences / Google Customer Match shared shape). **Raw addresses never leave the builder** — the adapter receives hashes only. `membersKey` = sha256 of the sorted hash list — the stable content anchor.
   - `adsAdapter.syncAudience`: PII-adjacent, so the gate **defaults to require-approval** (`actionPolicy['ads.audience']` unset ⇒ a `campaign-spend` PendingApproval, `spendKind:'audience'`, keyed by the membersKey-derived spend key — approve → re-run proceeds, fork-stable; `disabled` refuses). Platform legs are **seam-level** (the ADR 0167 posture): Meta `customaudiences` create + `users` upload (`EMAIL_SHA256`); Google `userLists:mutate` (the `offlineUserDataJobs` member upload is C1's production-completion follow-on). Provenance stamped; `campaign.ads.audience-synced` audit row + `host.campaign.ads.audience-synced` event via `emitHostEvent`.
   - Callers: `POST /campaign-connectors/audience-sync` (workspace:write; 202 on approval-pending) and the `feature.campaign-connectors.nodes.audience-sync` node (pack v1.2.0) for chains/agents.

## Alternatives rejected

- Suppression inside consentService — conflates the subject's choice with operational state; the two gates compose (both checked at send).
- Raw-email uploads with platform-side hashing — hashes-only leaves the host smaller attack surface and matches both platforms' preferred shape.
- A per-tenant toggle to skip the audience approval — the default stays approval-required; a tenant can only *tighten* (`disabled`), not loosen below approval.

## Verification

`campaign-audience-suppression.test.ts`: suppression CRUD + honesty rules; send-path skip; build exclusion accounting; adapter gate default (approval → approve → proceeds-to-connection-check) + `disabled`.
