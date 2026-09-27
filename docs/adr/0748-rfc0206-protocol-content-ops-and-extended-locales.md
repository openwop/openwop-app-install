# ADR 0748 — RFC 0206: protocol `/content/*` admin ops over the CMS kernel, and one honestly-advertised extended locale

Status: implemented (architect review 2026-09-24, below)

Related: ADR 0064 (CMS content localization, RFC 0103), ADR 0408 (pages ARE
content-kernel rows, `cms.page`), ADR 0027 (system site), ADR 0205 (translator
grants, per-locale publish state), ADR 0593 / 0672 (live-edit approval gate),
RFC 0206 (`../openwop/RFCS/0206-locale-keys-accept-negotiated-bcp47.md`),
PR #4098 (the LOCALE_RE widening + resolveSection script step this ADR builds on).

## Context

RFC 0206 widens content locale keys from RFC 0103's `ll(-RR)` to a case-canonical
BCP 47 subset (`zh-Hant`, `zh-Hant-TW`, `es-419`, `fil`) and adds a script-family
step to the §C merge. Its one live-host row, `openwop.requirement.0206.delivery-extended-locale`
(major-2 scenario `v2-content-locale-keys`), runs only when the v2 `content`
family is advertised with an extended tag in `supportedLocales`, and then:

1. `POST /content/pages` (published) → 2. `PUT /content/pages/{pageId}/sections/{sectionId}`
with `locale == baseLocale` → 3. the same with the extended tag (must be `< 300`) →
4. authenticated `GET /content/pages/{slug}` + `Accept-Language: <tag>` must answer
`Content-Language: <tag>`, the overlay field, and base fields falling through.

MEASURED at `bfd8b8545` (`ea9cd39ee` for this branch):

| Fact | Evidence |
|---|---|
| The only protocol content op is the anonymous delivery GET, and it always reads the SYSTEM SITE tenant | `routes/contentDelivery.ts:35` |
| `v1('/content')` is a PUBLIC path prefix, so the auth middleware never runs on anything under it — an authenticated GET has no principal, and any write op mounted there would be unauthenticated | `middleware/auth.ts:251-254`, `isPublicPath` |
| The delivery body fails its own schema: `page` lacks required `pageId`/`slug` and carries a forbidden `description`; each section carries a forbidden `order` | `contentDelivery.ts:62-72` vs `schemas/v2/localized-content-page-response.schema.json` |
| v2 advertises no `i18n` and no `content` family | `routes/discovery.ts` `buildV2Advertisement` |
| CMS section ids must start `sec:` or are re-minted; section bodies are CLOSED per type (a `hero` drops `cta`) | `cmsService.ts` `validateSection`, `buildSectionData` |
| `negotiateLocale` has no script step; the error catalog has only `pt-BR` | `host/i18n/locale.ts:61-80`, `host/i18n/errorMessages.ts` |
| Prod env `OPENWOP_I18N_LOCALES=en,es,pt-BR,fr` | `gcloud run services describe` 2026-09-24 |

## Decision (proposed — to be reviewed by /architect)

### D1 — The protocol content ops are a FAÇADE over the one CMS kernel, never a second store

`POST /content/pages`, `GET /content/pages`, `PUT /content/pages/{pageId}/sections/{sectionId}`
and `GET /content/settings` are registered at `v1(...)` (major 2 reaches them
through the manifest-derived unversioned rewrite, no second handler) and call
`cmsService` (`createPage` / `transitionPage` / `updatePage` / `listPages`) and
`host/contentLocales`. No new collection.

### D2 — Tenant and org resolution

- Tenant = `tenantOf(req)` (credential-derived, the active workspace).
- Org = the tenant's **workspace root** (`orgId === tenantId`), the shape
  `ensurePersonalWorkspace` / `createWorkspace` / `isWorkspaceOrg` already define.
  Protocol-authored pages therefore appear in the CMS editor under the workspace
  org. The org row is NOT created by a protocol write.

### D3 — Authority (the existing CMS model, mapped — no new scopes)

| Op | Gate |
|---|---|
| list, settings | `requireTenantScope(req, 'workspace:read')` |
| create (draft) | `requireTenantScope(req, 'workspace:write')`, translator-grant deny (ADR 0205) |
| create with `status: "published"` | the above + `host:members:manage` (the admin direct-publish tier) + `409` when `cms-approval-gate` is ON (same as `POST …/publish`) |
| section PUT on a draft | `workspace:write`; a translator grant narrows to granted non-base locales |
| section PUT on a non-draft | `host:members:manage`; `409` on a published page when `liveEditGateActive` (same as the editor PATCH) |

