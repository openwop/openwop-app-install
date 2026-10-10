# ADR 0812 — v1 after the cut: keep the compatibility shim, invert the canonical registration later, delete only on a product decision

Status: **Accepted** (2026-10-04) — P0 in progress

> **DECIDED 2026-10-04 (product owner): drop v1 from the codebase.** P3's gate,
> "is v1 support for white-label adopters a commitment?", is answered **no**. The
> plan below runs P0 → P1 → P2 → P3 in order. The inversion (P1/P2) is still
> done first, because it is the safe way to delete. Once v2 is canonical, P3 is
> the removal of one shim plus the test corpus's `/v1` addressing, not ~800
> edits that change behaviour and structure at once. The adopter release note
> moves from "gate" to "deliverable of P3".

Supersedes the W9 row of `docs/steward/V2-COMPLETION-PLAN.md` as a plan. That row
said "default contract 2, retire the `/v1` route registrations, drop the `/v1`
twin legs". This ADR corrects the first item and splits the other two into a
refactor and a product decision.

## Context

app.openwop.dev retired v1 on 2026-10-04 (ADR 0669 flag, RFC 0234 / corpus
2.45.14, revision `01043-rum`). The record is in
`docs/runbooks/V1-RETIREMENT-CUT.md` § Cut record. On the wire the host is now
v2-only:

- `/v1/*` answers `410`;
- public read twins answer a bodiless `308` (ADR 0806);
- discovery advertises `protocolVersions ["2.0"]`.

The code still runs v2 on top of v1. Measured on `origin/main` `005dcd145`:

| Fact | Where |
|---|---|
| Every protocol route registers at `/v1/…`, through `v1()` (ADR 0649). | `middleware/protocolVersion.ts:611` |
| A v2 request, and any unversioned vendor request, is served by rewriting `req.url = \`/v1${req.url}\`` onto those handlers. | `protocolVersion.ts:968`, `:1074` |
| `check-v1-reliance`: backend protocol path refs | 77 |
| `check-v1-reliance`: host-extension path refs | 712 |
| `check-v1-reliance`: versioned own URLs | 5 |
| Source that pattern-matches on a `/v1` path | 27 sites in 11 files (rateLimit 7, runs 6, packs-test 4, packs 2, auth 2, and one each in effectSeams, discovery, v2Identity, upgradeRegistry, collabServer, engagementService) |
| Test files that address `/v1/…` directly | 649 |
| `OPENWOP_V1_RETIRED` defaults to off | every white-label adopter serves v1 unless they set it |

### The first W9 item was wrong

"Default contract 2" referred to `WORKER_CONTRACT = 1` (`storage/eventEraAdapter.ts`,
ADR 0650). That constant is not a wire contract.

- **What it does.** It is the vocabulary that 14 daemons and `executeRun` read the
  event seat in, which is the storage vocabulary.
- **Why it must not flip.** Flipping it would make the executor read projected
  events and persist them into child logs. The `executeRun` comment
  (`executor.ts:1561`) names exactly this hazard, citing RFC 0041 §C.
- **Nothing outbound depends on it.** Every outbound body a worker sends is shaped
  per destination, never by the worker contract. Webhook bodies follow the
  subscription's own `protocolMajor` (`routes/webhooks.ts:560`).
- **No real subscriber needs a v1 body.** Measured over 30 days of production
  delivery logs, 100% of webhook deliveries went to test targets:
  - Cloudflare tunnels: 11,092
  - `example.com`: 4,220
  - `*.invalid`: 590

**Decision 1: `WORKER_CONTRACT` stays `1`.** Its doc comment ("December's flip is
one constant") is corrected to say it is a storage-vocabulary choice that does
not follow the wire.

## The dominant force

RFC 0234 says a host **MAY** drop 1.x from 2026-10-04. It is not a MUST.

This repo is two things at once:

- the code behind app.openwop.dev, which has dropped 1.x;
- a white-label starting point (README §1), whose adopters run with
  `OPENWOP_V1_RETIRED` unset and therefore serve v1.

Deleting the `/v1` registrations removes the option for every adopter. That is a
product decision about adopters, not a cleanup of this deployment. The cut needed
nothing from it, and production gains nothing from it on the wire.

## Options

| | A: delete v1 now | B: invert, keep a shim | C: leave as is |
|---|---|---|---|
| **What** | Remove the `/v1` registrations, the rewrite, the twins and the 649 test files' `/v1` addressing | Register canonically unversioned. `/v1` becomes a strip-prefix shim that is active while v1 is served and answers `410` when retired. | Keep v1-canonical registration plus the rewrite |
| **Wire change on app.openwop.dev** | none | none | none |
| **Adopters** | lose v1 support with no notice | unchanged | unchanged |
| **Cost now** | very large; it also rewrites the test corpus | large but mechanical. ADR 0649 designed for it: `v1()` becomes identity and the rewrite flips direction. The 27 path matchers are the real risk list. | none |
| **Debt left** | none | the shim, one middleware | v2 is permanently a rewrite of v1. Handlers see `/v1` in `req.path` for v2 calls, every new route is registered at a retired prefix, and the ratchet's framing ("zero is forbidden") is now false. |
| **Reversible** | no | yes: the shim is one middleware | n/a |

## Decision

> **RE-SEQUENCED 2026-10-04, after measuring P3's real cost** (once the product
> owner chose deletion). The plan below the line is the original "invert, keep a
> shim" option B. It was the right shape while deletion was gated. With deletion
> decided, a shim serving v1 only to the test corpus has no purpose. Measured on
> `005dcd145`:
> - **Source:** 24 major-branch sites in 13 files.
> - **Tests:** 649 of 2,232 test files call `/v1`.
>   - About 456 call ONLY host-extension twins. Vendor paths are served in the
>     host dialect on BOTH spellings (`protocolVersion.ts:966`), so moving them to
>     the unversioned path changes nothing they assert. That is mechanical.
>   - 193 call protocol operations (`/v1/runs` 677 times, `/v1/webhooks`,
>     `/v1/interrupts`, …) and assert the v1 contract: bare ids, v1 codes, v1
>     event names. That is a semantic migration.
>
> So the TESTS move first, then the code is deleted against a corpus that already
> passes on unversioned paths. The large source change then lands with full
> coverage instead of with the suite rewritten in the same diff.
>
> 1. **P0: docs and ratchet truth.** Done: see the Implementation record.
> 2. **P1: flip the default.** `OPENWOP_V1_RETIRED` defaults to **true**. An
>    adopter opts back in with `=false` for one deprecation window, with a
>    release note. app.openwop.dev is unaffected (already true). The vitest
>    setup pins `false` until P2 completes, so the suite is unchanged.
> 3. **P2: move the test corpus off `/v1`, in batches.**
>    - **P2a:** host-extension twins → unversioned, mechanically. A diff pass
>      confirms only path strings moved.
>    - **P2b:** protocol tests → unversioned with `OpenWOP-Version: 2` and v2
>      assertions. A test that pins v1-ONLY behaviour is deleted when a v2 twin
>      covers the same rule, and ported otherwise.
>    - `check-v1-reliance` gains a test-corpus count that only falls. P2 ends
>      when the vitest setup no longer pins the flag.
> 4. **P3: delete v1 from the code.**
>    - Register routes unversioned (`v1()` and `vendorTwin()` go).
>    - Remove both `req.url = /v1…` rewrites, the 24 major-1 branches, the v1
>      discovery representation, the deprecation headers and the flag.
>    - Inbound `/v1` stays answered (`410`, plus ADR 0806's `308` read forwards),
>      because third parties still hold those addresses. The internal "host
>      dialect" that vendor paths use (`MAJOR = 1`, contract 1) is renamed so it
>      no longer reads as v1.
> 5. **P4: the remaining clients and docs.** The SPA's last protocol call site,
>    `check-v1-reliance` at zero becoming a hard gate, and the README section.
>
> `WORKER_CONTRACT` (decision 1) is untouched throughout. It is the storage
> vocabulary, not v1.

### Architect review of the re-sequence (2026-10-04)

An independent review (read-only, file:line evidence) confirmed the order and
found the gaps below. Each is now a phase obligation, and each gets a test that
fails if it is missed.

**P1 must also:**
- Replace the 23 `delete process.env.OPENWOP_V1_RETIRED` resets in ten
  rehearsal tests with `='false'`. Under the new default, `delete` means
  retired, which turns each rehearsal's two boots into the same boot (a vacuous
  pass).
