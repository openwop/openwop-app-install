# ADR 1024 — Customer data platform: consented collection, bounded egress, erasure that reaches every copy

Status: Accepted — P1 implemented (row 73, #5473, 2026-11-04); P2 (subject-eraser seam) implemented in its own PR; P3 (CDP collect seam) pending, its own PR

Date: 2026-11-01 · Features: `cdp`, `destination-sync`, `campaign-journeys` (all extensions;
every toggle id unchanged) · Feature loop round 2, row 73 · Extends ADR 0262 (CDP graduation,
Gate 0), ADR 0266 (destination sync), ADR 0269 (event collection), ADR 0289 (openwop-host
egress), ADR 0292 (warehouse load), ADR 0222/0955 (journeys), ADR 0381 + ADR 0464 (subject
erasure), ADR 1020 P1 (noop-terminal shape) · Rides RFC 0128 (Accepted); no new RFC

## Context

Row 73's workflows grade (`docs/steward/workflows-assessment/2026-11-01-cdp-row73.md`,
`CDP2WF-*`) graded the three packages as one unit for the first time, on `origin/main` @
`061186e50`. The doctrine holds (every workflow is a chain pack; no pins). The row rubric added
five Blocker classes, and eight findings land in them:

- **Write authz.** Every CDP write route (`cdp/routes.ts:96-165`) and every destination-sync
  route (`destination-sync/routes.ts:39-141`) checks only the toggle. A workspace Viewer
  collects events, registers schemas, and creates, edits or deletes a sync, including the
  `peerIngestUrl` it egresses to. The chat tools check only that an acting user exists
  (`destination-sync/agentTools.ts:84,98,135`). (`CDP2WF-1`, `-5`)
- **Forged events.** `/cdp/collect` accepts `funnel.*` and `kicktodo.*` event types, which
  experiment units, funnel stats and lead-intel read as first-party truth
  (`funnels/experimentSurface.ts:93`, `funnels/funnelStats.ts:221-226`,
  `crm/leadIntel/signals.ts:62-66`). (`CDP2WF-2`)
- **Consent at ingest.** `collectEvent` checks no consent and records no purpose
  (`cdp/collectService.ts:37-74`), while ADR 0269 §1 states `/cdp/collect` is consent-gated.
  (`CDP2WF-3`)
- **Egress consent.** `permittedPurposes:[]` ("no onward use") is honoured on the onward path
  only; the warehouse path, `/prepare` and the surface `prepare` ship it
  (`destinationSyncService.ts:142-160,232`). An absent or malformed label is "no constraint"
  (`cdp/purposeLabels.ts:23-24,73`), and a `narrowTo` that narrows to `[]` still POSTs.
  (`CDP2WF-4`)
- **Egress approval.** A warehouse-load approval keys on `(tenant, sync, dataset, table,
  cursor)` (`warehouseLoadService.ts:75-77,199`): in batch/event mode the cursor never moves,
  so one approval admits every later load of any rows. And the inbox cannot approve it:
  `'warehouse-load' → 'run-proposal'` (`host/approvalDecision.ts:483`) throws "Proposing agent
  no longer exists" on the row's `rosterId:''` (`approvalService.ts:1615`). (`CDP2WF-6`)
- **Erasure reach.** `resolveCrmSubjectKeys` returns only the surviving contact
  (`crm/erasure.ts:405-413`), so analytics sessions, CDP events and enrollments keyed on a
  merged-away contact survive a DSAR that reports clean (`CDP2WF-7`). `cdp:segment-snapshot`
  and `campaign-journeys:enrollment` hold contact ids outside every eraser (`CDP2WF-8`).

And one High the lead asked about: journeys **fail the run** for a normal stop. `enroll`
fails `not_eligible`, `already_enrolled` and `superseded`
(`packs/feature.campaign-journeys.nodes/index.mjs:61-62,78-81`). That is not the #5443
`all_terminals_skipped` path (those chains always route `eligible:false` with
`stopped:'suppressed'`, so the 2026-10-31 static list is a false positive); it is an older node
failure, against the J955WF-12 ruling that an unsubscribe is a correct end. (`CDP2WF-9`)

## Boundaries audit

