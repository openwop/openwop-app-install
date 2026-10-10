# ADR 0818 — Media library integrity: the serve exit, the bytes, the quota, the run's authority

Status: Accepted (implemented on `feat/fl2-14-media`; flips to implemented on merge)

Related: ADR 0007 (Media library), ADR 0027 (media always-on), ADR 0055 / RFC 0055 §C
(capability-token asset serving), ADR 0352 (dedup, bulk, select), ADR 0363 (alt text),
ADR 0401 (AI image ops), ADR 0511 (brand-asset sniffers), ADR 0579 (byte lifecycle),
ADR 0817 (the system site's Media library; this ADR does not change it), CMNT-4
(`assertOrgScope`, the one org-scope predicate). Feature loop 2026-10 row 14; workflows
grade `MEDWF-1..6` in `docs/steward/WORKFLOWS-ASSESSMENT.md`.

> **Order of work, stated up front.** §1 closes a live stored-XSS hole. It was found,
> proved RED on `origin/main` source and fixed BEFORE this ADR was written, and the branch
> stayed unpushed past the claim until it was gated. §2–§4 were proved RED the same way.
> The adversarial `/architect` pass ran over the decision text and the implemented code
> together.

## Context

Media is always-on (ADR 0027) and sits under CMS, profiles, KB ingest, documents, the AI
image ops and three workflow node packs. It had no `FEATURES.md` row. Round 1 never graded
it as a unit. A security-first probe found the following, each proved with a failing
real-HTTP test against unmodified source:

1. **Stored XSS on the app origin (live).** `GET /host/openwop-app/assets/:token` is
   auth-exempt and served from the SPA's own origin (Hosting rewrites `/host/**` to Cloud
   Run). Sessions there are cookie-authenticated. The route reflected the stored
   `Content-Type` verbatim, with no `nosniff`, no CSP and no `Content-Disposition`.
   `host/allowedUploadMime.ts` excluded `text/html` and SVG and called itself "the
   stored-XSS guard", but the upload routes are not the only writers:
   - `local.openwop-app.image-emit` (`bootstrap/nodes.ts`) is registered unconditionally
     and stored a caller-chosen `mimeType`. Any user, an anonymous demo tenant included,
     could register a one-node workflow, store `text/html`, and send the link.
   - The AI image seams (`aiProvidersHost.ts`, `media/imageGenRoutes.ts`) store whatever
     type the provider returned, and a custom base-URL provider is caller-controlled.

   The Hosting CSP does not cover this. It allows `script-src 'self'`, so a second asset
   stored as `text/javascript` and loaded with `<script src="/host/openwop-app/assets/…">`
   is same-origin and runs.
2. **MIME spoof / polyglot.** The library checked the declared type against the allowlist
   and never looked at the bytes, so HTML labelled `image/png` was stored.
3. **Quota bypass.** The only byte cap was per org (256 MiB), so creating another org reset
   it. Capacity was a read of committed rows followed by a write, so concurrent uploads
   raced past it: six 1 KiB uploads against a 4 KiB cap all returned 201.
4. **A run's authority.** `ctx.features.media.createAssetFromServeUrl` and `select` took
   `orgId` from node args with no membership check. A run acting for an org VIEWER (or a
   member of a different org) wrote library assets where the HTTP route returns 403. This is
   the CMNT-4 shape that comments already closed.