- Pin `false` explicitly in every non-vitest boot: `scripts/e2e-routes.sh`, the
  `scripts/ci.sh` e2e boot, the `ci.yml` e2e job, and the in-process
  conformance host (`conformance/run.ts`). The conformance `--target-major`
  follows `preferredVersion`, so `npm run ci`'s conformance would silently have
  become a major-2 run without the major-2 quarantine.
- Correct the runbook rollback: `--remove-env-vars` now leaves the host retired.
  Rollback is `=false`.
- Carry decision 2. On a retired host, a `protocolMajor: 1` (or absent)
  webhook subscription receives nothing, and that is logged once per
  subscription. There is no subscription state field to "pause", and a
  silently upgraded body would break the subscriber.

**P2b must not delete authorization coverage (CRITICAL).** Tenant-isolation,
`id_tenant_mismatch` and credential-less `401` tests are always PORTED to v2,
never deleted. Each deleted test names the v2 test that replaces it. The count
of those assertions in the corpus may not fall. That is checked per batch.

**P2a is not purely mechanical in one place.** `SEAM_AUTH_EXEMPT` matches
`originalUrl` (`routes/testSeam.ts:277-284`), so an unversioned or `/api` call to
the seam login answers 401 while seams are on. Fix the matcher before moving the
seam-login callers.

**P3 checklist.** The ratchet's literal count is not a complete list, so grep
`'/v1` and `\/v1` across `src/`:
- **CRITICAL — the test seams' guard.** It is mounted by prefix at
  `/v1/host/openwop-app/test` and `/v1/host/sample` (`routes/testSeam.ts:287-288`,
  aliases in `routes/conformanceSeams.ts:165-202`). Removing the rewrite without
  re-mounting the guard on the canonical prefixes exposes the seams
  anonymously (the GC-1 class). Required test: an anonymous call to
  `/host/sample/*` and `/host/openwop-app/test/*` gets 401.
- **The body-parser mounts keyed on `/v1`** (`index.ts:649-756`): the packs
  50mb parser, the media 12mb parser, signed-ingest raw body, and the Stripe and
  commerce webhooks. Miss one and the global 1mb JSON parser wins: signatures
  fail closed and money events are dropped.
- **`v2Identity.ts` `RUN_PATH`.** It is the bound-id tenant guard and the
  bare-id 400.
- **`auth.ts`:** the `isCredentialOptionalRead` carve-out, the MFA exemptions and
  `PUBLIC_PATH_PREFIXES`. Also `rateLimit.ts` `SSE_STREAM_PATHS`.
- **The ADR 0806 forwarder.** `heldByThirdParties` is handed the INBOUND `/v1`
  path, so once the public prefixes are respelled it matches nothing and every
  embed, feed and sent-email read becomes a 410. Strip `/v1` before the lookup.
- **The `410` becomes unconditional.** Every `v1Retired()` reader folds to `true`,
  never to `false`, which would re-advertise 1.1.
- **The CLI.** Keep `extensions['openwop-app.host'].root` in discovery. Drop or
  document the `twin` key. `/v1/openapi.json` needs an unversioned home.
- **The P2a-deferred tests move WITH the code.** 22 test files stayed on `/v1`,
  because rewriting them alone turned them red. The local run of P2a found three
  classes, and none is a production defect:
  - **Minimal apps without the negotiator.** These register routes on a bare app,
    so only the `/v1` key exists and an unversioned call is a 404:
    `account-delete`, `admin-cleanup`, `auth-saml-disabled-user`,
    `auth-saml-sso-trust-root`, `auth-scim-*`, `migrate-tenant`,
    `oauth-advertisement-seams`, `kicktodo-*`, `insights-suite-governance`,
    `claude-code-pairing`, `conformance-claims-routes`, `http-metrics-stream-label`.
  - **`/v1` URLs the SOURCE emits.** `cdp-collect-sdk`, `voice-session` and
    `oauth-callback-base`. The OAuth redirect stays `/v1` deliberately until P3,
    because providers hold the registered URI, and ADR 0806 forwards its GET.
  - **Source-derived inventories.** `destructive-lane-census`, `kicktodo-authz-http`
    and `forms-route`, plus `rate-limit` (path-keyed buckets).
- **The `IdempotentEndpoint` keys** (`host/idempotentResponse.ts`:
  `'POST:/v1/runs'`, `'POST:/v1/host/openwop-app/agents'`) are PERSISTED key
  namespaces, not URLs. Renaming them needs a storage migration, or keep the
  spelling as an opaque id.
- **Unaffected:** `firebase.json`'s `/v1/**` rewrite must STAY (the inbound
  410/308 depends on it). `packs.openwop.dev/v1` is the registry's own version
  tree.

### P3 plan (2026-10-05, measured on `82d9606fa`)

A read-only survey re-measured the checklist above against the source. The
critical items were re-checked by hand, and the live probe was run. It found
the checklist **incomplete in five ways**:

- **A second anonymous-exposure guard.** `routes/packs-test.ts:387` mounts
  `requireNonAnonymousPrincipal` on `${V1_PATH_PREFIX}/packs-test` only. It is
  the same GC-1 class as the test seams (`testSeam.ts:295-296`).
