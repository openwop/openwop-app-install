# ADR 0693 — the managed free tier meters per TENANT, and ADR 0684 made a tenant a crowd

Status: implemented (phases 0–5)

## Context

ADR 0684 auto-joins every participant into a shared workspace and sets it as their
active tenant. `auth.ts` then stamps `req.tenantId` with that workspace for every
member, and it flows to `run.tenantId` → `dispatchTurn` → the managed provider.

The managed free tier meters on that id, and only that id:

```
storage.ts:895   getManagedUsage(tenantId, providerId, dateUtc)          ← no subject
storage.ts:886   incrementManagedUsage(tenantId, providerId, dateUtc, …) ← no subject
storage.ts:905   incrementMediaUsage(tenantId, dateUtc, ttsChars, sttBytes)
storage.ts:913   getMediaUsage(tenantId, dateUtc)
```

`managedProvider.ts:306` reads that row and compares it to `target.dailyTokenCap`.
So **every participant in `host-kicktodo` draws from one 50 000-token day**, and
the first few active users exhaust the free tier for the whole population. The
same is true of TTS characters and STT bytes through `incrementMediaUsage`, whose
own doc comment says *"Tenant = workspace = org at root (ADR 0015)"* — a sentence
that was accurate when every tenant held one person.

**This is a cost of ADR 0684's design, not a pre-existing bug that ADR 0684
revealed.** Auto-join was specified without asking what else keys on
`req.tenantId`. Found by the `kicktodo-3` session, verified here at HEAD.

### The measurement that shapes the decision

Nothing needs a two-account experiment to establish it: the key has no subject
dimension, so pooling is structural. What DOES need stating is which tenants are
actually affected:

| tenant shape | subjects | pooling today |
|---|---|---|
| `anon:<sid>` | exactly 1 | harmless — tenant IS the subject |
| `user:<hash>` | exactly 1 | harmless — tenant IS the subject |
| `default` | 1 (single-principal) | harmless |
| **`ws:<uuid>` / a declared default** | **many** | **the defect** |

`accessControlService.isSinglePrincipalTenant` (`:841`) already draws exactly this
line, as an allowlist that fails closed for unrecognised shapes. **The defect is
confined to the tenants that predicate returns false for**, which is the smallest
correct scope for a fix and the reason this ADR does not propose re-keying every
usage row in the product.

## Decision

### 1. Meter per (tenant, subject) ONLY where a tenant holds more than one subject

Charge and cap on the pair for multi-principal tenants; leave single-principal
tenants exactly as they are. A personal tenant's usage row is already per-subject
by construction, and re-keying it would be churn with a migration attached.

This is deliberately NOT "add a subject everywhere". The interface stays honest
for the 99% case and gains a second scope only where the first one stopped
meaning what it says.

### 2. The scope is composed into the existing key, not added to the interface

The repo already charges two scopes per call through one tenant-shaped parameter:

```
managedProvider.ts:252   GLOBAL_USAGE_TENANT = 'managed:global'
managedProvider.ts:318   getManagedUsage(GLOBAL_USAGE_TENANT, …)     // the operator ceiling
managedProvider.ts:381   incrementManagedUsage(GLOBAL_USAGE_TENANT, …)
```

`managed:global` is a **sentinel in the tenantId position** — not a tenant, a
bucket. The operator's global cap shipped with no storage change, no adapter
change and no migration because of it. A per-subject bucket is the same move:
`managed:sub:<tenantId>:<subjectHash>`.

**The alternative — widening `getManagedUsage`/`incrementManagedUsage` with a
`subject` parameter — is rejected, but not because it is more work.** It changes
the primary key of a usage table in both adapters, needs a forward migration, and
makes every existing caller state a subject it may not have (the global bucket
has none). The sentinel keeps the surface that has no subject free of one.

> **The cost of this choice, stated up front so the next reader does not have to
> find it:** it OVERLOADS the `tenantId` field with values that are not tenants.
> This repo has been burned by an overloaded field before — the commerce refund
> incident, where `provider:'none'` meant two different things and a predicate
> over the ambiguous field was permanently guessing. The mitigation is that
> `managed:*` is a **closed, prefixed namespace** no real tenant id can collide
> with (`anon:`/`user:`/`ws:`/`host-*` are the real shapes), and that exactly one
> module composes these keys. A second composer is the thing to refuse in review.

