# ADR 0402 — CRM booking links + e-signature (CRM-Book / CRM-Sign)

Status: implemented

Date: 2026-07-17

Lane: feature depth on `crm` (ADR 0008) — two new public surfaces + KV-blob entities, one node-pack
bump. NO SQL migration, NO wire change.

RFC verdict: **host work only.** Booking pages and signing pages are host-extension routes under
`/v1/host/openwop-app/*` (both public-unauthed, tenant-from-resource). They add no run-event field,
capability flag, event type, or normative `MUST` — nothing touches the OpenWOP wire. Per CLAUDE.md
("A spec change needs an RFC … not just an ADR") and FEATURES.md § "Adding a feature", a
public-surface host-ext route never needs an RFC. No new RFC.

## Context

`docs/steward/MYNDHYVE-GAP-ANALYSIS.md` names two concrete CRM surfaces with no openwop equivalent — the last
real losses on an otherwise COVERED/COVERED-BETTER CRM domain (line 249 marks CRM full-depth
covered):

- **Booking links (public self-serve scheduler)** — `docs/steward/MYNDHYVE-GAP-ANALYSIS.md:238`: *"CRM has
  `meeting` activity kind + internal `schedulingService`, no public Calendly-style booking page."*
  (Also lines 58, 263, 267.) A Calendly-style page where a visitor picks a slot from published
  availability; booking creates a CRM meeting activity + captures the contact + notifies + optionally
  attaches a video-call link.
- **CRM e-sign** — `docs/steward/MYNDHYVE-GAP-ANALYSIS.md:251`: *"No e-signature request/track in CRM."* (Also
  lines 58, 263, 269.) Request and track signatures on a document — a commerce quote (ADR 0177,
  `features/commerce/quotes.ts`) or a generated document — with an audit trail.

Both are standard mid-market CRM expectations. The gap doc scoped each **M** and suggested a
"connector-style" add; this ADR makes the build-vs-integrate call for both (native booking; native
click-to-sign core with a provider-connector seam deferred) and specs them against the app's existing
seams rather than as bolt-on integrations, because a **white-label platform** cannot make its core
scheduling and signing story a dependency on Calendly/DocuSign branding and pricing.

Everything the two features need already exists as a seam. This ADR is mostly **composition**:

- CRM already owns meetings and contacts (activity kind `meeting`, `createContact`).
- Forms already owns the public-submission machinery (published-only render, uniform 404,
  tenant-from-resource, honeypot/guards/rate-limit, submission sinks).
- Sharing already owns capability tokens (expiring, view-capped, revocable, live-resource resolve).
- Notifications and Email already own fan-out and send.

## Boundaries audit (who owns what — with file:line)

