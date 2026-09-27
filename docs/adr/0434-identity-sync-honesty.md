# ADR 0434 — Identity sync honesty: silent failures, the anon fail-open, and per-device state

**Status:** implemented — all five phases (2026-07-19).
**Date:** 2026-07-19
**Refines:** ADR 0003 (canonical user identity & session binding), ADR 0015
(workspace-as-tenant), ADR 0026 (Firebase owns identity).
**Authored with:** `/architect` (Track A — boundaries / authz / failure modes).

> **No OpenWOP RFC required.** Every surface touched is either frontend or a
> non-normative host-extension route under `/v1/host/openwop-app/*`. No
> run-event field, capability advert, endpoint contract, or normative `MUST`
> changes. Per `CLAUDE.md` § "A spec change needs an RFC", this is host work.

## Context

A user reported that signing in with the **same account on different machines
showed different stored data**. A five-lane audit traced it. The headline
finding is the opposite of the initial hypothesis:

**The identity core is sound.** `tenantIdFromOidc` (`middleware/auth.ts:428`) is
`user:sha256(iss:sub)` — deterministic and machine-independent. `reassignTenant`
(`storage/tenantMigration.ts`) is a single transaction whose table set comes from
schema introspection, with `ON CONFLICT DO NOTHING`, so it is atomic and
idempotent. Per-tenant seeding is CAS-claimed with deterministic keys. ADR 0003
Phase 4c got the design right.

**What is broken is everything around it: the failure paths are silent.** The
symptom is not one bug but three independent causes, each sufficient on its own.

### Cause 1 — writes fail silently and stay on one machine

`builder/persistence/backendStore.ts` wrote `localStorage` first, then POSTed
inside `try{}catch{}` **without ever reading `res.ok`**. A 401 (expired
session), 403, 429 (the per-IP fan-out hazard `CLAUDE.md` documents), or 5xx was
indistinguishable from success: the workflow lived in that one browser while the
UI reported saved. `listWorkflows` compounded it — `catch { return
localSummaries(); }` on *any* error rendered device-local drafts **as if they
were the account's list**. `removeWorkflow` mirrored it, deleting locally even
when the server refused.

### Cause 2 — a three-step fail-open chain

1. `routes/migrate.ts` appended `Set-Cookie: <name>=; Max-Age=0` on the same
   response where `middleware/auth.ts` appended a **promoting** `Set-Cookie`.
   Same name and path; the later header wins — so a user finished sign-in with
   **no session cookie at all**.
2. `middleware/auth.ts` treated any `OidcVerificationError` (expired, clock
   skew, wrong audience, JWKS blip) as a fall-through rather than a 401, with
   the comment *"Worst case the user lands on the anon path, which still works."*
3. With no cookie, that reached `mintAnonSession()` — a **brand-new
   `anon:<sid>` tenant**. The user, signed in and mid-session, silently became a
   new anonymous visitor and kept writing there.