- **Shell vs. operation is decided by the rewrite today.** An unversioned request
  reaches a handler only through `req.url = /v1…` (`protocolVersion.ts:977-982`,
  `:1070-1086`). A browser navigation to `/runs` or `/host/…` is not rewritten,
  so it falls through to the SPA shell (`features/publishing/routes.ts:308-323`).
  Once routes register unversioned, which one answers depends on REGISTRATION
  ORDER. It would be either JSON for SPA pages, or the shell for vendor GETs that
  a browser makes directly (asset `<img>`, `embed.js`, OAuth callback, prerender).
  `isProtocolClient` (`protocolVersion.ts:738`) already exists, and P3 must make
  that gate explicit.
- **WebSocket upgrades skip Express.** So the 410 never applies:
  `upgradePathname` (`host/upgradeRegistry.ts:52`) and `collabServer.ts:62` accept
  `/v1` upgrades on a retired host. No first-party client opens one (the voice
  URLs are OpenAI's and Gemini's).
- **The vendor "host dialect" runs at major 1.** That covers `MAJOR = 1` at
  `protocolVersion.ts:978-980` and the `negotiatedMajor` default at `:579`. So
  the 39 major-branch sites (re-measured: 39 in 13 files with the wider criteria,
  not 24) **cannot be folded blindly**. Folding `auth.ts:1453` makes
  credential-less vendor calls 401, which breaks the SPA's anonymous bootstrap.
  `interrupts.ts:426`/`:461` and `auth.ts:1073`/`:1103` change vendor behaviour.
  Each needs a protocol-PATH predicate, not a major test.
- **The idempotency key is in the digest too.** It is mixed into
  `request_digest` as well as the primary key (`idempotentResponse.ts:106`), so a
  rename has to rewrite both columns.

**A live defect found on the way, independent of P3.** The shipped CDP collection
SDK posts to `/v1/host/openwop-app/cdp` (`sdk/cdpCollectSdk.mjs:19`).
**MEASURED 2026-10-05:** `POST https://app.openwop.dev/api/v1/host/openwop-app/cdp/…`
→ `410 protocol_version_unsupported`. Writes are not forwarded, so `collect`,
`collectBatch` and `registerSchema` fail against any retired host. That is
app.openwop.dev, and every adopter by default since P1. The SDK is not on npm, so
it reaches users only as source (the white-label bundle, or a copy from the repo).
**Fixed by #4423.** `check-v1-reliance` never saw it: its backend scan covers
`src/*.ts` only, not `sdk/*.mjs`. P3d adds `sdk/` to the scan.

**The shape: make every matcher spelling-independent FIRST, then flip routing.**
This is the source-side twin of "tests move first". Each guard, parser and
predicate is converted to match the canonical path while routing is unchanged.
The flip then changes nothing they see. A guard that silently stops matching is
exactly the failure that cannot be caught after the fact.

| Phase | Scope | Witness (must fail if the step is missed) |
|---|---|---|
| **P3-0** | CDP SDK `BASE` → `/host/openwop-app/cdp`, plus its test (`cdp-collect-sdk`). Independent of the rest (#4423). | the SDK test calls the unversioned path and the route answers |
| **P3a: matchers become spelling-independent** (routing untouched) | One `canonicalPath()` that strips `/api` and `/v1`, the way `upgradePathname` already does. It feeds: both seam guards and the `packs-test` guard (a path-predicate middleware instead of `app.use('/v1/…')`); every body-parser mount (`index.ts:649-763`, 15 mounts incl. Stripe, commerce, signed-ingest raw bodies); `v2Identity` `RUN_PATH` (and `DECODED_BOUND_ID`); `auth.ts` `PUBLIC_PATH_PREFIXES`, MFA exemptions, `RUN_EVENTS_STREAM`, `isCredentialOptionalRead`; `rateLimit` `SSE_STREAM_PATHS`; `cors` `PUBLIC_EMBED_PREFIX`; `customDomain`; `keyVendorGate`; `a2aInterfaceErrors`; the forwarder's `heldByThirdParties` (`index.ts:634`). Also respell the `firebase.json:292` sandbox-CSP rule, which never matches the unversioned `entryPath` today. | anonymous `/host/sample/*`, `/host/openwop-app/test/*`, `/packs-test/*` writes → 401 on BOTH spellings; a >1mb body accepted on every large mount and a raw-body signature verified on every webhook mount, on both spellings; a bound id with the wrong tenant → 403 on the unversioned path |
| **P3b: routing flip** | `v1()` → identity and `vendorTwin()` deleted (65 + 35 sites, plus ~455 hard-coded `/v1/host/openwop-app/…` registrations). Both `req.url` rewrites removed. Shell-vs-operation made explicit with `isProtocolClient` on the shared roots, independent of order. v1-only routes deleted (`/packs` mounts, the `/test/memory` seams). The conformance and LEGACY seam aliases are re-targeted. **The ~51 deferred test files move in this PR** (22 from P2a, 20 from P2b-2, 11 from P2b-3, with overlap). | a route-table test: no `/v1` key is registered; for each shared root, a browser navigation gets the shell and a protocol client gets JSON, with the registration order reversed in a second app |
| **P3c: fold the flag and the major branches** | `v1Retired()` → `true` at all 9 callers. `v1DeprecationHeaders`, the v1 discovery representation, and dead `protocolVersion.ts:993-1025` deleted (the 406 at `:1033` stays). The host dialect renamed (no longer `MAJOR = 1`). The 39 major sites converted one by one: a protocol branch folds to its v2 arm, a vendor branch takes a path predicate. `/v1` WebSocket upgrades refused. Flag pins removed (`pinV1Served.ts`, `conformance/run.ts:505`, `e2e-routes.sh`, `ci.sh:773`, `ci.yml`, README, 11 tests). | the SPA's anonymous bootstrap still works (vendor calls without a credential); a `/v1` upgrade is refused; discovery serves no 1.x |
| **P3d: persisted and third-party data** | The rows below. `check-v1-reliance` scans `backend/typescript/sdk/` too (it missed P3-0). `cli-route-coverage.mjs:67-68` and `unversioned-mount-guard-complete` / `HOST_OWN_UNVERSIONED_MOUNTS` are updated, since both go blind or red on the new first segments. Release note: metric `route` labels change (`/v1/runs/:runId` → `/runs/:runId`). | `cli-route-coverage` reports the non-zero route count |

**P3a as built (2026-10-05).** There are two helpers in `protocolVersion.ts`.
`unversionedPath` strips one `/v1/` and never a bare `/v1`, so it cannot collapse
to the public `/`. `bothSpellings` turns a path into the pair `[/v1…, …]`; a URL
matches at most one of the two, so nothing runs twice and `req.params` still
binds.
- **Mounted on both spellings:**
  - the test-seam guards;
  - the `packs-test` guard;
  - the `kb` collection guard;
  - all 14 scoped body parsers, moved into `middleware/scopedBodyParsers.ts` so a
    bare app can test them.
- **Compared unversioned:**
  - `isPublicPath`, which also feeds the CSRF exemption and the ADR 0806
    forwarder;
  - the MFA exemptions;
  - `RUN_EVENTS_STREAM` and `isCredentialOptionalRead`;
  - the SSE exemption, the CORS embed prefix and the custom-domain org pin;
  - `v2Identity`'s `RUN_PATH`, with the prefix optional and captured.
- **Left alone on purpose:**
  - `keyVendorGate` and `a2aInterfaceErrors` already handle both spellings.
  - `isV1ProtocolOperationPath` sits behind `negotiatedMajor === 2 || …`, so
    every v2 request is refused 401 regardless; P3c deletes it with the flag.
  - The `content` guard sits on a SHARED name and would 404 the SPA page when
    i18n is off. It waits for P3b's `isProtocolClient` gate (a ratchet allows
    exactly that file).
  - Route registrations and rewrite targets (customDomain's `documentRewrite`,
    the conformance and LEGACY seam aliases) are routing, so they belong to P3b.