| Concern | Owner today | Evidence | This ADR's move |
|---|---|---|---|
| Meeting activity + contact capture | **crm** | `features/crm/entities/activities.ts:23` — `ActivityKind = 'note'\|'call'\|'email'\|'meeting'`; `formsSubmissionSink.ts:38` `createContact` | Booking **creates a `meeting` activity + a contact** via these; adds NO new activity kind. |
| Availability / working hours / timezone | **profiles** (user) + **host schedulingService** (tz plumbing) | `frontend/.../profiles/ProfileSchedulesTab.tsx:21,32` timezone; `profiles/i18n/en.ts:56` `availabilityLabel`; `host/schedulingService.ts:87-96` `timezone` + `nextFireAt` daemon-evaluated in IANA zone; `host/cronSchedule.ts` `computeNextFire` | Booking availability is a **new `crm:booking-link` entity** (working hours/buffers/durations). It **composes** profiles' availability display + the host tz convention; it does NOT reuse the cron job store (a booking link is not a fired schedule). |
| Public-submission machinery | **forms** | `features/forms/routes.ts:5` on `PUBLIC_PATH_PREFIXES`; `:133-217` uniform-404 published-only render, `tenantId: form.tenantId` (resource-derived, `:46`), honeypot `:172`, guards `:202`, rate-limit; `submissionSinks.ts:36-49` `registerSubmissionSink` | The booking page is form-**like** but NOT a `FormDef`: it computes live slots and claims one atomically, which forms' fire-and-forget submit cannot express. Booking **reuses forms' public-surface DISCIPLINE** (the four invariants below) and the `PublicFormRenderer` visual patterns — it does **not** route through `public-forms` or the submission-sink seam. See § "Why not ride forms' submit". |
| Capability tokens (expiring/capped/revocable) | **sharing** (ADR 0013) | `features/sharing/sharingService.ts:50,58,64` `token`/`expiresAt`/`revoked`; `:178-195` `commerce_quote` live-resolve; commerce public accept `features/commerce/routes.ts:341-347` `assertLiveLinkFor(token,'commerce_quote',…)` | **Reschedule/cancel tokens** and **signer tokens** are minted through sharing (two new resource kinds: `booking_manage`, `sign_request`). Signer identity = possession of the emailed token, exactly the commerce-quote public-accept precedent. |
| Email send (+ ICS) | **email** | `features/email/emailService.ts:112` `activeProvider()`; `engagementService.ts` builds ICS-adjacent content | Booking confirmation carries an **ICS `VEVENT` attachment**; signer invites + completion certs send via email. New: a small ICS builder helper (crm-local; email owns the send). |
| Notification fan-out | **notifications** | `notifications/emitter.ts:80` `emit` / `:115` `emitMany` | New-booking and signature-completed notifications to the owner via `emitNotification`. |
| Quote/document to be signed | **commerce** (quotes) + **documents** | `features/commerce/quotes.ts:35` `QUOTE_STATUSES`; `sharingService.ts:246` `creative_brief`/business-doc kinds | E-sign binds to a **content hash** of the target's rendered bytes; commerce/documents remain the SoT of the content. E-sign never mutates the quote — it records a signature and (for quotes) may emit an `accepted`-adjacent marker the quote lifecycle already supports. |
| Public-surface rules | **middleware/auth** | `middleware/auth.ts` `PUBLIC_PATH_PREFIXES` | Two new prefixes: `public-book`, `public-sign`. Both: published/active-only, tenant-from-resource, uniform 404, rate-limited, abuse-capped. |

**Net:** crm gains two entities (`crm:booking-link`, `crm:sign-request`) and two public route groups;
it depends on forms only for **patterns** (not code), and on sharing/email/notifications as existing
integrator seams. No feature reverses its dependency direction.

## Decision

Ship **CRM booking links** and **native click-to-sign e-signature** as depth on the `crm` feature
(one toggle, `crm`; no new top-level feature), in three phases. Build booking natively (not a
Calendly connector). Build e-sign as a **native lightweight click-to-sign core** now, with a
provider-connector **seam** designed but deferred (no DocuSign in v1).

### (a) Public booking links

