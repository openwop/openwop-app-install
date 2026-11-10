# ADR 1046 — CMS site components and code injection

Status: Accepted (David, 2026-11-03: "go, take it to the architect and write the ADR").
No phase built yet.

## Context

David asked for custom HTML, CSS and JS on CMS pages, first as code tabs on a
section. The first answer, sandboxed iframes, was rejected. Today:

- **Sections are a closed vocabulary.** `features/cms/cmsService.ts` `SECTION_TYPES`
  is validated per type, and ADR 0748 keeps section bodies closed. The one open body
  is `fields` (RFC 0206). ADR 0009, 0920 and 1029 each rejected stored markup.
- **Customer sites are static prerenders.** On a bound custom domain the semantic
  prerender (`features/publishing/sectionHtml.ts`) is served with the designed
  stylesheet (ADR 1030) and one first-party site runtime script (ADR 1015). Every
  prerender carries one global policy, `PRERENDER_CSP`
  (`features/publishing/siteRuntime.ts:36`).
- **Pack code has one trust authority.** `host/packTrust.ts` decides whether a pack's
  code may run. ADR 0300's signature covers `pack.json`, not the files.
- **ADR 0347 §5d** said pack-contributed components render only through the sandboxed
  UI-plugin seam (RFC 0117).

### What other builders do (research, 2026-11-03)

None of them use iframes, and none use one paste box. Each ships two separate things:

1. **Registered components.**
   - Webflow code components: React in Shadow DOM, server-rendered then hydrated,
     typed props, a CLI import.
   - Builder.io and Plasmic: `registerComponent` with typed inputs.
   - HubSpot modules: `module.html`, `module.css`, `module.js` and fields; the assets
     load once per page.
   - Shopify app blocks and Wix custom elements.

   In every case developers write the code and editors fill a form generated from a
   schema. Components are versioned and installed. Site design tokens reach inside.
2. **Admin code injection.** Webflow, Squarespace, Ghost and WordPress
   (`unfiltered_html`) offer site head and body slots and an embed block. Only admins
   can edit them, often only on paid plans. The code runs on the published site and
   never in the editor.

## Decision

### D1 — A host-private `site-component` pack kind

A `site-component` pack carries:
- one or more custom elements;
- for each element, its CSS, a typed prop schema, a server template, and an optional
  `sensitive` flag;
- a per-file SRI digest for every asset (alongside `packs/packContentDigest.ts`).

It loads through a new `host/siteComponentPackLoader.ts`, a sibling of
`formContentPackLoader.ts`, with the same caps, first-root-wins de-duplication and
tombstone handling.

The loader asks `classifyPackDir()` (`host/packTrust.ts`). Only `steward` and
`operator-trusted` packs are served, and there is no second trust decision. An
`untrusted` or `revoked` pack renders the D6 fallback.

**Naming.** Pack elements are named `x-<pack>-<name>-<major>`. The `owp-` prefix is
reserved for the host. The major is part of the tag because a document has one
custom-element registry, so two versions of one tag cannot coexist.

### D2 — A `component` section with flat props

The section data is `{ ref, major, ...props }`, flat like `fields`, never a nested
`props` object. Two existing rules force this:
- RFC 0103 overlays merge per top-level key, so a nested object would let a one-prop
  translation replace every prop.
- `sourceDigestOf` digests top-level keys, so a nested object would mark every
  translation outdated on any prop edit.

**Overlay rules.** Only props the schema marks `translatable` (text, rich text) may
appear in a locale overlay. `ref`, `major`, URL, enum, number and colour props are
base-layer only, the `motion` rule.

**Validation.** `buildSectionData` validates props against the manifest schema in a
closed world: unknown props are dropped, and a wrong type is refused.

**Version pinning.** The workspace pins the exact version (the enablement row); the
section carries only the major.

**Upgrades.** An upgrade is a workspace action. It validates every referencing
section against the new schema and keeps the old pin if any section fails.

### D3 — A logic-less server template

The template language is a Mustache subset, parsed to an AST at pack load. There is no
eval and no server-side JavaScript.

- **Interpolation:** double-brace and escaped only, with no raw or triple-brace form.
- **Where props may go:** text nodes and allowlisted attributes.
- **URLs:** `href` and `src` take only `url`-typed props, through the existing
  `safeUrl` validator. Images are media tokens.
- **Forbidden places:** no prop inside `<script>`, `<style>`, `on*` or `style`.
  Colours and lengths reach CSS as typed custom properties on the host element.
