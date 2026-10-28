# ADR 0981 — Secure production profile (gap-closure B1)

Status: implemented (2026-10-26). Accepted 2026-10-26; P1–P3 merged and live (rev 01056-bmp). The user accepted the recommended answers to Q1–Q5 on 2026-10-26 (recorded under "Decisions recorded" below). D4 and D5 changed on acceptance; their correction notes say how. Drafted 2026-10-25 as the decision record that Wave B item B1 of [ADR 0970](0970-platform-competitive-gap-closure-program.md) waits on; it answers planning question **S02-G1**. No code has changed yet, and SEC-01 stays Open.

Date: 2026-10-25. Plan: [section 02](../plans/platform-gap-closure-2026-10-24/02-secure-profiles-and-independent-assurance.prd.md), requirement **S02-R1 (SEC-01)**, witness **S02-T1**, risk **S02-K1**. Builds on [ADR 0195](0195-fail-closed-production-posture.md) (fail-closed production posture), ADR 0636 (by-name surface acknowledgement), ADR 0745 D4 and ADR 0833 D8 (deployed services refuse harness/test auth), and [ADR 0969](0969-superadmin-requires-mfa.md) (superadmin MFA, opt-in).

**RFC verdict: host-only, no RFC.** A profile is operator configuration checked at server start. It adds no run-event field, capability flag or error code. Turning on membership enforcement changes what `capabilities.authorization` advertises, but that advert and its RFC 0049 semantics already exist; this ADR only decides when the host must turn it on.

## Context: what already exists (measured 2026-10-25 on `bbecebaad`)

The plan's S02-R1 lists seven controls for a strict profile. Most already exist, and the strict profile is already named: `OPENWOP_DEPLOY_POSTURE=auth` (`host/deployPosture.ts`, "the strongest signal that a deploy is a real, multi-tenant, signed-in install"). Server start (`index.ts` `main()`) enforces it today:

| S02-R1 control | Under `auth` today | Where | Escape hatch |
| --- | --- | --- | --- |
| Authenticated identity | Sign-in required for managed-tier turns; anonymous sign-in off by default (`managedAnonSignInRequired`) | `deployPosture.ts` | `OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED=false` |
| Secure cookies / TLS, session secret, dev-token withdrawal | Refuses to boot unless `NODE_ENV=production` (DUR-5) | `enterprisePostureStartupError` | `OPENWOP_ALLOW_INSECURE_AUTH_POSTURE=true` |
| Durable control-plane store | Refuses to boot on a non-Postgres DSN (DUR-1) | same | `OPENWOP_ALLOW_EPHEMERAL_STORAGE=true` |
| Durable surface stores | Refuses to boot while a surface with a durable adapter stays on memory | `assertDurableSurfacesInEnterprise` (`surfaceBackends.ts`) | `OPENWOP_ALLOW_INMEMORY_SURFACES=<names>` |
| Persistent BYOK protection | Refuses to boot without `OPENWOP_BYOK_KMS_KEY` | `index.ts` KMS guard | none |
| Withdrawn test/dev entry points | Refuses to boot with `OPENWOP_TEST_AUTH_ENABLED=true` or harness OIDC env; `auth` counts as a deployment marker | `testAuthSeamStartupError`, `oidcTrustRootStartupError` | none |
| Demo seeding | Explicit seeding defaults off (DUR-3) | `.env.example`, ADR 0195 | `OPENWOP_DEMO_SEED_ENABLED=true` |
| **Expected membership authorization** | **Not required.** RFC 0049 enforcement runs only when `OPENWOP_AUTHORIZATION_ENFORCEMENT=true` exactly; otherwise it is dormant and not advertised | `protocolAuthorization.ts:53` | n/a |
| **Superadmin MFA** | **Not required.** Opt-in `OPENWOP_SUPERADMIN_REQUIRE_MFA=true`, default off on every posture (ADR 0969 D1) | `superadmin.ts:42` | n/a |

Two observations shape the decision:

1. **The gap is two controls, not a new profile system.** Identity, Secure cookies, durable storage, KMS and test-seam withdrawal are already fail-closed under `auth`. Membership authorization and superadmin MFA are the two S02-R1 controls the strict profile does not yet require.
2. **The guards report one failure at a time.** Each guard calls `process.exit(1)` on its own failure, so an operator missing three controls fixes them over three failed boots. The KMS guard throws from `createApp` rather than returning a message like the others.

Production today: `app.openwop.dev` discovery (read 2026-10-25) advertises an `anonymous` auth lane and no `capabilities.authorization`. It is the public demo, an evaluation posture, so nothing proposed here changes it. The postures of white-label operators (KickTodo, Book AI) were **not** read for this draft; see Q4.

