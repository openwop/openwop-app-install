# ADR 0745 — RFC 0200/0210 rows on the production posture: an enforced scope surface, the non-disclosure legs, and where harness-issuer rows are witnessed

Status: implemented

Builds on ADR 0743 (the `oidc` lane, PRM, challenges, lifetime refusal). ADR 0743 measured
everything in the conformance posture (cookies off). This ADR is about the posture
`app.openwop.dev` actually runs, and about the rows that posture could never produce.

Related, landed separately: **ADR 0750 / #4106** owns the cookie-mode credential-less
`401` (this ADR's gap 1 — see D1), and **#4107** hands the production evidence cut its
tenant-B key (`scripts/publish-evidence.sh`); D3 here is the in-process lane's half.

## Context

Four gaps stood between ADR 0743 and a production v2 bundle carrying the RFC 0200/0210
rows. All four were measured at `bfd8b8545`:

1. **`0200.challenge-401` fails in production.** Production runs cookie mode. There a
   request with no credential is handed a fresh `anon:<sid>` session
   (`middleware/auth.ts`, the anon-mint site), so the suite's bare
   `GET /runs/{id}` answers `404` from a tenant nobody asked for instead of
   `401 + WWW-Authenticate`. The conformance boot disables cookies, so every local run
   passed it. This is the MCP mount's H43 (RFC 0153 §E) again, on the whole protocol
   surface. *(Fixed by ADR 0750, not here — see D1.)*
2. **`0200.challenge-403-scope` is `blocked`,** and could not honestly be anything else.
   The PRM omitted `scopes_supported` (ADR 0743: "this host enforces no OAuth scopes"),
   `setBearerChallenge`'s `insufficient_scope` shape had no caller, and the suite needs
   `OPENWOP_TEST_LOW_SCOPE_KEY`. Underneath: `requireProtocolScope` is a no-op unless
   `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`, and a self-service `owk_` key's declared
   `scopes` were **ignored on every protocol route** — a key minted `['runs:read']` could
   create and cancel runs. Only the MCP authority and the entities routes read them.
3. **The non-disclosure legs are `blocked`/`inapplicable`.**
   `auth-challenge-no-oracle`'s cross-tenant leg needs `OPENWOP_TEST_TENANT_B_API_KEY`,
   which the harness never set; its tool leg needs a v2 `toolCatalog` family, which the
   host never advertised at major 2 although it serves the catalog there.
4. **The harness-issuer rows cannot run against production at all.**
   `0200.id-token-aud` and the four `0210.*` exp-only rows need a host that trusts the
   suite's synthetic issuer (`OPENWOP_TEST_OIDC_ISSUER_URL`). A deployed service trusting
   an issuer whose key lives on a test runner is an authentication bypass.

## Decision

Resolved with `/architect` (options mode, no human in the loop per the program's
decisions). One verdict per gap.

### D1 — WITHDRAWN in favour of ADR 0750 (#4106); what was learned is kept

> **CORRECTED before merge (2026-09-24).** This ADR first shipped its own fix for gap 1:
> `mayMintAnonymousSession` — on the protocol path (`/v1/*` outside `/v1/host/*`) a
> credential-less request got the `401` challenge unless it carried a browser signal
> (`Sec-Fetch-Site`, `Origin` or `Referer`) or a `?streamToken`. A peer session opened
> #4106 (ADR 0750) for the same production-measured defect with a different rule — on
> the MAJOR-2 wire, a protocol client (`isProtocolClient`: a version header or a non-HTML
> `Accept`) with no credential gets the challenge, and the SPA's v2 fetch re-bootstraps
> through `/me` and retries once. The two compose, but two rules for one decision at one
> mint site is the drift this repo's CLAUDE.md warns about, and #4106 was open first and
> prod-measured. So D1 is removed from this change, and ADR 0750 owns the decision.

Three findings from the withdrawn implementation, recorded because they bear on ADR 0750:

- **`Sec-Fetch-Mode` is not a browser signal.** MEASURED: Node's `fetch` (undici) sends
  `sec-fetch-mode: cors` on every request (and no `Sec-Fetch-Site`, no `Origin`). A
  prototype keyed on it would have treated the suite's driver as a browser — green
  against a host still minting for the suite. It was caught because it turned ZERO tests
  red, which is not what removing a behaviour looks like.
- **A presented `?streamToken` is a credential, not an absence.** The full gate refused a
  valid-token SSE read (`run-stream-token.test.ts`) before the route could verify the
  token. Under ADR 0750 the same shape is safe TODAY only because a header-less
  EventSource negotiates major 1.
- **Two latent risks in ADR 0750, both only after v1 retires** (header-less requests then
  default to major 2): the SPA's JSON bootstrap fetch to `/me` becomes a major-2
  protocol client and is refused, leaving no route that still mints; and a cookie-less
  `?streamToken` SSE read (`Accept: text/event-stream`) is refused before its token is
  checked. Posted on #4106; not fixed here.

**Kept: the regression coverage, retargeted at the invariants whichever rule owns them.**
`test/adr0745-cookie-posture-challenge.test.ts` boots the PRODUCTION posture (cookies
on): a refused bearer is `401 invalid_token` with no session minted in its place, the
`/api` rewrite names the sub-path PRM, and a browser visitor's session is honoured on the
protocol surface. Its headline leg (bare major-2 call → `401` + challenge, no error code,
no cookie) was held behind `it.skip` until ADR 0750 landed and is live since this ADR
rebased onto it — MEASURED both ways: red on the pre-#4106 `main` (`404`, the defect),
green on #4106's rule. A fifth leg pins today's MAJOR-1 behaviour (bare call → `404` +
minted session) so changing it is a decision, not a side effect.
`frontend/react/e2e/anon-cold-load.spec.ts` asserts, from a real Chromium on a real
`main()` boot, that a cold anonymous visit boots, is minted a session, and is then served
a v2 read; sabotage (backend never mints) → red. It deliberately does not assert "no 401
during load", because ADR 0750's SPA answers a first challenge by bootstrapping and
retrying once.