### 3. Both surfaces, or neither

`incrementMediaUsage` (`storage.ts:905`) carries the identical shape and the
identical defect: TTS characters and STT bytes pool across the workspace. Fixing
only the token cap ships the same bug for voice and leaves a second discovery for
someone else.

### 4. The consequence nobody raised: this creates a DSAR obligation

**Today, managed-usage rows are not personal data.** They key on a tenant, and no
subject eraser is registered for them — verified: `registerSubjectEraser` has no
managed-usage caller.

**A per-subject usage row is subject-linked data and falls under ADR 0464.** The
moment this lands, "how many tokens did this person use on this day" is a fact
about a person that a DSAR must be able to erase.

Therefore this ADR is not done when the metering works. It is done when:

- the subject component is a **hash**, not a raw subject, so the row is
  pseudonymous rather than directly identifying;
- a **`registerSubjectEraser` hook removes the per-subject buckets**, and the
  ADR 0464 tripwire test covers this store like every other;
- erasing a subject's buckets **does not** disturb the tenant-level or global
  totals, which are operator accounting rather than personal data.

An implementation that meters correctly and is not erasable is a regression
against ADR 0464, not a partial success.

> **CORRECTION, found during implementation — §2's "no interface change" does not
> extend to §4.** §2 is right that *metering* needs no new storage method: the
> sentinel rides the existing `tenantId` parameter. **Erasure does.**
> `managed_provider_usage` is a real table keyed `(tenant_id, date, provider_id)`
> and the Storage interface exposes only `incrementManagedUsage` and
> `getManagedUsage` — **there is no delete**. A DSAR cannot remove a row through
> a surface that can only add to it.
>
> So §4 requires one new method, `deleteManagedUsageForTenant(tenantId)`,
> implemented in both adapters. That is a smaller change than the per-call
> subject parameter §2 rejected — it takes a bucket id, which every caller
> already has, and it is needed for the operator's own housekeeping regardless.
> But it IS an interface change, and the ADR read as though there would be none.
> Recorded rather than quietly widened.

> **SECOND CORRECTION, also from implementation — §3's "both surfaces or neither"
> assumed they were the same job. They are not.**
>
> `incrementMediaUsage` has the identical DEFECT, and §3 stands on that. But the
> media call graph has **no subject anywhere in it**: `checkMediaBudget(tenantId,
> kind, size)` and `recordMediaUsage(tenantId, kind, size)`
> (`aiProviders/mediaBudget.ts:183,220`) take a tenant positionally, and nothing
> upstream of them carries an acting subject the way `conversationToolLoop`
> already carried `run.metadata.actingUserId`. Phase 3 is therefore its own
> plumbing exercise through a second call graph, not "the same change again".
>
> **What that does NOT change:** the constraint §3 and the Phases table were
> protecting. The real rule is *do not create per-subject rows without an erasure
> path*, and phases 0–2 + 4 satisfy it completely — token buckets exist and are
> erasable, and because phase 3 has not shipped, **no per-subject MEDIA rows
> exist to erase**. The increment is internally consistent.
>
> **What it does change:** TTS/STT remain pooled across a shared workspace until
> phase 3 lands. That is a live defect, stated here rather than left implied by a
> phase table that reads as though it were already handled.
>
> **RESOLVED — phase 3 landed, and it is SMALLER than this note feared.** The
> defect is confined to TTS/STT: images and video use separate counters
> (`imagesUsedToday`/`videoUsedToday`) and never touched `getMediaUsage`, so
> phase 3 reaches **six call sites in three files**, not the eighteen a naive
> grep of the media surface suggests. `aiProviders/aiProvidersHost.ts` already
> carried `scope.actingUserId` (ADR 0396 P4), so the TTS path needed no new
> plumbing at all. The kb and notebooks STT paths have no subject in scope and
> fall back to the tenant — legal, unchanged, and the reason the parameter is
> optional.
>
> §4 applies to the media rows too, so `deleteMediaUsageForTenant` joins the
> token delete and the single eraser clears **both** stores from one derived
> key. Erasing tokens but not TTS/STT would have left a DSAR half-done, and the
> gap would have been invisible: both keys are hashes nobody can enumerate.
>
> **A test-honesty note worth more than the fix.** The first version of the
> media coverage lived in the composer's test file, and a sabotage proved it
> VACUOUS: reverting `mediaBudget`'s read to the pooled tenant left all 13 cases
> green, because a composer test cannot see whether `checkMediaBudget` calls the
> composer. Mechanism and WIRING must be pinned separately. The replacement
> drives the real functions against real storage, and the same sabotage now reds
> 4 of 6 — the other 2 being the personal-tenant and no-subject cases, which are
> byte-identical under either implementation.