> **Measured 2026-10-26 (Q4; user-approved, read-only, service spec flags only, no values beyond these flags):** both `kicktodo-prod/kicktodo-backend` and `bookai-prod/openwop-app-backend` run `OPENWOP_DEPLOY_POSTURE=auth` with `NODE_ENV=production`, a KMS key, and `OPENWOP_AUTHORIZATION_ENFORCEMENT` unset. KickTodo sets `OPENWOP_SUPERADMIN_REQUIRE_MFA=true`; Book AI does not. Each lists two `OPENWOP_SUPERADMIN_TENANTS` entries. So D2's membership row affects both operators, and the MFA row affects Book AI.

## Decision

### D1 — Reuse `OPENWOP_DEPLOY_POSTURE`; `auth` is the strict production profile

No new `OPENWOP_SECURITY_PROFILE` variable. The three existing values become named profiles:

- `auth` — **strict production profile.** Every row of the D2 matrix is required.
- `cookie-per-visitor` and `bearer-shared` — **evaluation profiles.** They keep today's behaviour, and the host labels them as evaluation in its startup log and readiness output (D5), so nobody mistakes a demo install for a hardened one.

A profile is never a feature toggle or a paid entitlement (the plan rejects that: core safety cannot vary by plan).

### D2 — Minimum-control matrix for `auth` (the S02-G1 answer)

| Control | Requirement | Change from today |
| --- | --- | --- |
| Authenticated identity | Required | none |
| `NODE_ENV=production` (Secure cookies, session secret, dev tokens withdrawn) | Required; existing hatch kept | none |
| Durable control-plane store | Required; existing hatch kept | none |
| Durable surfaces | Required; by-name acknowledgement kept | none |
| BYOK KMS envelope key | Required; no hatch | none |
| Test login seam and harness OIDC withdrawn | Required; no hatch | none |
| **Membership authorization** (`OPENWOP_AUTHORIZATION_ENFORCEMENT=true`) | **Required**, with a named hatch `OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION=true` | new |
| **Superadmin MFA** (`OPENWOP_SUPERADMIN_REQUIRE_MFA=true`) | **Required whenever `OPENWOP_SUPERADMIN_TENANTS` is non-empty**, with a named hatch `OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA=true` | new |

Each new hatch follows ADR 0195's rule: an operator may accept a named risk, but never drift into it silently. Each one is logged at every start and shown to operators through the D5 output.

### D3 — One startup report instead of first-failure exits

`host/deployPosture.ts` gains `productionProfileStartupErrors(env, config): string[]`. It calls the existing guard functions (`enterprisePostureStartupError`, `oidcTrustRootStartupError`, `testAuthSeamStartupError`, the KMS check, the surface check) plus the two new rows, and returns **every** failure. `main()` logs them together and exits once. The guards stay in their current owners; this is a caller, not a second copy of the rules. It stays out of `createApp()`, as ADR 0195 requires.

### D4 — Migration without lockout (S02-K1)

> **CORRECTED ON ACCEPTANCE (2026-10-26, Q3):** the two-release warn-then-enforce plan below was dropped. The user questioned whether a warn release was needed, and it is not: a missing control is a **startup refusal** whose message names the exact variable or hatch, which is how ADR 0195's existing rows already behave. Nothing denies anyone silently. The real lockout moment is when an operator **turns membership enforcement on**, so the census becomes a read-only check the operator runs before doing that, not a release of its own. The two new rows ship as refusals in one release, with the hatches, the census and the release notes' "Upgrading from" block. The original text is kept for the reasoning trail.

Enforcing the two new rows can lock people out:

- **Membership authorization** is fail-closed: once it is on, a principal with no membership row is denied every protocol scope (`basis: 'none'`).
- **Superadmin MFA** turns a superadmin with no enrolled second factor into a regular user on admin routes. That is the lockout ADR 0969 D1 avoided by defaulting off.

So the two rows roll out in two releases:

1. **Warn release.** Under `auth`, a missing new control logs `production_profile_warning` at every start and shows in readiness, but the host boots. That release also ships a read-only **census** in the existing Operations surface:
   - every principal with tenant access but no membership row, which is exactly who enforcement would deny;
   - every listed superadmin with no enrolled TOTP factor.

   It reports counts and opaque subjects, never credentials.
2. **Enforce release** (the next minor version, no earlier). The warning becomes a startup error unless its named hatch is set. The release notes' "Upgrading from" block names both new variables, both hatches and the census.