- **One write predicate.** `requireTenantWrite(req)` (`features/featureRoute.ts:417`, built on
  `callerHoldsTenantScope`, which honours an `owk_` key's declared scopes at `:405`) on routes;
  the req-less `assertTenantScope(tenant, actingUser, scope, {personalTenant})` in chat tools,
  as CRM's `tenantGate` does (`crm/agentTools.ts:150-163`). Nothing new.
- **One consent decision.** `isAllowed` / `isPermittedForPurpose`
  (`consent/consentService.ts:547,1093`) already order necessary → strict → tombstone → toggle
  off (permit) → record → policy. Collection composes it; it does not re-derive a posture.
- **One purpose vocabulary.** RFC 0128 labels and `cdp/purposeLabels.ts`
  (`normalizeLabel`, `intersectLabels`, `isNoOnwardUse`). Egress keeps that module; it changes
  only what an unreadable label means for egress.
- **One approval queue.** The warehouse approval stays a `PendingApproval` row; it moves to
  the `campaign-spend` disposition (resolve + audit, no dispatch) that `commerce-spend` already
  uses (`approvalDecision.ts:470-482`), and gains a kind eligibility check through
  `registerApprovalEligibility` (`approvalService.ts:1088`), the seam `compensationRuntime`
  uses for its separation of duties.
- **One erasure fan-out.** `resolveSubjectKeys` (`host/subjectErasure.ts`) is a two-hop closure
  over registered resolvers. Adding merged-away ids to the CRM resolver's hop-1 output reaches
  analytics' sessions in hop 2 with no new seam. New erasers register through
  `registerSubjectEraser` and the manifest (`EXPECTED_SUBJECT_ERASERS`).
- **One noop terminal.** ADR 1020 P1's `core.flow.noop` + complementary `truthy`/`falsy`
  pair. No engine change, no RFC 0134 revision.
- **No new route, toggle, envelope, agent, capability or wire field.**

## Decisions

> **Pre-code `/architect` pass (2026-11-02, independent agent): 5 Blockers, 6 High, 4 Medium in
> the first draft of this section, all folded in below.** The ones worth remembering:
> **(B1)** the first D2 dropped every record without a purpose label on egress. No code stamps
> `permittedPurposes` on a record today (only `demoCdpSeed.ts:171-172` and conformance seams),
> so every warehouse load and onward batch would have shipped zero rows, and RFC 0128 §1 says an
> absent label is "unlabelled (no constraint asserted)", not `[]`. **(B2)** the first D4.3 let a
> caller pick `purpose:'transactional'`, which maps to `necessary` and returns allowed before
> the tombstone check (`consentService.ts:348,1128`). **(B3)** the first D3 named an audit verb
> the `campaign-spend` finalizer cannot emit (it hard-codes `campaign.ads.spend-*` with ad
> fields, `approvalDecision.ts:646,876`). **(B4)** the first D5 exported a merge walk that
> ignores `unmergedAt` and does not check `mergedInto === survivor` (`crm/erasure.ts:106-121`),
> so A merged into B, unmerged, then merged into C would be erased with B. **(B5)** the first
> D3 separation of duties locked a solo owner out of their own loads and stopped a submitter
> from withdrawing one.

### D1 — Writes need `workspace:write` (CDP and destination sync)

`requireTenantWrite(req)` after `requireEnabled` on: `POST /cdp/collect`, `/collect/batch`,
`/collect/import`, `POST /cdp/event-schemas` (PR A), and destination-sync create, update,
delete, `prepare` and `advance` (P1). `dry-run` stays read: it maps one caller-supplied sample.
`prepare` is a write for a different reason than "it returns PII": after D2.4 its `dropped`
count tells the caller which subjects were erased, which a reader of the workspace must not
learn by probing. Reads (`GET` list/one) need `workspace:read` through
`callerHoldsTenantScope`. Measured callers: the SPA calls no CDP or destination-sync write
route (`cdpClient.ts` is GET-only); a personal workspace (incl. `anon:`) and the wildcard
operator pass `callerHoldsTenantScope`; `owk_` keys already need `workspace:write` for POSTs at
`keyVendorGate.ts:81`.

Destination-sync chat tools call the same predicate through one `toolGate(scope, needed)`
(toggle + ADR 0419 entitlement + acting user + `assertTenantScope`, the CRM `tenantGate`
shape): `workspace:read` for `list` and `dry-run`, `workspace:write` for `run`.

`POST /cdp/event-schemas` needs `host:org:manage` (the built-in admin/owner scope) on top of
`workspace:write`: a schema decides what every later collect accepts.

### D2 — Egress goes only to the configured destination, and never ships what a label forbids

1. `selectEligible` drops `permittedPurposes:[]` ("no onward use") **by default** on every
   path: warehouse, `/prepare`, the surface `prepare`, onward. The `dropNoOnwardUse` option is
   removed (the seeder `demoCdpSeed.ts:170-173` changes with it).
2. An **absent** label stays "no constraint", as RFC 0128 §1 and `purposeLabels.ts:11-13` say.
   A **present but malformed** label (not an array of strings) is dropped on egress: it asserted
   a constraint nobody can read. A per-sync strict mode is filed, not built (`CDP2WF-25`).
3. After `narrowTo`, an envelope whose onward label is `[]` is dropped.
4. Before egress, each record is checked against the erasure barrier: the value of a field in
   `COLLECTED_IDENTITY_KEYS`, or of a field whose name `looksLikePiiName` AND whose value is
   email- or phone-shaped (identity-class only, pass-2 N4), through `isErasureTombstoned` in
   every form (`collectedIdentityForms`), memoised per batch. A tombstoned subject is dropped
   and counted in `dropped`, never named (`CDP2WF-16`).
5. The onward URL is bound to the stored sync. The http node's `config.url` cannot read an
   output port (`onwardSyncWorkflow.ts`), so it stays the run-variable template
   `{{inputs.peerIngestUrl}}`. (A whole-value `{{params.X}}` in CONFIG would freeze to
   `undefined` under the same-id deferred expansion, the ADR 1020 `CS70WF-1` trap.)
   `peerIngestUrl` becomes a declared chain parameter, bound as `{{params.peerIngestUrl}}` into
   a new `prepare-onward` input (node 1.1.0), so the `/` picker asks for it and param liveness
   holds; both read the same run variable. `prepare-onward` fails `destination_mismatch` when
   it differs from the stored `sync.peerIngestUrl` after normalisation (WHATWG URL parsing
   lower-cases the scheme and host and drops a default port; one trailing `/` is trimmed), and
   `not_configured` when the sync has no URL. The http node runs only after it succeeds.
   `onwardSyncWorkflow.ts` shrinks to the id + role map (the ADR 1020 D7 shape), so the pack
   is the one definition.
6. `peerIngestUrl` refuses userinfo and a query string at create (credentials belong in a
   connection, never a URL).

Filed, not in scope: `CDP2WF-17` (the chat `run` tool starts onward egress with model-supplied
records and no human gate; after D1 it needs `workspace:write`, the warehouse half is
approval-gated by D3, and the onward half is dark in every deploy config, so the gate is the
follow-up that turns the onward leg on). `CDP2WF-18`: fan-out over every envelope, a credentialed peer POST, a
non-2xx failure gate and an `advance` node. The onward leg also needs
`OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED=true`, which no deploy config sets.

### D3 — A warehouse approval is bound to its batch, and a second person decides it

1. The batch key adds `rowsDigest = sha256(canonicalize(rows))` over the built
   `[insertId, json]` rows (`host/canonicalJson.ts`, the audit chain's key-sorted form; insertIds
   are a pure function of sync, record key and cursor marker, and the canonical form fixes key
   order, so an approve-then-rerun of the same records rebuilds the same digest and a `:fork`
   reuses the decision). The approval row stores `rowsDigest`; `allow` requires equality.
2. When a new digest mints for the same `(sync, dataset, table, cursor)` slot, the slot's
   previous pending row is superseded, so changed batches do not pile up. A slot index row
   (keyed byte-for-byte by the pre-ADR-1024 batch key, so a row minted before this change is
   found too) moves by CAS (pass-2 N3). The previous row is resolved by the system
   (`resolveApproval`, not `rejectApproval`: there is no human decider) to `rejected` with
   the governance chain outcome `superseded` (the CMS precedent), the inbox is signalled,
   and that row's batch map entry is deleted, so the same rows coming back ask again instead
   of finding a rejection forever (pass-2 N2). A row with no `rowsDigest` (pre-change) is
   never `allow`ed.
3. `warehouse-load` gets **its own disposition** in `approvalDecision.ts`: resolve + audit
   (`cdp.warehouse-load.approved` / `.rejected`, fields `syncId`, `dataset`, `table`,
   `rowCount`), no dispatch, no waiter resume (the node returns `requires_approval` and never
   suspends, `feature.destination-sync.nodes/index.mjs:123-126`). It has no reject side
   effects, so the SLA expiry rung can still expire it.
4. The row records `submitters: [actingUserId]` when the load had an acting user. The
   destination-sync feature registers an eligibility check (`registerApprovalEligibility`, which
   runs on the approve and the reject lane): the decider holds `workspace:write`; and **on
   approve**, the decider is not a submitter (separation of duties, Q3). A submitter may reject
   (withdraw) their own load. The check learns the outcome through a new optional `outcome`
   field on the eligibility opts, threaded from both lanes.
5. Escapes: the wildcard operator (`opts.isOperator`) and the owner of a personal workspace
   (`opts.isPersonalOwner`) may approve their own load: there is no second person to ask. In a
   shared workspace a second `workspace:write` member decides; a shared workspace with a
   single writer therefore cannot approve its own loads (accepted, pass-2 Low: add a second
   writer, or an operator decides). A load with no acting user records no submitter.
6. The redactor for `warehouse-load` gains `idFields: ['submitters']`.

### D4 — Collection: write gate, reserved namespaces, consent and purpose (PR A)

1. D1's gate.
2. **Reserved namespaces.** `collectEvent` gains `source: 'http' | 'first-party'`, **default
   `'http'`** so a caller that forgets it fails closed. After the trim, an `http` event whose
   type starts `funnel.`, `kicktodo.` or `forms.` is refused 422 `reserved_event_type`
   (`forms.` is reserved for a future owner; nothing writes it today). The in-process callers
   (census in the PR body) pass `'first-party'`. `collectEventBatch` and `importCsv` pass their
   own caller's source through.
3. **Consent and purpose (Q1 = a), `http` source only.** The event records `purpose`
   (caller-supplied; one of `analytics`, `personalization`, `advertising`, `marketing-email`,
   `marketing-sms`, `marketing-push`; default `analytics`; `transactional` is refused, since
   collection is never a necessary-category act). When the payload names an identity, consent
   must allow that purpose for it through `isPermittedForPurpose`, else 403
   `consent_required`. The consent toggle off is permissive inside the consent module; the
   tombstone barrier runs regardless (`visitorEventIndex.ts:52-59`). First-party callers keep
   their own gates.

   > **Open interpretation (pass-2 N1, 2026-11-02).** Which keys are "an identity"? The user's
   > answer reads "names an identity (contact/visitor/session key)" and "anonymous no-identity
   > events pass". The lead reads "anonymous events pass" as governing: a visitor/session id
   > alone is anonymous, so only person keys (`contactId`, `userId`, `subjectKey`) are
   > checked. The implementer reads the parenthesis as listing visitor and session keys as
   > identities. Pass 2's objection to the first draft stands either way: routing visitor keys
   > through `visitorAnalyticsAllowed` with `region: null` treats every visitor as regulated
   > (opt-in), refusing every anonymous SDK event in a consent-on tenant; if visitor keys are
   > checked, it must be `isPermittedForPurpose` (the tenant policy default, no region guess).
   > Sent back to the user through the lead; PR A implements whichever they confirm.
4. **Schema registry bounds (`CDP2WF-11`).** New registrations: at most 20 versions per event
   type and 64 KB per schema; `pattern`/`patternProperties` refused (this host has no RE2;
   ajv uses JS regexes). Already-stored schemas keep compiling (refusing them would 422 every
   ingest of that type); the stored-pattern residual is filed with its prod count. A type
   already over 20 versions keeps them and accepts no more. The compiled validator is cached by
   `(tenant, eventType, version)` in a bounded LRU.
5. **Masked reads (`CDP2WF-12`).** `/collected-events` and `/merge-events` mask PII for the
   callers `/identity/resolve` masks, through `maskRecordForRead`.
6. **Value-shaped PII (`CDP2WF-21`).** Ingest adds a field to `piiFields` when its string value
   is email- or E.164-shaped. That feeds the tombstone barrier and redaction only; it is **not**
   an identity for D4.3 (a `supportEmail` field must not trigger a consent refusal).

### D5 — Erasure reaches merged-away contacts and the two unregistered stores (PR B)

1. The merge walk is corrected first: it reads only merge events with no `unmergedAt` and keeps
   a source only when `row.mergedInto === survivor` (`crm/erasure.ts:106-121`). A witness
   covers merge, unmerge, re-merge elsewhere.
2. `resolveCrmSubjectKeys` returns, for an email or phone key, the resolved contact **and**
   its merged-away contacts; for a key that is a live contact id of this tenant, its
   merged-away contacts. Hop 2 of `resolveSubjectKeys` then reaches their analytics sessions.
   > **Residual (grade-code M2, filed `CDP2WF-27`).** This holds for a DSAR keyed by email, phone
   > or contact id. Keyed by a session or a userId, the merged-away ids first appear in hop 2 and
   > are never hopped again, so their sessions are not reached. A bounded fixpoint over newly
   > derived `crm:` keys is the cure.
3. A CDP eraser for `cdp:segment-snapshot` removes a contact id from every snapshot's
   `memberIds` in the tenant (CAS per row).
4. A campaign-journeys eraser for `campaign-journeys:enrollment` deletes rows whose
   `contactId` equals the key (contact-id keys only; emails reach it through the resolver),
   every key shape including `@org` and `@grp`.
5. An `onCrmRecordMerged` handler **copies** a source contact's enrollments to the survivor
   when the survivor has none for that journey, marking each copy
   `copiedFromMergeEventId`. Unmerge removes the copies it made. `@grp` exclusivity rows are not
   copied: they arbitrate at the next enroll, and the copied journey rows already stop a
   repeat. The census reason at `subject-erasure-feature-stores.test.ts:412` becomes true.

   > **Correction (P2 implementation, grade-code M1, 2026-11-03).** Two facts in this item are
   > wrong. (a) `@grp` slot rows ARE copied, when the survivor holds no slot in that group:
   > `enrollArbitrated` writes ONLY the slot row for a grouped journey, so there is no per-journey
   > row to "already stop a repeat", and not copying the slot would re-arm the journey. (b) The
   > field is `copiedFromContactId` (the immediate source), not `copiedFromMergeEventId`: the
   > merge hook's event carries no merge-event id. Known limit, filed `CDP2WF-28`: in a chain
   > A→B→C, unmerging A from B removes B's copies but leaves the A-origin copies on C.
6. `recordMergeEvent` logs at error and retries once instead of swallowing (`CDP2WF-14`).
7. Census in the PR body: every eraser fed by the CRM resolver's keys.

### D6 — Journeys end cleanly for normal stops (`CDP2WF-9`, `-10`, `-19`)

1. `enroll` (node 1.2.0) takes `stopOnIneligible: true`. With it, a closed set of normal
   stops succeeds `{ enrolled: false, stopped: <reason> }`: `consent`, `topic_opt_out`,
   `suppressed`, `no_address`, `no_email`, `contact_not_found` (the contact was erased or
   deleted), `frequency_cap` (the person has had enough mail), plus `already_enrolled` and
   `superseded` from the enrollment ledger. Everything else still fails: `*_unreadable`,
   `deliverability_paused`, `client_required`, validation, and `quiet_hours` (that one should
   WAIT, not end the journey; filed `CDP2WF-26`). The set (`NORMAL_STOP_REASONS` in the node
   pack) is pinned against `CHANNEL_INELIGIBLE_REASONS` plus the legacy `no_email` by a test
   that refuses an unclassified reason.
2. `eligibility` and `channel-eligibility` accept `stopOnIneligible` with the same set;
   `stopOnSuppressed` stays as an alias for the one reason it covers.
3. Every journey chain sets the flag, routes `truthy enrolled → gate1` and `falsy enrolled →`
   a `core.flow.noop` terminal `not-enrolled`, and replaces each `equals stopped "suppressed"`
   edge with `falsy eligible`. welcome-email-sms gets a `channel-eligibility(sms)` with the flag
   before `send-sms`. Chain versions bump; tenant-instantiated copies keep their own defs (a
   re-instantiate picks up the new shape), and the node change is additive (flag off = today).
4. segment-winback forwards `senderEmail`/`body` (the child's names), declares `segmentId` as
   a parameter, and its witness runs the real re-engage child. The `childWorkflowId` →
   `subChainRef` conversion is filed (`CDP2WF-10b`).
5. `DELETE`/`GET /enrollments` require `workspace:write`/`workspace:read` when no client org is
   named (`campaign-journeys/routes.ts:44-48`).
6. ~~`enroll`'s own retry: an existing row whose `runId` is this run reads as `enrolled:true`.~~
   **Withdrawn during implementation (2026-11-02).** The existing concurrency witness
   (`campaign-journeys.test.ts`, AUDIT-2: eight simultaneous enrolls of one pair under ONE
   runId yield one winner) went red, and it was right to: the ledger cannot tell a sequential
   retry of a run from a concurrent duplicate execution of the same run, and the second is a
   double send. With D6.1 a lost retry now ENDS the journey cleanly (`already_enrolled`)
   instead of failing it, which costs the person the journey rather than sending twice.
   Filed `CDP2WF-20b`: the cure is an execution fence (one live attempt per node per run), not
   a ledger rule.

## Alternatives weighed

- **Change the engine so an all-skipped run completes.** Rejected: RFC 0134 semantics; and the
  journeys defect is a node failure, not the terminal rule.
- **Warehouse approval keyed by run.** Rejected: a `:fork` would re-ask, and two runs with the
  same rows should share one decision. A content digest is fork-stable and exact.
- **Move warehouse approvals to an admin-only audience.** Rejected by Q3: `workspace:write` +
  separation of duties matches the other money/egress gates.
- **Drop unlabelled records on egress.** Rejected (pre-code B1): nothing labels records yet, so
  every sync would ship nothing, and RFC 0128 defines absence as no constraint.
- **Reuse the `campaign-spend` finalizer for warehouse loads.** Rejected (pre-code B3): its audit
  line names an ad budget, the lesson `approvalDecision.ts:529-535` already records.
- **Bind the onward URL by edge.** Not possible: config cannot read an output port. Equality
  check at `prepare-onward` is the honest bound.
- **Refuse every HTTP collect of identity-bearing events.** Rejected: the generic collect is a
  supported first-party ingest (SDKs); consent decides it, not the transport.

## Phased plan

| Phase | PR | Content | Gaps |
|---|---|---|---|
| P1 | row 73 main | D1 (destination-sync half), D2, D3, D6 | `CDP2WF-4,-5,-6,-9,-10,-16,-19,-20 (enroll retry),-22` |
| P2 | own PR (subject-eraser seam) | D5 | `CDP2WF-7,-8,-14` |
| P3 | own PR (CDP collect seam) | D1 (CDP half), D4 | `CDP2WF-1,-2,-3,-11,-12,-21` |

Order P1 → P2 → P3; each branches from `origin/main`. P3's consent half waits on Q1.

## Evaluation matrix

1. Feature packages: changes stay in `features/cdp`, `features/destination-sync`,
   `features/campaign-journeys`, `features/crm/erasure.ts` (owner of the resolver), plus one
   map line in `host/approvalDecision.ts` and a field on `createWarehouseLoadApproval`.
2. Toggles: unchanged ids and defaults (`cdp`, `destination-sync`, `campaign-journeys` all
   `off`, tenant-bucketed; demo tenants on via `demoProvision.ts:41-45`).
3. `ctx.<feature>`: `destination-sync` surface `prepare` drops by default (D2.1);
   `campaign-journeys` surface unchanged.
4. Node packs: `feature.destination-sync.nodes` (prepare-onward destination check),
   `feature.campaign-journeys.nodes` (stopOnIneligible) minor bumps; chain packs bump.
5. Envelopes: none. 6. Agent packs: none (destination-sync tools gain the predicate).
7. Public surface: none added; the public funnel `?vk=` stays row 72's `FN72WF-14`.
8. RBAC: D1, D3.3. 9. Replay: rowsDigest is fork-stable; noop terminals deterministic.
10. Frontend: none required by P1; the console's collected-events view shows masked values
    after P3 (`CdpConsolePage.tsx`), copy in lazy namespaces.

## RFC verdict

Host extension. Labels ride RFC 0128 (Accepted); no wire field, event type or capability
changes.

## Open questions

- [x] Q1 (user, 2026-11-01) — consent at collect: (a) per-identity purpose consent when an
  identity is named and the consent toggle is on; anonymous events pass; the purpose is stored.
- [x] Q2 (user, 2026-11-01) — no default retention window for `cdp:collected-event`; it stays
  tenant policy and `CDP2WF-15` is filed.
- [x] Q3 — warehouse approval: `campaign-spend` disposition, `workspace:write`, no
  self-approval (lead decision, openwop-app-88, 2026-11-01).

## Implementation record

### P1 — destination sync + journeys (row 73 main PR)

| Decision | Commit | Witness (each guard sabotage-checked RED, applied and reverted in one step) |
|---|---|---|
| D1 (destination-sync half) | `f85e88479` | `adr1024-destination-sync-egress` D1 (routes, chat tools) |
| D2.1–D2.6 | `f85e88479`, `d15ff174f` | `adr1024-destination-sync-egress` D2 (`[]`, malformed, erased incl. folded visitor key, narrowTo→`[]`, URL mismatch + normalisation, creds/query refused) |
| D3.1–D3.6 | `f85e88479`, `d15ff174f` | `adr1024-destination-sync-egress` D3 (digest binding, supersede + re-ask, same-rows race → one approval, inbox decides, SoD on approve only, decider scope, reject-lane outcome) |
| D6.1–D6.5 | `b4cd6ddb2`, `0f878afb8` | `adr1024-journeys-normal-stops` (reason classification, real handlers, all 5 enrolling chains through the real loader + scheduler, enrollments route, winback contract); `workflow-chain-campaign-journeys-execution`, `adr0955-p5-blueprints` (end to end, flipped from `failed` to `completed`) |
| D6.6 | withdrawn | see D6.6 |
| grade-ux H2/M3/M4 | `0f878afb8` | `warehouseLoadCard.test.tsx` |

Closing grades (independent graders, 2026-11-02): grade-code **B** (from C; no Blocker;
M1/M2/M4/M5 fixed after the grade, not re-graded); grade-ux **C** (no frontend in the first
cut; H1/H2/M3/M4 fixed after, not re-graded). Filed, with reasons, in
`docs/steward/workflows-assessment/2026-11-01-cdp-row73.md`.

Prod measurement (lead, read-only, 2026-11-02): 0 warehouse-load approvals and 0 runs of any
CDP/journeys/destination chain, so the D3 inbox fix and D6 run-outcome change move no existing
row. 2 real `crm:merge-event` rows (2 tenants, never unmerged) and 326 `cdp:contact-ident` rows
make P2 a fix to live data, not a latent one.

### P2 — subject-eraser seam (its own PR, branch `fl2-73-eraser`)

| Decision | Commit | Witness (sabotage-checked RED) |
|---|---|---|
| D5.1 walk: skip unmerged events, require `mergedInto === survivor` | `6c448f1c5` | `adr1024-erasure-reach` D5.1: merge, unmerge, re-merge elsewhere. A named double guard, red only as a pair |
| D5.2 resolver returns merged-away contacts | `6c448f1c5` | `adr1024-erasure-reach` D5.2: real `mergeContacts` + `eraseSubject` by the survivor's email reaches the session link, events, enrollment and snapshot |
| D5.3 segment-snapshot eraser + the daemon keeps erased ids out | `6c448f1c5`, `72a89ab27` | `adr1024-erasure-reach` D5.3: the next pass leaves the erased id out |
| D5.4 enrollment eraser, `RECORDED_DEBT` 7 → 6 | `6c448f1c5` | `adr1024-erasure-reach`; `subject-erasure-feature-stores`, `subject-eraser-manifest` |
| D5.5 merge copy, unmerge removal | `6c448f1c5` | `adr1024-erasure-reach` D5.5 |
| D5.6 `recordMergeEvent` logs and retries | `6c448f1c5` | log path only (not witnessed by a test) |

Independent grade-code: **B** (no Blocker). H1 (the daemon put an erased id straight back), M3
(per-key full scans) and L2 (a false CAS failure) were then fixed. Filed: `CDP2WF-27/-28`, and
the census cannot list `cdp:segment-snapshot` (an id-array store the field census cannot
see), so the store's coverage is witnessed only by `adr1024-erasure-reach`.

### Closing re-grade of P1 (independent, read-only, head `3f83b10fc`, 2026-11-03)

grade-code **B → A−** (every prior fix verified; new Lows `CDP2CD-5..9`). grade-ux **C → B+**
(H1/H2/M3/M4 verified; new Mediums `CDP2UX-5/-6`, Lows `CDP2UX-7..10`). Both are recorded in
`docs/steward/workflows-assessment/2026-11-01-cdp-row73.md`.