### 5. What happens at the cap is a product decision, and this ADR takes the conservative one

With per-subject metering, one participant exhausting their allowance must not
exhaust anyone else's — that is the point. But the tenant-level row still exists
and the operator's global ceiling still applies. The order is:

1. per-subject cap (multi-principal tenants only) → `daily_limit_reached`, actionable to that person;
2. operator global ceiling → "the free tier is at capacity today";
3. prepaid balance continues to bypass (1) exactly as ADR 0176 Phase 2 has it bypass the tenant cap today.

No new cap value is introduced: the per-subject cap is `target.dailyTokenCap`, the
same number a personal tenant already gets. A participant in a workspace should
get what they would have got alone, which is also the least surprising answer.

## Alternatives considered

| option | why not |
|---|---|
| **Do nothing; rely on the operator global cap** | `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP` (set on kicktodo 2026-09-15) bounds the operator's spend. It does NOT stop participant A from consuming participant B's allowance — it makes the failure arrive for everyone at once instead. Correct as an interim, wrong as the answer. |
| **Widen the storage interface with a `subject` param** | Changes a usage table's primary key in both adapters + a migration, and forces a subject onto callers that have none. Revisit if a third scope ever appears. |
| **Meter per subject for ALL tenants** | Doubles the row count for personal tenants to express a fact the tenant id already carries, and drags every personal tenant into the DSAR surface of §4 for no benefit. |
| **Give shared workspaces a larger pooled cap** | Treats a fairness bug as a capacity bug. The first active participant still starves the rest; the number just changes. |

## Phases

| phase | content |
|---|---|
| **0** | **plumb an OPTIONAL acting subject to the managed dispatch surface** (`ManagedToolsRoundRequest` + `prepareManagedDispatch` + the two callers). Absent stays legal — see Open question 1. |
| 1 | the key composer + `isSinglePrincipalTenant` gate, one module, unit-tested against collision with real tenant shapes |
| 2 | `managedProvider` reads/writes the per-subject bucket for multi-principal tenants; cap order per §5 |
| 3 | `incrementMediaUsage`/`getMediaUsage` the same way (§3) |
| 4 | **`registerSubjectEraser` + the ADR 0464 tripwire coverage (§4)** — not optional, not a follow-up |
| 5 | an operator-visible read: per-subject usage is not observable today — **landed as a SELF read, see Open question 2** |

Phases 0–4 ship together or not at all. Landing 1–3 without 4 creates personal
data with no erasure path, which is a worse state than the pooling it fixes.

## Open questions

1. ~~Does the acting subject reach `managedProvider` on every path that charges?~~
   **ANSWERED by reading it, before writing any code — and the answer adds a
   phase.** It does not reach it at all: `ManagedToolsRoundRequest`
   (`managedProvider.ts:390`) carries `userFacingProvider`, `tenantId`, `messages`,
   `tools`, `maxTokens`, `signal` — **no subject**, and `prepareManagedDispatch`
   (`:295`) takes the tenant positionally. The subject must be plumbed before it
   can be metered, which is now Phase 0.

   The two callers show why the parameter must be **optional**:

   | caller | subject available? |
   |---|---|
   | `host/conversationToolLoop.ts:344` | yes — an acting user exists |
   | `features/chat-widget/publicGateway.ts:143` | **no** — the public widget is anonymous by design |

   So an absent subject is a legitimate, permanent state, not a gap to close. It
   falls back to the tenant bucket, which for the widget is the correct scope
   anyway. A design that made the subject mandatory would have broken the public
   widget, and I would have found that during implementation rather than here.
