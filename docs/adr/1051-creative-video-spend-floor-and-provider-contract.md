# ADR 1051 — creative video: spend floor, provider contract, likeness consent

Status: Accepted (P1 implemented 2026-11-03, PR pending; P2 not started)

| Field | Value |
|---|---|
| **Feature** | `creative-video` (+ `creative-video.t2v`), and the `ctx.callVideoGenerator` lane it owns (`host/hostCapabilityGates.ts` `videoGeneratorOwningFeatures`) |
| **Feature loop** | Round 2, row 83 (`docs/steward/FEATURE-LOOP-2026-10.md`) |
| **Builds on** | ADR 0404 (§b avatar, §P4 text-to-video), ADR 0411 (`callVideoGenerator`), ADR 0945 D7 (image-to-video), ADR 0832 (surface org floor), ADR 0106 (media budget), row 82's fix for the briefs reel (PR #5532, the same class of fix) |
| **RFC verdict** | Host work, **no new RFC**. Every route here is a `/v1/host/openwop-app/*` host extension; the node pack contract is unchanged in shape (new optional inputs only); `ctx.callVideoGenerator` keeps the accepted `host.aiProviders` result shape. |

## Context — what the grade found (2026-11-03, `origin/main` `ec97cbb21`)

Prod, read-only (2026-11-04T00:14Z): 0 video jobs, 0 budget rows, 0 HeyGen/Runway
connections, 0 video assets; both toggles `beta`; **no video env override is set**,
so the shipped defaults are what prod would run. Every finding below is **latent**.

- **CV83WF-1 (Blocker) — a reader can spend through the workflow surface.** The
  feature registers no `orgPolicy`, so `generateVideo`, `textToVideo` and
  `imageToVideo` ask the ADR 0832 floor for `workspace:read`. The HTTP routes ask
  `workspace:write`. Same shape as row 82's `CB82WF-1`. The barrier today is only
  that a tenant-level Viewer cannot create runs; an org-scoped reader, a custom role
  with `runs:create`, and an actorless run caused by a reader all pass.
