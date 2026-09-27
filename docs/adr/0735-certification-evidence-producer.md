# ADR 0735 — The certification bundle is cut AFTER the deploy, by the suite CLI, against the deployed revision

Status: Accepted — partially implemented (WHD-2 landed; WHD-18's out-of-image serving origin + `scripts/publish-evidence.sh` built 2026-09-21, NOT yet configured, deployed or run; decision 1's "stops producing a bundle" not done)

Supersedes nothing. Corrects the producer chosen in **ADR 0550 P4** (which built
`conformance/certify.ts` to assemble the bundle in-process) in light of
`docs/runbooks/V2-HOST-MIGRATION.md` §4.2b and a steward ruling on the
openwop bus (2026-09-18, `f033`).

## Context

This host's committed evidence is not merely stale — it is structurally unable to
substantiate a claim. MEASURED at `../openwop/evidence/v2-host-bundles/openwop-workflow-engine.json`:

```
bundleVersion   3
suite           2.0.11          (corpus is at 2.10.0)
claimedProfiles 2, BOTH certified: false
evidenceTier    self
```

The corpus cannot declare v2 "production ready" while a reference host carries
that, and the steward said so plainly: doing it would be *"a statement whose
check does not hold"* — the same class of claim the corpus spent 2026-09-18
removing (`--require-behavior` that never did anything; soft-skipped legs
counting as acceptance; `contractProvenance` deleted as unfalsifiable
self-declaration).

## The defect is an ORDERING one, and it is visible in three lines

`scripts/deploy.sh` runs, in this order:

| line | step |
|---:|---|
| 234 | `npm run test:conformance -- --certify` — assembles the bundle |
| 285 | `gcloud run deploy …` — ships the revision |

**The bundle is cut before the thing it describes exists.** It attests a local,
in-process vitest run against a host booted from the working tree, and is then
published as evidence about a production revision that has not been deployed
yet. Every field in it is honest about the wrong subject.

`V2-HOST-MIGRATION.md` §4.2b states the rule this violates, verbatim: *"A major-2
bundle is cut by the upstream CLI, against the deployed revision, with a key that
is not in git."*

### Why it produced TWO artifacts that disagree

`conformance/certify.ts` hard-codes `bundleVersion: '2'` at four sites and serves
the result at the advertised `…/conformance/certification-bundle` URL, while the
committed corpus evidence is a v3-shaped document from a different run. Nothing
read either, so nothing noticed. That is the steward's "no reader" diagnosis and
it is the second producer that makes the drift possible.

## Decision

**Split the one artifact into two, because it is doing two incompatible jobs.**

1. **Pre-deploy, in-process — a REGRESSION GATE.** `run.ts --certify` keeps its
   three refusals (the RFC 0148 §A ledger, the forced
   `OPENWOP_CONFORMANCE_NO_QUARANTINE=1`, and `OPENWOP_REQUIRE_BEHAVIOR=true`).
   It keeps refusing to ship a regression. **It stops producing a bundle**, and
   nothing it emits is served or committed as evidence.
2. **Post-deploy, CLI, signed — the EVIDENCE.**
   `openwop-conformance --base-url <deployed origin> --certify bundle.json
   --signing-key <pkcs8 pem> --signing-key-id <id>` cuts the v3 bundle against
   the revision that is actually serving. That artifact is what the advertised
   URL returns and what lands in the corpus evidence directory.

The host keeps **only** the ADR 0550 P4 claims derivation — a profile is claimed
when every floor requirement recorded `executed-pass` with ≥1 assertion — now
reading `results.requirements` out of the CLI's bundle rather than out of its own
assembly. That rule was the point of P4 and it survives the move intact; what
does not survive is this host hand-rolling the document format.

> **CORRECTED 2026-09-21 (`WHD-18`) — not at runtime, and `/claims` is withheld
> in origin mode instead.** The v3 rows ARE shape-compatible (`id`/`result`/
> `assertions` map one-to-one onto `requirementId`/`disposition`/
> `assertionCount`), but the derivation is not runnable where it would have to
> run: `conformance/certify.ts` computes it with the suite's
> `deriveRequirementDispositions` + floor tables, a devDependency the release
> image does not ship (`npm ci --omit=dev`). Re-implementing it in the server
> would be the second derivation this ADR exists to remove. Full reasoning in
> § "Implementation record — 2026-09-21 (WHD-18)", decision D5.