2. ~~Should a workspace OWNER see per-subject usage (an operator view), and does
   that conflict with §4's pseudonymity?~~ **ANSWERED by phase 5: NO operator view,
   a SELF read instead — and the conflict is the reason, not an obstacle routed
   around.**

   An operator view over other subjects needs a reverse map from bucket back to
   person. The bucket is `sha256(tenantId + subject)` *precisely* so these rows are
   not a log of who asked what, when (§4). A reverse map would rebuild exactly
   that: a second personal-data surface, created to display a number, over rows a
   DSAR must be able to empty. The pseudonymity is not an inconvenience the
   operator view has to work around — it is a decision this ADR already made, and
   an operator view would quietly repeal it.

   A self read needs no map at all: the caller's subject arrives with the request,
   so the bucket composes directly. **And it is the read that was actually
   missing.** "Per-subject usage is not observable today" was a complaint on behalf
   of participants, and phases 0–4 gave every participant a private allowance with
   no way to see it.

   The load-bearing part is not the number, it is the **scope**. Under the old
   pooled behaviour "the free tier is exhausted" was a property of the workspace;
   after phases 0–2 it is a property of *you* — and a bare token count cannot tell
   a user which regime they are under. So the read reports
   `scope: 'subject' | 'tenant'`, **derived from the composer's own answer rather
   than decided a second time**, and the UI says either "this is your own daily
   allowance" or "this allowance is shared with everyone in this workspace".

   What an operator still cannot do is see an individual's usage. If that is ever
   wanted it is a NEW decision with a threat model, not an extension of this one.
3. ~~Retention: does a `managed:sub:` key attribute correctly to a held tenant
   under `kvAgeOut`, or age out early?~~ **PREMISE FALSE — `kvAgeOut` never
   touched these rows at all.** See the correction above. The real retention
   question, which stands open: these tables have NO TTL lane of any kind, and
   phases 1–3 multiplied their row cardinality by the participant population.

## CORRECTION 2026-09-15 — the bucket key had to carry its tenant, and open question 3's premise was false

**Open question 3 asked whether `kvAgeOut` attributes a `managed:sub:` key to the
right held tenant. It could not have been answered as asked.** `kvAgeOut` sweeps
`hostext:*` rows in `host_ext_kv`; managed usage lives in a dedicated SQL table,
`managed_provider_usage`. The two never meet. I wrote a question about a mechanism
that was not in play, and it sat there reading like a known unknown.

**What is actually true, and it is a regression this ADR introduced.** ADR 0284
teardown (`deleteAllTenantData`) introspects every table with a `tenant_id` column
and deletes by EXACT match. Phases 1–3 put `managed:sub:<hash>` in that column. So
tearing down a workspace deleted the rows literally keyed to it and **left every
participant's row behind** — orphaned under a one-way hash, in a store §4 itself
calls subject-linked personal data.

**The asymmetry is the shape of the thing §4 chose deliberately.** A bucket is
re-derivable from a SUBJECT, which is what makes DSAR satisfiable. It is not
re-derivable from a TENANT, which is what teardown has. **I bought
DSAR-by-subject and paid for it in teardown-by-tenant without noticing the
trade.**

**The fix puts the tenant in the key** — `managed:sub:<tenantId>:<hash>` — so
teardown can match a prefix. Chosen over denormalising an `owner_tenant_id`
column onto both usage tables (the `a2aTaskStore` precedent), which also works and
costs a contiguous migration in both adapters. **It costs nothing in
pseudonymity**: §4 requires the SUBJECT not be recoverable, and a workspace id is
not personal data — it is in the URL of every request that touches that workspace.
The prefix says which workspace an unreadable counter belongs to, which is exactly
what teardown needs and nothing more.

**Timing, because it decided the order of work.** Measured at the time: production
was 15 commits behind and `7b4b350fa` (phases 0–2) was inside that gap, so **no
`managed:sub:` bucket had ever been written in production — not once.** Every
orphan was still hypothetical, and stayed hypothetical only until the next deploy.
That is why the fix preceded the deploy instead of following it.

