# ADR 0511 — Host brand assets ride Media via copy-on-select

Status: Accepted
Date: 2026-08-02

## Context

ADR 0510 §6 closed the mode-aware half of DSA-016 (per-mode mark fields, the
`BrandLogo` primitive, default-logo parity) but deliberately deferred the asset
PIPELINE: custom brand assets are still pasted URLs or small `data:` URIs. The
deferral reason is the decision this ADR makes: the app brand is **host-global**
(one reserved record, superadmin-written, served to *anonymous* visitors via
`/public-brand`), while Media — the app's one asset owner (ADR 0007) — is
**tenant/org-scoped** (CTI-1: every read/write verifies `tenantId` + `orgId`).
Bridging the two carelessly would let the public, unauthenticated brand response
expose tenant-owned bytes whose lifecycle (deletion, retention, re-upload) the
brand does not control.

Relevant mechanics discovered in the audit:

- Media serves bytes via **RFC 0055 capability tokens**
  (`mediaStorage.serveUrl` → `/v1/host/openwop-app/assets/<token>`): a serve URL
  is already a bearer capability — renderable by anyone who holds it. "Public
  exposure" is therefore not a route-authz question but a **lifecycle and
  consent** question: which bytes does the host deliberately publish, and who
  owns their lifetime?
- The backend has **no SVG sanitizer or raster decoder dependency** (no
  dompurify/jsdom/sharp/svgo). Regex-based SVG "sanitizing" is a known
  anti-pattern and will not be attempted.
- `safeBrandAsset` (ADR 0170) already accepts `https:`/relative URLs and small
  (≤8KB) `data:image/*` URIs with scheme validation — the compatibility surface
  that must keep working.

## Decision

### 1. Copy-on-select into a reserved host scope

Publishing a brand asset **copies the bytes** into a reserved host-owned media
scope (`tenantId = 'host:brand'`, outside every real tenant) and stores the
copy's serve URL on the brand record. The source asset — whether freshly
uploaded or picked from the superadmin's own library — is left untouched and
unreferenced.

Why copy, not reference:
- **Lifecycle severance.** A tenant deleting the source asset, a retention
  purge, or an org teardown can never dangle the public logo.
- **No cross-tenant reach.** The copy endpoint resolves the source within the
  CALLER's own tenant/org scope, so a superadmin can only publish bytes they
  can already read; the host scope never references foreign tenant rows.
- **Deliberate publication.** The copy is the consent act: what is public is
  exactly what was copied, nothing more, frozen at copy time.

### 2. One superadmin endpoint, validation at the boundary

`POST /v1/host/openwop-app/app-brand/assets` (host-extension route — no wire
impact), gated by the same superadmin check as the app-brand PUT. Accepts
`{ contentBase64, contentType, slot }`
(`slot ∈ mark | markDark | lockup | lockupDark | favicon`) — bytes only in v1;
an `{ assetId }` copy-from-library lane joins the follow-up with the picker
seam (§4 boundary correction). Returns `{ url }`; the
Appearance panel then writes that URL through the existing brand PUT +
`safeBrandAsset` path.

Validation, fail-closed, at copy time:
- **Magic-byte MIME verification** for the raster allowlist — PNG, JPEG, WebP,
  GIF, ICO — the declared `contentType` must match the sniffed bytes.
- **Byte cap** (512 KB) — brand chrome, not a gallery.
- **SVG is REJECTED on this path in v1.** With no sanitizer dependency, an
  accepted SVG would be an XSS vector on an anonymous endpoint. The two
  existing trusted SVG paths remain: the built-in inline default mark, and the
  pre-existing `safeBrandAsset` `data:image/svg+xml` URI acceptance (≤8KB,
  scheme-validated — an ADR 0170 decision this ADR does not relitigate).
  Adopting a real sanitizer (DOMPurify-over-jsdom or rasterization) is the
  named follow-up that would lift the rejection.

### 3. Host-scope lifetime

Copies are stored durable (the same durability class Media uses) under
`host:brand`. The reserved scope is excluded from tenant-facing enumeration and
from tenant retention/erasure flows (it belongs to no subject). Replacing a
slot's asset deletes the previous copy for that slot (bounded growth: at most
one live copy per slot, prior copy freed on successful replacement).

### 4. Frontend: upload-first, URL as escape hatch

The Appearance logo section becomes upload-first: each slot gains a file-upload
control that posts through the new endpoint and writes the returned URL into
the existing field. The URL fields remain as the documented white-label escape
hatch (unchanged `safeBrandAsset` validation, ADR 0510 §6 compatibility
window).

*Boundary correction (found at implementation):* the original sketch said
"reuse `MediaPickerDialog`" — but the Appearance panel lives in core
(`src/brand/`) and the picker is feature UI (`features/media/`); core must not
import upward into a feature. v1 is therefore direct upload (the common case
for five logo slots); pick-from-library joins the sanitizer follow-up, behind
a proper seam if it proves wanted.

## Alternatives rejected

1. **Reference the tenant asset directly** — leaves the public logo's lifetime
   in a tenant's hands; couples the anonymous surface to tenant retention;
   invites "publish someone else's asset" mistakes. Rejected on lifecycle and
   consent grounds.
2. **A shared host media org browsable like a library** — a second media UX and
   a standing cross-tenant surface for a need that is five slots big. The
   reserved scope stays an implementation detail, not a product surface.
3. **Accept SVG with a hand-rolled sanitizer** — regex/allowlist sanitizers
   have a long CVE history; an anonymous endpoint is the worst place to learn
   that again. Rejected until a real sanitizer dependency is justified.
4. **Store bytes on the brand record as `data:` URIs** — already capped at 8KB
   for good reason (the record rides `/public-brand` on every anonymous load);
   raster logos don't fit and shouldn't.

## RFC verdict

No OpenWOP RFC. Host-extension route + host-extension data only; the wire,
capability advertisements, run events, and replay behavior are untouched.

## Implementation record

| Phase | Status | Evidence |
|---|---|---|
| 1 — backend endpoint + host scope + validation + tests | implemented | this PR |
| 2 — Appearance upload-first UI | implemented | this PR |
| 3 — SVG sanitizer adoption (lifts the v1 rejection) | open | tracked follow-up |
