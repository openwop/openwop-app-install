# ADR 0405 — Security-scan remediation program

Status: implemented (Phases 1–7)

## Context

A full two-layer vulnerability scan (deterministic banned-pattern sweep + a 6-way
semantic fan-out with adversarial verification) of the openwop-app backend and
frontend surfaced a cluster of real defects — every HIGH/CRITICAL re-verified
against source. The dominant root causes:

1. **Cross-tenant run/interrupt IDOR** — run-scoped route handlers fetched by bare
   `storage.getRun(runId)` (null-check only) instead of the `loadReadableRun` tenant
   gate. The `GET …/runs/:runId/interrupts` handler additionally returned RFC 0093
   capability tokens, so any authenticated caller who learned another tenant's runId
   could hijack that tenant's HITL/approval gates (the token authorizes the PUBLIC
   `POST /v1/interrupts/:token`). `host/runAccess.ts`'s own comment falsely claimed
   "the run-MUTATION paths already gate on run.tenantId" — the drift these findings
   proved false.
2. **Authority defaulting to tenant-owner / missing sub-tenant RBAC** — several
   management routes call `resolveEffectiveAccess(tenant, {})` (which returns full
   OWNER scopes with no member context) or gate only on `requireSignedIn`, so a
   low-privilege member of a shared/SSO workspace gains owner-level authority.
3. **Money-path TOCTOU** — prepaid-balance / affiliate ledger mutations use a plain
   `get→put` with no CAS (the codebase's own `imageGenBudget`/`codeExecBudget` show
   the correct `compareAndSwap` pattern).
4. **Prompt-injection fence breakout** — `promptCompose.ts` wraps untrusted variables
   in `<UNTRUSTED>…</UNTRUSTED>` without defanging an embedded closing marker.
5. **SSRF / egress-guard gaps** — the A2A outbound surface and OAuth token POST
   bypass the shared `webhookEgressGuard`; the deny-list omits CGNAT / IPv6 site-local.
6. **BYOK crypto** — KMS envelope + inner AES-GCM omit tenant EncryptionContext/AAD;
   a legacy flat secret path drops `tenantId`.
7. **CSRF / misc** — `SameSite=None` cookie with no explicit anti-CSRF; a scatter of
   MEDIUM/LOW hardening items.

None of these change the OpenWOP wire — they are host-authorization, host-crypto,
and host-route fixes on `/v1/host/openwop-app/*` and the reference run routes. **No
new RFC is required**; the run-authorization behavior implements already-Accepted
RFC 0049 / RFC 0093 semantics more faithfully. This ADR is the program tracker.

## Decision

Remediate in severity-ordered phases; each phase gets an `/architect` review before
implementation and `/code-review` (+ `/ux-review` where frontend is touched) after.
Correct — not rewrite — the misleading `runAccess.ts` comment in place (CLAUDE.md
"correct, don't rewrite history").

### Phase 1 — Cross-tenant run/interrupt IDOR (CRITICAL C1 + HIGH H1) — implemented

Introduced **`loadOwnedRun(req, storage, runId, scope)`** in `host/runAccess.ts`: the
run-MUTATION / capability-token-yielding gate. It mirrors `loadReadableRun` (tenant
ownership, wildcard-operator hatch, `run_not_found` no-existence-leak) but
deliberately does **NOT** honor the read-only `?streamToken` capability — a read
grant must never authorize a cancel/fork/resume or yield RFC 0093 resume tokens
(that would be a read→write privilege upgrade, a fresh hole). Scope is caller-supplied
so each site keeps its RFC 0049 authority floor.

| Handler | Gate | Scope |
|---|---|---|
| `GET …/runs/:runId/interrupts` (leaked tokens) | `loadOwnedRun` | `runs:read` |
| `POST /v1/runs/:runId/interrupts/:nodeId` (resume) | `loadOwnedRun` | `runs:read` |
| `POST /v1/runs/:runId/cancel` | `loadOwnedRun` | `runs:cancel` |
| `POST /v1/runs:bulk-cancel` (per-item) | per-item tenant filter → `not_found` | `runs:cancel` |
| `POST /v1/runs/:runId:fork` | `loadOwnedRun` | `runs:create` |
| `GET /v1/runs/:runId/ancestry` (pure read) | `loadReadableRun` | `runs:read` |