- **CV83WF-2 (Blocker) — text-to-video and image-to-video cannot succeed.** Measured
  against Runway's published OpenAPI (`docs.dev.runwayml.com/api`, info.version
  `2024-11-06`, read 2026-11-03; fixture saved under test fixtures):
  - the default base `https://api.runwayml.com` is not the API; the spec's server is
    `https://api.dev.runwayml.com`;
  - the default model `gen3a_turbo` is not in either endpoint's model set;
  - the ratio `1280:768` (and i2v's `768:1280`) is valid for no model;
  - `gen4.5`, the current default family, REQUIRES `duration`; we omit it unless asked;
  - task outputs are served from CloudFront (`https://dnznrvs05pmza.cloudfront.net/…`,
    per the outputs guide), but the result allowlist is `runwayml.com`, so a job the
    provider completed would be **charged and then fail terminally** at download.
  - the free-text `model` field lets any typo reach a paid submit.
- **CV83WF-3 (Blocker) — the spend cap is check-then-record.** `doSubmit` (and
  `callVideoGenerator`) read today's count, submit, then increment. N concurrent
  distinct jobs all read the same count and all pass. The default cap is `0` =
  uncapped and prod sets none.
- **CV83WF-4 (High) — outputs recorded that were not produced.** `callVideoGenerator`
  returns the clamped REQUESTED `width/height/durationSeconds` as the video's, and
  maps 1280×768 to `16:9` while still reporting 1280×768. Row 82's D4 lesson.
- **CV83WF-5 (High) — likeness and voice consent is unrecorded.** Avatar mode takes a
  free-text `avatarId`/`voiceId`, which can be a custom avatar cloned from a real
  person. Nothing records whose likeness it is or that anyone affirmed consent.
- **CV83WF-6 (High) — a timed-out submit can be paid twice.** `request_failed` is
  retriable; when the POST reached the provider and only the response timed out, the
  next call re-claims and submits a second paid job, unmetered.
- **CV83WF-7 (Medium) — a missing connection writes a failed job row.** The claim row
  is written before the connection is known; `no_connection` then lands in the list.
- **CV83WF-8 (Medium) — DSAR.** `creative-video:job` sits in the actor-attribution debt
  ledger (`createdBy`, plus a prompt snippet that may quote a person).
- **CV83WF-9 (Medium) — doctrine.** No chain and no agent use the four nodes; they are
  reachable only by hand in the builder. Not a pinned workflow (the doctrine holds),
  but not chat-drivable either.
- UX: the job list and the error toast print raw codes (`no_connection`, `t2v_400`).

## Decision

> **Architect pass, 2026-11-03 (independent, before code): approve-with-corrections,
> 7 Blockers in this decision text, all folded in below.** The first draft (a) put
> the consent record in asset lineage, which `cleanLineage` drops and the media
> eraser never reaches; (b) closed only the `timedOut` path to a double payment,
> while a crash between POST and `putJob`, a 2xx without an id, a reset after send
> and a 5xx are all the same hazard; (c) released a reservation against whatever
> day it was at release time; (d) left `callVideoGenerator`'s release phase
> undefined; (e) kept a request hash that ignores ratio and the resolved
> model/duration; (f) let a run with no person reach the spend methods; (g) left
> the host kill switch off the workflow surface. Majors folded in: a node-input
> literal is not a person attesting (D5), the pseudonym was re-identifiable (D8),
> the debt ceiling must drop (D8), and polling used the reader's credential (D10).

### D1 — write floor and a person on every spend (CV83WF-1)
- `CREATIVE_VIDEO_SURFACE_POLICY.methodScopes`: `generateVideo`, `textToVideo`,
  `imageToVideo` → `workspace:write`, registered as the feature's `orgPolicy`
  (the creative-briefs precedent).
- The three spend methods refuse a run with **no person** (neither an acting user
  nor a causing member): `forbidden_scope`, before any row or reservation. The
  ADR 0832 floor passes such runs ("no person ⇒ no check"); spend needs someone
  who is accountable for it. Rows from a caused run record the causing member as
  `createdBy`, not `run:<id>`.
- The surface's spend methods check `creativeVideoEnabled()` like the routes.
- `getVideoStatus` stays `workspace:read`, said plainly: it never submits or
  reserves, but it can download up to 200 MiB, mint the media asset, use the org's
  storage capacity and write a fidelity verdict — all finishing a job a writer
  already paid for. A test names every surface method as read or write.

### D2 — the Runway contract, from the spec (CV83WF-2)
- Default base `https://api.dev.runwayml.com`; version header `2024-11-06`.
- `host/runwayModels.ts` is the ONE model table (a subset of the spec): t2v
  `gen4.5` (default), `veo3.1`, `veo3.1_fast`; i2v `gen4.5` (default), `gen4_turbo`,
  `veo3.1`, `veo3.1_fast`; each with its ratio set and duration rule. The page reads
  it from `GET …/video-models`; the pack text does not enumerate models.
- Defaults: ratio `1280:720` (i2v portrait still → `720:1280`); duration 5 s
  (`veo3.1*`: 6 s). Every request sends `ratio` and `duration`.
- An unknown model, a ratio the model does not take, or a duration outside its rule
  is `validation_error` (422) before the row, the reservation and the provider. A
  configured `OPENWOP_T2V_DEFAULT_MODEL` outside the table is refused per call
  (logged once per process).
- Result allowlist: `cloudfront.net` is added **only while the base is the default
  Runway base**; an operator override does not inherit it. Reason: the URL comes
  only from Runway's authenticated TLS response, the egress guard and 200 MiB cap
  still apply, and an exact pin on today's distribution turns a CDN rotation into
  "charged, then refused". Residual: a compromised provider could make us fetch any
  public CloudFront object up to the cap.
- A test pins the table, base and header against a saved fixture of the parsed spec.

### D3 — reserve before the paid call (CV83WF-3)
- `reserveMediaBudget(tenantId, 'video', units)` → `{ ok:false }` (over cap) or a
  token `{ dayKey, units, counted }`. One bounded CAS loop increments only if
  `used + units ≤ cap`; exhausting the loop is `exceeded` (video fails closed, as
  the read already does). Cap 0 returns `counted:false`.
- `releaseMediaBudget(token)` decrements exactly `token.dayKey` by `token.units`,
  and only when `counted`. A release can never touch another day or a counter that
  did not exist when the reservation was taken.
- The token is kept on the job row and released only on a **provably-not-taken**
  outcome (D6). `recordMediaUsage` is no longer called for video jobs.
- The counter is per **tenant**, shared by every org in the workspace and by the
  `callVideoGenerator` lane. Default cap: pending the lead (open questions). Until
  a default ships, the race is closed but the exposure is not, and CV83WF-3 stays
  tracked.
- `callVideoGenerator` uses the same reservation (P2). It releases only when
  Replicate's create did not return 2xx; `dispatchVideoReplicate` reports the
  phase it failed in. A timeout or failure while polling keeps the reservation.

### D4 — record what was produced (CV83WF-4) — P2
`host/mp4Probe.ts` walks the box tree (bounded, no decode): duration from the
**video track's** `mdhd`, width/height from its `tkhd` with the rotation matrix
applied; a fragmented file or a zero duration is unmeasured, never `0`.
`callVideoGenerator` returns measured values, or the requested ones with
`metadata.dimensionsMeasured:false`; the aspect ratio sent is in
`metadata.requestedAspectRatio`. A creative-video job records only what it
requested (`requested: { model, ratio, durationSec }`) in P1; nothing measured is
claimed until the probe lands.

### D5 — likeness and voice consent (CV83WF-5, the lead's decision A)
- Consent text version `cv-likeness-2026-11`, the sentence "I have the depicted
  person's consent to use their likeness and voice", shown verbatim (4 locales).
- **A person attests, never a definition.** The page's avatar form has a required
  checkbox; the route takes `likenessConsent: { attested: true, textVersion }`
  from the signed-in user and writes a **consent record** for
  `(tenant, org, user, avatarId, voiceId?, textVersion)` in
  `creative-video:likeness-consent`.
- The workflow lane takes NO attestation input. `generateVideo` requires a consent
  record made by the run's person (the acting user, else the causing member) for
  that org, avatar, voice and the current text version. None, a stale version, or
  no person → `likeness_consent_required` (422) before the row, the reservation and
  the provider. A literal in a saved workflow therefore attests nothing.
- The check runs before the request-hash lookup, so a dedup hit cannot skip it. The
  hash does not include the attestation; a second attesting person with identical
  inputs reuses the job.
- The job stores a snapshot `likenessConsent: { attestedBy, attestedAt, textVersion,
  avatarId, voiceId?, channel: 'route' | 'record' }`. The asset carries only a
  pointer, `lineage.likenessConsentJobId` (added to `MediaAssetLineage` and the
  `cleanLineage` allowlist), stamped on the dedup branch too when absent. No
  personal data sits on the asset.

  > **CORRECTED 2026-11-03 (grade-code CV83CD-4): the shape shipped differently.**
  > The asset carries a server-only, write-once facet
  > `lineage.likenessConsent: { jobId, textVersion, attestedAt, avatarId, voiceId? }`
  > (the lead's "on the asset too", minus the person), written through
  > `createAsset({likenessConsent})` / `stampLikenessConsentIfAbsent`, like
  > `suppliedBy`. It is NOT in `cleanLineage`, so no caller can set it, and a
  > patch keeps it. `attestedBy` lives on the job only.
  >
  > **And the record lane is the ACTING user's only (CV83CD-3).** The draft let a
  > caused run (`orgScopeSubject`) render on the causing member's record. ADR 0832
  > D3 says that field only narrows, and a consent record is a grant, so a caused
  > run now fails `likeness_consent_required`. Spend still needs *a* person (D1),
  > which the causing member satisfies: that is narrowing, not a grant.
- C (an org-admin allowlist of approved avatars, each with a consent record) is
  filed (CV83WF-11). The person depicted by a free-text `avatarId` is not a DSAR
  subject anywhere in this design; that belongs to C.

### D6 — an unconfirmed submit is never resubmitted (CV83WF-6)
- Before the POST, the claimed row is CAS'd to carry `submitAttemptedAt`. A row with
  that stamp and no `providerJobId` is never reclaimable, stale or not: it becomes
  terminal `submit_unconfirmed` (added to `TERMINAL_ERRORS`), and its reservation
  is kept.
- The adapters return a classified outcome instead of a bare code. **Provably not
  taken** is `no_connection`, `insecure_base`, an egress refusal before the dial,
  and a 4xx other than 408/409/429. These release the reservation and stay
  retriable. **Unconfirmed** is every `request_failed` (timeout, reset after send),
  every 5xx/408/409/429, and a 2xx whose body has no job id.
- The message tells the user to check the provider's dashboard before retrying
  with changed input. A writer-only "resubmit anyway" action is filed (CV83WF-12).

### D7 — no row without a connection (CV83WF-7)
Before the claim, `connectionExists` (selection + the D2 `connections:use` gate, no
decrypt, no egress) with the same tenant/user/org arguments the broker gets. Both
providers are fixed-endpoint, not instance-scoped, so `brokeredPost`'s
instance-scoped refusal cannot disagree; a test pins that they stay so. None →
`no_connection` (409 / a typed node failure), no row, no reservation.

### D8 — DSAR (CV83WF-8)
`eraseCreativeVideoSubject` (registered, in the manifest), matching with
`subjectKeyForms`:
- job rows: `createdBy`, `submitterUserId` and `likenessConsent.attestedBy` →
  `ERASED_USER_REF` (re-attribute, not delete: the job is the org's record that
  money was spent and consent attested; `attestedAt`, `textVersion` and `avatarId`
  carry that without naming anyone); `promptSnippet` → `ERASED` (the hash stays);
- consent records: **deleted** (the key names the person; the job snapshots keep
  the evidence; an erased person can no longer run avatar workflows, which is
  right).
`creative-video:job` leaves `ACTOR_ATTRIBUTED_DEBT` and `ACTOR_DEBT_CEILING` drops
18 → 17 in the same PR. The asset keeps only the job pointer, so the media eraser
needs no change.

Residual (filed, CV83CD-8b): the eraser writes by CAS, but the service's own
writes are plain `put`s, so a job still running during the erasure can write its
stale copy back over the tombstones. The window is one in-flight job's lifetime.

### D9 — request hash on resolved inputs (architect Blocker e)
The hash covers the resolved `{ model, ratio, durationSec }` (and, unchanged,
provider, org, kind, text, avatar, voice, source). Two requests that differ only in
ratio are two jobs; a new default model is a new job, never the old model's asset.
This changes the `jobId` for t2v/i2v requests; prod holds 0 rows, so nothing is
stranded. Avatar hashes do not change (no ratio/duration/model on that lane).

> **D6 addendum (grade-code CV83CD-1/2):** a stale `downloading` row was
> re-claimable, so it was re-SUBMITTED (a second paid job for one the provider had
> finished), and the recovery path stripped the provider id, the pin and the
> reservation. Now any row with a `providerJobId` is never re-claimed; a stale
> download is recovered in place (`downloading → processing`, everything kept) and
> re-downloaded.

### D10 — poll with the submitter's connection (architect Major 12)
The job stores `connectionId` (from the broker's provenance) and `submitterUserId`.
Polling (`resolveVideoJob`, the GET route, the inline finalize) calls
`brokeredFetch` pinned to that connection with the submitter as the acting user.
A reader therefore only ever advances a job with the credential that started it,
and never spends on their own key. If the pin is refused (revoked, erased owner),
the job stays `processing` and the row says why.

### D11 — UX
Error codes map to translated reasons (job row + toast), never the raw code. Model,
ratio and duration are selects fed by `GET …/video-models`. The consent checkbox
(D5). 4 locales.

### P1 also changes the `callVideoGenerator` lane (grade-code CV83CD-11)
The video cap is one per-tenant counter, so the new default (10 units; `0` = off)
applies to `ctx.callVideoGenerator` from P1, not P2. That lane still checks then
records (its reservation is P2), and a cap of `0` there is now
`host_capability_missing` ("switched off"), not a rate limit "(0/0)".

### Not in this ADR (filed)
- **CV83WF-9**: a chain pack + agent so the chat can drive video (reachability).
- **CV83WF-10**: an ADR 0832-style write floor for `ctx.callVideoGenerator` itself
  (an executor-wide seam shared with row 82's reel; today guarded by `runs:create`
  plus the BYOK key the run must carry).
- **CV83WF-11**: option C (approved-avatar allowlist with consent records).
- **CV83WF-12**: "resubmit anyway" for `submit_unconfirmed`.
- **CV83WF-13** (grade-code CV83CD-13): deleting the video's media asset deletes
  its job row (`clearJobsForAsset`, so the inputs can be regenerated), which is
  also the spend and consent record D8 keeps. Unlinking the asset instead needs a
  "completed without asset" re-claim rule.
- **CV83CD-6**: a refused poll pin leaves the job `processing` with no reason on
  the row (D10 promised one). **CV83CD-14**: the pack tells an AI author to read
  the model list, which no node or chat tool exposes (with CV83WF-9).
- `CB82UX-1` (only a host admin can store a Replicate key) still applies to the
  `callVideoGenerator` lane. It does NOT apply to HeyGen/Runway: any member with
  `workspace:write` can add a personal connection (`connections/routes.ts:303`),
  and an admin an org one.

## Alternatives weighed
- **Exact CDN host pin** (D2) — rejected: rotation turns into paid-then-refused.
- **Delete jobs on DSAR** — rejected: a job is the only record that consent was
  attested and money spent.
- **Consent as a node input** (D5) — rejected by the architect pass: a literal in a
  saved definition would attest for every later runner.
- **A hashed pseudonym on erasure** (D8) — rejected: hashing each member id reverses it.
- **A provider idempotency key** (D6) — Runway offers none; HeyGen unverified.
- **Probe with ffprobe** (D4) — no binary on Cloud Run; the box walk is ~80 lines.

## Implementation record (P1)
Shipped as ONE squashed commit (PR #5556; renumbered before merge, as #5555 took the number
first). What it carries and what witnesses it:

| Item | Witness |
|---|---|
| Red witnesses: 17 of 22 red on unmodified main `ec97cbb21`, all on behaviour | `adr1051-{surface-floor,runway-contract,spend-reservation}.test.ts` |
| D1–D3, D5–D10 backend | + `adr1051-video-contracts.test.ts`; 14 sabotages red |
| Pack 1.4.0, page, Governance panel | page + panel tests |
| grade-code / grade-ux fixes | 2 more sabotages red (CD-1, CD-3) |
| Pre-handoff fixes, docs, census | a non-atomic reservation (blind put) sabotage red without any sleep in the test |

## Phased plan
| Phase | Scope |
|---|---|
| P1 | D1–D3 (creative-video lane), D5–D11: backend + pack 1.4.0 + page |
| P2 | D3 + D4 for `callVideoGenerator` (the ADR 0411 lane, `aiProvidersHost.ts`) |
| later | CV83WF-9..12 |

## Open questions
- [x] **Default video cap** (lead, 2026-11-03): 10 units per tenant per UTC day
  (t2v/i2v weigh 3, avatar 1) when `OPENWOP_MEDIA_DAILY_VIDEO_JOBS` is unset.
  `0` means paid video is **disabled**, not uncapped (zero-means-unlimited is a
  known foot-gun here); uncapped needs the explicit value `unlimited`. The per-org
  governance override `videoJobs` follows the same rule. Released only on a typed
  pre-spend refusal, never after the provider may have spent.
  The override's `0` changes meaning, so stored rows were MEASURED first (read-only,
  2026-11-04): production holds **0** `hostext:governance:policy:*` rows, hence no
  stored `videoJobs: 0` exists and no rewrite to `unlimited` ships.
- [x] Consent policy — A, C filed (lead, 2026-11-03). The asset carries the
  non-personal fields; `attestedBy` lives on the job, where D8 reaches it.
