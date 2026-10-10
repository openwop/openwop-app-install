# ADR 0771 — A write budget for operator-provisioned keys, not a conformance exemption

Status: implemented (P1). P2 (prod knob + re-cut) rides the next deploy. Architect-reviewed 2026-09-28: 0 blockers, 2 HIGH folded in
Date: 2026-09-28
Relates to: ADR 0640 (read/write split of the per-IP limiter), ADR 0735 (post-deploy certification evidence), ADR 0270 (developer API keys)

## Context

Three of the four red rows across today's two production certification runs
trace to one mechanism. `middleware/rateLimit.ts` gives every client IP one
write budget of 60/min (ADR 0640). A certification run is one client, from one
IP, doing a lot of writes: registering webhooks, creating runs and deleting
subscriptions.

MEASURED:
- **b3de651e9, 2.43.0 m2:** `v2-webhook-delivery-isolation` (0215, "with 8 subs")
  and `v2-webhook-standard-webhooks-delivery` (0201, "opt-in registration MUST
  answer 201 (got 429 rate_limited)") failed on 429s.
- **c4aad98c2, 2.43.0 m2:** `v2-webhook-message-id-stable` recorded `blocked`
  with no reason. The corpus steward traced that to a suite bug (openwop #1753,
  in 2.43.2). A cleanup hook doing serial webhook DELETEs overran the 30 s hook
  timeout, and the likely cause on this path is DELETEs retrying on 429.

The evidence is supposed to measure the wire. Here it measured our throttle
instead, and a certification that fails for a reason unrelated to conformance
is worth less than one that passes.

Two tempting fixes are wrong:
- **Exempt the conformance tenant.** That tenant is just a bearer key, so any
  holder skips the limiter. The corpus steward agreed this is not the home.
- **Raise the global write knob during an evidence run.** That loosens the
  limit for everyone for the length of the run, which is exactly when the host
  is under load.

## A finding that constrains the design

`features/developer-keys/routes.ts` says "issuing a credential is not
anonymous". Its guard is `req.userId ?? req.principal?.principalId`, and
`authMiddleware` stamps anonymous sessions with
`principalId: session:<sid>` (auth.ts:1375). **So an anonymous session can mint
a developer API key.** The key is scoped to that anonymous tenant, so nothing
escalates. It does rule out any budget keyed on user-minted keys or their
tenants: opening more anonymous sessions would multiply it. (The guard itself is
fixed separately: see Consequences.)

## Decision

**D1.** A request authenticated by an **operator-configured** key draws writes
from a per-key bucket with budget `OPENWOP_RATELIMIT_KEY_WRITE_REQS_PER_MIN`
(default 600). It does not draw from the per-IP write bucket. An
operator-configured key is `req.principal.auth.kind === 'env-key'` **and** the
key came from `OPENWOP_API_KEYS`/`OPENWOP_API_KEY`. The built-in `dev-token`
fallback does not count; see the review corrections below. The bucket is keyed
on a digest of the full token, never on `principalId`.

**D2.** Everything else is unchanged: sessions (anonymous and signed-in),
user-minted developer keys, subject bearers and OIDC. They keep the per-IP
read and write buckets of ADR 0640, because none of them is a finite,
operator-controlled set.

**D3.** Reads are unchanged for everyone. Run-creation quotas (per-session and
per-IP runs/day) are unchanged too. This decision is about the write burst
bucket only.

**D4.** The limiter already runs after `authMiddleware`, which is why it can
read `auth.kind`. A test pins the ordering: moved before auth, the keyed bucket
would read an unverified bearer, and a rotating fake token would buy fresh
budget.

**Why this is not an exemption.** The keyed bucket is still a limit, it applies
to every operator key rather than to a tenant singled out by name, and only the
operator can create such a key. The harness gets a budget sized for one
automated client, and a stranger gets nothing new.

## Review corrections (/architect, 2026-09-28)

- **HIGH-1: the built-in `dev-token` is an `env-key` on unenforced deployments.**
  `apiKeyTenants.ts:44` falls back to `dev-token:*` when auth is not enforced
  and no key is configured, and auth.ts:918 stamps it `env-key`. On that
  posture, a PUBLIC string would inherit the keyed budget, and "only the
  operator can create such a key" would be false. The keyed budget therefore
  requires a configured key. (`dev-token:*` there is already a cross-tenant
  credential, SEC-2, so the added blast radius was small, but the claim should
  be literally true.)
- **HIGH-2: bucket key.** `principalId` is `bearer:<first 8 chars>` (auth.ts:908).
  Two configured keys that share a prefix would share a bucket: fail-safe, but
  wrong. The bucket is keyed on a digest of the full token instead.
- **Verified by the review:**
  - The only `env-key` setter is auth.ts:918, fed only by operator env.
  - The limiter mounts after auth (index.ts:767 → :799), with no handlers
    before auth.
  - The anonymous-mint finding is confirmed (developer-keys/routes.ts:20 +
    auth.ts:1375).
  - A minted `owk_` key is `api-key` and can never be `env-key`.

## Alternatives weighed

| option | why not |
|---|---|
| Exempt the conformance tenant | Any holder of that bearer skips the limiter, and the exemption is a special case keyed on a name. |
| Per-key budget for every API key | Anonymous sessions can mint keys (above), so the budget multiplies. |
| Per-tenant budget for every keyed caller | Same multiplication through anonymous tenants. |
| Raise the global write knob during evidence runs | Loosens the limit for everyone, at peak load, for the length of the run. |
| Make the suite honour `Retry-After` | Worth doing for the suite (openwop-77 is considering it for the DELETE hook), but it only hides our throttle rather than sizing it. |

## Phases

1. **P1:** implement D1–D4 in `rateLimit.ts`, with the principal bucket as a new
   `RateLimitReason` (`key_write_rate`, scope `key`), and add route tests:
   - an env-key caller passes 60 writes in a minute;
   - a session caller from the same IP still hits 429 at 61;
   - an anonymously minted developer key gets no keyed budget;
   - the limiter still reads a verified principal;
   - the unenforced `dev-token` gets no keyed budget (HIGH-1);
   - two keys sharing an 8-character prefix get separate buckets (HIGH-2).
2. **P2:** set `OPENWOP_RATELIMIT_KEY_WRITE_REQS_PER_MIN` explicitly on prod,
   using the merge-only `--update-env-vars`, and re-cut evidence. The rows above
   should then fail only on what they measure.

## Consequences

- Certification runs stop measuring our throttle.
- `details.reason: key_write_rate` makes a keyed 429 distinguishable from an IP
  one in the logs.
- Separately, `developer-keys` must refuse `auth.kind === 'anon'`, so the
  route's own claim ("issuing a credential is not anonymous") becomes true.
  That is its own small fix with its own test, not part of this ADR's budget
  logic. The D1 design deliberately does not depend on it.

## Open questions

- Is 600/min right for one automated client? The m2 cut is single-worker. Measure
  the peak writes per minute of one cut before setting the prod value in P2.

## Implementation record

| phase | change | proof |
|---|---|---|
| P1 | `rateLimit.ts`: `configuredKeyBucketId` + `key_write_rate` (scope `key`), and a keyed budget that honours `OPENWOP_FORCE_RATE_LIMIT`. `apiKeyTenants.ts`: `apiKeysConfigured()`. | `test/adr0771-key-write-budget.test.ts` (7 legs). Each guard is sabotage-proven: dropping the configured check reds HIGH-1, bucketing on the 8-char prefix reds HIGH-2, and ignoring FORCE reds the envelope leg. Through the real `createApp`, a fake bearer is refused with 401 by auth before reaching any bucket. |
| guard | `developer-keys` refuses `auth.kind === 'anon'`. | `test/developer-keys-anon-refused.test.ts`. Red first: on the unfixed code an anonymous session minted `owk_…` in `anon:…`. The signed-in control still mints. |

**Correction to the P1 test list.** The planned leg "a rotating fake bearer
would buy fresh budget" was guarding a case that cannot occur. `authMiddleware`
answers an unrecognised bearer with 401 before the limiter runs, so a fake token
reaches no bucket at all. The leg now pins that instead.

**One trap the review did not list.** `OPENWOP_FORCE_RATE_LIMIT` exists so
`rate-limit-envelope` can induce the canonical 429, and it does that with the
conformance ENV KEY. A keyed bucket that ignored FORCE would have made that
scenario unable ever to see its 429. The keyed budget is therefore tied to FORCE,
unlike the MCP one.

## Addendum (2026-09-29): the keyed budget also covers runs per day

P1 covered write *requests*. It left the run quota (`runQuotaMiddleware`)
alone, and that quota keys a bearer caller on its tenant (`s:<tenantId>`). So
the conformance key kept sharing its tenant's `session_runs_per_day` (500 on
prod).