As accepted: before an operator upgrades to the release with the two new rows, each known operator chooses, through its owner. KickTodo turns membership enforcement on (after the census) or sets `OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION=true`. Book AI does the same, and also either enrolls TOTP for its superadmins and sets `OPENWOP_SUPERADMIN_REQUIRE_MFA=true`, or sets `OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA=true`. The coordinator relays this; this ADR does not change any operator's configuration.

Recovery paths that must keep working with both rows on, and that the witness must exercise:

- **Break-glass** (ADR 0389 P3) stays exempt from the MFA rule; ADR 0969 D2 already exempts the `breakglass:` principal prefix.
- **Owner bootstrap**: a caller in their own personal workspace already passes the enforcement check (`isOwnPersonalWorkspace`, `protocolAuthorization.ts:268` and `:310`). For a **shared** workspace, this draft did not verify that the creator gets a membership row, so witness case 7 must prove it before the membership row ships (P3).
- **Hatches**: each hatch is a single env change through `scripts/update-env.sh`; no rebuild is needed.

### D5 — The evaluation label is observable, not just logged

`/api/readiness` gains a host-local `profile` field: `strict` or `evaluation`, plus the names of any hatches in effect. Names only, never values. It is a host-extension readiness field, not a wire field. That makes "evaluation remains clearly labeled" (S02-T1) something a test and an operator can read.

> **CORRECTED ON ACCEPTANCE (2026-10-26, Q5):** public `/api/readiness` carries only `profile: strict | evaluation`. Hatch names tell an outsider which risks an operator accepted, so they appear only to signed-in superadmins (the existing Operations surface) and in the startup log.

## Alternatives considered