- **Witness:** `test/adr0812-p3a-canonical-matchers.test.ts` drives a bare app
  (no negotiator, no auth), so an unversioned URL reaches each mount directly,
  as it will after P3b. Seven single-fix sabotages each turn their own case red.
  Two ratchets refuse a new `/v1`-only `app.use` mount and a `/v1`-anchored
  middleware regex.

**P3b step 1 (2026-10-06): pin who answers each shared root, before the flip.**
`test/adr0812-p3b-shell-vs-protocol.test.ts` runs on a host that has retired 1.x,
as prod has. It measures `48fcab3b2` and pins:
- **All 13 manifest roots, and a path under each:** a browser gets the SPA shell;
  an API client gets JSON and never the shell, both when it names the version and
  when it only accepts JSON.
- **Vendor `/host/openwop-app/*`:** a browser is answered by the vendor route
  table, never the shell. `/host` is a shared root, so the shell is mounted on
  `/host/*`; today the vendor rewrite is the only thing keeping vendor GETs away
  from it.

Sabotages:
- Leaving a vendor browser GET unrewritten turns the vendor leg red.
- Routing browser navigations to the JSON handlers turns the shell leg red.
- **The API leg is masked today:** deleting the shell's own `isProtocolClient` gate
  leaves it green, because the rewrite intercepts API clients first. That gate
  becomes load-bearing in step 2, and the routing PR must re-run this sabotage.

**Step 2 obligations, from this measurement and the #4445 prod regression:**
- register the shell route so it is reached BEFORE the JSON handlers on shared
  roots, or give every shared-root handler its own `isProtocolClient` gate;
- exclude the vendor space (`/host/<org>/…`) from the `/host/*` shell mount;
- re-run every P3a matcher against an unrewritten shell navigation. Anything
  gated on `negotiatedMajor === 2` also sees browsers.

**P3b step 2 is done family by family (decided 2026-10-06, while implementing).**
MEASURED on `869ac06bf`, `src/` holds:
- 465 literal `/v1/…` route registrations;
- 51 `v1()` and 35 `vendorTwin()` calls;
- 986 quoted `'/v1/` literals. About 145 of them are `BASE` constants, and some of
  those are also emitted to third parties: the OAuth `redirect_uri` must
  byte-match what each provider has registered. Others are not ours: Stripe's
  `/v1/…` API paths and persisted idempotency keys.

A single rewrite of every site is not reviewable, and #4445 already showed what a
missed case costs. So:
- **The mechanism.** The negotiator gets a `MIGRATED_PREFIXES` list. A request on
  a migrated family is not rewritten onto `/v1`. While v1 is served, an inbound
  `/v1/…` on it is stripped onto the same unversioned route; a retired host still
  answers 410 first. Every other family is rewritten as before.
- **The shell** skips vendor paths (`isVendorPath → next()`). It is mounted on
  `/host/*`, and a migrated vendor family is no longer kept away from it by the
  rewrite.
- **Batches.** Each batch PR strips one group of families' registrations and adds
  their prefixes. The witness `test/adr0812-p3b-migrated-families.test.ts`:
  - checks parity on both spellings while v1 is served;
  - checks 410 on a retired host;
  - checks a browser GET on a missing migrated vendor path gets JSON 404, not the
    shell;
  - runs a ratchet that refuses a migrated family keeping any `/v1`-keyed source
    line.
- **The proof batch** is `heartbeat-admin`. Four single-fix sabotages each turn
  their own case red.
- **The last batch** migrates the protocol roots and puts the shell route ahead of
  their handlers. It deletes the list and the rewrite, and re-runs step 1's masked
  sabotage.
- **Each batch decides its non-registration literals one by one:** strip, keep as
  an opaque persisted id, or keep for a third party.

**P3b batch 1 (2026-10-06): the long tail, 155 vendor families.**
- **What moved:** families with six or fewer `/v1` literals, excluding a
  hand-review set: webhooks registered with third parties, OAuth, `public*`
  pages, assets, `agents` (its persisted idempotency key), the vendor `runs`
  twin, auth, and the `test` seams. That came to 242 route lines plus log and
  error strings, which were stripped by a segment-boundary script and then
  diff-reviewed. Nothing persisted or third-party was found.
- **`isMigratedPath` is now a set lookup** on the family segment, not a list scan.
- **The `/host/sample` legacy alias** (`testSeam.ts`) now lands on the bare path
  for a migrated family. Without that, `a2ui` and every other seam reached
  through it 404.
- **Runtime route-table check:** the witness walks the real app's Express stack
  and refuses any `/v1` path for a migrated family. That catches runtime-built
  paths a grep cannot.
- **Five P2a-deferred tests moved with their routes:** `account-delete`,
  `migrate-tenant`, `insights-suite-governance`, `voice-session` and
  `destructive-lane-census`. Their bare apps and source-derived keys now use the
  bare path.
- **Remaining:** B2, the 16 heavy families; the careful set, by hand; and the
  final protocol-roots batch.

**P3b batch 2 (2026-10-07): the 16 heavy families.**
- **Families:** `crm`, `chat`, `orgs`, `profiles`, `assistant`, `workflows` (the
  vendor family, not the protocol root), `kicktodo`, `workforces`, `goals`, `cdp`,
  `byok`, `scheduler`, `governance`, `roster`, `proposals`, `approvals`.
- **What moved:** 245 route lines across 39 files, plus one
  `vendorTwin('/workflows/:workflowId/head')` registration.