**Measured.** An undisturbed major-2 cut of c3d06c29 came out 155 pass / 27 fail
/ 83 blocked. 108 of the 110 non-pass rows were `429 session_runs_per_day`: the
day's cuts had spent the tenant's 500 runs. At first this was blamed on
overlapping cuts. A free probe (POST `/v1/runs` for a nonexistent workflow,
which is refused before any charge) returned the 429 with
`reason: session_runs_per_day` and a retry of 19.5 h.

**Change.** Callers matching the same predicate as the keyed write bucket
(`configuredKeyBucketId`) count their day's runs on
`OPENWOP_RATELIMIT_KEY_RUNS_PER_DAY` (default 5000, `0` = unlimited), keyed on
the token digest. On refusal the reason is `key_runs_per_day`, with scope `key`.
- This does **not** follow FORCE. FORCE induces the request-rate 429, and no
  per-day run quota has ever moved under it.
- The per-minute and concurrency run caps are unchanged for everyone.
- Sessions, anonymous callers, user-minted developer keys and the unconfigured
  dev-token keep the session cap. Tested in `test/adr0771-key-run-budget.test.ts` (7 legs). Sabotage-proven: widening the keyed budget to every caller reds all four must-not-widen legs.

**Operational pair.** `publish-evidence.sh` probes the quota the same free way
before its load test, and refuses rather than publish 429s as evidence.