Probed and found sound: cross-tenant and cross-org asset read/list/delete (404 and 403,
existing tests); a removed member loses list, read and delete (new test); the system-site
scope admits a super admin only, and a tenant cannot reach it (ADR 0817 tests; the
workflow surface writes under the run's own tenant, never `host:site`). There is no
import-from-URL path in media, so nothing new reaches the network and there is no SSRF
surface. Filenames are never used as paths, because bytes are KV rows keyed by a random
token.

## Decision

### §1 — The byte exits are the guard (MEDWF-1)

Stored bytes leave through two routes: the token serve route (`routes/mediaAssets.ts`)
and the public podcast audio enclosure (`features/podcasts/publicRoutes.ts`). The guard
goes at those exits, not at each writer. Both call one function,
`assetServeHeaders(contentType)` (`host/assetServeHeaders.ts`), which sets on every
response:

- `X-Content-Type-Options: nosniff`;
- `Content-Security-Policy: default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox`.
  `application/pdf` gets NO CSP. A restrictive policy (`sandbox`, or `object-src`
  through `default-src`) can stop the browser's built-in viewer, and that viewer never
  runs a PDF's script in this origin. It still gets `nosniff`.
- **Inline** only for an inert set: raster images, `audio/*`, `video/*`, PDF,
  `text/plain|csv|markdown` and JSON.
- Everything else gets `Content-Disposition: attachment`. A type that a page could load as
  a subresource (any `text/*`, markup, `+xml`, script, CSS, wasm) is also rewritten to
  `application/octet-stream`. So is a `+xml` type under an otherwise inert major type
  (`audio/x+xml`). This matters because `<script src>` and
  `<link rel=stylesheet>` ignore `Content-Disposition`. An inert download (a `.docx` or
  `.epub` export) keeps its declared type, so it still saves correctly.

At the source, `image-emit` refuses any `mimeType` that is not an allowlisted `image/*`
type. Its output is a `media.image`.

### §2 — Bytes must be the type they claim (MEDWF-3)

`allowedUploadMime.ts` gains the signature map that brand assets already used
(`MIME_SIGNATURES`: PNG, JPEG, GIF, WebP, ICO, plus PDF) and `bytesMatchDeclaredType`.
`host/brandAssets.ts` now reads the shared map instead of its own copy.
`storableContentType(declared, bytes)` decides what the upload, bulk and
workflow-surface lanes STORE:

- A declared image is **relabelled** to what its bytes are. A `.png` that is really a
  JPEG is common, because browsers label files by extension and AI providers label
  their output loosely.
- A declared image is refused (415) only when its bytes are no allowlisted raster image.
  HTML labelled `image/png` is the case this exists for.
- A declared PDF must carry `%PDF-` within its first KiB.

The AI-image lane stores the sniffed type and skips non-images. Text, JSON, audio and video have no
single signature and are inert when served (§1).

### §3 — A workspace quota that holds (MEDWF-4)

- `assertOrgCapacity` also caps the workspace total. The cap is
  `OPENWOP_MEDIA_TENANT_MAX_BYTES`, default **2 GiB**, read per call. The 409 carries
  `scope: 'workspace'`.
- `withOrgCapacity(tenant, org, bytes, write)` runs check then write as one step per tenant
  within an instance. The upload, bulk, surface and image-gen lanes use it.
- Each writer waits for the one ahead to START, then for it to finish or for 30 s,
  counted from that start. So ordinary slow writes still run one at a time, and a hung
  write delays only the writer behind it, by one bound; it cannot wedge a workspace's
  uploads (the async-guard-wedge lesson). A timeout is logged
  (`media_capacity_wait_timeout`).

  > **Corrected twice in review.** The first cut chained each waiter on the hung write,
  > so EVERY later writer paid the bound (`/architect` #2). The second cut started the
  > clock when a writer JOINED the queue, so a queue of ordinary 20 s writes ran three
  > at a time: the race §3 claims to close, reopened under slow storage. `/grade-code`
  > `MEDCD-2` measured that. The clock now starts at the write ahead's start, and
  > `adr0818-media-access-probes` pins both properties.
- Run artifacts (`runArtifactStore`, `orgId === tenantId`) count toward the workspace
  total, but they are already held to the 256 MiB per-org cap in that pseudo-org. So
  they can take at most an eighth of the default, and cannot lock out library uploads.
- Across Cloud Run instances the overshoot is bounded by one upload per instance, not by
  request concurrency.
- Seeds, documents and run artifacts keep calling `assertOrgCapacity` directly, so they get
  the workspace cap without the queue.

### §4 — A run acting for a person has that person's authority (MEDWF-2)

The surface calls `assertOrgScope`, the predicate the routes use, when the run carries an
`actingUserId`: `workspace:write` for `createAssetFromServeUrl` and `workspace:read` for
`select`. Two lanes are unchanged:

- **The workspace-root id** (`orgId === tenantId`) in a single-principal tenant (`user:`,
  `anon:`, `default`, via `isSinglePrincipalTenant`). KickTodo lesson media and run
  artifacts write there, and it need not be an org row. With one principal there is
  nobody to escalate over.
- **A run with no acting user** (a schedule or trigger) stays tenant-trusted, as every
  surface without an actor is (`MEDWF-6`, a platform question).

Every other org goes through `assertOrgScope`. That includes a real org inside a personal
tenant, which passes the routes' personal-owner short-circuit after the existence check.
So a made-up org id is a 404 everywhere.

> **Corrected in review (`/grade-code` `MEDCD-1`, `-3`).** The first cut exempted every
> `user:`/`anon:` tenant outright. That skipped the existence check, so a made-up `orgId`
> was written there. It also missed `default`, where KickTodo's root-id write regressed
> to a 404. The exemption is now the root id on a single-principal tenant, and nothing
> wider.

> **CORRECTED 2026-10-05 (ADR 0830, `KBCD-5`) — `default` is single-principal only in
> demo mode.** The predicate above now lives in the shared `assertRunOrgScope`
> (`host/accessControlService.ts`), which KB calls too. Its root-id shortcut admits
> `user:`/`anon:` tenants, and `default` ONLY when `OPENWOP_DEMO_MODE=true`. Outside demo
> mode `default` is the SAML tenant every SSO user shares (`samlSso.ts`), so "with one
> principal there is nobody to escalate over" is false there, and its root is answered by
> membership like any other org. On `app.openwop.dev` (demo mode on) KickTodo's root-id
> write is unchanged; a non-demo shared SAML deployment tightens. Both arms are pinned in
> `test/adr0818-media-access-probes.test.ts`. The text above is kept as the original
> reasoning.

### §5 — The library tells the truth in the UI

- **Alt text renders (MED2-M1, the library half).** Library thumbnails use the asset's
  `altText`. A `decorative` image, or one with no alt text yet, renders `alt=""`, because
  every thumbnail sits beside its visible file name and the name as alt would be read
  twice (`MEDUX-7`). Previews with no caption (edit, alt dialog) fall back to the name.
  Alt text on the CONSUMING surfaces (CMS, slides, the public site) is out of scope
  (`MEDUX-8`).
- **Delete warns about real usage.** Before delete, the confirm reads the usage graph
  (`GET …/assets/:id/usage`, the ADR 0206 refs) and names the asset plus each page,
  campaign, brief or render that will show a broken image, by kind. Every server kind is
  labelled, with a neutral fallback.
  - If that read fails, or takes longer than 8 s, the confirm says it could not check,
    never that nothing uses the asset.
  - The trash button is busy while the read runs.
  - The shared `ConfirmDialog` body is now a `<div>` (it held a `<p>`, which cannot
    contain a list), and the dialog is `aria-describedby` that body, so a screen reader
    speaks the warning on open (`MEDUX-1..5`).

### §6 — Catalog

`FEATURES.md` gets a Media Library row (always-on, no toggle, `feature.media.nodes`).

## Adversarial `/architect` pass (2026-10-05) — findings and dispositions

Run over this decision text AND the implemented diff. Each finding was fixed on the
branch before P3. Every one was a real defect in the first cut.

1. **CRITICAL [security] "one exit" was false.** The public podcast audio route
   (`publicRoutes.ts` `audioHandler`) also reflected a stored type verbatim, on a public
   route. An episode's audio token names an asset the speech seam stored with the
   provider's type. Fixed: both exits call `host/assetServeHeaders`.
2. **HIGH [resilience] the capacity chain compounded a hang.** The first cut chained each
   waiter on `ahead`, so one hung write made EVERY later writer pay the full 30 s.
   Fixed: a waiter chains on the previous waiter's bounded turn.
3. **HIGH [regression] strict signatures refused real images.** Rejecting any
   declared/actual mismatch would 415 a mislabelled photo and 502 an image op whose
   provider labels WebP as PNG. Fixed: relabel to the sniffed type (§2).
4. **MEDIUM [compat] PDF under `default-src 'none'`.** This can block the built-in
   viewer. Fixed: no CSP for PDF.
5. **MEDIUM [security] `+xml` under an inert major type.** `audio/x+xml` matched the
   inline set, and a browser renders `+xml` as an XML document. `sandbox` already
   blocked script; fixed anyway, so it downloads.
6. **LOW [residual] the test-seam presign route** (`routes/testSeam.ts`
   `/blob/presigned/:token`) also reflects a stored type. It is mounted only under
   `OPENWOP_TEST_SEAM_ENABLED` (the local release-conformance container, never prod).
   Recorded, not changed.

Checked and sound:
- Type parsing handles case, parameters (`; charset=`) and whitespace, and an empty type
  becomes octet-stream plus attachment.
- `<img>`, `<video>` and `<audio>` ignore both the CSP and `Content-Disposition` of a
  subresource, so CMS pages, slides and profile avatars are unaffected (the 135-file
  media/brand/podcast/documents/artifact test set is green).
- `assertOrgScope` resolves delegated `apikey:` subjects through their issuer (ADR 0795).
- `default` and `ws:` tenants are not personal, so they get the full check.

## Matrix

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | Extends `features/media`. No new package. `routes/mediaAssets.ts` (core serve) and `host/allowedUploadMime.ts` are core files touched for a cross-cutting guard. Core does not import the feature. |
| 2 | Toggle | None. Always-on (ADR 0027), unchanged. |
| 3 | `ctx.features.media` | Unchanged ops. §4 adds the actor's org scope. |
| 4 | Node pack | `feature.media.nodes` unchanged (no manifest or code change). The `select` node has zero chain consumers (`MEDWF-5`, open). |
| 5 | Envelopes | None. |
| 6 | Agent pack | None. `openwop:media.list` is unchanged; it already shares the route's predicate. |
| 7 | Public surface | The serve route stays capability-token and auth-exempt. §1 changes only its headers. Tokens are still unguessable and non-expiring for library assets (ADR 0579 lifecycle). |
| 8 | RBAC | Routes unchanged. §4 aligns the workflow lane. A removed member is witnessed to lose access. |
| 9 | Replay | The surface write dedups on the content hash. §4's check is a live read, so a `:fork` of a run whose actor has since lost access fails closed, which is the intended behaviour. |
| 10 | Frontend | `features/media/MediaViews.tsx` and `MediaLibraryPage.tsx` only. `src/client/**` is not touched. Strings land in all 4 locales. |

**RFC verdict: host-extension, no RFC.** RFC 0055 §C requires a tenant-scoped capability
URL and says nothing about response headers. Sending `nosniff` and a CSP, and downloading
active types, is host policy. No capability flag changes.

## Alternatives weighed

- **Guard each writer (extend the allowlist check to image-emit and the AI seams).** This is
  what was there, and it is how the hole happened: the risk sits at the one reader, and the
  writers multiply. We keep the writer checks as defence in depth (§1 image-emit, §2), but
  the exit is the guarantee.
- **Serve assets from a separate cookieless origin.** This is the strongest isolation, and
  the right long-term shape. It needs a second Hosting site or domain, DNS, and a rewrite of
  every stored relative serve URL (ADR 0669 shows stored URLs are content). Recorded as an
  open question, not done here.
- **Sanitize SVG and allow it.** There is no sanitizer dependency (ADR 0511 §2 reached the
  same answer), and `sandbox` plus attachment already make a stored SVG harmless.
- **A durable atomic quota counter.** This would close the cross-instance residual, but it
  is a new store and a migration for a bounded overshoot. Recorded as an open question.
- **Rotate a serve link (revoke a leaked or departed member's token).** Every embedding
  consumer stores the URL (CMS, slides, documents), so rotation breaks them unless the usage
  graph rewrites them. That is a larger change, and §5's usage read is its prerequisite.
  Recorded as an open question.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P1 | §1 serve hardening + image-emit refusal | implemented, `test/adr0818-media-serve-hardening.test.ts` (5/5 RED on `origin/main` source) |
| P2 | §2 signatures, §3 workspace cap + serialized capacity, §4 surface RBAC | implemented, `test/adr0818-media-access-probes.test.ts` (4 RED on `origin/main` source; removed-member and personal-lane cases pass on both) |
| P2b | the `/architect` findings 1–5 | implemented, same two test files (+ header edge cases, + relabel) |
| P3 | §5 alt text + usage-aware delete, §6 FEATURES row | implemented, `frontend/react/src/features/media/__tests__/mediaDeleteUsageAndAlt.test.tsx` (3 RED on `origin/main`) |
| P4 | `/grade-ux` `MEDUX-1..5,7` + `/grade-code` `MEDCD-1..5,7,8` | implemented, same files + `adr0390-podcast-distribution` (podcast exit) |

Also: the chat-attachment upload (`/media/upload`) now runs the same byte check
(`MEDCD-7`). Relabels and refusals are logged (`media_upload_relabelled`,
`media_upload_type_mismatch`).

## Open questions

- [ ] A separate cookieless asset origin (the durable fix for the whole class).
- [ ] Revocable or rotatable serve links, rewriting usage-graph consumers.
- [ ] A cross-instance atomic quota (today's residual is one upload per instance).
- [ ] `MEDWF-5`: give `feature.media.nodes.select` a gallery chain, or declare it agent-only.
- [ ] `MEDWF-6`: authority for actor-less runs is a platform decision.
- [ ] `MEDUX-6`: the card's "used N×" counter and the usage graph can disagree (slides,
      podcasts, brand and CAD never record usage refs). One source of truth for "used".
- [ ] `MEDUX-8`: alt text on consuming surfaces (CMS, slides, public site).
- [ ] `MEDCD-6`: the workspace-total scan runs inside the per-workspace lock (one
      bounded tenant read per write).
- [ ] Prod sizing: no live workspace near 2 GiB of library bytes (read-only check requested
      from the orchestrator before merge).