- **Diff review:** only route prefixes, route-path arrays and the vendor OpenAPI
  document's path keys changed. The OpenAPI keys should advertise the unversioned
  path anyway. No persisted or third-party string was touched.
- **Still to go:** the careful set, with its keep-list (the persisted `agents`
  idempotency key, `/v1` links in email already sent), and SAML/OAuth read by hand;
  then the final protocol-roots batch.

**P3b batch 3 (2026-10-07): the careful set, 27 families reviewed by hand.**
The families are `public*`, `assets`, `shared`, `present`, `widgets`, `agents`,
the vendor `runs` twin, `auth`, `users`, `admin`, `connections`,
`connections-inbound`, `commerce`, `billing`, `app-builder-sync`, `public-email`,
`a2a`, `mcp`, `messaging`, `interrupt-action`, `partner`, `dev`, `conformance`,
`claude-code`, `cli-login` and `developer-keys`. 141 route lines moved, plus 14
`vendorTwin` sites switched to the new `vendorPath()`.
- **KEEP (marked `ADR 0812 KEEP`; the ratchet skips those lines):**
  - the `POST:/v1/host/openwop-app/agents` idempotency key, a persisted primary
    key and request digest;
  - `engagementService`'s match for `/v1` links in email already sent;
  - `a2aInterfaceErrors`' compare, which runs before the negotiator and so sees
    the inbound `/v1` spelling.
- **OAuth:** the `redirect_uri` emitter still yields the `/v1` URI that providers
  hold, unless `OPENWOP_OAUTH_REDIRECT_UNVERSIONED`. The callback ROUTE moved; a
  `/v1` callback reaches it through the served-v1 shim, or the ADR 0806 forwarder
  when retired.
- **SAML:** the ACS URL comes from operator config (`OPENWOP_SAML_ACS_URL`), not
  code, so it is unaffected.
- **Caught by the runtime route-table check, missed by every source scan:**
  `CERTIFICATION_BUNDLE_MAJOR2_PATH` was built as `` `/v1${VENDOR_ROOT}…` `` and
  registered only on the twin. It is now registered on the vendor path it is
  advertised at.
- **Kept as they were:** three `src/**/__tests__` files that the script had
  rewritten were reverted, because they feed stored `/v1` asset and route URLs
  deliberately. They pass unchanged, since the code accepts both.
- **Remaining:** only the `test` seam family, `/host/sample`, and the protocol
  roots, in the final batch.