`requireTenantScope` already admits the wildcard operator principal and the
personal-workspace owner, and is enforced unconditionally.

> **CORRECTED 2026-09-26 (ADR 0755, END `/grade-code` pass) — `requireTenantScope`
> was the wrong predicate, three ways.** (1) It reads the caller's scope UNION across
> every org in the tenant while the write lands in the workspace ROOT org, so an admin
> of a sub-org who is only a viewer at the root could author and publish root pages
> (`WIT-CNT-3`). (2) It treats an `anon:` tenant as the caller's own personal
> workspace, so in the cookie posture a header-less POST was handed a minted anonymous
> session with full authority — the editor refuses the same caller (`WIT-CNT-2`). (3) It
> never reads an `owk_` key's declared scopes (`WIT-CNT-4`). The ops now call one
> `authorizeContent` (`features/cms/contentProtocolRoutes.ts`): wildcard operator →
> allow; no principal or an anonymous session → `401`; the caller's own personal
> workspace → allow; otherwise `assertOrgScope` IN the root org (a tenant with no root
> org is a `403`, not an org `404` — the caller addressed no org). Each op first calls
> `requireKeyLaneScope(req, 'content:read' | 'content:write')`, the documented RFC 0103
> extension scopes, which `scopes_supported` now lists. Witnessed on real members in
> `test/adr0755-content-authority.test.ts` (every leg sabotage-proven) — the scenario
> test here drives the wildcard operator, which returns before any of this runs, so it
> could not have caught any of the three.

### D4 — Delivery serves the caller's tenant when a credential is presented

`GET /content/pages/{slug}` becomes **optionally authenticated**: `/v1/content`
leaves `PUBLIC_PATH_PREFIXES`; a new narrow rule lets a credential-less GET of
exactly `/v1/content/pages/<one segment>` through anonymously (no anon session
minted). With a credential it authenticates normally and reads the caller's
tenant (workspace-root org); with none — or an anon-tier session, which is a
host-minted identity, not a credential — it reads the system site exactly as
today. Caller-tenant responses are `Cache-Control: private` + `Vary: Authorization,
Cookie, Accept-Language`; the anonymous response keeps `public`.

### D5 — Section id + type mapping

- Protocol `sectionId` `X` ↔ CMS `sec:X` (a CMS id is projected with the `sec:`
  prefix stripped), so ids round-trip and delivery reports the same id the write used.
- A section PUT that names a section absent from the page creates it with a new
  CMS block type **`fields`**: a flat map of scalar text fields (bounded keys,
  `cleanString` values), the protocol's open body mapped onto the one kernel.
  Existing typed sections keep their closed schema (fields outside it are dropped,
  as the editor does today); the PUT response returns the stored record so the
  caller sees exactly what was kept.
- The editor and renderer gain `fields` (key/value editor; renders as a titled
  definition list), 4-locale strings.

### D6 — Locale semantics

- Protocol `baseLocale` = host `hostDefaultLocale()` (the advertised
  `content.baseLocale`). If the workspace org's stored `baseLocale` differs, a
  write answers `409` rather than authoring into the wrong axis.
- `GET /content/settings` returns the **effective** settings the delivery path
  honours: `{ baseLocale: host default, supportedLocales: advertised content
  locales, autoTranslateOnPublish: the org's stored flag }` — so the
  language-settings schema's "the advertisement MUST reflect it" holds.
- `negotiateLocale` gains the script step (exact → `ll-Ssss` → language family →
  default), matching `resolveSection`.

### D7 — Advertisement

- v2 `i18n` + `content` family records, from the SAME source as v1
  (`hostSupportedLocales`, `hostDefaultLocale`), `status: experimental`,
  `witness: witnessable-gated`, only when `hostI18nEnabled()`. Invariants
  test-pinned: `content.baseLocale == i18n.defaultLocale`; base ∉
  `content.supportedLocales`; content ⊆ i18n.
- Conformance boot: `OPENWOP_I18N_LOCALES=en,pt-BR,es-419` (run.ts +
  release-conformance.sh). `es-419` is honest for error envelopes because the
  catalog gains an `es` column and `localizeErrorEnvelope` falls back by the same
  script → language chain, reporting the catalog locale actually used.
- Prod: documented, NOT applied in this change:
  `--update-env-vars OPENWOP_I18N_LOCALES=en,es,es-419,pt-BR,fr`.

### D8 — Not served

