# ADR 0614 — The OpenWOP wire lives at the origin root, not behind the SPA's `/api` prefix

Status: Accepted — implemented 2026-09-01.

Date: 2026-09-01

## Context

`app.openwop.dev` served the OpenWOP wire only under `/api`. Measured against the
deployed origin:

| path | result |
|---|---|
| `/.well-known/openwop` | **`200 text/html`** — the SPA catch-all |
| `/api/.well-known/openwop` | `200 application/json` |
| advertised `certificationBundleUrl` (`…/v1/host/…/certification-bundle`) | **`200 text/html`** |
| `/api/v1/host/…/certification-bundle` | `200 application/json` |

Two normative requirements were being violated, not two preferences:

- `spec/v1/capabilities.md:30` — *"The response **MUST** be JSON with
  `Content-Type: application/json`."*
- `spec/v1/capabilities.md:32` — *"A server MAY expose this at additional paths
  for backward compatibility but **MUST treat `/.well-known/openwop` as
  canonical**."*

We had the spec inverted: the *additional* path worked and the *canonical* one
returned a web page. An external client discovering this host at its RFC 8615
location failed at step one.

**Root cause.** `firebase.json` rewrote only `/api/**`, `/`, `/p/**` and
`/llms.txt` to Cloud Run; everything else fell to `/app-shell.html`. The backend
builds its pointer as `{requestOrigin}{CERTIFICATION_BUNDLE_PATH}`
(`host/conformanceClaims.ts:147`) and has no knowledge of the `/api` mount
prefix — so it published root-relative URLs for a service mounted under a prefix.

## Why this survived eleven deploys

**Every verification path we own is origin-relative, so a prefix-mounted
deployment is invisible to all of them.**

- the conformance suite fetches `driver.get('/.well-known/openwop')` relative to
  `OPENWOP_BASE_URL` (`conformance/src/lib/discovery-capabilities.ts:46`)
- `check-wire-claims.mjs` strips the advertised host and re-dials
  `${base}${path}`

Point either at `…/api` and both pass while the published URLs resolve to HTML.
This is not a gap anyone forgot to close; it is a blind spot the whole stack
shares by construction, and it is the reason the defect needs a ROUTING fix plus
a check that dials the URL **as published**.

## The observation was not new — the conclusion was

`scripts/verify-deploy.sh:128-132` has carried this since **2026-08-15**:

> *"`$BASE/api` — NOT `$BASE`. On Firebase Hosting the bare path hits the SPA
> `**` rewrite and answers `200 text/html`, so a check pointed there would
> compare against an app shell … the right URL is cheaper than the right error.
> (Both spellings measured 2026-08-15.)"*

Someone measured exactly this, wrote it down accurately, and drew the wrong
conclusion from it — that it tells you **where to point a checker**. It also says
the canonical discovery path violates two MUSTs, and that every consumer without
our `/api` knowledge is broken.

That is the failure mode worth recording: **a true, measured, well-documented fact
whose implication was never drawn.** Re-measuring would not have caught it — the
measurement was already right and still is. Only re-reading the *inference* does.
It is the same shape as the RFC 0147 §A.1 row retired in `docs/steward/TODO.md`,
where the cited evidence stayed true while the conclusion it supported went stale.

The note stays in `verify-deploy.sh`, now pointing here.

## Decision

**Serve the wire at the origin root.** `firebase.json` now rewrites
`/.well-known/**` and `/v1/**` to Cloud Run.

**Rejected: teaching the backend its mount prefix** (advertise `{origin}/api{path}`).

1. **It cannot satisfy the canonical-discovery MUST at all.** No advert change
   makes `/.well-known/openwop` return JSON; only routing does. The advert fix
   addresses one symptom and leaves the normative violation standing.
2. **It bakes one deployment's rewrite table into published wire URLs.** A
   self-hosted openwop-app serving Cloud Run at the root would need the opposite
   value. The advert should describe the protocol, not the CDN in front of it.

Rejected "both" for the same reason: (A) is not redundant-but-harmless, it is
debt with no benefit once (B) lands.

**Security delta: none — measured, not assumed.** Every `/v1/*` route is already
publicly reachable at `/api/v1/*`; this adds a second door to the same rooms with
the same locks, because gating lives in the Express app, not the path.
`/api/v1/runs` → `200 JSON` (already public) and `/api/v1/test` → **`404 JSON`**
(the seam is off by `OPENWOP_TEST_SEAM_ENABLED`, `index.ts:225`, independent of
path). No SPA route claims `/v1` or `/.well-known`, and there is no
`public/.well-known` to shadow.

**No RFC required.** The MUST already exists; the host was violating it. Fixing a
host to honour existing normative text is host work.

## Also changed: the check that could not see this

`check-wire-claims.mjs` justified its origin-relative dial with *"the advertised
host may legitimately differ (custom domain, rewrite prefix)"* — treating those
as one benign category. They are not:

- a different **host** is a deployment detail the origin-relative dial correctly
  ignores;
- a different **path prefix** makes the advertised URL unfollowable by the only
  party it exists for.

The origin-relative dial stays as the primary assertion. Added alongside it: when
the advertised host **equals** the origin under test, the absolute URL MUST
resolve to JSON. A different host SKIPS with a stated reason rather than passing
silently.

## Falsifiability

If a `/v1/**` rewrite were found to shadow a hosting-served static asset, the rule
would need narrowing to explicit subpaths. Checked at authoring time: no SPA route
and no `public/` file claims either prefix.

The fix is only real once **deployed** — `firebase.json` is hosting config, so a
green gate proves nothing about production here. The acceptance evidence is
`/.well-known/openwop` returning `application/json` on the live origin.

## Correction note — the first attempt made `firebase.json` schema-invalid

The rules originally shipped with a `"_comment"` key on each rewrite, carrying the
rationale above. That was wrong in a way worth recording, because the instinct
behind it was right and the execution inverted it.

**Every branch of firebase-tools' own `HostingRewrites` schema is
`additionalProperties: false`** (`schema/firebase-config.json`; branch 8 is exactly
`{run, source}`). An extra key matches no branch, so the file was invalid. Measured
against the CLI's real validator: `VALID: false` at `/hosting/rewrites/1` — the new
rule itself.

**And it would have deployed anyway.** `lib/config.js:227` runs that validator and
passes each error to `logger.debug`. Nothing surfaces at default verbosity, nothing
fails. So the state was: the file whose correctness the deploy depends on was
invalid per its own published schema, and every signal available said fine.

That is the same shape as the defect this ADR fixes — a check that cannot fail is
indistinguishable from a check that passes — reproduced while fixing it, one file
over.

Two further traps found on the way out, both of which would have looked like fixes:

- **`//` comments are not the answer.** The CLI loads this file with `cjson`
  (`loadCJSON.js`), so comments parse for *it*. But
  `frontend/react/scripts/check-csp-runtime.mjs:29` does a bare `JSON.parse` of
  the same file. The obvious repair for the unknown key breaks a sibling gate.
- **A comment could never have been the record anyway.** It has no gate. The
  rationale now lives in `scripts/check-hosting-wire-rewrites.cjs`, which asserts
  what the comment could only assert *about*: that both rules exist, target Cloud
  Run, and precede the SPA catch-all — plus the two traps above, so the next
  author meets a failing check instead of rediscovering this.

Ordering is the one worth naming: Firebase Hosting takes the **first** matching
rewrite, so moving the catch-all up restores the original bug with every rule
still present and reading correctly. Prose cannot catch that. All four assertions
are sabotage-verified (each made to fail, then restored).