### Signing

The trust root is **self-asserted by design** — `docs/IMPLEMENT-CORE.md`: *"A
verifier resolves that `keyId` in YOUR discovery document — there is no key list
the steward keeps."* There is no approval step and none is needed. A signature
attests **integrity and origin**, never that the results are true; a bundle with
no key attests integrity only, which is the strictly weaker state this host is
in today.

The host side is **already built and merely unconfigured**:
`routes/discovery.ts` `readBundleSigningKeys()` reads `OPENWOP_BUNDLE_SIGNING_KEYS`,
validates `keyId`, `alg: "ed25519"` and `/^[A-Za-z0-9_-]{43}$/`, and **fails
closed** — a malformed entry withholds the whole array rather than publishing a
bad key. Its error text even names the encoding, because *"the commonest operator
error by far is pasting the PEM instead of the 32 raw bytes."*

Two encodings, two halves, nothing converting between them:
- **sign with** the PKCS8 **private** key (`host.pem`, never in git);
- **publish** the **last 32 bytes of the SPKI DER**, base64url unpadded, exactly
  43 chars.
- The repo's `openssl genpkey` recipes belong to the **pack**-signing surface and
  emit a form that fails the pattern. Use the `IMPLEMENT-CORE.md` node recipe.

## Prerequisite: the three blocked rows are a RUN-configuration gap, not a host defect

MEASURED in the committed bundle — all three blocked rows carry
`"assertions": 0` and the same detail:

```
[blocked] host SSRF guard rejected the loopback receiver (webhooks.md §Egress
requires it); set OPENWOP_WEBHOOK_RECEIVER_URL to a public https tunnel
```

`v2-webhook-durable-delivery.test.ts` starts a receiver on loopback and registers
a webhook pointing at it. **A conforming host MUST refuse that**, and this host
does. The scenario therefore records `blocked` — it could not execute, which is
not the same as failing.

**This is the trap in the row, and it is worth naming before someone "fixes" it:
the obvious way to turn these three green is to relax the SSRF guard. That would
be a security regression performed to make a test pass** — trading a real egress
control for a green row. The guard is behaving exactly as `webhooks.md` §Egress
requires.

The remedy is on the RUN side, at cut time:

1. front the suite's receiver with a public https tunnel;
2. `OPENWOP_WEBHOOK_RECEIVER_PORT=<local port>` so the tunnel has a fixed target;
3. `OPENWOP_WEBHOOK_RECEIVER_URL=<public https url>`;
4. then cut.

Per the steward (bus `e733`, measured across all three reference hosts): **none
of this host's three blocked rows clear on a re-cut alone** — unlike the
reference host's two, which were a stale-suite artifact. So the tunnel must be in
place BEFORE the cut, or the cut is spent for nothing.

## Alternatives weighed

| option | why not |
|---|---|
| Move `certify.ts` after the deploy, keep assembling in-process | Keeps a second producer of a format the corpus owns and moves (2.5.0 added audit affordances). A hand-rolled copy drifts by construction — it already did, v2 vs v3. |
| Port `certify.ts` to emit v3 | Same objection, plus it makes this host's public claim depend on our re-implementation of a schema we do not own. |
| Keep the pre-deploy bundle, add a post-deploy one | Two artifacts, two claims, one advertised URL. This is the defect, restated. |
| Skip signing (`--skip-certify`) | Legal per RFC 0089 §D, but leaves `certified: false` standing and blocks the corpus declaration. Not a resolution. |

## Consequences

- `deploy.sh` gains a post-deploy certify step; the pre-deploy step stops writing
  the bundle and becomes explicitly a gate.