**Availability model** — a `crm:booking-link` KV-blob entity (`DurableCollection` over
`host_ext_kv`, same store family as ADR 0383's crm entities, so **no SQL migration**):

```
BookingLink {
  bookingLinkId; tenantId; orgId; slug;            // public URL = /book/:slug
  ownerUserId;                                      // whose calendar/meeting this is
  status: 'draft' | 'published' | 'disabled';       // published-only is public
  timezone;                                          // IANA — the availability is expressed here
  weeklyHours: { day: 0..6; start: 'HH:MM'; end: 'HH:MM' }[];  // working hours
  durations: number[];                               // offered slot lengths (minutes)
  bufferBeforeMin; bufferAfterMin;                   // padding around a booking
  minNoticeMin; maxAdvanceDays;                      // booking window
  videoLink?: string | 'generate';                  // optional static link or per-booking generate
  createdAt; updatedAt;
}
```

**Slot computation (tz-aware)** — slots are derived, never stored. Given a link + a requested date
range, compute candidate slots by walking `weeklyHours` in the link's `timezone`, stepping by the
chosen duration, applying buffers/notice/advance, then subtracting already-claimed slots. Timezone
handling follows the **host convention already in production**: `schedulingService`/`scheduleDaemon`
evaluate a cadence against an IANA `timezone` (`host/schedulingService.ts:87-96`), and `cronSchedule.computeNextFire`
is the reference for zone-correct wall-clock math. Slot computation reuses that zone-conversion
approach (Intl/`Temporal`-style offset resolution), NOT a naive UTC offset. All stored booking times
are UTC instants; the link's `timezone` is display/compute-only.

**Double-book prevention (idempotent slot claim)** — a booking is an atomic **claim** on a
`(bookingLinkId, slotStartUtc)` key. The claim writes a `crm:booking` row keyed by that tuple; a
second claim on the same tuple is rejected `slot_taken` (compare-and-set on the KV row, same
CAS discipline commerce uses for stock reservation, `features/commerce/reservationSweep.ts`). The
public submit is **idempotent** on a client-supplied `Idempotency-Key` (replay of the same request
returns the same booking, never a duplicate) — the ADR 0162 deterministic-id pattern the crm surface
already uses (`features/crm/surface.ts:19`). On successful claim, in ONE path:
1. write the `crm:booking` row (holds `slotStartUtc`, contact ref, duration, videoLink),
2. `createContact` (auto-capture, dedup via existing identity resolution — ADR 0263),
3. `createActivity` kind `meeting` linked to the contact,
4. `emitNotification` to `ownerUserId`,
5. email the visitor a confirmation with an **ICS `VEVENT`** attachment + a **manage link** (a
   `booking_manage` share token for reschedule/cancel).

**Public page (the four invariants, mirrored from forms)**:
- **Published-only** — a `draft`/`disabled` link is dark (`forms/routes.ts:141` resolves the feature
  toggle + status before rendering).
- **Tenant from resource** — the tenant is read off the resolved `BookingLink`, never the request
  (`forms/routes.ts:46`; commerce `routes.ts:413`).
- **Uniform 404** — missing / unpublished / crm-off / bad-tenant all throw the SAME
  `not_found` (`forms/routes.ts:137`), so the surface leaks no existence signal.
- **Rate-limited + abuse-capped** — the public read (slot list) and the claim ride the per-IP read
  budget (`middleware/rateLimit.ts`) plus a per-link daily booking cap and honeypot, matching forms'
  posture (`forms/routes.ts:172,202`).

**Reschedule / cancel** — the manage link carries a `booking_manage` capability token (sharing,
expiring + revocable). Reschedule = cancel-then-claim under the same idempotency guard (frees the old
slot, claims the new); cancel voids the `crm:booking` row and marks the meeting activity cancelled.
Both re-send an updated ICS (`METHOD:CANCEL` / new `VEVENT`).

**Composition with profiles** — a booking link's default `weeklyHours`/`timezone` seed from the
owner's profile availability (`profiles` availability fields) when present; the link owns its own copy
thereafter (a link's schedule is not the person's global availability).

### (b) E-signature — native click-to-sign core

**v1 decision: native lightweight click-to-sign, NOT a DocuSign-class connector, NOT eIDAS.** Rationale:

1. **White-label core, not a branded dependency.** A booking page that says "powered by Calendly" or
   a signing page that redirects to DocuSign undercuts the whole white-label value prop (ADR
   0366/0367 trust-tier program). The signer must stay on the operator's domain.
2. **The seams already exist.** Signer identity via an emailed capability token is the EXACT
   commerce-quote public-accept flow (`commerce/routes.ts:341-347`, `sharingService.ts:178`) — proven
   in production. Content-hash binding + an audit record is a small durable entity, not a platform.
3. **Sufficient for the target use.** Internal approvals and SMB quote/contract sign-off need a
   defensible record (who, what content, when, from where), not a qualified trust-service signature.
4. **The connector is a later seam, not a fork.** A `SignatureProvider` interface (native |
   docusign | …) lets a provider connector land later without reshaping the entity — the same
   promotion path ADR 0330's submission-sink seam took. v1 registers ONE provider: `native`.

**Legal-scope honesty statement (ships in the ADR, the UI, and the certificate):** *This is a
lightweight electronic-signature record (signer intent + a cryptographic hash binding the signature
to the exact signed content + an audit trail). It is suitable for internal approvals and general
business agreements under e-signature statutes that recognize electronic records (e.g. US ESIGN /
UETA "electronic signature" tier). It is NOT a qualified or advanced electronic signature under
eIDAS, does NOT use a trust-service-provider certificate, and does NOT perform government-ID identity
verification. Where a qualified/eIDAS signature or notarization is legally required, use a
DocuSign-class provider (a future connector seam).* This statement is non-negotiable copy — an honest
capability claim, the same discipline as the wire-honesty rule.

**Entities** (KV-blob, no migration):

```
SignRequest {
  signRequestId; tenantId; orgId;
  target: { kind: 'commerce_quote' | 'document'; id };  // what is being signed
  contentHash;                                          // SHA-256 of the rendered signed bytes at request time
  signers: { signerId; email; name?; order?; token; status: 'pending'|'signed'|'declined'; }[];
  status: 'draft' | 'sent' | 'partially_signed' | 'completed' | 'declined' | 'voided';
  createdBy; createdAt; completedAt?; certificateArtifactId?;
}
SignatureRecord {                                       // one per signer signature event (audit)
  signRequestId; signerId; signedAt; ipHash; userAgentHash;
  contentHashAtSign;                                    // MUST equal SignRequest.contentHash — mismatch = void
  method: 'click-to-sign'; typedName?;                  // the signer's typed/drawn intent
}
```

**Signer token flow** — `requestSignature` mints one `sign_request` capability token per signer
(sharing: expiring, revocable) and emails each a signing link. The public signing page resolves the
token → the target's rendered content + the honesty notice; the signer's identity is possession of
the live token (the commerce-quote precedent). Order (`signers[].order`) gates sequential signing when
set.

**Content-hash binding** — at request time the exact rendered bytes (the quote PDF / document render)
are hashed (SHA-256) into `SignRequest.contentHash`. At sign time the current render is re-hashed; a
mismatch (the underlying quote/doc changed after the request) **fails loudly** (`content_changed`,
never a silent sign of stale content) — the same "staleness fails, never silent reprice" invariant
commerce quotes enforce (`quotes.ts:7`). This binds the signature to WHAT was signed.

**Signature record + audit** — each signature writes a `SignatureRecord` (hashed IP + UA for privacy;
raw IP is PII we don't retain). When all required signers reach `signed`, the request completes:
generate a **PDF certificate page** (signers, timestamps, content hash, per-signer audit) as a
`documents`/artifact, store its id on `certificateArtifactId`, and notify the requester.

**Decline / void** — a signer may `decline` (records intent, moves request to `declined`); the
requester may `void` a request before completion (revokes all outstanding signer tokens via sharing).
Both are terminal and audited.

**Public surface** — `public-sign` prefix, same four invariants as booking: active-request-only,
tenant-from-resource, uniform 404, rate-limited + abuse-capped. A voided/expired token → uniform 404.

## Feature evaluation matrix (10 rows)

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | Depth on **`crm`** — new files under `features/crm/` (`bookingService.ts`, `bookingRoutes.ts`, `signService.ts`, `signRoutes.ts`, `ics.ts`). NO new feature package; NO new toggle. Entities are `crm:booking-link` / `crm:booking` / `crm:sign-request` KV-blob `DurableCollection`s (ADR 0383 family) — **no SQL migration**. |
| 2 | **Toggle / admin UI** | Gated by the existing `crm` toggle (booking + sign dark when crm is OFF, uniform-404). NO new top-level toggle. Two optional admin sub-settings on the crm feature config: `bookingEnabled`, `esignEnabled` (default on when crm is on) so an operator can run CRM without exposing public pages. Superadmin abuse caps (per-link daily bookings, per-request signer count) are env-tunable like the rate-limit knobs. |
| 3 | **Backend ops (ctx.crm surface)** | Extend the crm feature surface (`features/crm/surface.ts`, `role:action` replay-safe verbs, ADR 0208): **`createBookingLink`**, **`listBookings`**, **`requestSignature`**, **`getSignatureStatus`**. Mutations call the SAME service functions the HTTP routes call, stamp `crmMutated` actor `run:<runId>`, and accept a deterministic idempotency id (surface.ts:19). Reads are org-scoped + visibility-filtered (surface.ts:10). |
| 4 | **Node pack** | Bump **`feature.crm.nodes`** with new `role:action` nodes: `crm.booking.create-link`, `crm.booking.list`, `crm.sign.request`, `crm.sign.status`. **Three-place pin (memory):** bump the version in (1) the pack manifest `packs/feature.crm.nodes/pack.json` (currently `1.7.0` → `1.8.0`), (2) the feature bindings `features/crm/feature.ts:70` (`{ name: 'feature.crm.nodes', version: '1.8.0' }`), and (3) the pack-parity tests (`test/crm-packs.test.ts`, `test/crm-feature.test.ts`). Nodes are pack-allowlisted, NOT added to the ADR 0315 default-on baseline. |
| 5 | **AI-chat envelopes** | **None new.** No new RFC 0021 envelope kind or field — booking/sign are ordinary tool-mediated actions, not in-run structured intent. The node/entity schemas are **tool/catalog asks**, never envelope kinds (per CLAUDE.md's three-lane rule). Honest: this feature adds zero wire surface. |
| 6 | **Agent packs** | **No new agent.** The existing sales-ops / CRM agent (or any agent granted the crm node pack) USES the new tools via the ADR 0058 chat-drivability pattern — "ship nodes, drive through the one chat." No bespoke chat panel (CLAUDE.md single-chat rule). New tools are pack-allowlisted per agent, never silently default-on. |
| 7 | **Public surface** | **Two public pages**, both on `PUBLIC_PATH_PREFIXES` (`middleware/auth.ts`): `public-book/:slug` (booking) and `public-sign/:token` (signing). Both enforce the four invariants: published/active-only, **tenant-from-resource** (never request), **uniform 404** (no existence leak), rate-limited + abuse-capped (per-IP read budget + per-link/per-request caps + honeypot). Mirrors `forms/routes.ts:133-217` and `commerce/routes.ts:341` exactly. |
| 8 | **RBAC / tenant isolation** | Authoring (create/publish a link, request a signature, void) is org-scoped operator RBAC via the shared authz helper (`featureRoute.authorizeOrgScope`, commerce `routes.ts:68`). Public routes are unauthed but tenant-bounded by the resolved resource. Capability tokens (manage/signer) share sharing's expiry/revocation/view-cap. Booking auto-captured contacts respect crm record-visibility (`filterVisibleCrmRecords`, surface.ts:106). |
| 9 | **Replay / fork safety** | Booking claim is **idempotent** (CAS on `(link, slotUtc)` + `Idempotency-Key`; replay returns the same booking, never a double-book). Node-driven creates supply the ADR 0162 deterministic id (`<prefix>:${runId}:${nodeId}`), so a `:fork` re-runs to the same booking/sign-request, not a duplicate. Sign content-hash is re-verified at each sign so a forked/replayed sign of changed content fails loudly. Signature audit records are append-only. |
| 10 | **Frontend + i18n** | Operator SPA (`frontend/react/src/features/crm/`): **availability editor** (weekly hours/buffers/durations/tz), **booking-link manager** (list/publish/copy-URL, bookings table), **sign-request tracker** (status per signer, void/download-cert). **Public pages** reuse `PublicFormRenderer` visual patterns (`forms/render/PublicFormRenderer.tsx`) — booking slot-picker + signing view — built with the app `ui/` design system (no new chat panel). **i18n ×4 locales** (fatal parity gate, memory): all strings in `crm/i18n/{en,es,fr,de}.ts` including the legal honesty notice. |

## Phased plan

| Phase | Scope | Ships |
|---|---|---|
| **P1 — Booking** | `crm:booking-link`/`crm:booking` entities; tz-aware slot compute; idempotent claim + double-book guard; `public-book` page (four invariants); contact auto-capture + `meeting` activity + notification; ICS attachment; reschedule/cancel manage tokens; availability editor + link manager UI; `crm.booking.*` nodes (pack `1.8.0`, three-place pin); tests (slot math, double-book, uniform-404, idempotency, i18n parity). | crm surface `createBookingLink`/`listBookings`; 2 nodes. |
| **P2 — E-sign native core** | `crm:sign-request`/`SignatureRecord` entities; signer capability-token flow; content-hash bind + loud staleness fail; `public-sign` page; signature audit; PDF certificate artifact; decline/void; sign-request tracker UI; the legal honesty notice (UI + cert); `crm.sign.*` nodes; tests (hash mismatch void, sequential order, decline/void, token expiry, cert content). | crm surface `requestSignature`/`getSignatureStatus`; 2 nodes. |
| **P3 — Provider connector seam (design-only in this ADR; build deferred)** | `SignatureProvider` interface (`native` | `docusign` | …) registered like the submission-sink seam; a future `docusign` connection pack (RFC 0095 connection, host-ext) routes qualified/eIDAS signing to the external provider while the native path stays default. **Not built in this ADR** — the interface shape is fixed so P2's native provider slots in without an entity reshape. | Seam only; no v1 connector. |

## Implementation record (2026-07-17)

All three phases implemented on branch `feat/adr-0402-crm-booking-esign`.

| Phase | Status | Key files |
|---|---|---|
| **P1 — Booking** | implemented | `features/crm/{bookingTime,ics,bookingService,bookingRoutes}.ts`, `entities/{bookingLinks,bookings}.ts`; FE `{BookingTab,PublicBookingPage,PublicBookingManagePage,bookRoute,bookingClient}.tsx`; tests `crm-booking{,-time}.test.ts` (21). |
| **P2 — E-sign native** | implemented | `features/crm/{signTargets,signService,signRoutes}.ts`, `entities/signRequests.ts`; FE `{SignTab,PublicSignPage,signRoute,signClient}.tsx`; tests `crm-esign.test.ts` (6). |
| **P3 — Provider seam** | implemented (design-only) | `features/crm/signProviders.ts` — the `SignatureProvider` interface + registry + `native`; `requestSignature` honestly refuses an unbuilt/external provider (501); `SignRequest.provider` stamped. No connector built. |

**Correction notes (design refinements found during implementation):**

- **Capability tokens decoupled from the `sharing` content-toggle.** The ADR routes
  `booking_manage` / `sign_request` tokens through sharing, but sharing's public
  resolve was gated on the `sharing` feature toggle (default OFF). A booking's
  reschedule link and a signing link must work whenever the OWNING feature (`crm`)
  is on, independent of the operator enabling the content-sharing UI. Added
  `resolveActiveResource(token, kind)` (skips the sharing-toggle gate) and gate the
  manage/sign routes on the `crm` toggle instead. Capability tokens ≠ content shares.
- **tz slot math is a crm-local inverse.** The host cron scheduler only does the
  FORWARD direction (UTC→wall-clock); slot generation needs the INVERSE
  (wall-clock-in-zone→UTC), which does not exist in the host, so `bookingTime.ts`
  implements it (DST-correct, spring-forward gaps rejected via a round-trip check).
- **E-sign content hash binds to the SOURCE, never the PDF.** `renderMarkdownToPdf`
  (pdfkit) stamps a `CreationDate`, so PDF bytes are not byte-stable; the
  `contentHash` is over a canonical serialization of the target (quote projection
  with money as fixed strings / document version markdown). The PDF is the
  human-readable certificate artifact only.
- **Certificate stored as a media asset**, served via the existing
  `/v1/host/openwop-app/assets/:token` capability route (unguessable, org-scoped) —
  `certificateArtifactId` = the serve token.
- **i18n locales are `{en, es, fr, pt-BR}`**, not `de` as the matrix (row 10) said —
  matched the existing CRM locale set.
- **Sub-settings are env-gated** (`OPENWOP_CRM_BOOKING_ENABLED` /
  `OPENWOP_CRM_ESIGN_ENABLED`, default on; `OPENWOP_CRM_BOOKING_DAILY_CAP`;
  `OPENWOP_PII_HASH_KEY` for the audit IP/UA HMAC) — consistent with commerce's
  `OPENWOP_COMMERCE_OFFSESSION_ENABLED` precedent rather than a new per-tenant
  config schema.

**Grade pass (2026-07-17) — fixes applied:** grade-code + grade-ux + grade-data
run over the feature area; fixes committed:
- **DATA P0** — `crm:signature-record` carried `tenantOf = signRequestId` (not a
  tenant), so tenant teardown (ADR 0284) never reclaimed the signer-PII rows
  (immortal PII / erasure violation). Fixed: added a real `tenantId` field +
  `tenantOf = r.tenantId` + a fail-closed validator.
- **DATA P1** — `deleteBookingLink` orphaned its `crm:booking` rows + left
  `booking_manage` tokens live. Fixed: `deleteBookingLinkCascade` removes booking
  rows + revokes tokens.
- **DATA P3** — the audit IP/UA hash was an *unsalted* SHA-256 (reversible for a
  low-entropy IPv4 = pseudonymization theater). Fixed: HMAC-keyed.
- **CODE (HIGH)** — concurrent any-order signers lost updates via a blind `put`
  (stuck `partially_signed`, certificate never fired). Fixed: a CAS retry loop on
  the sign-request transition (mirrors the booking claim CAS); completion side
  effects fire exactly once.
- **CODE** — node-driven `requestSignature` emailed a schemeless `/sign/<token>`
  link when no public origin is configured. Fixed: skip the invite (log) when the
  base URL is empty.
- **UX (HIGH)** — public confirmation CTAs used `a.btn-primary` / bare
  `a.secondary` (no CSS → unstyled links). Fixed to `btn` / `btn secondary`.
- **UX** — index-keyed signer rows (mis-reconcile on remove) → stable ids;
  weekday-picker `role=group`; step-focus management on public flow transitions.

**Deferred (recorded, not blocking):** a retention sweep for `cancelled`/long-past
`confirmed` bookings + terminal (`completed`/`voided`/`declined`) sign requests
(DATA P4 — growth is bounded today by the per-link daily cap + the per-org
sign-request count cap); status-chip glyphs + shaped skeleton rows on the operator
trackers (UX polish); and the P3 external-provider `initiate` contract + webhook
route + connection pack.

## Alternatives considered

- **Integrate Calendly + DocuSign only (the gap doc's "connector-style" suggestion) — REJECTED for
  the core.** A white-label platform (ADR 0366/0367) cannot make its scheduling and signing story a
  branded third-party redirect with third-party pricing and data residency. Native booking + native
  click-to-sign keep the visitor/signer on the operator's domain. The connector is retained as a
  *later* seam (P3) for the qualified-signature use, not as the v1 core.
- **Full eIDAS / qualified electronic signatures — REJECTED for v1.** Requires a trust-service
  provider, certificate issuance, and government-ID verification — a platform unto itself, disproportionate
  to the target internal/SMB use. Explicitly out of scope with an honest legal statement; the P3
  connector seam is the path if a deployment needs it.
- **Ride the forms `public-forms` submit + submission-sink seam for booking — REJECTED.** Forms'
  submit is fire-and-forget capture; a booking must compute live slots and **atomically claim** one
  (double-book prevention), which a `FormDef` cannot express. Booking reuses forms' public-surface
  DISCIPLINE and `PublicFormRenderer` visuals, but owns its own claim route. (E-sign likewise: it's a
  stateful multi-party request, not a one-shot submission.)
- **Reuse the `schedulingService` cron job store for availability — REJECTED.** That store is for
  *fired* schedules (a cadence that triggers a run); a booking link is a published availability
  surface, not a job. It borrows the store's tz convention, not the store.
- **New top-level `booking` / `esign` feature packages — REJECTED.** Both are CRM depth (they create
  CRM contacts/meetings and sign CRM/commerce artifacts); a separate toggle would fragment the CRM
  surface and duplicate its RBAC/visibility plumbing. One `crm` toggle, two optional sub-settings.

## Open questions

1. **External calendar sync (Google/Microsoft) — DEFER.** v1 booking writes a CRM meeting activity +
   sends an ICS the visitor imports; it does NOT read the owner's live Google/Outlook free-busy to
   avoid double-booking against external events. A `campaign-connectors`/OAuth-vault-backed free-busy
   read is a natural P4 (the ad-connector OAuth spine already exists) — deferred until a deployment
   needs true calendar-conflict avoidance.
2. **Group / round-robin booking — DEFER.** v1 is single-owner (one link → one person's availability).
   Round-robin across a team and group (multi-attendee) events are a later extension of the
   availability model (an owner *set* + an assignment policy); the entity leaves room (`ownerUserId`
   could generalize to `ownerSubject` like the schedule store did) but v1 does not build it.
3. **Signer identity beyond token possession.** v1 = possession of the emailed token (the commerce
   precedent). An optional email-OTP step before signing (a stronger identity assertion, still
   pre-eIDAS) is a possible P2.5 if internal policy needs it — noted, not built.
4. **Payment-at-booking.** Charging for a booked slot (a paid consultation) would compose commerce
   checkout into the claim path. Out of scope v1; the claim path is the natural insertion point later.

## RFC verdict

**No RFC.** Both surfaces are host-extension routes under `/v1/host/openwop-app/*`
(`public-book`, `public-sign`), tenant-from-resource, adding no run-event field, capability flag,
event type, endpoint contract on the wire, or normative `MUST`. Per CLAUDE.md ("Host-extension routes
under `/v1/host/openwop-app/*` are non-normative and never touch the wire — they never need an RFC")
and FEATURES.md § "Adding a feature", this is host work only. The node-pack bump, KV entities, and
capability-token reuse are all existing host seams.

---

## Correction note — visitor-surface upgrade (2026-07-24, `docs/steward/UX_UPGRADE-crm-public.md`)

A competitive UX benchmark of the public booking + signing surfaces against
Calendly and Cal.com graded them **Interaction C+**, with a11y, designed states
and dark mode already at or above the market. Catalog, matrix and ranked gaps
B-G1–B-G3 / S-G1–S-G2 are in `docs/steward/UX_UPGRADE-crm-public.md`.

**B-G1 — times now render in the VISITOR's time zone by default.** §a's
"persistent timezone anchor" signature was the right instinct pointed at the
wrong zone: it anchored on the HOST's, so a visitor in Tokyo booking a New York
host had to convert in their head at the single highest-risk moment in
scheduling. Calendly detects the invitee's zone from device/browser and presents
slots adjusted to the viewer's region, with a dropdown to change it. We now do
the same, and:

- the switcher appears **only when there is a choice** (a visitor already in the
  host's zone still sees the plain anchor note, not a one-option select);
- the anchor is preserved and strengthened — every view says *whose* zone it is;
- the confirmation states the host's time as well when the visitor is reading
  their own, since cross-zone bookings are where "I said 2pm" goes wrong.

This cannot mis-book: a slot is a UTC instant and only its rendering changes.
(Calendly's own guidance to lock the zone for *in-person* events is noted; our
links carry a `location`, so that is the natural place for a future
lock-to-location option.)

**S-G1 — the signer now keeps a copy.** §b let someone sign a legally-scoped
agreement and be left holding nothing. The done state offers a download composed
from the markdown they were shown, who signed, the legal notice they accepted,
and the **server's** signature instant — for which `signRequest()` now returns
`signedAt` (it already computed it for the durable record). It is offered only to
the session that did the signing: a returning signer has no signature instant to
cite, and a copy dated by their own browser clock would be a fabricated record,
not a record.

**B-G2 — the details form moved onto `ui/Field`** with per-field errors. It also
gained `noValidate`, which was a latent defect: with native `required`/`type=email`
and no `noValidate`, the browser's constraint bubble fires first and the app's
own messages can never appear — and the native bubble is neither localized to the
app's locale nor associated with the control for a screen reader. This matches
the posture the shared `PublicFormRenderer` already took.

Deferred with reasons: a month-grid day picker (B-G3 — the chip row degrades
gradually and is fine at the default window; a scale gap, not a defect), and a
"read to the end" gate before signing (S-G2 — a hard scroll gate has real
accessibility hazards for linear screen-reader reading and for short documents,
so it wants a deliberate decision rather than a drive-by).