No `DELETE /content/pages/{pageId}` — it is not a manifest operation, and RFC 0181
puts proprietary ops under `/host/openwop-app/`. The scenario's cleanup DELETE
404s (ignored by the scenario); probe pages are removable through the vendor CMS
route.

> **Re-examined 2026-09-26 (`/grade-data` + `/architect`, CMSPROBE-1) — D8 stands.**
> The question was the orphan growth this leaves. MEASURED by reading the lanes:
> the deploy-day certify (`deploy.sh` → `npm run test:conformance -- --certify`)
> and `release-conformance.sh` both run against a throwaway store (a temp sqlite
> file / `memory://`), so they leak **nothing**. Only a major-2 run with
> `OPENWOP_CONFORMANCE_TARGET_URL` aimed at a persistent host leaves one
> published `rfc0206-<nonce>` page per run, in the calling key's tenant, visible
> only to that tenant (never on the credential-less lane).
>
> Options weighed: serving DELETE on `/v1` only (spec'd in v1 §D, but the probe
> runs at major 2 through the manifest rewrite, so it cleans nothing); serving it
> at major 2 (an unmanifested op on the protocol path, which RFC 0181 forbids); a
> host reaper deleting `rfc0206-*` pages by age (a destructive sweep keyed on a
> naming convention the host does not own, which would also delete a user's page
> that happened to match). Accepting the bounded leak dominates: it is manual, per
> external run, tenant-private, and capped by `MAX.perOrgPages`. The residue is the
> corpus gap already recorded under A12. Cleanup after an external run is the
> vendor route, `DELETE /v1/host/openwop-app/cms/orgs/<orgId>/pages/<pageId>` (org = the tenant's workspace root) (it runs the full
> `deletePage` cascade). **What would change this:** a scheduled or recurring
> external witness against a persistent host. At that point the right move is an
> RFC adding the DELETE to the v2 manifest, and then serving it.

## Alternatives considered