**P3b batches 2 and 3 MERGED (#4504, #4512); final batch 1 = the test seams (2026-10-07).**
Every vendor family is now migrated. What surfaced along the way:
- **Batch 2:** `cli-route-coverage.mjs` counted only `/v…` routes, so each migrated
  family disappeared from it. It now also counts `/host/…` routes and
  `vendorPath(…)` registrations, keyed without the version.
- **Batch 2:** four source-derived crm/kicktodo route inventories keyed on `/v1`.
- **Batch 3:** eleven P2a-deferred tests, all in the planned classes.

**Final batch 1** makes `isMigratedPath` also accept a short `MIGRATED_ROOTS` list
of non-vendor roots: `/host/sample`, `/host/workspace`, `/host/durability`,
`/host/effect-seams`, `/packs-test` and `/test`. The `test` vendor family joins as
well. It strips 87 lines in 34 files.
- The `/host/sample` legacy alias matches the unversioned spelling.
- The conformance seam aliases target the bare paths.
- `/packs-test` and `/test` join `HOST_OWN_UNVERSIONED_MOUNTS`. Neither is a v2
  manifest segment.
- The full backend suite ran as the pre-check: three test-side fixes.

**Next, final batch 2:** the protocol roots (`v1()` and its literals).
- The shared-root shell registers BEFORE every route module, so a browser GET on
  `/runs/<id>` gets the shell ahead of the JSON handler.
- The rewrite and the migrated list are deleted; a served `/v1` is always
  stripped onto the bare route, keeping major 1.
- `isV1ProtocolOperationPath` reads the unversioned path.
- The `content` guard leaves the P3a allowlist.
- Step 1's masked sabotage is re-run.

**P3b final batch 2 (2026-10-07): the protocol roots. The routing flip is COMPLETE.**
- **The negotiator rewrites nothing.** A served `/v1` request is always stripped
  onto the unversioned route, keeping major 1. P3c deletes that shim with the
  flag. `MIGRATED_PREFIXES` and `isMigratedPath` are deleted.
- **Registrations:**
  - `v1()` is the identity (P3c deletes it);
  - the six `/v1`-anchored regex routes in `runs.ts` lose the anchor;
  - every remaining `vendorTwin` registration becomes `vendorPath`. These were
    template-built, so the family count never saw them: `builder-pair`,
    `team-intent-ledger`, the OAuth conformance seams, Copilot `subscription`,
    the vendor `trigger-subscriptions` delete, and `packs`.
- **The `/v1`-only pack-registry halves** (`v1('/packs…')` and `/^\/v1\/packs…/`)
  are dropped, not migrated. They were a 410 on every retired host, and making
  them unversioned would have revived a public `/packs` surface. The vendor path
  serves the same handlers.
- **Shell first.** The shared-root SPA shell moved to `registerSharedRootShell`,
  mounted before every route module. Step 1's masked API leg is now live:
  deleting the shell's `isProtocolClient` gate fails it. Registering the shell
  after the route modules fails the browser leg here and in
  `adr0812-shell-navigation-retired-host` (the #4445 class).
- **`isV1ProtocolOperationPath`** reads the unversioned path, so a credential-less
  served-v1 protocol request is still refused 401.
- **Two live defects fixed.** Both pointed a client at a `/v1` address that a
  retired host answers 410:
  - the prompt-create `Location` header, now `advertisedPath`;
  - the webhook trigger-subscription `ingestUrl`, now unversioned.
- **The witness is absolute now:**
  - the REAL route table, strings and RegExp prefixes, holds no `/v1` path;
  - no source line registers a `/v1` literal or a `vendorTwin` route.

**Next: P3c.** Fold `v1Retired()` to true and delete the served-v1 shim, `v1()`,
`vendorTwin`, `bothSpellings`, the deprecation headers and the v1 discovery
document. Delete the 32 P2b hand-off files' v1 legs and `pinV1Served`, and convert
the 39 major-branch sites.

> **P3c as landed: the deploy-day certify lane (2026-10-08).** The plan above
> said the image-mode bundle "needs a deliberate cut in P3c, not a side effect".
> It became one anyway: the first post-fold deploy REFUSED to ship. Before the
> fold the in-process certify host still served v1, so `--target-major`
> followed `preferredVersion` 1.1 and the lane certified MAJOR 1. After it, the
> lane certifies major 2, and in-process major 2 claims NO profile, so the
> bundle failed its own schema (`claimedProfiles` minItems 1). The production
> cut claims `openwop-discovery-core` and `openwop-core-standard`; the 18 rows
> that pass there and not in-process are all configuration-driven (inbound
> signing, operator fixtures, `production`). The cut, made deliberately in
> `scripts/deploy.sh`:
> - **Origin mode** (`OPENWOP_CERT_BUNDLE_ORIGIN`, production): no image bundle
>   is built. The host only ever serves the origin bundle `publish-evidence`
>   cuts against the live service, so the image bundle was vestigial there.
> - **The major-2 ratchet** moved out of the image-certify arm and runs in
>   BOTH modes. `--skip-certify` still skips it, now through an explicit
>   `DO_CERTIFY -eq 1` guard (pinned in `test-deploy-gates.sh`).
> - **Image mode is unchanged and still refuses without a claim.** OPEN:
>   adopters who certify in image mode cannot claim a profile in-process at
>   major 2 until the lane sets the production posture its claim needs.
>   Until then, they deploy with `--skip-certify`, and the RFC 0089 §D pointer
>   is absent, which is conformant.

**Persisted and third-party data. The recommendations are open for the architect
pass:**
- **`IdempotentEndpoint` keys: KEEP the strings as opaque ids.** Only the TS
  identifier names change. A rename rewrites the primary key and the digest in
  both stores, and a client retry spanning the deploy would re-execute a run
  create. Keeping the strings costs one comment.
- **`webhook_subscriptions.protocol_major` 1/null rows: DELETE in a migration.**
  Decision 2 already makes them receive nothing on a retired host.
- **Stay answered through the 410/308 forwarder, never rewritten:**
  - stored `/v1` links in sent email (`engagementService.ts:298`);
  - asset URLs in stored documents and event logs (`retiredAssetServePath`);
  - provider-registered OAuth redirect URIs (`oauthFlow.ts:214`);
  - pasted `embed.js` snippets;
  - stored idempotent `response_body` URLs (`v2Ids.ts:343`).
- **Conformance:** removing the flag removes the major-1 lane and its quarantine
  (`conformance/run.ts:500-505`). `conformanceClaims.ts:357`'s image-mode bundle
  is major-1 only. This needs a deliberate cut in P3c, not a side effect.

**Test files P2b hands to P3 (from the P2b owner, 2026-10-05).** 32 protocol test
files stay on `/v1` deliberately. They test v1 itself, carry deliberate v1-vs-v2
legs, or build minimal apps without the negotiator. P3 **deletes their v1 legs
rather than migrating them**. The P2b rule still binds: a deleted leg that asserts
authorization (tenant isolation, `id_tenant_mismatch`, a credential-less 401)
must name the v2 test that covers it, or be ported instead.
- **v1 itself and the cut:**
  - `adr0650-era3-v1-read-inverts-codemap`, `adr0654-v1-sunset-and-vendor-twins`;
  - `adr0669-*` (cut rehearsal, run links, self-calls, retirement rehearsal);
  - `adr0730-phase-c-v1-retirement`, `adr0806-third-party-addresses-survive-cut`;
  - `v1-cut-signed-trigger-ingest`, `v1-path-prefix-single-owner`, `v1-snapshot-version-axes`;
  - `check-v1-reliance`.
- **Deliberate v1-vs-v2 legs:**
  - `adr-0744-a2a-errorinfo-v2-outcomes`, `adr0658-run-list`, `adr0682-legacy-host-types-readable`;
  - `adr0712-run-ai-credential-ref`, `adr0723-bound-id-kinds`, `adr0781-unadvertised-not-found`;
  - `adr0807-v2-compensation-read`, `idempotent-replay-v2-bound-id`, `v2-bulk-cancel-tenant-bound-id`;
  - `v2-create-links-origin`, `v2-event-sequence-zero-based`, `v2-malformed-body-envelope`;
  - `v2-origin-decoded-bound-id`, `v2-run-pause-resume`, `v2-sse-frame-runid-projection`;
  - `v2-sse-values-snapshot`;
  - `rfc0114-a2ui-delta-e2e` (the delta frame is v1-only, RFC 0209 §D.15);
  - the one in-flight test in `idempotent-run-admission` (its major-2 twin is the next test).
- **Minimal apps:** `http-metrics-stream-label`, `rate-limit`,
  `rfc0093-interrupt-token-lifecycle`.

These are in addition to P2a's 22 source-coupled files.

**Trap for P3c: bare ids that pass only because of the pin.** Ported tests pass
today because `test/setup/pinV1Served.ts` keeps `OPENWOP_V1_RETIRED=false`, which
still admits BARE run ids on v2 paths. Some tests take a bare id from a
host-extension response (e.g. a redrive's `redriveRunId`) and use it on
`/runs/{id}`. They go red with `400` when the fold refuses bare ids. Before
removing the pin, grep for host-extension-returned ids used on protocol paths,
and bind them the way `client/v2Wire.ts` does. A red there is a test spelling,
not a host defect. The same pattern in the SPA would be a defect, so check the
SPA call sites too.

**P3 follows the last P2b batch (P2b-5).** P3b would turn any remaining `/v1`
protocol test red rather than migrate it. P3-0 and P3a do not depend on P2b.

*Original option-B sequence, kept as the record:*


**B, sequenced, with deletion (A) left behind an explicit product gate.**

1. **P0, now (docs and ratchet truth).**
   - `check-v1-reliance` stops saying "zero is FORBIDDEN … EOS 2026-12-04".
     Zero is now the target, and it ratchets toward it.
   - The `WORKER_CONTRACT` comment is corrected.
   - `README` gains an operator note on `OPENWOP_V1_RETIRED`, which adopters
     cannot discover today.
   - The plan's W9 row points here.
2. **P1 (protocol routes).** `v1()` returns the unversioned path. The negotiator
   stops prefixing, and instead strips `/v1` and sets major 1 while v1 is served.
   - Each of the 27 path matchers is audited and moved to the canonical
     spelling.
   - **Witness:** the full suite passes unchanged with the flag OFF. The 649
     `/v1` test files then run through the shim, which proves the shim. The same
     suite also runs once with the flag ON, to find every test that silently
     depends on v1.
3. **P2 (vendor routes).** The same inversion for `vendorTwin()` and the 712
   host-extension refs. Vendor paths keep the host dialect (`MAJOR = 1`,
   `runUnderContract(1)` at `protocolVersion.ts:966`), because they are not
   protocol operations.
4. **P3 (gated, not scheduled).** Delete the shim, which removes v1 from the
   codebase. Gate:
   - the product owner decides that adopters lose v1;
   - a release note and a deprecation window for adopters;
   - the test corpus is migrated off `/v1` first (mechanical once P1 and P2
     have landed).

**Decision 2.** After retirement, a webhook subscription with
`protocolMajor: 1` is **paused**, not silently upgraded. A subscriber whose
payload shape changes without warning breaks quietly, while a paused
subscription is visible in its dead-letter state. With zero real subscribers
this is cheap to do in P1.

## Implementation record

| Phase | What | PR |
|---|---|---|
| P0 | Docs and ratchet truth (`check-v1-reliance` targets zero; `WORKER_CONTRACT` comment corrected; README operator section; `check-wire-claims` N/A cites capabilities.md §Deleted fields). Also v2 `aiProviders.authModes` `api-key` → `apiKey` (host-services.md vocabulary; reported by the corpus steward), with a test pinning the vocabulary that fails on the old value. | this PR |
| P1 | `OPENWOP_V1_RETIRED` defaults to retired (only `false` serves v1); the 23 `delete` resets → `'false'`; `test/setup/pinV1Served.ts`; explicit pins in e2e-routes.sh, the ci.sh e2e boot, ci.yml e2e and in-process conformance; decision 2 (no delivery to a major-1 webhook subscription on a retired host); runbook rollback `=false`; README operator section. Pinned by `test/adr0812-v1-default.test.ts` (reverting the default or the webhook skip reds it). | `feat/adr0812-p1-v1-off-by-default` |
| P2a | `/v1/host/openwop-app` → `/host/openwop-app` in 602 test files (backend + frontend e2e), with 22 deferred to P3 (classes above). Seam-login exemption normalised. `testCorpusV1Refs` ratchet. The first train went red on tsc: a persisted idempotency key is not a URL. | #4376 |
| P2b-1 | `/v1` stripped from protocol paths in 75 test files that pass under v2 unchanged. Header-less unversioned protocol paths are served major 2. Each of the 10 files with tenant-isolation negatives was checked for a positive control in the same file, so no negative passes because v2 refused the id. MEASURED on the full batch: 169 files → 94 fail (205 tests) in five classes, restored to `/v1` for P2b-2…: (A) a bare internal run id on a v2 path (the largest); (B) `:fork` flows (bound ids, v2 fork shape); (C) v1-only operation paths with no v2 mount (they fall through to the SPA shell); (D) host error codes vendor-namespaced under v2; (E) v2 response envelope fields. | P2b-1 PR |
| P2b-2 | `/v1` stripped from 37 more protocol test files (`testCorpusV1Refs` 1421 → 1287). MEASURED on the remaining 137: 21 passed unchanged; 16 were fixed for (D) vendor-namespaced codes, asserted as LITERAL v2 spellings (`openwop-app.byok_required`, the event-lane `openwop-app.config_invalid`, the `workflow_not_found`→`not_found` alias). Two codes are deliberate major-2 behaviour rather than projection: `credential_revoked` (`auth.ts`) and `validation_error` with `details.field` (`streams.ts`). A namespaced code also turns a `.not.toBe('<bare code>')` vacuous, so the taint test's two negatives moved with it. `stream-run-authz` gained a positive control (the wildcard operator reads the same run on the same path) because its cross-tenant 404s had none. **20 files stay on `/v1` until P3:** 17 that test v1 itself (retirement, cut rehearsal, the v1 codemap and links, the reliance census) and 3 minimal apps without the negotiator (`http-metrics-stream-label`, `rate-limit`, `rfc0093-interrupt-token-lifecycle`). **80 files remain for P2b-3+**, still failing in classes (A) bound ids reaching host-extension routes or bare-id comparisons, (B) `:fork`, (E) v2 envelope/event fields. | P2b-2 PR |
| P2b-3 | `/v1` stripped from 19 more protocol test files (`testCorpusV1Refs` 1287 → 1177). Two port patterns, both mirroring the SPA (`client/v2Wire.ts`): (A) a run id stays BOUND on protocol paths and is unbound with `test/support/bareRunId.ts` only where it crosses into a host-extension route or storage. Unbinding at create time would put bare ids back on protocol paths, which a host that has retired 1.x refuses with 400. (C′) `GET /runs/{id}/debug-bundle` is not a v2 operation; its home is the ADR 0654 vendor twin `/host/openwop-app/runs/{id}/debug-bundle`. **11 more files stay on `/v1` until P3:** v1-vs-v2 parity tests whose `/v1` calls are deliberate v1 legs (`adr0723`, `adr0712`, `adr0781`, `adr0807`, `idempotent-replay-v2-bound-id`, `v2-bulk-cancel`, `v2-event-sequence-zero-based`, `v2-origin-decoded-bound-id`, `v2-run-pause-resume`, `v2-sse-frame-runid-projection`, `v2-sse-values-snapshot`), which brings the P3 list to 31. **50 files remain for P2b-4.** One is a candidate host finding, not a test spelling: under a v2 `:fork`, `adr0751-fork-suspended-checkpoint` sees the forked gate's `createdAt` differ from the source's, while ADR 0262 ruling #2 says a fork inherits it. To be investigated before that file is ported. | P2b-3 PR |
| P2b-4 | `/v1` stripped from 25 more protocol test files. The ports were semantic, not spelling changes: (A) more crossings into host/in-process lanes: event-log appends, `applyCostRollup`, channel appends, agent-tool inputs, redrive bodies, and storage reads written as `storage()`/casts; (E) the major-2 webhook body is `{ runId, event }` and stores the v2 vendor name (`openwop-app.crm.contact-created`); `connector.auth-expired` is hyphenated on the v2 wire; closed v2 payloads drop host fields (`artifactTypeId`→`artifactType`, `valid`, `pinned`), so those are asserted on the stored event or the host `debug-bundle`; and v2 resolves a cancelled run's gate as `409 interrupt_already_resolved`. **Security legs:** cross-tenant negatives now see v2's earlier `403 id_tenant_mismatch`, so `quorum-review` adds the attack that reaches the gates behind it (a foreign id re-bound to the attacker's own tenant), with a positive control. MEASURED under sabotage: a second tenant gate also holds. **CORRECTION to P2b-3's row:** the suspected v2 `:fork` `createdAt` defect is NOT real. The test's `appendMarker` wrote to the event log under the BOUND id; with the bare id `adr0751` passes 12/12. 23 files remain for P2b-5. `rfc0114-a2ui-delta-e2e` moves to the P3 list, because the delta frame is major-1 only by design (RFC 0209 §D.15). | P2b-4 PR |
| P2b-5 | The last 21 portable protocol test files leave `/v1`, which completes P2b. New port shapes: a v2 snapshot carries no `interrupt`, so the token-redaction test asserts that NO snapshot carries the handle, for either scope, while the scope-checked host list still gives it to a responder; the v2 owner block is `{ tenant, subject }`, so the opaque id is witnessed on `subject.subjectId`; the v2 poll cursor is `afterSequence` (`lastSequence` is not a parameter); a run cancelled after it finished is `409`, so the key-preset probe uses a live run; the SPA persists BARE ids, so chat bubbles and conversation binds do too. Ported this way, three negatives stopped being vacuous (`not.toContain(theirs)`, and D5's foreign and non-conversation binds). `metrics-golden-telemetry` keeps the `/v1/runs` ROUTE LABEL, which is the internal route key until P3, not a request path. **Two host fixes the port exposed** (see Findings): the major-2 run list now carries `compensationStatus`, and an anonymous visitor's decoded bound id resolves. **34 files stay on `/v1` for P3** (v1 behaviour, v1-vs-v2 parity legs, minimal apps). | P2b-4/5 PR |

## Open questions

- [x] Product owner: is v1 support for white-label adopters a commitment?
      **No** (2026-10-04). P3 is scheduled, not gated.
- [ ] P1 needs measuring, not just estimating: the number of tests that fail
      with the flag ON.
- [ ] Do the deliveries to `example.com` (4,220 in 30 days) come from
      leftover test subscriptions? If so, fold them into the trigger-subscription
      cleanup that openwop-app-31 is picking up.

## Findings the port surfaced

- **2026-10-05, P2b, fixed by the pin-fix PR.** **A live UX defect the cut caused, found by porting `run-retention-pin` off `/v1`.** Major 2's closed RunSnapshot (`host/v2Snapshot.ts`) strips `pinned`, `removalAt` and `interrupt`. The SPA has spoken major 2 since v1 retired, so `RunDetailPage` read `!snapshot.pinned` as always true: every click pinned, Unpin never rendered, and the pinned notice never showed. The provenance panel's open-interrupt kind was also lost. Fixed by a host-extension READ, `GET /host/openwop-app/runs/{id}/pin` (same readable-run gate and the same derivation as the v1 snapshot), plus the open-interrupt kind from the page's existing interrupt read. An unknown pin state disables the toggle instead of claiming "not pinned".
- **2026-10-05, P2b-5, fixed in the P2b-5 PR.** **The major-2 run list omitted `compensationStatus`.** `GET /runs` under
  major 2 projected each snapshot without the RFC 0151 §D rollup, while the major-2 getRun carried it. §D puts the field on
  every snapshot. The steward A-grade wire test pins exactly this "second call site gets forgotten" class, but it read the
  v1 list, which resolves the rollup per page. Porting it off `/v1` exposed the gap. The v2 branch now runs the same
  one-scan resolution.
- **2026-10-05, P2b-4. Ruled by the corpus steward and tracked as ADR 0825.** **A major-2 webhook delivery of a HOST event fails its own schema.**
  `routes/webhooks.ts` (`runId: \`hostext:${type}\``) sends a runless host event (e.g. `openwop-app.crm.contact-created`) to a
  major-2 subscriber with envelope `runId: "hostext:<type>"`. `webhooks.md` §Delivery requires the body to validate against
  `webhook-delivery.schema.json`, whose `runId` is the tenant-bound grammar (`<tenant>/<opaque>`), so every such delivery is
  invalid. The `v2Ids.ts` note that these pseudo-ids "are not reachable on the v2 path space" is true of paths and false of
  webhook bodies. Options: stop delivering host events to major-2 subscriptions (v2 webhooks carry run events), or mint a
  grammar-valid tenant-bound pseudo-id per host event. **The ruling was (a), plus a corpus gap:** v2 webhooks carry
  run events only, a pseudo-run id is non-conformant, and v2 has no home for vendor host events yet (an RFC is owed, corpus
  TODO §8). Because v1 is retired on prod, dropping them would end host-event webhooks for every user, so ADR 0825
  moves them to a host-extension lane first. Until then `crm-events`, `cms-host-event-binding` and
  `commerce-governance` (ported in P2b-4) pin the non-conformant delivery, and ADR 0825 P1 re-points them.

## P3c record: the major-branch sites and the v1 helpers (openwop-app-4a)

The fold (P3c-1) made major 2 the only contract. This slice removed what still
branched on the major, on the rule in the P3c row: **a protocol branch folds to its
v2 arm, a vendor branch takes a path predicate.**

- **The predicate.** After the negotiator every request is either a protocol request
  (stamped major 2) or a vendor-path request (`/host/openwop-app/…`, the host dialect,
  stamped 1). `/v1` never gets past it. So `negotiatedMajor(req) === 2` meant
  "protocol request", and that is now its name: `isProtocolRequest(req)`. It is used
  only where a vendor request still arrives: auth (the credential-less 401 and the
  revoked-key code), the v2 identity guard, and the run list shared with its vendor
  twin. `negotiatedMajor` survives for one caller, the v1 discovery representation
  P3c deletes. The rest fold to v2: run create, cancel, bulk-cancel, pause and
  resume, poll, compensation, artifact, snapshot, the node-scoped interrupt
  resolve, the token resolve and inspect, the SSE stream, webhook registration
  (`protocolMajor: 2`), the host-event stream, content, connection providers, the
  prompts `Location`, the unadvertised refusal (`v1Status`/`v1Code` dropped) and
  the run JSON sender.
- **A vendor branch kept on purpose.** The `interrupt-action` one-click links (email,
  chat) are host dialect, so they keep the store lookup they always took. The
  scheme check is now an explicit `verifyScheme` option set only by the protocol
  routes, not a major.
- **Left alone:** `currentContract()` sites (`pinnedRunDisposition`, the debug-bundle
  owner block). That is the storage era, which is not a wire major (decision 1).
- **Deleted:** `v1()`, `vendorTwin`, `bothSpellings`, `unversionedPath`,
  `isV1ProtocolOperationPath`, `negotiatedVersion`, and the `major` parameter of
  `advertisedPath`/`runLinks`. About 90 call sites were unwrapped.
- **KEEP:** the OAuth `redirect_uri` is byte-identical (providers hold the `/v1` URI).
  The A2A error wrapper still matches the inbound twin, because it runs before the
  negotiator and shapes the 410 for an A2A caller.
- **Trap found:** `isPublicPath` fed the ADR 0806 forwarder the INBOUND `/v1` path
  and relied on `unversionedPath` to strip it. Deleting the helper there would have
  stopped every held third-party link from forwarding. `index.ts` now strips the
  twin with `retiredVendorTwinPath` before asking, which is the same answer, because
  only a vendor twin is ever forwarded.
- **`/v1` WebSocket upgrades are refused 410.** `upgradePathname` stripped `/v1` and
  collab's matcher took it as optional, so a retired host still opened sockets on
  the withdrawn path space. Witness: `test/adr0812-p3c-v1-upgrade-refused.test.ts`,
  which is red with the guard removed.