**Residual, recorded rather than proposed:** under ADR 0750 a bare MAJOR-1 protocol
client with no credential is still minted an anonymous session. That is outside RFC
0200's MUST: §B binds a host "bound by §A.1", §A.5 gives v1 "no new MUST" (v1 PRM is a
SHOULD), and every `0200.*` row is a major-2 scenario. So no second predicate is proposed
for #4106; if v1's own `auth.md` missing-credential rule is ever measured against the
cookie posture, it belongs in ADR 0750's predicate, not beside it.

### D2 — a key's declared scopes narrow it, always; publish exactly the enforced set

- `requireProtocolScope` refuses an `api-key` principal whose declared `scopes` are
  non-empty and lack the required scope — **before** the enforcement flag, the wildcard
  escape and the personal-workspace escape. A key narrowing its own delegation can only
  remove authority, so there is no posture where honouring it is unsafe. Empty `scopes`
  keeps its documented meaning, "undeclared" (the issuer's authority), the reading
  `resolveMcpAuthority` already applies; a declared `'*'` is read the same way, because
  scopes are free-form at mint and a key someone minted "all" must not start refusing.
  **Scope of the fix, stated precisely (review correction):** this narrows the key on
  every route that calls `requireProtocolScope` — create, read, cancel, fork, debug,
  evals, tools, reviews, artifacts. It does NOT make a `['runs:read']` key read-only
  everywhere. Still ungated by key scope: `POST /v1/trigger-subscriptions` + its
  `…/ingest` (which starts runs), webhook and prompt writes, annotations, interrupt
  resolution (gated on `runs:read` only), and host-extension routes that start runs
  (notebooks, podcasts). None of those is a scope `scopes_supported` lists, so the
  advert stays honest; the gap is recorded under "Not done".
- Every scope refusal carries `WWW-Authenticate: Bearer error="insufficient_scope",
  scope="<required>", resource_metadata="…"`. **The mechanism is #4113's, not this
  ADR's** (corrected on rebase, 2026-09-25): a peer PR landed the challenge on the RFC
  0049 membership deny path — set on `req.res` at the throw site, the body unchanged —
  while this branch had built the same thing as an `InsufficientScopeError` type the
  error envelope recognised. Two mechanisms for one header is the drift CLAUDE.md warns
  about, so this branch dropped its own and the key-narrowing refusal now sets the
  challenge exactly as the membership path does. Both sit only on the scope-deny
  paths, never on a resource-binding `403` or a non-disclosure `404` (`identity.md`
  §2.5). What #4113 left for later — making `challenge-403-scope` execute in the
  conformance boot — is what this ADR's low-scope key does, without turning RBAC
  enforcement on.
- `ENFORCED_PROTOCOL_SCOPES = ['runs:create','runs:read','runs:cancel','artifacts:read']`
  is published as the PRM's `scopes_supported`. It is the set of scopes some protocol
  route gates on, **not** the thirteen-name vocabulary: `requireProtocolScope`/
  `loadOwnedRun` accept only these (a new gate on another scope is a compile error until
  it is listed), and `test/adr0745-scopes.test.ts` scans the call sites so a listed scope
  nothing gates on fails the build.
  > **CORRECTED 2026-09-26 (ADR 0755).** The list above is the D2 snapshot; it grew to
  > five with the `approvals:respond` follow-up and to six with `webhooks:manage`, and the
  > PRM now publishes `SCOPES_SUPPORTED` (those six + the five `KEY_LANE_EXTENSION_SCOPES`:
  > `runs:annotate`, `prompts:read`, `prompts:write`, `content:read`, `content:write`). The
  > parity scan also counted comments as gates until ADR 0755 stripped them.
- The harness mints a real `owk_` key declaring only `runs:read` and exports it as
  `OPENWOP_TEST_LOW_SCOPE_KEY` (in-process boots only).

Rejected: a scope syntax on `OPENWOP_API_KEYS`. It would create a second
scope-bearing credential shape to keep in step with the first, and the row would
witness the harness's key table rather than the product's key narrowing, which is what
`scopes_supported` claims.

A tension to record, not resolve here: `scopes_supported` is RFC 9728's list of scopes
"used in authorization requests", and this host's authorization server (Firebase) mints
no scope claims — a caller acquires these scopes by minting an `owk_` key, not from the
AS. `identity.md` §2.5 says the field MUST list "the scopes the host enforces", which this
does exactly. Flagged to the corpus as a clarification, not treated as a defect.

Not changed: the REST `403` body keeps `details.requiredScope`; v1 `auth.md`'s
top-level `scopeRequired` field remains unsent, as before this ADR.

### D3 — the tenant-B key (major 2 only), and the v2 `toolCatalog` family

- The harness adds an env key pinned to `conformance-tenant-b` and exports it as
  `OPENWOP_TEST_TENANT_B_API_KEY`. **At major 2 only**, because of a suite defect
  (below): at major 1, `workspace-cross-tenant-isolation-blackbox` sends the tenant-B
  key without `authenticated: false`, the driver overwrites `Authorization` with the
  owner's key, and the row reds as a leak. A direct HTTP repro with the same two keys
  answered `404`.
- `v2ToolCatalogFamily()` advertises `toolCatalog` at major 2 under the **same gate** as
  the v1 record (`OPENWOP_MCP_SERVER_ENABLED`), with the same facets. The unversioned
  `/tools` reaches the v1 handler through the manifest-derived rewrite, so this is one
  surface with two spellings. Measured before advertising: the tool-catalog scenarios
  execute and pass at major 2 (below).

### D4 — harness-issuer rows are witnessed on a colocated boot of the release image, and a deployed service refuses to trust a harness issuer

| Option | Verdict |
|---|---|
| (i) a separate Cloud Run "conformance" service trusting a tunnelled test issuer | **rejected.** It is the forbidden arrangement with a different name: an internet-reachable service whose trust root's key lives on a runner. It also cannot be built as specified: the suite binds its issuer on `127.0.0.1` at the URL's own port (`:80`/`:443` for an https tunnel URL). And its bundle carries no more verifier weight than a loopback one — `discovery.url` is not signed. |
| **(ii) a colocated boot of the SAME release image, cut as a companion major-2 bundle for the same build commit** | **chosen.** `scripts/release-conformance.sh` already boots the release image with `OPENWOP_OIDC_ISSUER=http://host.docker.internal:18102`. The verifier accepts loopback bundles mechanically (`evidence/v2-host-bundles/openwop-host-v2-reference.json` is one). Zero cloud surface. |
| (iii) the production certify records these rows `blocked` | unavoidable for the production bundle until the corpus changes — reported below. |

**Dominant force:** the hard rule. Nothing that answers on the internet may trust a
harness issuer, so the witness must run where the harness is. (ii) is that, with the
production artifact.

**The guard** (`host/oidcTrustGuard.ts`, called from `main()`): on Cloud Run
(`K_SERVICE` set) the process refuses to boot if any harness env is present
(`OPENWOP_TEST_OIDC_ISSUER_URL`, `OPENWOP_TEST_OIDC_AUDIENCE`,
`OPENWOP_CONFORMANCE_HARNESS_HOST`, `OPENWOP_CONFORMANCE_OIDC_PORT`), if
`OPENWOP_OIDC_ISSUER`/`OPENWOP_OIDC_JWKS_URL` is not https or names a
loopback/private/`.internal`/`.local` host, or if `OPENWOP_OIDC_AUDIENCE` is the suite's
`openwop-conformance`. Keyed on `K_SERVICE` rather than `NODE_ENV`, because the release
lane is production-mode and legitimately trusts `host.docker.internal`. **No escape
hatch** — unlike the ADR 0195 guards, which accept a named durability risk, this one
would accept a forged identity. Verified against the live service (read-only
`gcloud run services describe`): its issuer, audience and JWKS URL all pass.

What the guard cannot see: an https issuer on a public host that is secretly a tunnel to
a runner. The env and audience checks catch the harness's recipe; configuring an issuer
is still configuring an issuer.

## Verification

| Row / leg | Before (`bfd8b8545`, major 2) | After | Sabotage (reverted) |
|---|---|---|---|
| `0200.challenge-403-scope` | `blocked` | `executed-pass` (3 assertions) | challenge attach removed → `executed-fail`; key narrowing removed → unit leg red |
| `0200.no-challenge-on-nondisclosure-404` (tool, agent, cross-tenant legs) | tool `inapplicable`, cross-tenant `blocked` | all three `executed-pass` | tenant-B key mapped to `*` → scenario `executed-fail`; tool list forced 500 → leg `blocked` |
| `tool-catalog-projection` (v2) | `inapplicable` | `executed-pass` | list forced 500 → `executed-fail` |
| `tool-catalog-compact-projection` (v2) | `inapplicable` | `executed-pass` | list forced 500 → `inapplicable`, **not** red: this sabotage cannot prove the row; recorded rather than claimed |
| `0200.id-token-aud`, `0210.exp-only-*` (4) | `executed-pass` locally (ADR 0743) | unchanged locally; `blocked` on any production certify by construction (D4) | — |
| trust-root guard | none | `test/adr0745-oidc-trust-guard.test.ts` 13/13 | guard short-circuited → 9 red |

Dispositions above are read from the RFC 0148 ledger of filtered major-2 runs
(`OPENWOP_LEDGER_PATH`), not from vitest's ✓: a soft-skip counts as a vitest pass, and
this ADR's first read of the filtered run would otherwise have reported every leg green.

## Review record (`/code-review`, independent reviewer, 2026-09-24)

No CRITICAL. Applied: (M) the D2 overclaim above; (M) the trust guard missed
IPv4-mapped IPv6 (`new URL()` rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the
dotted check never matched — the metadata address `169.254.169.254` passed the same
way), CGNAT `100.64/10`, `fec0::/10`, trailing-dot names and single-label hosts — all now
refused and pinned; (L) a declared `'*'` scope is not narrowed; (L) stale "no-op unless
enforced" comments and the leaf-module header of `authChallenge.ts`. Left, with reason:
under RFC 0049 enforcement an anonymous cookie caller's scope 403 now carries the
challenge (the 403 status is pre-existing, and it IS a scope refusal). The reviewer's D1
findings (Hosting header forwarding unmeasured, `/V1/…` case) went with D1.

## Corpus defects found (reported, not fixed here — WS1 does not edit the corpus)

1. **Harness-issuer rows make every production bundle uncertifiable.** Once a production
   host advertises an `oidc` lane, `v2-oidc-id-token-audience` and
   `v2-lane-exp-only-bound` record `blocked` (issuer env unset, or untrusted), and one
   `blocked` row denies certification bundle-wide. A production host that trusts no test
   issuer is doing the right thing. The corpus needs a disposition for "witnessed on a
   colocated boot of the same build" (a companion-bundle reference by `host.build`), or
   these rows must not be `blocked` on a host that attests a production trust root.
   MyndHyve is in the same position.
2. **The synthetic issuer has no listen-port / bind knob.** It binds `127.0.0.1` at the
   URL's own port, so an issuer URL without a port binds `:80`, and a Linux Docker host
   cannot reach a loopback-bound issuer through `host-gateway`. The webhook receiver has
   `OPENWOP_WEBHOOK_RECEIVER_PORT` and honours `OPENWOP_CONFORMANCE_HARNESS_HOST`; the
   issuer honours neither.
3. **Two major-1 scenarios never send the credential they are about**:
   `workspace-cross-tenant-isolation-blackbox` (tenant-B key) and
   `interrupt-auth-required-resume` (low-scope key) pass it in `headers` without
   `authenticated: false`, so `lib/driver.ts` overwrites `Authorization` with the owner
   key. Any host that supplies the key gets a false red — a "leak", and a low-scope
   approval that "succeeds". Present at 2.36.1 and still at 2.38.0 (MEASURED: the full
   gate on this branch at 2.38.0 red the second one, `expected 200 to be 403`). Both
   keys are therefore exported to the in-process lane at MAJOR 2 only, where the one
   consumer of each sets `authenticated: false` correctly.
4. **`openwop.requirement.0210.lane-rule-surfaces-agree`** is referenced by
   `src/coherence/v2-lane-exp-only-schema.test.ts` and absent from `requirements.json`.
5. **The synthetic issuer reuses kid `openwop-conformance-key-0` with a fresh key per
   scenario** (already reported under ADR 0743's correction; still present).
6. **Clarification, not a defect:** `scopes_supported` "MUST list the scopes the host
   enforces" vs RFC 9728's "used in authorization requests" when the AS mints no scopes
   (D2).

## Deploy-phase runbook

No cloud resources are created by this ADR. The steps the deploy phase runs:

1. **Deploy** (backend then frontend) with `scripts/deploy.sh` from a clean
   `origin/main` worktree. No env change is needed: the guard passes the live config.
   Verify: `scripts/verify-deploy.sh`, then
   `curl -s -o /dev/null -w '%{http_code}\n' https://app.openwop.dev/api/runs/x -H 'OpenWOP-Version: 2.0'`
   → `401`, and `curl -sI … | grep -i www-authenticate` shows `resource_metadata=` with
   no `error=` (ADR 0750's rule — this ADR's runbook only reads it); `curl -s https://app.openwop.dev/.well-known/oauth-protected-resource/api`
   shows `scopes_supported`.
2. **Production v2 certify** — per `docs/steward/CERTIFY-RUNBOOK.md` § "RFC 0200 rows on
   the production certify": mint two expiring `owk_` keys through
   `POST /api/v1/host/openwop-app/developer-keys` declaring `["runs:read"]` in the
   certify tenant → `OPENWOP_TEST_LOW_SCOPE_KEY`, run the cut, revoke it.
   `OPENWOP_TEST_TENANT_B_API_KEY` comes from the conformance binding's second key via
   `scripts/publish-evidence.sh` once #4107 lands — do not mint a second one. Expect `challenge-401`, `challenge-403-scope`, the non-disclosure legs and the
   PRM rows to pass; expect `0200.id-token-aud` and the `0210.exp-only-*` rows to be
   `blocked` (defect 1) — which leaves the bundle uncertified until the corpus rules.
3. **Companion colocated bundle** — per the same runbook section: boot the release image
   with `scripts/release-conformance.sh --keep`, run the upstream CLI against
   `http://127.0.0.1:18099` at `--target-major 2` with
   `OPENWOP_TEST_OIDC_ISSUER_URL=http://host.docker.internal:18102`, sign with the
   published bundle key, `--host-build git:<the deployed sha>`. Docker Desktop (macOS)
   only, until corpus defect 2 is fixed. **UNMEASURED:** this box had no Docker daemon
   when the ADR was written, so step 3 is a recipe assembled from
   `release-conformance.sh` and the suite's CLI, not a run. The same rows are
   `executed-pass` on the in-process major-2 boot (table above), which exercises the
   same code; the companion run is what moves them onto the release artifact.

## Not done, and why

- **CLOSED 2026-09-26 by ADR 0755 D1** (webhooks, trigger subscriptions + ingest,
  prompts, annotations, content; interrupt tokens projected only to `approvals:respond`,
  D3). Host-extension run starters outside these remain unsurveyed. Original text:
  **Key-scope gaps outside `requireProtocolScope`** (D2 precise scope): trigger
  subscriptions + ingest, webhooks, prompts, annotations, interrupt resolution on
  `runs:read`, host-extension run starters. A `['runs:read']` key can still start runs
  through the first. Worth its own ADR: extending `ENFORCED_PROTOCOL_SCOPES` changes the
  advert, so each new gate lands with its own row.
- ~~**Interrupt resolution is gated on `runs:read`, not `approvals:respond`**~~ —
  **DONE in the follow-up below.**
- **Existing production keys were not surveyed.** A key minted with only non-protocol
  scopes (e.g. the MCP vocabulary `workspace:read`) is now refused on protocol routes —
  the correct reading of a declared delegation, but a behaviour change for its holder.

- **INTEROP-MATRIX / the committed v2 bundle** are corpus files (`../openwop`); WS1 does
  not edit the corpus. They move with the post-deploy bundle cut.
- **The top-level `scopeRequired` body field** (v1 `auth.md`) — pre-existing, unchanged.
- **Anonymous principals can mint `owk_` keys** for their own anonymous tenant through
  `POST …/developer-keys` (pre-existing; `requirePrincipal` accepts a `session:` subject).
  Harmless as far as this ADR can see — the key reaches only that empty tenant — but it
  is a credential mint with no sign-in, and it deserves its own look.

## Follow-up (2026-09-25): interrupt resolution requires `approvals:respond`

`POST /v1/runs/{runId}/interrupts/{nodeId}` gated on `runs:read`, described in code as
"the node-resume floor RFC 0049 defines". The spec names a different scope for exactly
this route: `rest-endpoints.md` lists it with `approvals:respond`, `interrupt.md` §resume
says the run-scoped surface "requires `approvals:respond` scope", and the gRPC map pairs
`ResolveInterruptByRun` with it. So a key minted read-only could answer an approval gate —
a mutation on a read grant, and the case D2's "Not done" recorded.

**Decision:** the route calls `loadOwnedRun(…, 'approvals:respond')`. It is the ONE gate
for both lanes: key-scope narrowing (always) and RFC 0049 membership (under
enforcement). The alternative, a key-only check beside the membership one, would put two
floors on one route, and the spec names one scope for it. `approvals:respond` joins
`ENFORCED_PROTOCOL_SCOPES` and therefore `scopes_supported`, because it is now enforced.
The call-site parity test would fail if it were listed without the gate.

**What moves, under enforcement only:** built-in `viewer` holds `runs:read` but not
`approvals:respond` (`accessControlService.ts` `EDITOR_SCOPES` adds it), so a viewer can no
longer resolve a run interrupt through this route. That is the spec's allocation. The
signed-token surface (`POST /v1/interrupts/{token}`) and quorum eligibility are
unchanged. Enforcement is off by default and in the conformance boot, and the `*`
operator key bypasses as before.

**Verified:**
- `adr0745-scopes`: a `runs:read` key gets `403` + `scope="approvals:respond"` before any
  existence check. The control, an `approvals:respond` key, passes the gate and gets
  `404` with no challenge. The parity scan now covers five scopes. Sabotage (restoring
  `runs:read`) turns all three legs red.
- The 27 test files that drive `/interrupts/` routes: 180/180.
- Filtered conformance on interrupt, approval, quorum and challenge scenarios: 40 files
  green at major 1 and at major 2.

The suite leg that should witness this, `interrupt-auth-required-resume`'s low-scope
leg, cannot while corpus defect 3 stands. It records `blocked` at major 1, where this
harness withholds the key.

**Corpus defect 3 is fixed upstream** (openwop#1557, in the unpublished 2.39.3 cycle).
When the pin reaches a suite that carries it, widen the two major-2-only exports in
`conformance/run.ts` (tenant-B and low-scope keys) to both majors. Both comments there
name this condition. The `interrupt-auth-required-resume` low-scope leg then witnesses
this follow-up at major 1.