Nothing reconciled it: `migrateAnonToUser` ran **only** on an explicit sign-in
click (never on session restore) and swallowed every failure. Its own comment
promised a retry — *"caller can retry after onIdTokenChanged fires"* — that no
caller performed. `bindOidc()` failure was likewise swallowed, degrading the RBAC
subject to a per-device `session:<sid>` (the ADR 0015 "lost access to my own
org" class).

### Cause 3 — user content in un-namespaced `localStorage`

Chat threads, prompts, and builder drafts (`chat/lib/storageKeys.ts`,
`prompts/userPrompts.ts`, `builder/persistence/localStore.ts`) carry no subject.
Per-device by construction — and on a shared machine, the next user sees the
previous user's threads. `chat/tabDeck/tabDeckPersistence.ts:39` already does
this correctly; the pattern simply was not applied to the `content`-class keys.

### Cause 4 — the active workspace is device-local

`routes/workspaces.ts` writes the active workspace **only to a cookie**; an
exhaustive grep for any last-active-workspace persistence returns zero hits, and
every session-mint path hard-codes `tenantId = personalTenant`. Switch into a
shared workspace on machine A and machine B shows your personal tenant. **This
reproduces the report with no failure condition at all.**

## Decision

Five phases. The ordering is `/architect`-reviewed and follows real gates.

### Phase 1 — one shared helper; stop swallowing failures *(implemented)*

`client/config.ts` gains `SyncFailureError`, `assertSynced()`, and
`isOfflineError()`. The distinction the old code lacked is the whole fix:

- **transport failure (offline)** → the local cache is honest, degrade quietly;
- **server refused (4xx/5xx)** → data loss, MUST surface.

`isOfflineError` is deliberately an **allow-list** (`TypeError` from `fetch`,
`AbortError`), not `!(err instanceof SyncFailureError)`. A catch-all would
relabel every programming error as "offline" and swallow it — recreating the bug
one layer up. This was caught by the phase's own tests, which initially passed a
serialization crash off as an offline save.

The builder store records the autosave outcome (`syncState`,
`syncFailureStatus`) and `SyncFailureBanner` surfaces a refused write with
cause-specific guidance — "sign in again" for 401/403 is useless advice for a
429, and vice-versa. The banner is **not dismissible**: the edit really is
unsaved.

### Phase 2 — narrow the fail-open; make adoption reconcile *(implemented)*

**The fall-through is not wrong; its breadth was.** `/architect` flagged that
removing it outright is unsafe: the backend deploys before the frontend, so a
hard 401 landing first would convert every hourly token-rotation race into a
user-visible failure — a worse regression than the bug.

So: a rejected bearer may still fall through **to a healthy session cookie**
(the case the behavior was written for, preserved), but a new `bearerRejected`
flag forbids reaching `mintAnonSession()`. A request that presented a bearer we
refused now gets `401 bearer_rejected_no_session` instead of a silent identity
switch. A visitor presenting **no** bearer is unaffected — the public demo path
is unchanged, and a test pins that.

`routes/migrate.ts` no longer expires the cookie, so the middleware's promotion
survives. `migrateAnonToUser` retries transient failures (401/429/5xx) with
backoff, and `reconcileRestoredSession()` runs the same handshake on a **restored**
session, once per page load — both underlying calls are idempotent.

> **Two pinned behaviors were deliberately overturned** (corrections, not silent
> rewrites — the rationale lives inline in both test files):
> `auth-bearer-cookie-fallthrough.test.ts` cases 2–3 ("no cookie → fresh anon
> minted, NOT 401") and `migrate-tenant.test.ts` ("expires the anon cookie").
> Both were reasoned from the 401-storm rationale, but that protection is the
> *healthy-cookie* case, which is untouched. With no cookie there is no session
> to preserve — minting handed the caller a new identity.

### Phase 3 — subject-scope the localStorage content keys *(implemented)*

Signed in the four `content` keys live at `<key>:<uid>`; anonymously they use
the **bare key**. That scheme was chosen over the alternatives for two reasons
beyond simplicity:

1. **No migration is required.** Every payload sitting at a bare key today is
   already correctly placed as anonymous content, and a visitor who never signs
   in keeps it exactly where it is. The ADR's original OQ-1 ("requires a
   one-time migration") was therefore **wrong** — the migration dissolves once
   the bare key is defined as the anonymous scope.
2. **It mirrors the backend**, where the anon sandbox is the default that gets
   adopted into the user tenant (ADR 0003 Phase 4c).

A generated per-device id was **rejected by `/architect`**: it would introduce a
third identity concept with no owner, beside the Firebase uid and the backend
session — the parallel-identity violation the review exists to catch.

The seam lives in **`platform/storage.ts`**, which already owns `STORAGE_KEYS`,
the `content` classification, and a one-time-migration precedent
(`migrateSampleNamespace`). A new module would have been a second owner. The
subject itself is module-level state with **one writer** (`auth/useAuth.ts` via
`auth/localContentAdoption.ts`) — threading it through the dozens of call sites
in `localStore`, `userPrompts`, and the chat caches would have spread identity
across the codebase.

Adoption on sign-in **unions, never destroys, and prefers the signed-in copy on
a true collision**; the anonymous source is removed only after the merged write
is CONFIRMED, so a quota failure leaves the work recoverable.

> **Ruling against the ADR's own OQ-2.** Sign-out does **not** delete the
> previous subject's content. Subject-mismatch-returns-null fully solves the
> *read*-isolation concern, which is what the leak actually is; deleting would
> destroy work in the overwhelmingly common case (own machine, sign out, sign
> back in). A shared machine wants an explicit "clear my data on this device"
> affordance instead — recorded as OQ-6.

**Bundle cost, accepted deliberately.** The scoping helpers and their call sites
added ~1.3 kB gzip to the entry chunk, taking it past the 196 kB budget. The
anon→user merge was split into a lazy chunk (`auth/adoptAnonContent.ts`), but
the isolation logic itself cannot be deferred — it runs on every read of
user-authored content. The budget was raised to 198 kB with that rationale
recorded inline, following the existing bump convention in
`check-bundle-budget.mjs`. The alternative was shipping a known cross-user
content leak.

### Phase 4 — persist the active workspace server-side *(implemented)*

`/architect` ruled out both tempting owners: the `User` record is keyed
`(tenantId, principalId)` — one human has **multiple rows, one per tenant** — so
it cannot hold a cross-tenant preference without a circular lookup; and
`navigation-settings` is a menu-config store, so putting workspace state there
creates a second owner for a concept ADR 0015 assigns to workspaces.

Decision: a **new subject-keyed `DurableCollection`** (keyed on `subject`, never
tenant) owned by the workspaces module. **It must be membership-revalidated at
session mint**, not only per-request — otherwise a removed member's stored
preference resurrects revoked access. Also fixes the switcher indicator, which
currently fetches once on mount, never refetches, swallows its error, and falls
back to rendering the deployment brand name — so it can actively lie about which
tenant you are in.

**Implemented as `host/activeWorkspacePref.ts`** — a `DurableCollection` keyed on
**subject**, never tenant. The switch route writes it (best-effort: a storage
failure must not fail a switch that was already authorized); the OIDC-bind mint
site reads it through `resolveActiveWorkspace`, which is **fail-closed**: the
stored preference is honored only after `isWorkspaceMember` confirms the subject
is STILL a member, and any error resolves to the personal tenant. Without that
re-check, a preference set before a revocation would resurrect access at mint
time — ahead of the per-request revalidation in the auth middleware, which is
why the middleware check alone is not sufficient.

The personal tenant short-circuits the membership check: a caller is the
implicit owner of their own tenant by construction.

### Phase 5 — demo seeding must not touch real accounts *(implemented)*

`AutoSeedExampleData` gated on `demoMode` **alone**, so on `app.openwop.dev` a
real signed-in user got demo personas written into their own tenant. It now also
requires an anonymous visitor. The gate reads `onAuthChanged`, **not** the
synchronous `getCurrentUser` cache — that cache is empty during the boot window,
so a sync check would read a signed-in user as anonymous and seed anyway, which
is the exact race this component runs inside.

> **A reported defect was investigated and REJECTED.** The audit flagged
> `ensureSeededAgentByRole` as a hole in the LEAK-7 kill-switch because it never
> calls `exampleDataSeedEnabled()`. Gating it was implemented, then **reverted**:
> it creates exactly one functional roster entry (no boards, cards, schedules,
> or demo depth), and its sole caller `ensureAssistantAgent` **throws** on null —
> so the "fix" would have disabled the assistant on every hardened deploy. The
> asymmetry is intentional and is now documented at the call site. Residual: the
> bootstrapped agent carries a sample persona label on a white-label install —
> a branding item, not data leakage.

## Alternatives considered

- **Delete the localStorage mirror; go server-authoritative.** Rejected for
  Phase 3: offline resilience is a real feature and its removal is a bigger
  behavioral change than the defect justifies.
- **Remove the bearer fall-through entirely.** Rejected — see Phase 2; the
  deploy-skew window would hard-fail every token-rotation race.
- **Store last-active-workspace on the `User` row / in `navigation-settings`.**
  Rejected — circular lookup and second-owner respectively.
- **`OPENWOP_AUTH_ENFORCE_BEARER=true` as the whole fix.** It does close the
  anon-mint fallback, but causes 1, 3, 4 and 5 are posture-independent and
  follow the app into production unchanged.

## Implementation record

| Phase | Change | Tests |
|---|---|---|
| 1 | `SyncFailureError` / `assertSynced` / `isOfflineError`; `backendStore` + `workflowsClient` call sites; builder `syncState` + `SyncFailureBanner` + 4-locale i18n | `backendStore.syncHonesty.test.ts` (10) |
| 2 | `bearerRejected` guard; `migrate.ts` cookie preserved; adoption retry + `reconcileRestoredSession` | `auth-bearer-cookie-fallthrough.test.ts` (6, 2 overturned + 1 added), `migrate-tenant.test.ts` (5, 1 overturned) |
| 3 | `platform/storage.ts` scoping seam (`scopedKey`/`scopedSpec`/`writeScoped`/`adoptAnonScoped`/`setStorageSubject`); all four `content` keys scoped; `auth/localContentAdoption.ts` + lazy `auth/adoptAnonContent.ts`; STORAGE.md row | `localContentAdoption.test.ts` (8) |
| 4 | `host/activeWorkspacePref.ts` (subject-keyed store, fail-closed resolution); write in the switch route; read at the OIDC-bind mint | `active-workspace-pref.test.ts` (8) |
| 5 | `AutoSeedExampleData` anonymity gate; `ensureSeededAgentByRole` rationale documented | — |

## Open questions

- **OQ-1** ~~Phase 3 migration + collision handling.~~ **RESOLVED** — no
  migration is needed (the bare key IS the anonymous scope); collisions union
  with the signed-in copy winning. See Phase 3 above.
- **OQ-2** ~~Clear content on sign-out?~~ **RESOLVED: no.** See the ruling in
  Phase 3. Still open for Phase 4's stored workspace preference specifically.
- **OQ-6** A "clear my data on this device" affordance for shared machines —
  the right home for the destructive action sign-out should not perform.
- **OQ-3** `requestSubject.ts:26` — `tenantOf()` returns the literal `'default'`
  for unauthenticated requests, so anonymous writes converge on one shared
  tenant. Not addressed here; needs its own decision.
- **OQ-4** `accessControlService.ts:690` full-scans `members.list()` on every
  authenticated request. Phase 4 adds a second membership check at mint; a point
  lookup should land first, given the prior `host_ext_kv` prefix-scan incident.
- **OQ-5 (accepted risk, stated explicitly).** With a **misconfigured**
  `OPENWOP_OIDC_AUDIENCE`/issuer, every bearer is rejected, so browser callers
  now see `401 bearer_rejected_no_session` where they previously degraded to a
  working-but-anonymous session. That is the intended trade — a visible failure
  beats a silent identity switch — and operators get signal from the existing
  `noteOidcFallthrough` alarm (threshold 10/60s). Two things bound the blast
  radius: the healthy-cookie fall-through still absorbs the ordinary hourly
  rotation race, and the Phase 2 `migrate.ts` fix means users now *retain* a
  user-tier cookie, so the bearer-only state that made this reachable is itself
  much rarer. If it proves noisy in practice, the client-side follow-up is a
  single forced `getIdToken(true)` refresh-and-retry on that specific reason
  code — deliberately NOT added speculatively.

## Code-review fixes folded in (2026-07-19)

The `/code-review` pass caught **four regressions introduced by Phase 1 itself** —
recorded because they are the predictable cost of converting silent failures into
thrown ones, and the next phase should expect the same class:

1. `WorkflowsDashboard.tsx` list effect `void …then()` had no `.catch` — the now-
   rejecting `listWorkflows` would be an unhandled rejection **and** never clear
   `loading`, leaving the dashboard spinning forever.
2. `onRename` / `onDuplicate` awaited `saveWorkflow` unguarded — unhandled
   rejection, and `refresh()` skipped.
3. `onDelete`'s ADR 0369 handling checked `err.message === 'workflow_referenced'`,
   which silently stopped matching once the message became
   `sync_failed_409: workflow_referenced`. The friendly toast would have been
   lost and the error rethrown. Now checks `SyncFailureError.reason`.
4. `isOfflineError` sniffed the `TypeError` message with a regex. Browsers word
   this differently and **may localize it** — in an app shipping four locales
   that would misclassify genuine offline saves as server refusals. Reduced to
   `err instanceof TypeError`, which is sufficient because the domain errors it
   must not swallow (`SerializeError`, `CanonicalParseError`) extend `Error`.

A refused list now renders its own `StateCard` with a retry action rather than
the empty state — rendering "no workflows yet" for a 401 is the same lie the
silent local-cache fallback told.
