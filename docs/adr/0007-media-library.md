# ADR 0007 — Media Library

**Status:** Accepted (Phases 1–3 sequenced)
**Date:** 2026-06-09
**Depends on:** ADR 0004 (Organizations — the org an asset belongs to),
ADR 0006 (RBAC — read/write authority via accessControl scopes)
**Owner of media data:** a NEW feature-package `src/features/media/`
(`feature.ts` + `routes.ts` + `mediaService.ts` + `mediaStorage.ts`).
**Surface:** `/v1/host/sample/media/*` (host-extension, NON-NORMATIVE — no RFC;
bytes ride the existing RFC 0055 media-asset surface).

---

## Context (boundaries audit first)

An **org-scoped asset store**: organizations group assets into collections,
upload/organize/search them, and track where they're used. Pulled out of CMS
(ADR 0009) because it's the one hard upstream dependency CMS/Page Builder need,
and is reusable standalone. MyndHyve couples Media ⇄ Knowledge Base; that
co-dependency is **cut** — Media ships standalone, KB is out of scope.

What already exists (so Media does NOT duplicate it):

- **Orgs + members + roles** are `accessControl` (ADR 0004/0006). A collection
  belongs to an `Organization`; who may read/write is the RFC 0049 scope a
  member's role grants. Media must NOT invent its own org or permission model —
  it reuses `resolveEffectiveAccess(tenant, { subject, orgId })`.
- **Byte storage + capability serving** is the RFC 0055 media-asset surface
  (`storeMediaAsset` → token, served by `GET /v1/host/sample/assets/{token}`).
  Media stores asset **metadata** + a storage reference; the bytes ride that
  surface, served by an unguessable capability token (the same path avatars use).

So Media is a new surface (collections, searchable asset metadata, usage) layered
on orgs/RBAC/media-bytes rather than re-implementing any of them.

## Decision

A `media` feature-package (toggle `media`, default OFF, `bucketUnit: tenant`)
owns org-scoped **collections** and **assets**, tenant-scoped, RBAC-gated.

### Authority (consumes ADR 0006)

Every route is scoped to a path `:orgId` and gated by the caller's RFC 0049
scope **in that org** (`resolveEffectiveAccess(tenant, { subject, orgId })`):

- **Read** (list / search / get) ⇒ `workspace:read` (viewer +).
- **Write** (create collection, upload, rename / tag / move, delete, mark-used)
  ⇒ `workspace:write` (editor +).

A non-member resolves to ZERO scopes ⇒ fail-closed 403 (ADR 0006 Phase 2). The
org must exist in the caller's tenant or the route 404s (IDOR guard). Bytes are
served by capability token (discovery is the org-scoped gate; the token is the
byte gate) — the same model avatars use.

### The model

```
MediaCollection { collectionId, tenantId, orgId, name, createdBy, createdAt }
MediaAsset {
  assetId, tenantId, orgId, collectionId?,    // collection optional (uncategorized)
  name, contentType, sizeBytes,
  storageRef,                                  // opaque ref into mediaStorage
  serveToken,                                  // RFC 0055 capability token for <img>
  tags: string[],
  uploadedBy, createdAt, updatedAt,
  usageCount, lastUsedAt?                      // Phase 2 usage tracking
}
```

### Storage adapter (the roadmap's "one-file swap")

`mediaStorage.ts` is a thin adapter — `put(tenantId, { contentBase64,
contentType }) → { storageRef, serveToken, sizeBytes }` and `delete(storageRef)`.
The in-memory reference impl delegates byte storage to `storeMediaAsset` (RFC
0055) with a long retention horizon (the library is durable, not a 7-day scratch
asset). A production deployer swaps THIS ONE FILE for S3/GCS — the service +
routes are storage-agnostic. (Retention is the same open question profiles'
portfolio raised; centralizing it here is the fix.)

### Phase 1 — Collections + assets CRUD + org-scoped RBAC

`mediaService` + three `DurableCollection`s (collections, asset metadata, and the
storage-adapter blob store). Routes under `/v1/host/sample/media/orgs/:orgId`:
collections (create `[w]` / list `[r]` / delete `[w]`), assets (upload `[w]` /
list+filter `[r]` / get `[r]` / patch rename·tag·move `[w]` / delete `[w]`).
Deleting a collection re-homes its assets to uncategorized (never orphans bytes).
Deleting an asset frees its bytes. Route-harness tests.

### Phase 2 — Usage tracking + search

`POST …/assets/:assetId/use` (`[w]`) bumps `usageCount` + `lastUsedAt` — the
minimal "where is this used" signal a consumer (CMS, ADR 0009) increments when it
references an asset. List supports `?collectionId=`, `?q=` (name substring), and
`?tag=` filters. (Deep referenced-by graph is deferred until a consumer needs it.)

### Phase 3 — Frontend Media Library

`/media` (lazy route, nav-gated on the `media` toggle): an org picker, a
collections sidebar, an asset grid (thumbnails via the capability serve URL),
drag-free file upload, search/filter, and rename/tag/delete. Registered in
`FRONTEND_FEATURES`; the canonical `npm run build` gate must pass.

## Architectural constraints honored

- **Single source of truth / boundaries:** Media owns collections + asset
  metadata + usage only — orgs/roles stay in `accessControl`, bytes in the RFC
  0055 surface. No parallel org/permission/storage model.
- **Authority from RBAC, not from the feature (ADR 0006):** read/write is the
  caller's RFC 0049 scope in the org; a non-member gets zero scopes, fail-closed.
- **Tenant isolation (CTI-1):** every collection/asset read/write is tenant +
  org scoped; cross-tenant or cross-org access fails closed with `not_found`.
- **No wire surface → no RFC:** entirely under `/v1/host/sample/*`; bytes reuse
  the already-accepted RFC 0055 surface — nothing new on the protocol wire.
- **Storage swap is one file:** `mediaStorage.ts` is the only thing a real-backend
  deployer touches.

## Alternatives considered

1. **Store bytes inline in the asset record.** Rejected — `list()`/search would
   load every asset's bytes (a full-content scan per directory view). Metadata +
   a storage ref keeps listing cheap; bytes are fetched only when served.
2. **A new `media` capability + RFC for the serve surface.** Rejected — byte
   serving already exists (RFC 0055); the library is pure host-extension product
   surface with no cross-host/wire contract (the CLAUDE.md `/v1/host/sample/*`
   rule).
3. **Tenant-scoped (not org-scoped) library.** Rejected — MyndHyve media is
   org-scoped and the roadmap places Media after Orgs+RBAC precisely so
   collections are an org surface with role-gated access.
4. **Port the Media ⇄ Knowledge-Base co-dependency.** Rejected per the roadmap —
   Media ships standalone; KB/RAG is an explicit out-of-scope cut.

## Open questions

- [ ] **Real retention / quotas.** The in-memory adapter uses a long TTL; a real
  backend needs lifecycle + per-org storage quotas. Adapter-local — resolve when
  a production storage backend lands.
- [ ] **Usage authority.** `…/use` is `workspace:write` today; if an automated
  consumer (CMS render) marks usage, it may need a service principal rather than
  an editor session. Revisit when ADR 0009 wires the consumer.
- [ ] **Image optimization (srcset / WebP / AVIF).** Deferred; a transform step
  belongs behind the storage adapter when there's a renderer that needs it.