**What is STILL open, and is not this correction's to close:** these usage tables
have no TTL sweep of any kind — no `registerKvAgeOut` (wrong seam), no
`registerRetentionPurger`. They accumulate one row per (bucket, provider, day)
indefinitely, and phases 1–3 multiplied that cardinality from O(tenants) to
O(active participants). That is a retention gap, it predates this ADR, and it is
now materially larger because of it.

## Non-goals

- Billing. Prepaid balance and paid plans stay per-tenant; this is the FREE tier's
  fairness, not a change to who pays.
- A new cap knob. §5 reuses `target.dailyTokenCap`.
- Re-keying personal tenants' existing rows. No migration is proposed.

## Implementation record

| phase | landed | evidence |
|---|---|---|
| 0 | `7b4b350fa` (#3852) | optional `actingSubject` on `ManagedToolsRoundRequest` + `ManagedDispatchRequest`; both callers unchanged in behaviour |
| 1 | `7b4b350fa` (#3852) | `providers/managedUsageScope.ts` — the one composer; `managed-usage-per-subject.test.ts` |
| 2 | `7b4b350fa` (#3852) | cap read and charge both routed through `managedUsageBucket`, cap order per §5 |
| 3 | `d430a8cab` (#3858) | `mediaBudget.ts` TTS/STT; `media-usage-per-subject.test.ts` |
| 4 | `7b4b350fa` + `d430a8cab` | `eraseSubjectManagedUsage` registered AND declared in `subjectEraserManifest`; clears the managed AND media stores |
| 5 | (this PR) | `describeOwnManagedUsage` + the figure on the existing settings prefs read; `managed-own-usage-read.test.ts` |

**Phase 4's tripwire caught me, which is the point of having it.** I registered
the eraser and did not declare it in `subjectEraserManifest`, and the ADR 0464
WF-CONS-2 source-vs-manifest equality gate went red. My own ADR's §4, enforced
against me by a mechanism I did not have to remember.

**Phase 3 was SMALLER than the correction note feared, and the note now says so.**
Images and video never touched `getMediaUsage` — separate counters — so the defect
was confined to TTS/STT: six call sites in three files, and `aiProvidersHost`
already carried `scope.actingUserId` from ADR 0396 P4.

**The phase-3 test was VACUOUS on the first attempt.** Media cases added to the
composer's test file stayed green under a sabotage that reverted `mediaBudget`'s
read to the pooled tenant, because a composer test cannot see whether
`checkMediaBudget` calls the composer. Mechanism and WIRING have to be pinned
separately.

### Phase 5 record

Landed on the existing `GET …/settings/prefs` route beside the BYOK `usageToday`
figure, NOT on a new endpoint. That route is already the answer to "how much have
I used today"; a second endpoint for the second lane would make a user check two
places to learn one thing — the parallel-surface mistake `ARCHITECTURE.md` exists
to prevent.

`describeOwnManagedUsage` reads through the SAME composer as the charge and the
cap check. **A usage display that disagreed with the cap that blocks you would be
worse than no display**: it would make a correct "daily limit reached" look like a
bug.

Sabotage, two decisions reverted independently:

| reverted | red |
|---|---|
| the read composes its own bucket (`bucket = tenantId`) | 3 of 6 — own-spend, remaining, scope |
| `scope` hardcoded instead of derived | 1 of 6 — scope only |

The three survivors of the first are the anonymous-tenant read, the
bucket-never-exposed assertion, and the null-when-unconfigured assertion — all
byte-identical under either implementation, so a disjoint red set rather than a
global failure.

**`null` is not zero.** A deployment with no managed target reports `null` and the
UI renders nothing. `0 of 0` would tell a white-label operator's users they have a
free tier that is fully spent.

### What this ADR did NOT close

Open question 3 stands: whether `kvAgeOut` attributes a `managed:sub:` key to the
right held tenant, or ages it out early, was **never measured**. A reserved-prefix
key is not a tenant prefix. The status line above must not be read as answering
it.