- **Output:** a Declarative Shadow DOM wrapper holding the component CSS. The prop
  text is slotted in the light DOM, so crawlers and no-JS readers get the real words.

### D4 — Component JS runs only on bound custom domains

Assets are served as immutable, SRI-tagged modules from the pack directory, through
the ADR 1015 door at `/_c/<pack>@<version>/<file>`. There is no per-site bundler,
because a server build step is a supply-chain surface.

Components don't depend on the visitor-runtime toggle, the same independence ADR 1030
D4 gives the stylesheet.

Components are first-party presentation:
- they set no cookies;
- they call only their own origin (`connect-src 'self'`), unless the manifest
  declares an origin and review accepts it;
- so they are not consent-gated.

### D5 — The platform origin never runs component JS

`PublicPreviewFrame` is a same-origin, unsandboxed portal. A
`customElements.define` bundle there would run with the app's authority, which ADR
1015 rejected and RFC 0117 §2 forbids.

So the SPA, the CMS preview and app.openwop.dev public pages render the D3 static
output only: Declarative Shadow DOM plus the component CSS, with no pack JS. Live
behaviour is previewed on the bound domain through a draft-preview URL.

### D6 — The page is never blank

A section renders the fallback in any of these cases:
- the pack is missing, uninstalled, tombstoned or revoked;
- the props fail the schema;
- the template fails to render.

The fallback is the props as escaped semantic text, the way `fields` renders
(`sectionHtml.ts`).

Uninstalling a pack warns "used by N pages" but blocks nothing.

### D7 — Admin code injection, custom domains only

**Where it lives.** Site-wide head and body snippets, plus an `embed` section that
holds a reference to a stored snippet, never markup inline. They are kept in a
custom-domains store keyed `<tenantId>:<orgId>`, like `host/siteBrand.ts`, with
version history.

**Who can edit.** Scope `host:members:manage` with fresh re-authentication, behind:
- the toggle `custom-domains.code-injection` (default off);
- a plan gate.

**Record-keeping.**
- Every change goes in the audit log.
- `updatedBy` is registered for ADR 0464 subject erasure.

**Where it is emitted.** Only on bound custom domains, and never in the editor, the
preview or on the platform origin, which show a placeholder instead.

**Where it is refused:**
- **Checkout and order documents.** PCI DSS 4.0 §6.4.3 and §11.6.1 require a script
  inventory there.
- **Platform-settled storefront tenants** (ADR 0877), refused outright, because the
  platform is the merchant.
- **Platform-sibling hosts:** any host whose registrable domain (eTLD+1) equals the
  platform origin's or a CORS origin's. `isPlatformHost` checks suffixes only, so a
  sibling such as `x.openwop.dev` would otherwise be same-site with the app.

**Bots.** Bots get the same document. Serving them anything else is cloaking.

### D8 — A security policy built per site

When a site has injection, its prerender policy is built in the same read as the
snippets, so the header and the body cannot drift apart:
- `script-src 'self'` plus the `sha256-` hash of each inline snippet and the
  allowlisted script origins;
- `connect-src`, `img-src` and `frame-src` allowlists;
- `form-action` additions.

**Hashes, not nonces.** Untagged prerenders are publicly cached for an hour, so a
nonce would be replayed.

**`'strict-dynamic'`** is a per-site opt-in with a warning, because it voids the
origin allowlist.

Sites without injection keep `PRERENDER_CSP` unchanged.

### D9 — Consent categories gate snippets

Each snippet declares a category: `necessary`, `analytics` or `marketing`.

- **Necessary snippets** run as written.
- **Analytics and marketing snippets** ship inert (`type="text/plain"
  data-owp-consent="<category>"`). The site runtime activates them only after the
  server-recorded consent allows that category, the Cookiebot, OneTrust and Webflow
  pattern.

Injected code shares the page with the consent core and can call it directly. The
editor states that this is the site owner's responsibility, and the audit log records
who added each snippet.

### D10 — The session-replay fence must see inside components

`replayCapture.ts` `pageMayBeRecorded` uses `querySelector`, which does not look
inside shadow roots. So a component holding a password, card or one-time-code input
would make the page recordable.

The fix:
- components use open shadow roots;
- a manifest `sensitive: true` makes the server stamp `data-owx-sensitivity` on the
  host element;
- the check looks inside open shadow roots and re-runs on every resnapshot.

Replay is off on sites with injection unless an admin attests the snippets add no
sensitive fields.

### D11 — Tenant-authored components get the injection trust class

When P5 lets a workspace upload its own components, they never get `steward` trust.
They are served on bound domains only, behind the D7 gates, and follow D2's flat-prop
rules.

