# ADR 0652 — RFC 0181: `/host/openwop-app/…` is this host's vendor path namespace

Status: Accepted (implemented in this PR; RFC 0181 `Active → Accepted` criterion)

## Context

The 2026-09-10 v2-readiness measurement (crosstalk `8f27` §7c) found that
every `/host/openwop-app/…` request from a JSON client was already answered —
by accident. `/host` is a manifest-derived v2 prefix (from the protocol
operations `/host/effect-seams` and `/host/events`), so ADR 0646's
content-negotiation rewrote the whole 1,086-path proprietary surface onto its
`/v1/host/…` twin, stamped `OpenWOP-Version` on a non-protocol response, and
served the SPA shell to a browser `Accept`. Measured live on production:
`GET /host/openwop-app/orgs` → 200 with and without the header;
`Accept: text/html` → the shell. Nobody had decided any of it.

The corpus steward ruled (`d4d0`) and then filed **RFC 0181** (`0c9c`, corpus
`13126d01e`, suite **2.0.12**): a host-proprietary path space lives at
`/host/<org>/…` where `<org>` is registered in `spec/v2/declaration.json`
`extensions` (`openwop-app`, registered 2026-09-11). No major in the path. It
is served under whatever `OpenWOP-Version` or none — **the header selects
nothing there**, because nothing there is a protocol operation (§1.2 binds
manifest-named operations only). `/v1/host/<org>/…` MAY stay as the twin
through the overlap and retires atomically with `/v1` (`versioning.md` §5).
§1.4 is scoped to manifest-named paths; a vendor path's representation is
unconstrained. `reservedOrgs` gains the manifest's `/host/` segments so no org
can collide with a protocol operation. Rejected alternatives, per the ruling:
(a) `/v2/host/<vendor>/*` — RFC 0172 removed majors from the path; (b) staying
on `/v1/host/*` exempt — an exemption means `1.x` never leaves
`protocolVersions[]`, which is not retiring.

## Decision

1. **Explicit mount, not a derived accident.** `middleware/protocolVersion.ts`
   exports `VENDOR_ORG` (the same constant that already namespaces vendor error
   codes), `VENDOR_ROOT = /host/<org>` and `isVendorPath()`. The negotiator
   short-circuits a vendor path BEFORE the shared-name logic: major 1, no
   `OpenWOP-Version` response header, no `Vary`, no v2 response hygiene, no
   negotiation refusals (a malformed or unsupported header is ignored — it
   selects nothing), rewrite onto the `/v1` twin, host dialect. A boot-time
   guard refuses a manifest that ever uses `/host/<org>` as a protocol segment
   (RFC 0181's reserved-segment rule, enforced against the vendored manifest).
2. **Declared, not inferred.** The v2 discovery `extensions['openwop-app.host']`
   record carries `root: "/host/openwop-app/"`, `twin: "/v1/host/openwop-app/"`,
   `rfc: "0181"`. The record's shape is the org's own (`capabilities.md` §3.2),
   so this needs no schema change; the suite never measures under a vendor
   root and nothing there counts as reaching an operation.
3. **The twin stays** (`/v1/host/openwop-app/…` keeps every registration) and
   the SPA keeps calling it through the overlap. Moving the SPA's call sites
   (1,100 sites, 145 features, 471 route prefixes — `ff83` §4) to the canonical
   root is its own unit; the December flip inverts the rewrite direction.
4. **Not vendor paths** (steward's list, `d4d0`): `GET /runs` (list),
   `DELETE /runs/{id}`, the events token, `debug-bundle`, the v1 capabilities
   document. They are v1 protocol operations with no v2 twin; they stay `/v1`
   until RFC'd into the manifest or accepted as gone.

## Consequences

- Vendor responses are the host's own contract: bare run ids, v1 event
  vocabulary, no version header. A v2 client reading a vendor path must not
  expect the protocol's id grammar there.
- `spa root` in `verify-deploy.sh` probes manifest paths, not vendor paths;
  the vendor root is checked by the route test below, not by the deploy probe.
- The `/host` derived prefix remains for the two protocol operations under it;
  the vendor branch is scoped to the org root, never to `/host` as a whole.

## Implementation record

| what | where |
|---|---|
| `VENDOR_ORG` exported, `VENDOR_ROOT`, `isVendorPath`, reserved-segment boot guard, vendor branch in the negotiator | `backend/typescript/src/middleware/protocolVersion.ts` |
| `root` / `twin` / `rfc` on the extension record | `backend/typescript/src/routes/discovery.ts` |
| route test: browser Accept → JSON not shell; five header variants → 200, no `openwop-version`, body equals the twin; manifest `/host/*` still protocol; declaration + reserved segments; discovery declares the mount | `backend/typescript/test/adr0652-vendor-path-namespace.test.ts` |

Sabotage-verified: disabling the vendor branch reddens exactly the two
behavioural legs (shell served; version header stamped). ADR 0646's eight legs
and the effect-seam tests are unchanged.