`:fork` gains a pre-fork ownership check only; the forked run still inherits
`sourceRun.tenantId` (now provably the caller's), so `:fork` replay/determinism is
unchanged. Test: `host/__tests__/runAccess.test.ts` (ownership 404, wildcard-operator,
and the key property that `loadOwnedRun` rejects a streamToken).

### Phase 2 — Authority-default privescs (HIGH H2/H3 + MEDIUM M6/M9/M10) — implemented

Root cause: management routes resolved authority with a bare `resolveEffectiveAccess({})`
(returns full OWNER scopes) or gated only on `requireSignedIn`, so a low-privilege
member of a shared SSO/SCIM tenant gained owner authority.

- **New shared gate** `requireTenantScope(req, scope)` in `features/featureRoute.ts` —
  the tenant-level sibling of `requireOrgScope`, for host-extension management routes
  that are tenant-scoped (no `:orgId`) yet mutate tenant-wide state. Authority (fail-closed):
  (1) implicit personal-workspace owner short-circuit (`isOwnPersonalWorkspace` — preserves
  solo-user + anon-demo flows), else (2) the caller's tenant-wide scope UNION
  (`resolveSubjectScopesUnion`, the same primitive `requireProtocolScope` uses) must
  include the scope. Enforced **unconditionally** (NOT behind
  `OPENWOP_AUTHORIZATION_ENFORCEMENT`): these are non-normative `/v1/host/openwop-app/*`
  surfaces, never an advertised RFC 0049 wire capability, so there is no wire-honesty
  reason to defer — and deferring would leave the privesc open in the default posture.
  `requireOrgScope` (its sibling) already enforces unconditionally.
- **H2 orgs invite** (`features/orgs/routes.ts` `requireMemberManage`): now mirrors the
  reference `routes/accessControl.ts requireScope` — `isOwnPersonalWorkspace` short-circuit
  then `resolveEffectiveAccess({subject: callerSubject(req), orgId})`; never the bare `{}`.
- **H3 capability-firewall** (`features/capability-firewall/routes.ts`): the tenant-wide
  rule write now requires `requireTenantScope('host:members:manage')` (was per-org
  `workspace:write`); GET uses `requireTenantScope('workspace:read')`.
- **M6 users lifecycle** (`features/users/routes.ts`): create / PATCH(groups) / disable /
  enable / delete now require `requireTenantScope('host:members:manage')` on top of
  `requireSignedIn`; self-service stays on `PATCH /me`.
- **M9 assistant** (`features/assistant/routes.ts`): a `wrapWrite` wrapper adds
  `requireTenantScope('workspace:write')` to the mutating routes (CRUD, approve/reject
  which can trigger email sends, loop toggles).
- **M10 agent-pack install** (`routes/agentPackRegistry.ts`): added `requireSuperadmin`
  (matching the sibling installer) plus `isSafePackName` + SemVer-version validation
  (closes the scan's path-traversal hardening in the same handler).

Test: `features/__tests__/requireTenantScope.test.ts` (personal-owner short-circuit,
admin allowed, editor DENIED for `host:members:manage`, non-member + no-subject fail-closed).

Scope note: `host:members:manage` is reused as the tenant-admin authority proxy;
inventing a dedicated `governance` scope would touch the RFC 0049 scope vocabulary
(RFC gate) and is deferred.

**Examined & dropped — M8 (canvas cross-org).** The `Canvas` record (`host/canvasSurface.ts`)
has no `orgId`; canvases are tenant-scoped, keyed by `tenantId`+`canvasId`. The
`:orgId` path segment is a routing artifact, so there is no per-org canvas ownership
boundary to bypass — the finder's premise doesn't hold. Not a vulnerability. (If
org-private canvases become a product requirement, that's a separate feature + ADR
adding `orgId` + scoping, not a security fix.)

### Phase 3 — Money-path TOCTOU (HIGH H4 + MEDIUM M5 + LOW credit) — implemented

Prepaid-balance / affiliate-ledger mutations were plain `get→put` with no CAS —
concurrent writers lost updates (free tokens / lost commission) or created duplicate
payout rows. Fixed by adopting the in-repo `compareAndSwap` bounded-retry pattern
(`host/imageGenBudget.ts`, 12 attempts) the scan cited as the A+ reference.

- **H4 `drawFromBalance`** (`features/billing/billingService.ts`): CAS-retry, re-reading
  + recomputing `drawn` per attempt. Exhaustion under-draws (daily-cap backstop covers)
  + `log.warn` — never throws into an already-completed model call.
- **LOW `creditTokens`** (same file, new `creditBalance` helper): CAS-retry credit.
  Exhaustion `log.error` for reconciliation — NOT thrown, because the Stripe event id is
  already CAS-claimed upstream, so a throw would let redelivery skip the credit
  (permanent under-credit). (Follow-up noted: the claim-then-credit pair is not atomic;
  fully-correct is credit-then-mark-processed under one CAS — a larger refactor.)
- **M5a `accrueCommission`** (`features/commerce/affiliate.ts`): CAS-retry the owed-balance
  increment (a lost accrual / balance resurrection otherwise).
- **M5b `recordPayout`** (same file): **fail-closed ordering** — CAS `balanceOwed→0`
  FIRST; only the swap WINNER creates the payout row (a lost swap → 409, no duplicate).
  Eliminates the double-disbursement. A best-effort **additive restore** compensates if
  the payout row fails to persist after the zero-swap (re-read + add back so a concurrent
  accrual isn't clobbered), `log.error` if even that fails — payouts are advisory, so
  under-pay is the recoverable direction and double-pay is eliminated.

Tests: `features/billing/__tests__/drawFromBalance.test.ts` (debit arithmetic, cap,
empty-balance) + `features/commerce/__tests__/affiliatePayoutRace.test.ts` (additive
accrual; one payout per balance; a SECOND payout on a zeroed balance → 409, proving no
duplicate). Design ruled by `/architect` (exhaustion directions + CAS-then-create ordering).

### Phase 4 — `<UNTRUSTED>` prompt-fence breakout (HIGH H5 + LOW) — implemented

Two wrap sites used the XML-tag fence `<UNTRUSTED …>…</UNTRUSTED>` but interpolated
the untrusted payload with NO defang, so a payload containing the literal
`</UNTRUSTED>` closed the fence and injected trusted prompt structure. (The existing
`defangUntrustedFence` only covered the *word-marker* fence `BEGIN/END UNTRUSTED
CONTENT` — a different syntax.)

- **New shared helper** `defangAngleFence(s)` in `host/untrustedContent.ts` (the
  single-source fence-neutralization module, alongside `defangUntrustedFence`):
  neutralizes the delimiter's `<` → `&lt;` for both the opening and closing marker,
  case-insensitively (`/<(\/?\s*UNTRUSTED)\b/gi`), matching `escapeAttr`'s convention.
  Deterministic → replay-safe.
- **H5 `host/promptCompose.ts`** (live RFC 0124 deferred-param node): defang the value
  before the `<UNTRUSTED>` wrap.
- **L `host/promptInjectionGuard.ts`** `wrapForLLMPrompt` (test-seam today, the
  canonical wrap helper): defang the payload before interpolation (attributes were
  already escaped; the payload was not).

One helper for both sites so the two injection boundaries can't drift again. Test:
`host/__tests__/defangAngleFence.test.ts` (closing/opening/case/whitespace neutralized,
benign angle-brackets untouched, `wrapForLLMPrompt` un-escapable via the payload).

Follow-up (documented, out of this patch's scope): promptCompose could additionally
carry a per-variable "treat as data" instruction like `fenceUntrustedBlock` — separate
defense-in-depth, not needed to close the breakout. Replay note: the composed-prompt
body is host-internal composition recomputed on `:fork` (not a wire-normative durable
checkpoint), so defanging pre-existing marker-bearing values on replay is the intended
security behavior, not a replay break.

### Phase 5 — SSRF / egress gaps (MEDIUM M1 + LOW ×2) — implemented

`host/a2aSurface.ts` was the one host outbound-egress path that never adopted
`webhookEgressGuard` — its 3 fetch sites hit a caller-supplied `baseUrl` with no
guard (`discoverAgent` returns `res.json()` into the run = read-SSRF).

- **New shared helper** `guardedEgressFetch(url, init)` in `host/webhookEgressGuard.ts`
  bundles the full egress posture so a new site can't adopt a weaker subset: string
  deny-host precheck + https-only (both `OPENWOP_WEBHOOK_ALLOW_PRIVATE`-bypassable) +
  `webhookEgressDispatcher()` connect-time pinned resolution + `redirect: 'error'`
  (default; a caller may override `init.redirect`).
- **M1** `host/a2aSurface.ts`: all 3 sites (rpc / rpcStream / discoverAgent) now use
  `guardedEgressFetch`.
- **LOW** `features/connections/oauthFlow.ts` `postTokenRequest`: OAuth token POST now
  SSRF-guarded (defense-in-depth for a compromised/unsigned pack manifest).
- **LOW** `host/webhookEgressGuard.ts` `isDeniedWebhookHost`: widened to deny CGNAT
  `100.64.0.0/10` (RFC 6598 — cloud internal LBs / PSC) and IPv6 site-local `fec0::/10`.
  Shared by every egress path (uniform hardening).

Test: `host/__tests__/webhookEgressGuard.test.ts` (deny-list ranges incl. the new ones;
`guardedEgressFetch` refuses denied host / http / bad URL before any socket).
`redirect: 'error'` is safe for A2A (RPC endpoints don't 3xx; matches the codebase's
egress posture). No wire change — host-side outbound SSRF control → no RFC.

Follow-up (documented): converge the existing inline-guarded egress sites
(`imageProviderAdapter`, `mcpClient`, `triggerIngestionService`) onto `guardedEgressFetch`
— left as-is here to preserve their site-specific error-mapping nuances.

### Phase 6 — BYOK crypto tenant-binding (MEDIUM M2 + M3) — implemented

- **M2** `byok/kmsEncryption.ts`: the KMS envelope's inner AES-256-GCM now binds the
  record to its `(tenantId, credentialRef)` via `setAAD` — a storage-layer row misroute
  decrypts to nothing under a different tenant's AAD (fails the GCM auth tag) instead of
  leaking a cross-tenant secret. Bound at the INNER GCM (not the KMS wrap) because it's
  **uniform across AWS/Azure/GCP** (Azure RSA-OAEP has no AAD) and protects the secret
  ciphertext directly — so `KmsClient` + the three cloud backends (`kmsBackends.ts`) are
  **untouched**. AAD is a fixed-delimiter canonical string `${tenantId}\x1f${ref}` (not
  JSON — key-order drift would brick stored secrets). **Backward compat:** envelope
  versioning — legacy records stay `v:2` and decrypt WITHOUT AAD; new writes are `v:3`
  WITH AAD; `kmsDecrypt` branches on `record.v` (unknown version → throw). Old records
  re-bind to v3 on the next write/rotation; no data migration. `secretResolver` threads
  the context (it always holds tenantId + ref); `host/webhookSecretCodec` uses a fixed
  context (webhook secrets weren't the finding — real per-subscription binding is a
  noted follow-up).
- **M3** `byok/secretResolver.ts`: the legacy flat path (no KMS, no ephemeral) keyed by
  bare `credentialRef`, silently dropping `scope.tenantId` → two non-`user:`/`ws:`
  tenants storing the same ref read each other's secret. Now tenant-prefixes the flat
  key (`${tenantId}::${ref}`) when a scope carries a tenantId (resolve / set / remove /
  list); a scopeless host-global ref keeps the bare key. `listSecretRefs` filters by the
  tenant prefix in memory (flat/demo scale — avoids a storage prefix-scan, cf. the
  [[host-ext-kv-prefix-scan-incident]]).

Tests: `test/byok-kms.test.ts` — wrong-tenant-AAD → throws (the M2 binding), v2 legacy
record still decrypts (compat), flat-path two-tenant isolation + scopeless host-global
(M3). Design ruled by `/architect` (inner-GCM AAD, v2/v3 versioning, flat-prefix vs
fail-closed, `\x1f` AAD delimiter). No wire change — at-rest encrypt internals → no RFC.

### Phase 7 — CSRF + remaining MEDIUM/LOW — implemented

- **M4 CSRF** — new `middleware/csrf.ts` `csrfOriginGuard`, mounted after `authMiddleware`.
  The `SameSite=None` prod cookie removed SameSite's CSRF protection; CORS doesn't block a
  cross-site simple-request POST. The guard validates the request Origin (Referer origin
  fallback) for COOKIE-authed unsafe methods against the SAME `cors.ts originPolicy`
  allowlist (single source). Scope: safe methods skipped; bearer/no-cookie skipped (not
  CSRF-able); **`PUBLIC_PATH_PREFIXES` exempt** (widget/forms/consent/analytics are
  cross-origin BY DESIGN — architect's required refinement); absent Origin → allow
  (non-browser). No-op in dev (reflect-any). `PUBLIC_PATH_PREFIXES`/`isPublicPath` are now
  exported from `auth.ts` so the two exemption lists can't drift.
- **M7** — `GET /v1/workflows/:workflowId` scoped: a wildcard operator or the owner reads;
  an un-owned def is a public fixture/premade template (kept public via new
  `isAuthoredByAnyTenant`); a def owned by ANOTHER tenant → 404. Closes the cross-tenant
  read of authored definitions without breaking conformance/example fixtures.
- **L** `host/triggerIngestionService.ts` — cap `attachmentUrls`/`fileUrls` fan-out
  (`MAX_INGEST_ATTACHMENTS`=20) with a `log.warn` on truncation (egress-amplification / DoS).
- **L** `features/goals/agentTools.ts` — `goals.list` now fails EMPTY without
  `scope.actingUserId`, matching the sibling read-tools.
- **L** `notifications/notificationStore.ts` (frontend) — `navigateToActionUrl` itself now
  enforces `isSafeActionUrl` (plus the native-shell path), so no consumption site (desktop
  toast / native shell) can regress into an open redirect.
- **L** `host/auth/samlSso.ts` — `validateInResponseTo` is env-configurable
  (`OPENWOP_SAML_VALIDATE_INRESPONSETO=always` for deployments without IdP-initiated SSO)
  + documented. Follow-up: a durable per-assertion-ID one-time cache for IdP-initiated.

**Accepted (documented, not changed):** the `middleware/rateLimit.ts` run-quota and
`host/sandboxAdapter.ts` per-tenant-budget check-then-commit windows are documented
single-instance best-effort soft caps — the durable ceilings (`runBudgetService`,
`withSandboxConcurrency`) are atomic. Changing them adds complexity for a documented,
correct-by-design trade-off.

Tests: `middleware/__tests__/csrf.test.ts` (attacker-origin 403, allowlisted/absent/bearer
pass, **public-path exempt**, dev no-op). No wire change (host-side request gating +
host-ext reads) → no RFC.

## Status
Phases 1–7 implemented (each `/architect`-reviewed, `/code-review`-clean, tested).


## Alternatives weighed

- **Reuse `loadReadableRun` everywhere** — rejected: it honors the SSE read
  streamToken, so a read capability would authorize a mutation. The mutation gate
  must be a distinct helper (`loadOwnedRun`) to keep the read/write boundary honest.
- **Inline the tenant check per handler** (like DELETE already does) — rejected as
  the primary approach: five copies of an authorization boundary drift. One shared
  helper is the single source of truth.
- **403 vs 404 for non-owned** — keep 404 (`run_not_found`), matching DELETE /
  notifications: never leak another tenant's run existence.

## Grading-pass corrections (post-implementation code + data grade — A− / B)

A code-quality + data-integrity grade of the diff surfaced defects the phased work
introduced or missed; all fixed:

- **`isDeniedWebhookHost` IPv6-prefix false-positive** (`host/webhookEgressGuard.ts`) —
  the `fc`/`fd`/`fec` startsWith checks matched ordinary public DOMAINS (`fec.gov`,
  `fdic.gov`, `fc2.com`), and Phase 5 widened it (added `fec`) + newly routed A2A/OAuth
  egress through it. Now gated on an IPv6 LITERAL (`host.includes(':')`). Test added.
- **`creditBalance` exhaustion must THROW, not swallow** (`features/billing/billingService.ts`) —
  the Phase 3 rationale was inverted: `processStripeEvent` RELEASES the event-id claim
  on throw (`seenEvents.delete`), so throwing lets Stripe redelivery reprocess the credit.
  Swallowing dropped a paid credit permanently. Corrected to throw + fixed the comment.
- **M7 workflow-read false-404 + O(N) hot-path scan** (`routes/workflows.ts`) — reserved
  PUBLIC namespaces (`wf.seed.*`, `tmpl.*`, `openwop-app.*`) are shared templates; they
  now short-circuit BEFORE the ownership scan, so an un-owning tenant reads them AND the
  common template read skips the cross-tenant `isAuthoredByAnyTenant` scan. (A workflowId
  secondary index for genuinely-authored cross-tenant reads is a noted follow-up.)
- **`recordPayout` spurious 409 under concurrent accrual** (`features/commerce/affiliate.ts`) —
  the zero-CAS now retries in a bounded loop, re-reading owed each attempt, so a concurrent
  accrual doesn't misfire the "already being recorded" 409; only a genuinely-zero balance 409s.
- **BYOK flat-path M3 upgrade note** (`byok/secretResolver.ts`) — an automatic bare-key
  fallback was considered and REJECTED: a bare-keyed row is indistinguishable from a genuine
  host-global secret, so a fallback would leak host-global secrets to a tenant (worse than
  the orphan). Documented instead: a self-host on the local-AES flat posture (no KMS, no
  ephemeral) with existing scoped secrets must re-enter them once on upgrade. Reference
  deploys (KMS/ephemeral) are unaffected.
- Noted follow-ups (unchanged): webhook-secret per-subscription AAD binding; the workflowId
  ownership index; KMS-wrap EncryptionContext (AWS/GCP).

## Open items

Phases 2–7 land under this ADR. The scan's full coverage ledger (sampled areas, not
reached) lives in the scan report; a follow-up wave is recommended once complete.