- **A new `OPENWOP_SECURITY_PROFILE=strict` variable, independent of posture.** Rejected: it would duplicate `auth`, which already means "real signed-in install", and create a fourth combination (`auth` but not strict) that is exactly the drift ADR 0195 closed.
- **Default every control on for every posture.** Rejected: the public demo and local development have no members or MFA by design, and ADR 0969 D1 records why default-on MFA locks out superadmins.
- **Enforce both new rows immediately, with hatches only.** First rejected: without a warn release and a census, an operator learns about missing membership rows by being denied in production. **Chosen on acceptance** (see D4's correction): the refusal is at startup, so no one is denied before the operator decides, and the census runs before enforcement is turned on.
- **Leave membership enforcement opt-in and only document it.** Rejected: S02-R1 names "expected membership authorization" as a strict-profile control, and documentation is not a control.

## Witness (S02-T1) — what acceptance requires before any gap moves

A backend test file (`test/production-profile.test.ts`) drives `productionProfileStartupErrors` with an operator-config fixture, using no real secrets:

1. With every control met, it returns no errors and readiness reports `strict`.
2. It removes each D2 row in turn (a test per row) and asserts that exact row's error appears and no other row's does.
3. It removes three rows at once and asserts all three errors come back together (D3).
4. With each new row's hatch set, it boots; the operator view lists the hatch by name and public readiness does not.
5. An evaluation posture boots with no D2 requirements, and readiness reports `evaluation`.
6. ~~Warn release: a missing new row logs `production_profile_warning` and does not exit.~~ Dropped with the warn release (D4 correction). Instead: the census on a fixture reports exactly the membership-less principals and the superadmins without a factor, as counts and opaque subjects.
7. No lockout, as HTTP tests on `createApp`:
   - break-glass reaches a superadmin route with MFA required;
   - a personal-workspace owner, and the creator of a newly created shared workspace, can each create and read a run with enforcement on;
   - a principal reported by the census as membership-less is denied after enforcement and allowed once a membership row is added.

Sabotage witnesses: drop one row from `productionProfileStartupErrors` and its case reddens; restore first-failure exit and case 3 reddens.

The S02-R1 status records what ran. **SEC-01 stays Open** until the S02-T2 permission matrix also runs and the closure packet is reviewed. This ADR alone closes nothing.

## Phased implementation (after acceptance)

| Phase | Scope | Exit |
| --- | --- | --- |
| P1 | D3 aggregate report over existing guards; D5 public `profile` label; no behaviour change for a coherent deploy | Cases 1–3 and 5 for existing rows |
| P2 | Read-only census in Operations (membership-less principals, superadmins without a factor); operator view of hatches | Case 6; shared-workspace creator half of case 7 |
| P3 | Two new rows refuse unless hatched; release-notes upgrade block; known operators decide first (D4) | Cases 2–4 and 7 for the new rows; sabotage witnesses |

## Decisions recorded (2026-10-26)

The user accepted the recommended answer to each question.

- [x] **Q1** — Membership authorization is **required** under `auth`, with the `OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION=true` hatch (D2 row 7).
- [x] **Q2** — Superadmin MFA is **required** under `auth` when superadmins are configured, with break-glass exempt and the `OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA=true` hatch (D2 row 8).
- [x] **Q3** — **No warn release.** Missing controls refuse at startup with the exact fix named; the census is a pre-enable check (D4 correction).
- [x] **Q4** — Measured 2026-10-26: KickTodo and Book AI both run `auth` with membership enforcement off; Book AI also has MFA off (Context).
- [x] **Q5** — Hatch names are **operators only**; public readiness shows only `strict` or `evaluation` (D5 correction).

## Implementation record

| Phase | Commit / evidence | Status |
| --- | --- | --- |
| P1 — one startup report (D3) and the readiness `profile` label (D5) | #5262, merged 6adc7ca93. Witness `backend/typescript/test/production-profile.test.ts`; `adr0745-oidc-trust-guard` re-pointed at the collector. Both sabotage-witnessed. | Merged; LIVE 6adc7ca93 (rev 01052-rd5, 233b) |
| P2 — census (D4) and operator view of hatches (Q5) | #5265, merged e79425222. Witness `backend/typescript/test/profile-census.test.ts`, sabotage-witnessed except the personal-workspace skip (see the test header). Shared-workspace creator half of case 7: `createWorkspace` seeds the creator as `owner`, and `authorization-fail-closed.test.ts` ("owner allowed (200)") already proves an owner passes with enforcement on. | Merged; LIVE e79425222 (rev 01054-xbz, 234b) |
| P3 — the membership and superadmin-MFA rows with their hatches | #5272, merged 9ff1b1e94. `strictProfileRuleErrors()` in `host/startupChecks.ts` reads each rule's own predicate (`isAuthorizationEnforced`, `superadminMfaRequired`, `listedSuperadminTenants`). Witness `production-profile.test.ts` (both rows, both hatches, exact-`true`, no superadmins listed, all rows reported together, evaluation profile). No-lockout HTTP cases: `break-glass.test.ts` (break-glass reaches a superadmin route with MFA required) and `profile-census.test.ts` (a census-reported member is denied under enforcement, then allowed once given a role). Census lists both new hatches. DEPLOY.md and `.env.example` document both rows. `scripts/preflight-deploy.sh` Gate 5c refuses a deploy BEFORE the build when the live env lacks either decision (a bare deploy carries the live env forward), witnessed by 12 checks in `scripts/test-deploy-gates.sh` and sabotage-witnessed (7 red with the gate disabled). Requested by the coordinator after kicktodo-2b's review: a boot refusal alone costs an operator a build plus a revision that fails its startup probe. | Merged; LIVE 9ff1b1e94 (rev 01056-bmp, 236b); preflight Gate 5c printed `profile: OK evaluation` and boot logged `deploy_profile=evaluation` with no startup refusal |

> **P2 design note (2026-10-26).** The census records the decision a rule WOULD make on real traffic, not a list at rest. Switching into a shared workspace is already membership-gated, so the callers enforcement would deny are members whose role lacks a scope and keys whose issuer lost it, which is a decision rather than a table. While membership enforcement is off under the strict profile, `requireProtocolScopeIn` asks `decideProtocolAuthorization` off the request path. It skips the same callers enforcement skips (wildcard bearer, own personal workspace), samples each (tenant, subject, scope) at most once per 10 minutes, and records only a "no". `isSuperadmin` records person sessions without a verified second factor while the MFA requirement is off. Both record opaque subjects and tenant ids, never credentials. They are per instance and since boot, and the report says so. `GET /host/openwop-app/operations/profile-census` is superadmin-only and is the one place hatch names appear.

> **Wire check (2026-10-26).** P1 and P2 moved no conformance rows: the major-2 cut 234c on e79425222 (bundle sha256 `667450609dd8`, witness `9d7999f46936`) certified 500/0/11/376 = 887, identical row for row to cut 230c, with `claimedProfiles` equal. P3 likewise moved none: cut 236c on 9ff1b1e94 (P3 live, sha256 `d7ac1adf4a4f`) certified 500/0/11/379 = 890, where the 3 new rows are #5271's inapplicable 0082/eval-gate rows and `claimedProfiles` are unchanged. P3 adds startup and deploy-time refusals only, under the `auth` posture, which the certified demo does not run.
>
> **Operators (2026-10-26).** Both known `auth` operators acknowledged before P3 merged. KickTodo will enforce membership via the census before syncing P3; Book AI will set `OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION=true` before the upgrade, enforce after the census, and require MFA once its superadmins have enrolled. Neither operator's configuration was changed by this work.
>
> **What this does not close.** SEC-01 stays Open. S02-T1 is complete for the D2 matrix; the S02-T2 role × tenant × entry-lane permission matrix (S02-R2) has not started.