- The advertised `certification-bundle` URL serves the CLI's artifact.

  > **CORRECTED 2026-09-21 (`WHD-6`) — not achievable as written.** The advertised
  > URL serves whatever bundle the SERVING IMAGE carries — today `deploy.sh`'s
  > pre-deploy, in-process `bundleVersion: "2"` artifact (MEASURED on `3da7df376`:
  > `200`, 615 kB, sha256 equal to `/claims`' `evidence.bundleSha256`). It cannot
  > serve the post-deploy CLI cut: that cut exists only after the image is built,
  > and `build-meta/` is immutable per revision. Until an out-of-image origin
  > exists (`WHD-18`), the CLI's v3 bundle is published only in the corpus
  > evidence directory and the major-2 discovery root omits the pointer. The
  > "nothing is served there today" sentence below was true on 2026-09-19 and
  > stopped being true at 2026-09-20T23:54Z.
  >
  > > **CORRECTED 2026-09-21 (`WHD-18`) — the out-of-image origin now exists in
  > > code.** With `OPENWOP_CERT_BUNDLE_ORIGIN` set, the advertised URL serves the
  > > CLI's signed v3 cut (verified per request against this build), the in-image
  > > bundle is no longer served at all, and the major-2 root carries the pointer.
  > > Unset, the paragraph above still describes the host exactly. See
  > > § "Implementation record — 2026-09-21 (WHD-18)".
- The corpus evidence file is replaced by a fresh cut at 2.10.0, signed, with a
  resolvable `keyId` — which is what lets `certified` become true.
- A deploy that cannot reach the deployed origin cannot produce evidence. That is
  correct: no reachable revision, no claim.

## Implementation record — 2026-09-19

### WHD-2 observability landed

PR #4051 (merge commit `fb39cd093`) made an empty webhook fan-out observable,
closing the instrumentation phase identified below. It does not complete this
ADR's post-deploy signed-evidence producer, so the decision remains only
partially implemented.

Executed the run-side remedy above (option A of the `/architect` options pass:
an ephemeral `cloudflared` quick tunnel, no account, for the duration of one cut).
What the execution turned up that the decision above did not anticipate:

### The advertised key had no recoverable private half

The committed bundle is signed `openwop-app-self-2026-09-04`, and the live host
advertised that keyId. **MEASURED: the private half exists nowhere on this
operator box.** Derived the public half of all seven files in `~/.openwop-keys`
with node (`createPublicKey(createPrivateKey(pem))`, last 32 bytes of the SPKI
DER, base64url) — none matches `SFBjFSjHaQSUbIb…`. A filesystem sweep for the
keyId and for `BEGIN PRIVATE KEY` found it only in tests, docs and bundles. The
sweep was run with a control that returned 60 key files, so the empty result is
a finding and not an inert query.

So the key could sign nothing further, and rotation was **forced, not elective**:
minted `openwop-app-bundle-1` and published it via `--update-env-vars`.

This retires the second open question below from "out of scope" to **answered the
hard way**: "a local file is fine for an operator-run `deploy.sh`" is exactly what
failed. A key that signs a public claim needs a durable home (Secret Manager
beside `openwop-conformance-api-key`), not an operator's laptop.

### Retiring a key by REPLACING it un-verifies the bundles it signed

The first rotation attempt **replaced** the array element. That is a wire
regression, and the repo's own test names it —
`discovery-signing-keys.test.ts:37`, *"keeps a RETIRED key listed — dropping it
invalidates every bundle it already signed"*. A verifier resolves a bundle's
`keyId` in the host's live discovery doc; drop the key and the 2026-09-10 bundle
stops verifying, having been made unverifiable by the act of publishing its
successor.

Corrected: both keys are advertised, the old one carrying
`retiredAt: 2026-09-19T00:00:00Z` (a field `readBundleSigningKeys` already
supports). The curve-point test now covers **every** published key rather than a
single hardcoded literal, so a future rotation that forgets the retired half is
caught by the suite instead of by a verifier.

### A config-only `gcloud run services update` lands at 0%

Traffic on this service is **pinned by name** (the remediation from the
2026-09-05 pg-exhaustion incident). Both `--update-env-vars` calls created a new
revision at 0% while gcloud printed the OLD revision as *"deployed and serving
100 percent"* — the hazard `CLAUDE.md` documents, reproduced twice here. Neither
key reached the wire until an explicit
`update-traffic --to-revisions <name>=100`. The verification that caught it was
reading `signingKeys[]` back off the live origin; the gcloud success line is not
evidence.

### The advertised bundle URL currently 404s

Worth recording against the Consequences above: *"the advertised
`certification-bundle` URL serves the CLI's artifact"* is not yet true — nothing
is served there today. `build-meta/` is baked into the image at build time, so a
post-deploy cut **cannot** retroactively change what that URL returns. Closing
this needs either a deploy that ships the bundle, or an origin that reads it from
outside the image. Tracked as unfinished; the cut itself does not depend on it.

### The tunnel worked — and the rows it unblocked found a REAL defect

The run-side remedy did its job: `blocked 3 -> 0`, `executedPass 137 -> 154`,
and `openwop-discovery-core` cut `certified: true` for the first time. But two
`v2-webhook-durable-delivery` rows moved `blocked -> executed-fail`, and that is
not an artifact. **MEASURED, black-box, against the deployed revision
`3080f2f24a0f`:**

| probe | result |
|---|---|
| `POST /v1/webhooks/{id}/test` (synthetic delivery) | **arrives** in ~2 s, correctly signed |
| real run, subscription `events:['run.completed']`, run reaches `status: completed` | **0 deliveries** |
| same, run created via `/v1/runs` instead of the v2 root | **0 deliveries** |
| same, subscription `events:['*']` | **0 deliveries** |

The tunnel is not implicated: 20/20 POSTs through it returned 204 at ~130 ms,
and the `/test` delivery arrived through that same tunnel minutes earlier. The
subscriptions were live, the run was `completed`, and the receiver was listening
(`lsof` confirmed, sampled every 2 s through the window).

`/test` is the discriminator. It calls `enqueueDelivery` **directly**; the real
path goes through `deliverToSubscribers` -> `matchingSubscribers` ->
`storage.listWebhooks({ tenantId })`. One works and the other does not, with the
same subscription row, so the fault is in that matching step — and the wildcard
probe rules out event-type spelling, leaving the tenant the fan-out resolves
(`routes/webhooks.ts:279`, `const tenantId = run?.tenantId ?? 'default'`) or the
`forkMode` early return above it.

**It fails exactly as its sibling did.** `enqueueDelivery`'s own docblock
(`routes/webhooks.ts:367-375`) describes ADR 0629 breaking this same scenario by
projecting ids in the response senders and not the delivery: *"no error, no 4xx,
no log line."* This one is the same shape one step earlier — `webhook fanout
error` never logs, because nothing throws; the subscriber set is simply empty.

**Consequence for the claim:** `openwop-core-standard` cannot be certified, and
should not be. Webhook subscribers on this host receive nothing for real run
events — a production defect, not a harness detail, and one that was
**unobservable for as long as the three rows sat `blocked`**. Unblocking them is
what surfaced it. The bundle from this cut is therefore NOT published upstream:
it is honest about the failure, but the fix belongs before the evidence.

#### Localisation, after a second pass (same day)

Confirmed a THIRD time through an independent channel — no tunnel, no receiver:
two `events:['*']` subscriptions pointed at a dead public https URL, so the
host's OWN delivery-failure log becomes the witness. Run reached `completed`;
**zero** delivery attempts and zero `webhook fanout error` lines. The harness is
fully exonerated.

What the second pass then RULED OUT, each by measurement rather than reading:

- **The subscriber seam fires.** SSE (`routes/streams.ts:278`) subscribes to the
  very same `getEventLog().subscribe()` seam as the fan-out
  (`routes/webhooks.ts:86`). Streaming a live run returns `run.started` ->
  `node.*` -> **`run.completed`**, so `deliverToSubscribers` IS invoked. This is
  the single most useful fact: it moves the defect strictly INSIDE that function.
- **Tenant attribution agrees on both sides.** The SSE `run.started` owner block
  reads `tenant: "conformance-prod"`, and registering with an EXPLICIT
  `tenantId: "conformance-prod"` is accepted rather than 403 — which under
  `resolveWebhookTenant` means it is the caller's active tenant. So the
  `?? 'default'` fallback at `:279` is not obviously the culprit.
- **`getRun` is not tenant-scoped** (`SELECT * FROM runs WHERE run_id = $1`), so
  the bare v1 runId resolves and `run` is non-null.
- **`forkMode` is not the early return**: `fork_mode TEXT` carries no default, so
  an ordinary run is NULL -> `undefined`.
- **Not event-type spelling**: an `events:['*']` subscription is equally silent.
- **Not a stale read of the wrong code**: `git diff 3080f2f24a0f HEAD` over
  `routes/webhooks.ts` + `executor/eventLog.ts` is EMPTY, so the deployed
  revision runs exactly the source quoted here.

Every link inspects as correct and the observed behaviour is still zero. That
discrepancy is the finding: it cannot be closed by reading, and black-box probing
against production has reached its limit. **Next step is a local reproduction
with instrumentation inside `deliverToSubscribers`** (log `run?.tenantId`, the
`listWebhooks` result length, and the post-filter count), not another remote
probe.

NOT fixed here. The fix needs its own ADR and a regression test.

> **RETRACTED, same day — the sentence that used to end this section was wrong,
> and it was the part that read best.** It said: *"every existing test drives
> `__deliverToSubscribersForTests` or `POST /webhooks/{id}/test`, and both enter
> BELOW the step that is broken."*
>
> **`test/adr0722-webhook-fanout-projected.test.ts` enters ABOVE it**, and passes:
> `createApp()` (so the boot-time `getEventLog().subscribe()` is registered) ->
> `storage.insertRun({ tenantId })` (a REAL run row, so `getRun()` resolves) ->
> `POST /v1/webhooks` (a REAL subscription through the API) ->
> `getEventLog().append()` (the seam the executor itself uses). That is the full
> path, structurally identical to production.
>
> I grepped for the two below-the-break entry points, found them, and stopped.
> **Finding two instances of the shape you expect is not the same as
> establishing the shape** — the claim required enumerating the callers that
> enter CORRECTLY, which I never did. The steward had already generalised from
> it on the bus before I caught it; retracted there too (`380c`).
>
> The defect is unchanged in severity and WORSE in mystery: a structurally
> identical setup passes on `memory://` and fails against the deployed host.

### Hypotheses falsified, each by measurement with a control

Recorded so the next session does not re-run them:

| # | hypothesis | how it died |
|---|---|---|
| 1 | Cloud Run CPU throttling starves the poll loop | attempts 2, 3, 4 logged; retries continued past the run |
| 2 | my own orphaned probe listener held the port | real, but killing it changed nothing |
| 3 | queue backlog head-of-line blocks the delivery | drained to ~1 failure/min; still zero |
| 4 | run-id projection mismatch (bare vs `tenant/uuid`) | v2 create and the delivery payload AGREE |
| 5 | cloudflared origin keep-alive serving stale 502s | disabled it; still zero |
| 6 | stale-subscription fan-out starving the real one | deleted all 15; still zero |
| 7 | tenant mismatch via `run?.tenantId ?? 'default'` | explicit `tenantId:"default"` -> **403 "not a member"**, bogus tenant also 403, so the gate discriminates and the active tenant IS `conformance-prod`, matching the runs |
| 8 | storage-adapter divergence in `listWebhooks` | sqlite and Postgres filter logic and `rowToWebhook` are equivalent (`tenant_id ?? 'default'` in both) |

Also ruled out by reading: the subscriber set is never cleared (`executor/eventLog.ts`
has no reset; `setEventLogBackend` only assigns `backend`), `runOwnerV2` returns
`run.tenantId` verbatim so the SSE owner block IS the column, `fork_mode` has no
default so the replay early-return cannot fire, and `git diff` over the deployed
commit is empty so the source read here is the source running.

**The seam demonstrably fires**: SSE subscribes to the same
`getEventLog().subscribe()` seam and streams `run.started` -> `run.completed` live.

**Next step is instrumentation, not another hypothesis.** Log `run?.tenantId`,
the `listWebhooks` result length, and the post-filter count inside
`deliverToSubscribers`, against Postgres. Eight black-box probes have established
where the defect is NOT; none can see inside that function.

## Implementation record — 2026-09-21 (WHD-18): an origin outside the image

Decision 2's "that artifact is what the advertised URL returns" had no place to
come from (the WHD-6 correction above). The owner authorized a bucket —
`gs://openwop-dev-certification-bundles` (us-central1, uniform access,
public-access-prevention ENFORCED; the Cloud Run runtime identity has
`roles/storage.objectViewer`, only owners/editors write). This phase builds the
serving side and the producer. **Nothing below is live**: the service does not
yet carry the env var, and `publish-evidence.sh` has never run end to end.

### What was built

| # | decision | where |
|---|---|---|
| D1 | `OPENWOP_CERT_BUNDLE_ORIGIN=gs://<bucket>/<prefix>`. **Unset = today's behaviour exactly** (image stamp, major 1 only). **Set = the in-image bundle is not served for either major**, even while the bucket is empty; a malformed value withholds everything rather than fall back. A fallback would be the defect this ADR names, on a longer fuse. | `host/conformanceClaims.ts` `servedBundle()` — the ONE predicate route, pointer and `/claims` hang off |
| D2 | Object key `<prefix>/<commit>/major-<1\|2>.json`, `<commit>` = `buildCommit()` (full 40-hex only). No "current" pointer exists to go stale; a new revision looks up a key nobody has written, and its pointer is absent until someone does. | `host/certificationEvidence.ts` `bundleObjectKey` |
| D3 | Verified before it is served OR advertised; ANY failure withholds all surfaces and logs `certification_evidence_withheld` with the reason (never the body): not v3 · `host.build.kind` ≠ `commit` · `host.build.id` ≠ this commit · `suite.targetMajor` ≠ the major served · duplicate/malformed rows · totals or `assertionCount` ≠ the rows · recomputed witness digest ≠ `witnessSha256` · signature missing, `over` not the four fields, `keyId` not in this host's `signingKeys[]`, key retired before `generatedAt` (unparseable `retiredAt` = retired), or ed25519 fails over the canonical attestation bytes. | `verifyServedBundle` |
| D4 | Fetch discipline: metadata-server token → GCS JSON API, plain `fetch`, **awaited in the request** that needs it, ONE 2 s deadline over both calls (race + `AbortSignal`), single-flight per key with the latch cleared in `.finally` of the RACED promise (so a hung fetch cannot wedge the next refresh — the #3056 shape), cached 5 min positive / 60 s negative, stale-if-error for TRANSPORT failures only (a 404 or a verification failure withdraws a previously verified bundle). | `CertificationEvidenceReader` |
| D5 | Major 1 keeps its path and the major-1 pointer. Major 2 is served at `/host/openwop-app/conformance/certification-bundle/major-2` (RFC 0181 vendor form; `/v1` twin registered) and advertised at the major-2 root ONLY, through the slot `schemas/v2/capabilities.schema.json` already declares — no new discovery field (RFC 0147 §A). Both routes return the **exact uploaded bytes**. | `routes/discovery.ts` |
| D6 | **`/claims` is WITHHELD in origin mode** (404 with the reason). See below. | `conformanceClaims()` |
| D7 | `verify-deploy.sh` → `check-wire-claims.mjs` gains an origin-mode arm: a present pointer must be v3, `host.build.id` = the deployed commit (`EXPECTED_COMMIT`, now passed), for that major, signed under a LIVE key; an absent pointer is `PENDING (no evidence published for <commit> yet)` — neither OK nor a failure; `/claims` must be 404. | `scripts/check-wire-claims.mjs`, `scripts/lib/bundle-v3-verify.mjs` |
| D8 | `scripts/publish-evidence.sh`, operator-run, NOT wired into `deploy.sh` (see its header for the full sequence: live commit from `/api/readiness`, refuse unless `origin/main`'s tip, signing key + client keys from Secret Manager into 0600 temp files, key-pair check against the LIVE `signingKeys[]` before the 10-minute run, cloudflared tunnel, opt-outs DERIVED by `scripts/lib/conformance-opt-outs.mjs`, cut 2 then 1, suite `--verify` + the host's own rules, upload, webhook cleanup with counts, served-digest check). | `scripts/` |

### Why `/claims` is withheld rather than derived (D6)

The task that commissioned this phase allowed deriving `/claims` from the
verified major-1 bundle "using the host's EXISTING claims derivation if the v3
rows are compatible". The rows ARE compatible — `id`/`result`/`assertions` map
one-to-one onto the ledger's `requirementId`/`disposition`/`assertionCount`. The
derivation is not: `assembleCertification` runs the suite's
`deriveRequirementDispositions` and floor tables, which exist only in the
devDependency the release image strips. The two ways round it are a second
derivation in the server (forbidden by name above) or importing a devDependency
at runtime (the ADR 0550 P3/P4 line). And the image's own claims stamp cannot be
served either: it binds `evidence.bundleSha256` to the in-image v2 bundle this
mode refuses to serve. So in origin mode the v3 bundle IS the claim — its
per-profile `certified` verdicts are what `openwop-conformance --verify`
re-derives — and `/claims` answers 404 naming that. If a claims projection is
wanted later, the honest producer is `publish-evidence.sh` (it has the suite
installed): cut, derive with `certify.ts`, publish a claims object beside the
bundle, and have the host serve it only when BOTH verify. Not built.

### Two deviations from the WHD-18 design note, on purpose

1. **v3 for both majors, not "`'2'` for the v1 root".** The CLI cuts v3 at either
   major (RFC 0168 §D.3; `discovery-signing-keys.test.ts` states it), so there is
   no post-deploy v2 artifact to serve. The v1 schema's slot is a bare `uri`,
   which a v3 document satisfies.
2. **Keyed and checked by `buildCommit()`, not `OPENWOP_BUILD_COMMIT`.** The env
   var alone is the value a bare redeploy carries over from the PREVIOUS deploy
   (`host/buildInfo.ts`, the 2026-08-10 correction). `buildCommit()` prefers the
   image stamp and is what `/api/readiness` reports — which is where
   `publish-evidence.sh` reads the key from. One resolver on both sides.

### Found on the way

- **The manual cut's opt-out list was wrong.** It carried `conformance-fixtures`
  and `form-content` — path segments of a `resolve(...)` call 400 lines below
  `OPTED_OUT_PROFILES` in `run.ts`, picked up by a grep for quoted strings. The
  derivation reads only the array's own lines and is pinned by test (25 base
  entries, the major-2 ledger checked against its export, both bogus ids
  asserted absent).
- **The witness digest's sort is locale-sensitive.** The suite sorts with a bare
  `localeCompare`; for ASCII punctuation the `en` and POSIX collations can order
  differently, and a container with no `LANG` is POSIX. Measured on the real
  fixture: `en`, default, POSIX and code-point order all agree today. The
  verifier pins `'en'` (the operator box's locale) so a future id cannot make a
  correct bundle read as tampered.
- **`deploy.sh` would have leaked the origin into its own pre-deploy gate.** It
  exports every `deploy.env` key; the in-process host the certify lane boots
  would then have tried GCS with no metadata server. The lane now unsets it.
- **`discovery-signing-keys.test.ts`'s `PUBLISHED_KEYS` does not list
  `openwop-app-bundle-2`**, the key the reference fixture is signed with. Not
  changed here (the live key set was not re-measured); flagged.

### Evidence

| phase | commit | witness |
|---|---|---|
| serving origin + verifier + routes | `3cf962b5d` | `test/whd18-certification-evidence.test.ts`, `test/whd18-certification-bundle-routes.test.ts` |
| one guard behind one predicate | `2dba3d046` | `test/conformance-claims.test.ts` (renamed predicate) |
| deploy-side verify + producer | `df616dc9a` | `test/whd18-scripts.test.ts`, `scripts/test-deploy-gates.sh` (origin-mode section) |

The reference fixture is a REAL cut: suite 2.34.0, `--target-major 2`, against
production `27315b41c8f4`, signed `openwop-app-bundle-2`. It verifies under this
host's verifier and under the deploy-side twin, and every tamper fails with its
own reason. Each guard was sabotaged by direct edit on a committed tree and went
red on a behavioural assertion (none on a syntax error); the list is in the PR
description rather than here, because it is a property of this commit, not of
the decision.

**Not verified:** anything against the live service or the real bucket — the
metadata-token path and the GCS JSON API are exercised only through an injected
fetch, and `publish-evidence.sh`'s network half (Secret Manager, cloudflared, the
suite run, the upload, the webhook cleanup, the served-digest poll) has never
executed.

## Open questions

- [ ] Does the pre-deploy gate keep the `--certify` flag name? It no longer
      certifies; `--conformance-gate` describes it. Renaming touches
      `scripts/test-deploy-gates.sh`, which asserts the current invocation.
- [ ] Where does the private key live for a CI-driven deploy? Local file is fine
      for an operator-run `deploy.sh`; a hosted runner needs a secret binding.
      Out of scope until hosted CI is re-enabled (currently disabled).
- [ ] MyndHyve's three blocked coexistence rows are theirs to re-cut; this ADR
      does not attempt to speak for that host.