## Addendum 2 (2026-09-29): …and in-flight runs

After addendum 1 shipped (b29427fef), major 2 certified (260/2/0), but major 1
still had one rate-limit red, and it was on a FLOOR row: `replay-fork`'s setup
run was refused with 429.
- Every 429 of the cut fell inside one 8-second burst while creates ran at
  about 18 per minute. That rules out the per-minute (120), day and write
  budgets.
- What remains is the tenant's concurrency cap (`session_concurrent`, default
  5), which the key shared with its tenant. Earlier scenarios leave runs
  non-terminal until a terminal event or the 60 s TTL.
- The request log carried no reason, so this was attributed by elimination.

**Change.**
- A configured key's in-flight runs are their own slot bucket (the token
  digest), capped by `OPENWOP_RATELIMIT_KEY_CONCURRENT` (default 50, `0` =
  unlimited). A refusal carries reason `key_concurrent` with scope `key`.
- Sessions keep `sessionConcurrent`. Developer keys do too.
- Every 429 now logs `rate_limited {reason, scope, method, path}`, with no
  principal and no token, so the next diagnosis is not by elimination.

**Proof.** Four new legs in `test/adr0771-key-run-budget.test.ts`, including
that a session caller gets `session_concurrent` at its 6th in-flight run.
Sabotage-proven both ways:
- widening the key cap to everyone reds 3 legs;
- dropping the keyed cap reds 2.