### D12 — Who installs components

A superadmin installs packs (pack state is process-wide, as in
`features/marketplace/routes.ts`), and each workspace enables the components it uses.
Tenant admins cannot install packs.

### D13 — AI authoring rides the catalog

CMS agents author component sections through:
- a `getCatalog` op generated from the manifests, pinned by a `promptCatalogParity`
  test;
- a closed-world `validate` op.

This is the AI-exchange non-negotiable in CLAUDE.md.

## Alternatives weighed

- **Code tabs on every section, run inline everywhere.** Rejected. On app.openwop.dev
  that is stored XSS against the app's origin. Elsewhere it escapes localization, the
  crawler renderer and dark mode, which is why ADR 0009, 0920 and 1029 rejected stored
  markup.
- **Sandboxed iframes per section (RFC 0117 plugins).** Rejected by David. It also
  means no SEO, no design tokens, and one frame per section.
- **A per-site bundle built on the server.** Rejected: a supply-chain surface and a
  build service to run. Packs ship pre-built, SRI-pinned modules instead.
- **React components hydrated as in Webflow.** Deferred. Custom elements need no
  framework on customer pages, and a pack may bundle its own framework inside its
  element.

## Wire

No RFC for P1–P5:
- The pack kind is host-private. Hosts that don't recognise it filter it out, as the
  canvas-content kind does (ADR 0347).
- Section bodies already ride an open `sectionType` and an open `data` object on the
  wire (`schemas/v2/localized-content-page-response.schema.json`).
- Injection is a host-extension route under `/v1/host/openwop-app/*`.

Publishing `site-component` packs to the public registry (packs.openwop.dev) needs an
RFC, because RFC 0107's `registry-version-manifest` lists the declarative kinds as a
closed set. That is P6, the same path form-content packs took to RFC 0137.

## Corrections to earlier ADRs (P0)

- **ADR 0009, 0920 and 1029** (no stored markup): typed component props are not
  markup. Injected markup lives only in the custom-domain store and never reaches the
  platform origin.
- **ADR 0347 §5d:** public-site components on a customer's own origin are not RFC
  0117 plugins.
- **ADR 1015:** the prerender policy becomes per site, and fence 4 must look inside
  shadow roots (D8, D10).
- **ADR 1030:** the token contract becomes a pack-facing, versioned API (P3).

## Phases

| Phase | Scope | Gate | Status |
|---|---|---|---|
| P0 | This ADR and the correction notes | Review | done |
| P1 | Loader with `packTrust` and SRI; the `component` section, validator, flat props and overlay rules; the template engine; the fallback in every renderer (cmsService, sectionHtml, sectionMarkdown, the sharing export, SectionRenderer, the editor, the preview, four locales), held by a ratchet test; the editor form from the schema; static Declarative Shadow DOM preview with no JS; the D13 catalog and validate ops | Escaping and URL fuzz tests, render parity, overlay and digest tests | planned |
| P2 | The `/_c/` asset door, module tags on bound hosts, SRI, the D10 replay-fence fix | Behaviour tests on a bound host, including that no component JS reaches the platform origin | planned |
| P3 | The versioned token contract, a steward reference component, the workspace upgrade flow | Chromium render in light and dark | planned |
| P4 | Injection store, routes and UI; per-site policy; consent activation; audit and erasure; the refusals | Security review | planned |
| P5 | Tenant-authored private components (D11) | Security review | planned |
| P6 | RFC to publish `site-component` to the registry | RFC lock | optional |

## Open questions (recommended answers recorded)

1. **May tenant admins install packs?** No. A superadmin installs and the workspace
   enables (D12).
2. **Do snippets reach bots?** Yes, the same document (D7).
3. **Does replay record injection sites?** Off by default, with an attested opt-in
   (D10).
4. **Is component JS consent-gated?** No. Components are first-party and same-origin
   only (D4).
5. **May a section pin an exact version?** No. Sections pin the major; the workspace
   pins the exact version (D2).
6. **Do funnel pages on app.openwop.dev need custom code?** **Decided
   (recommendation, 2026-11-04): no.** Code on the platform origin runs with the
   app's authority (D5, D7). Funnels already publish on a bound custom domain (ADR
   0295), where D7's injection applies, and D7 refuses checkout documents anyway.
   A shared sites domain (`*.openwop.site`, on the Public Suffix List the way
   github.io is) is real work: wildcard certificates, a PSL submission and a
   second serving origin. It gets its own ADR if customers without a domain ask
   for scripts.