- **Leave the row unwitnessed (PR #4098's position).** Honest, but the v2 content
  family then stays unadvertised and the delivery body keeps failing its schema.
- **Protocol content in a reserved per-tenant org.** Invisible in the editor — a
  parallel store in all but name.
- **Map protocol writes onto `hero` etc.** The closed per-type schema silently
  drops open fields; the protocol body is open by definition.
- **Keep delivery anonymous-only.** Spec §F says tenant is credential-derived when
  authenticated; a page written by a tenant could never be read back by it.

## Implementation plan

| Phase | Scope |
|---|---|
| P1 | locale: script step in `negotiateLocale`; error catalog `es` (+`fr`) + fallback |
| P2 | `fields` block type (backend sanitizer + FE editor/renderer + 4 locales) |
| P3 | optional-auth delivery + tenant resolution + schema-valid response |
| P4 | admin ops (`routes/contentAdmin.ts`) over cmsService |

> **CORRECTED 2026-09-26 (ADR 0755):** the module shipped as `features/cms/contentProtocolRoutes.ts` (the CMS feature package owns `/v1/content/*`), and A5's `upsertSectionLocale` shipped as `cmsService.upsertProtocolSection`. Names only; the decisions stand.

| P5 | v2 `i18n` + `content` records; conformance env; DEPLOY.md |
| P6 | tests incl. schema validation against `schemas/v2/localized-content-*`; sabotage |

## Architect review (2026-09-24) — verdict and the decisions it changed

Tracks: A (CMS façade, tenancy, authz, delivery auth) and B (v2 family advert,
`localized-content.md` §D/§F, error-envelope locale claim). Pre-existing-surface
audit: nothing else registers under `/v1/content`; `cmsService` + `host/contentLocales`
are the only owners of pages/settings; `requireTenantScope` is the house gate for
tenant-scoped routes; `protocolVersionMiddleware` runs BEFORE `authMiddleware`
(`index.ts:600,756`), so the auth rule sees the `/v1/…` spelling for both majors.

Verdict: **proceed**, with these corrections folded into the decisions above.

| # | Sev | Dim | Finding | Resolution |
|---|---|---|---|---|
| A1 | CRIT | AUTHZ | Removing `/v1/content` from the public prefixes is required (writes under it would otherwise run with NO auth and NO CSRF guard), but the anonymous carve-out must be exact: GET/HEAD only, exactly `/v1/content/pages/<one segment>`. | D4 rule is method + shape exact; route test proves unauthenticated `POST /v1/content/pages` → 401 and cookie POST without Origin → CSRF refusal. |
| A2 | CRIT | AUTHZ | A presented-but-REJECTED bearer on delivery must not degrade to the system site (ADR 0434: a rejected credential never becomes anonymous). | Rejected bearer → 401, as on every other route. Only a request with NO credential (or only a host-minted anon-tier session) is anonymous. |
| A3 | HIGH | DATA | `createPage` returns an existing row for a repeated `pageId` and silently renames a taken slug (`uniqueSlug`). On the protocol the slug IS the delivery address and the caller chose the id; a silent rename/merge makes a later GET read a different page. | Protocol create answers `409 conflict` for an existing `pageId` or a taken slug; it never renames. `pageId` charset-bounded (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`). |
| A4 | HIGH | DATA | `sectionOrder` has nowhere to live if sections exist only after a PUT, so order would be lost. | Create materialises one empty `fields` section per `sectionOrder` id, in order; a PUT to an id not on the page appends. Order is then the one CMS order, no second field. |
| A5 | HIGH | COUPLING | The section upsert is a read-modify-write over `sections[]`; written in a route it would be the second copy of `surface.updateSectionDraft`'s pin+retry. | One service function `upsertSectionLocale` in `cmsService` (version-pinned via `updatePage`'s `expectedVersion`, one bounded retry on `conflict`). |
| A6 | MED | BOUNDARY | `routes/contentDelivery.ts` (core) imports `features/cms` — an upward edge; adding the admin ops there would grow it. | All `/v1/content/*` ops live in ONE module, `features/cms/contentProtocolRoutes.ts`, registered by the (always-on) cms feature; `routes/contentDelivery.ts` is removed. |
| A7 | MED | SECURITY | `fields` is an open body on a public page. | Values are scalars only (string/number/boolean; nested → 400), strings via `cleanString`; ≤ 40 keys matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`; rendered as text (React-escaped), never HTML/URL. |
| A8 | MED | WIRE | The delivery body fails its own closed schema (`page.pageId`/`slug` missing, `description` + per-section `order` forbidden). Removing forbidden fields is conformance to the published shape, not a break (a strict consumer already rejects them). | Fixed; a test validates the body against `schemas/v2/localized-content-page-response.schema.json`. |
| A9 | MED | WIRE | `§D` prescribes `Cache-Control: public` for public delivery, while `§F` makes tenant scoping a MUST. An authenticated tenant read is not the public lane. | Anonymous: unchanged `public`. Authenticated: `private, no-store` + `Vary: Accept-Language, Accept-Encoding, Authorization, Cookie`. |
| A10 | MED | WIRE | Advertising `es-419` in `i18n.supportedLocales` also claims error-envelope negotiation. | Catalog gains `es` and `fr` (prod advertises both); lookup walks exact → script → language; `Content-Language`/`details.locale` name the catalog locale actually used. |
| A11 | LOW | DATA | Protocol writes do not create an org row, so a tenant with no workspace root (`default`, an env-key tenant) holds protocol pages the editor cannot list. | Accepted: creating access-control rows is `accessControl`'s job, not a content write's. Documented. |
| A12 | LOW | WIRE | `DELETE /content/pages/{pageId}` is in `localized-content.md` §D but NOT in the v2 manifest; the scenario's cleanup calls it. **Superseded 2026-09-27: openwop#1634 added `deleteContentPage`; served — see § "Correction (2026-09-27)".** | Not served (RFC 0181: proprietary ops live under `/host/openwop-app/`; serving an unmanifested op on the protocol path is the wrong namespace). Probe pages are removable via the vendor CMS route. Recorded as a corpus gap. |

Compatibility (Track B): **additive** for the ops and the v2 records (advertised
only when served); the delivery-body change is a conformance fix to a closed schema.
No RFC needed — every op and record is already in the corpus (RFC 0103 + RFC 0206,
both `Active`, shapes locked, neither gates advertisement).

## Implementation record

| Phase | What landed | Where | Witness |
|---|---|---|---|
| P1 | `negotiateLocale` script-family step; error catalog `es` + `fr`; exact → script → language lookup that names the column used (`Content-Language: es` for `es-419`) | `host/i18n/locale.ts`, `host/i18n/errorMessages.ts`, `middleware/errorEnvelope.ts` | `test/adr0748-protocol-content.test.ts` (negotiation + catalog blocks) |
| P2 | `fields` block type (backend sanitizer, prerender HTML, markdown, share export; FE editor, public render, preview, 4 locales, `.fp-fields`) | `features/cms/cmsService.ts`, `features/publishing/section{Html,Markdown}.ts`, `features/sharing/sharingService.ts`, `frontend/react/src/features/cms/*` | `adr0384-section-html` golden, `section-markdown` coverage, `fieldsSection.test.tsx` |
| P3 | `/v1/content` off the public prefixes; exact credential-optional read; caller-tenant delivery (`private, no-store`); schema-valid body | `middleware/auth.ts` `isCredentialOptionalRead`, `features/cms/contentProtocolRoutes.ts` | route block: anonymous 404 for a tenant page, rejected bearer 401, admin ops 401 without a credential, body validates `localized-content-page-response` |
| P4 | `POST`/`GET /content/pages`, `PUT …/sections/{id}`, `GET /content/settings` over `createProtocolPage` / `upsertProtocolSection` | same module + `cmsService.ts` | the scenario replay (201 → 200 → 200 → `Content-Language: es-419`, overlay + base fall-through), 409s, 400s, approval gate, shared-ref refusal |
| P5 | v2 `i18n` + `content` records; `hostContentLocales()` as the one derivation; conformance env `en,pt-BR,es-419` (run.ts + release-conformance.sh); DEPLOY.md command | `routes/discovery.ts`, `conformance/run.ts`, `scripts/release-conformance.sh`, `DEPLOY.md` | v2 advert validates `schemas/v2/capabilities.schema.json`, invariants pinned |

**Sabotage (once each).** Reverting `LOCALE_RE` to the RFC 0103 grammar reds 6 of
the ADR 0748 tests (advert, scenario replay, major-2 replay, settings, locale
validation, approval gate). Forcing delivery to ignore the credential reds the
scenario replay, the major-2 replay and the negotiation-scope test.

**Review corrections folded in (code-review 2026-09-24).** A `PUT` to a section
that is a shared-section reference answered 200 while `validateSection` silently
dropped the write; it now answers 409. The `fields` editor held rows in local
state and did not follow external layer changes (Copy from base / Translate /
Clear overlay); it now re-seeds when the layer is not its own echo. Error ids
were index-only and collided across sections; they are `useId`-scoped.
(ux-review) `padding-right` → `padding-inline-end`; the component has a
`DESIGN.md` §5 row.

**Prod env (NOT applied by this change):**
`gcloud run services update openwop-app-backend --update-env-vars '^|^OPENWOP_I18N_LOCALES=en,es,es-419,pt-BR,fr' --region us-central1 --project openwop-dev`

## Remaining

- **ADR 0755 (2026-09-26) closed four write-lane defects the scenario test could not
  see:** `WIT-CNT-1` (a create whose `pageId` a sibling org held OVERWROTE that page —
  the kernel row key carries no org, and the existence check was org-filtered; now
  tenant-wide), `WIT-CNT-7` (`hero` and `sec:hero` addressed one section; `sec:`-prefixed
  protocol section ids are refused), `WIT-CNT-9` (`Vary` is appended with `res.vary`, not
  set, and the shared-cacheable anonymous answer varies on `Authorization`/`Cookie`), and
  `WIT-CNT-13` (the unknown-field 400 echoes at most 8 names of at most 64 chars).
  **Still open:** the concurrent-create race (no create-only kernel write — two
  simultaneous POSTs for one `pageId` or slug can both pass the checks; `WIT-CNT-6`),
  `GET /content/pages` pagination (`WIT-CNT-8`), an `owk_` key's subject holds no
  membership so a key can never pass the admin ops (fail-closed; `WIT-CNT-4` residual),
  and the markdown export renders `fields` values unescaped like every other section type
  in `sectionMarkdown.ts` (`WIT-CNT-11`, a class-wide decision, not a `fields` defect).

- The corpus fix (openwop#1533, scenario gates on record presence) ships in the
  **2.38.0** suite cycle; this repo pins `^2.36.1`, whose copy of the scenario still
  gates on a forbidden `supported: true` and therefore records `inapplicable`. The
  row turns executable in this repo's lanes when the pin moves (a separate step).

## Supersedes a corpus statement (RFC 0206, openwop#1549)

RFC 0206 went `Active → Accepted` on 2026-09-24 as a **corpus gate** (openwop#1549).
Its `Updated` note, "Why no host serves an extended content locale", says that
openwop-app does not advertise a tag outside `ll(-RR)` "because [it has no]
content, UI strings or a product decision behind one", and that advertising one
only to witness the row would be a claim with nothing behind it. For this host,
**this ADR replaces that statement** point by point:

| The corpus premise | What now stands behind `es-419` here |
|---|---|
| no product decision | this ADR: `es-419` is added deliberately, as the Latin-American regional tag beside the existing `es` |
| no strings | error envelopes negotiated to `es-419` are answered from the `es` catalog (new in this ADR). `Content-Language: es` names the column actually used. |
| no content | authorable per section via the §D ops (`PUT …/sections/{id}` with `locale: "es-419"`) and the CMS editor's locale tabs. The locale must also be in the workspace's content languages, which accepts the tag since #4098. |
| no v2 `content` family (RFC §Conformance correction) | the v2 `content` record is served from the same operator source as v1 (D7) |
| — | the row MEASURED `executed-pass` at major 2 against this branch (below) |

Scope of the supersession: it holds on a deployment that sets
`OPENWOP_I18N_LOCALES` to include `es-419`. The conformance boot does that from
this change on. Production does it only once the documented `--update-env-vars`
is applied. The corpus text itself is corrected in `../openwop` when a committed
bundle of this host carries the row's pass. Until then the RFC's record stays
literally true of the committed evidence, and false only about capability.

## Measurement (2026-09-24)

`openwop.requirement.0206.delivery-extended-locale`, MEASURED against this branch
with the installed 2.36.1 scenario file temporarily replaced by `../openwop`
`origin/main`'s (#1533 gate fix; reverted after), `OPENWOP_TARGET_MAJOR=2`,
`--filter "extended content locale"`:

| Run | Disposition |
|---|---|
| this branch, conformance env `en,pt-BR,es-419` | **executed-pass** (2 requirement ids: the row + the scenario), 1 test passed |
| same, at the default major-1 lane | `inapplicable` — "registered for target major 2 and this lane runs at major 1"; the row is major-2 only, so a major-1 lane can never witness it |

The corpus-side sabotage (the RFC 0103 grammar restored) did not complete: under
peer suite contention the run hit the 45-minute watchdog while still collecting
skipped files, before it reached the scenario. That is not evidence either way.
The same flow is sabotage-proven in `test/adr0748-protocol-content.test.ts`
(above), which replays the scenario step by step.

- `DELETE /content/pages/{pageId}` is in `localized-content.md` §D but not in the
  v2 path manifest; the scenario's cleanup DELETE is unanswered by design (A12).

## Correction (2026-09-26) — D3 authorized the certify binding's key as a stranger

**MEASURED:** the production major-2 evidence cut at `ad3717cde` (suite 2.38.0)
recorded `0206.delivery-extended-locale` **blocked**, with "POST /content/pages
answered 403". The certify traffic runs as tenant `conformance-prod` on a
**tenant-pinned `OPENWOP_API_KEYS` entry** (`auth.kind: 'env-key'`). There is
no `authorization.denied … key-scopes` line, so it is not ADR 0755's
`requireKeyLaneScope`, which only narrows `owk_` keys and logs its refusals.
Nor is it the publish tier. The refusal came earlier, at `workspace:write`.

**Root cause:** D3 resolved every caller as an RBAC subject from its id string. It
did that through `requireTenantScope`, and ADR 0755 kept the shape through
`assertOrgScope`. An env key's id is `bearer:<8 chars>`, which no member row is
ever keyed on, so the tenant's own operator key was refused as a stranger. ADR
0601 C4 already settled this: an env key is "the tenant's own principal, in the
tenant the config pinned it to", and the MCP lane honours that
(`resolveMcpAuthority`). This ADR's own test pinned the defect as a virtue ("a
tenant-scoped key without content authority cannot write (403, fail-closed)").
The same gate also resolved an `owk_` key as `apikey:<keyId>` instead of as its
issuer.

**Fix:** `authorizeContent` resolves authority by provenance. An `env-key` goes
through the subjectless tenant-owner branch (`resolveEffectiveAccess(tenantId)`),
in its pinned tenant only. An `api-key` goes through its issuer's membership in
the root org, still narrowed by its declared scopes. `subject` sessions are
unchanged. Wildcard and anonymous handling are unchanged. **No key change and no
member row:** ADR 0601 C3 records why a member row named after 8 characters of a
secret is not an exit.

**One classification, not two copies.** The provenance reading is extracted as
`credentialAuthority()` + `tenantOwnerScopes()` in `host/protocolAuthorization.ts`.
Both `resolveMcpAuthority` (MCP tools) and `authorizeContent` call it; the MCP
lane's behaviour is unchanged by construction (same sources, same declared-scope
filter). Each lane still asks its own question of the answer: a tenant-wide union
for MCP, the root-org scope for content.

**Architect check (2026-09-26, authz).**
- **Escalation:** an env key is operator-configured, and no member can mint one.
  It is pinned to its tenant (`req.tenantId`), so it cannot reach another tenant.
  An `owk_` key never exceeds its issuer. Its declared `content:*` still gates it
  first (`requireKeyLaneScope`).
- **Freshness:** the issuer's membership is read per request by `assertOrgScope`,
  never captured at mint. Downgrading or removing the issuer narrows or kills
  the key immediately, and a revoked key is a 401 at the boundary. All three are
  witnessed.
- **Fail-closed:** an unknown subject, or a tenant with no root org, is a 403,
  and an anonymous caller is a 401, as before.
- **Wildcard:** untouched on both lanes (ADR 0601 C4 "Not widened").

Verdict: pass, no blockers.

Witnesses: `adr0755-content-authority.test.ts` now has a tenant-pinned env key,
with no member row, that publishes and writes an `es-419` overlay. A key pinned
to another tenant reaches none of this tenant's content. The ADR 0755 legs now
authenticate as `owk_` keys issued by real member subjects rather than as env
keys with `bearer:` member rows. New tests cover the issuer being downgraded
(403 at `workspace:write`, reads still allowed) and then removed (403), a
revoked key (401), and the approval gate still returning 409 to an env key.
The MCP authz suite (22 files, 206 tests) is green on the shared helper.
Sabotage: removing the env-key branch reds 3 tests, and removing the issuer
mapping reds 5.

## Correction (2026-09-26b) — the public front door cannot deliver `es-419`; the prod advertisement is withdrawn

**MEASURED:** the certified production cut on `1c6a74420` (rev 00752) got
`0206.delivery-extended-locale` past the 403 and 409. The probe page was created
and its `es-419` overlay written. Delivery then failed: "Content-Language MUST name
the negotiated extended locale 'es-419': expected 'es'". Read-only probes, with an
anonymous GET of the system-site `home` page:

| `Accept-Language` | via `https://app.openwop.dev/api` (Firebase Hosting → Cloud Run) | direct `https://openwop-app-backend-…run.app` (`/v1` and `/api/v1`) |
|---|---|---|
| `es-419` | `Content-Language: es` | `es-419` |
| `es-419, pt-BR;q=0.9` | `es` | `es-419` |
| `pt-BR` | `pt-BR` | `pt-BR` |
| `zh-Hant-TW, pt-BR;q=0.9` | `pt-BR` | `pt-BR` |

**Root cause:** the Firebase Hosting edge rewrites `Accept-Language` before the
request reaches the origin. The backend's own `/api` prefix strip is not involved:
`run.app/api/v1/…` also answers `es-419`. Firebase documents the behaviour for its
i18n machinery: "Hosting drops any regional and country subtags in the
Accept-Language header" (<https://firebase.google.com/docs/hosting/i18n-rewrites>).
It evidently applies on the Cloud Run rewrite too. **The exact rule is
undocumented**, because `pt-BR` survives while `es-419` does not.

**The host code is correct and stays as it is.** It honours `es-419` at the
origin. But the certified `BASE` is the Firebase door, and there no client can
negotiate `es-419`. An advertisement of it at that door is a claim the door cannot
honour, so **the production advertisement is withdrawn**:
`OPENWOP_I18N_LOCALES=en,es,pt-BR,fr`, applied by the operator after the
2026-09-26 freeze. The production row now records `inapplicable` with its reason
("no advertised content locale outside the RFC 0103 subset"). That is the honest
disposition for this door.

**Where the witness lives:** on the origin-direct lanes.
- The local major-2 run (`conformance/run.ts` sets `en,pt-BR,es-419`): `executed-pass`, above.
- The release-image companion cut under RFC 0216 (`scripts/release-conformance.sh`
  boots the release image with `es-419` and certifies it at `127.0.0.1`, with no
  Firebase in the path).

The supersession of the RFC 0206 corpus note (§ "Supersedes a corpus statement")
therefore holds **for this host's origin, not for its public Firebase door**.

**The path to re-enable it in production, recorded and not done now:** serve the
protocol from an origin that does not rewrite request headers, such as a Cloud Run
domain mapping or a load balancer on e.g. `api.openwop.dev`, and certify `BASE`
there. That is a deploy-topology change touching every certified claim, so it is
a program decision rather than a WS4 fix. A door-aware advertisement (omit
`es-419` when the request came through Firebase) was rejected: it depends on an
undocumented Firebase header reaching the origin.

**Re-measure the door** (read-only; it should print `es-419` twice once a
non-rewriting door is in place):
```
for u in https://app.openwop.dev/api https://openwop-app-backend-jkav3gnlqa-uc.a.run.app; do
  curl -sS -D - -o /dev/null -H 'Accept-Language: es-419' "$u/v1/content/pages/home?cb=$(date +%s%N)" | grep -i '^content-language'
done
```

## Correction (2026-09-27) — D8 / A12 "DELETE not served" is superseded: `deleteContentPage` is served

The corpus added the operation (openwop#1634, suite 2.42.2): `DELETE` on the
`/content/pages/{slug}` path item, where the segment is the page's **`pageId`**.
It answers `204` with no body, and `404` for a page absent in the caller's tenant.
D8's reason ("not a manifest operation", RFC 0181) no longer holds, so the host
serves it. This also ends the probe-page growth from certify runs, whose
cleanup DELETE had been unanswered by design.

**Decisions (/architect, 2026-09-27):**
- **Over the kernel's own delete.** `cmsService.deletePage` owns every cascade:
  versions, redirects, share links, comment threads, usage, the lifecycle seam,
  and a pending review closed as `superseded`. The route adds none of its own.
- **Authority:** the create/put pair. That is key-lane `content:write`, then
  `workspace:write` in the root org through `credentialAuthority`, plus the
  translator refusal. A page that is **not a draft** is live, under review or
  archived. Removing it is at least an unpublish, which is admin tier, so it
  needs `host:members:manage`.
- **The approval gate does not apply.** It stops content from going live
  without review. Removal is the fail-safe direction, which is why unpublish,
  archive and schedule-unpublish are ungated too.
- **Path clash with delivery:** the same path item, but a different method.
  Only `GET`/`HEAD` of this shape is credential-optional
  (`isCredentialOptionalRead`), so a DELETE with no credential is a 401. The
  segment is read as a `pageId`, never a slug. A malformed id, an id in another
  tenant, and one in a sibling org all answer the same `404` (§F).
- **The EDITOR's delete route is aligned (was looser).** The vendor route
  `/v1/host/openwop-app/cms/orgs/:orgId/pages/:pageId` required only
  `workspace:write` for a page in ANY status, so an editor could delete what they
  could not unpublish. Now a non-draft page needs `host:members:manage` there
  too. Drafts stay `workspace:write`, and the approval gate does not apply.
- **UI (ux check).** The editor offers Delete to everyone, the same convention
  it uses for publish and unpublish: authority is enforced server-side, and the
  CMS has no client-side role signal to hide the action with. So it says what is
  at stake instead. For a non-draft page, the confirm says the page is live,
  that deleting it takes it offline, and that only a workspace admin can do it.
  An editor's 403 then shows the remedy ("Unpublish it first, or ask an admin")
  instead of a generic "no permission". Strings are in 4 locales.
- **Status-read / delete window.** The kernel offers no conditional delete (no
  `compareAndDelete`, and `deleteSystemEntity` is unconditional). Adding one
  would be a storage-layer change across every backend. So `deletePage` takes an
  `authorize(page)` callback and runs it on ITS OWN read, immediately before
  `pages.delete`, on both routes. The tier decision is therefore made on the row
  actually deleted, not on a caller's earlier read. The remaining window is that
  read and the delete inside one function call.

**Witnesses** (`test/adr0755-content-authority.test.ts`, plus the 401 leg in
`adr0748-protocol-content.test.ts`):
- The tenant's env key removes a published page with 204 and an empty body.
  After that, delivery and a second DELETE both answer 404.
- The segment is a pageId: a slug answers 404, and major 2 reaches the same
  handler.
- An editor can remove a draft but not a live page (403 `host:members:manage`).
- Another tenant's key and a sibling org's page answer 404, and nothing is removed.
- An `owk_` key without `content:write` is refused first.
- The approval gate does not block removal.
- No credential answers 401.
- Sabotage: dropping the admin-tier check reds the editor/live leg.
- Editor route (`adr0748-cms-delete-live-tier.test.ts`, cookie sessions): an
  editor deletes a draft (204), but is refused a published page (403
  `host:members:manage`, page intact). The owner deletes a published page even
  with the gate ON. Sabotage: dropping the route's tier check reds the editor leg.
- UI (`cmsLiveDelete.test.tsx`): a live page's confirm says "live" and "admin",
  and an editor's 403 shows the remedy. A draft keeps the plain confirm.
  Sabotage: reverting the confirm body reds it.
