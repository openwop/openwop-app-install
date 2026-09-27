# ADR 0649 — the major-1 path prefix has one owner

Status: Accepted (implemented; see § Implementation record)

## Context

ADR 0642 established that v1 retirement is **atomic** (`versioning.md` §1.1:
`preferredVersion` MUST name a 1.x member while `protocolVersions[]` carries
one) and dated (v1 EOS 2026-12-04). ADR 0647's measurement then found the
shape of the December change: **v2 is a rewrite façade over the v1 handlers**
(`protocolVersion.ts`: `req.url = \`/v1${req.url}\``), and **346 of 347 route
registrations hard-code `/v1` individually**, across 66 files. Retiring the
protocol's major-1 path space was therefore not a deletion but a re-rooting —
46 protocol registrations in 14 files, plus the public-path allowlist — to be
done under a deadline.

Of the 346, only the 46 protocol registrations are the retirement's business.
The other 300 are `/v1/host/openwop-app/*` host extensions (269) and
conformance seams (26+), whose home under major 2 is an open corpus question
(*undecided, not permissive*) — they must NOT move when the protocol does.

## Decision

1. **One constant, one helper, in the module that already owns the prefix.**
   `middleware/protocolVersion.ts` — home of `isV1Path` and the v2 rewrite —
   exports `V1_PATH_PREFIX = '/v1'` and `v1(path)`. `isV1Path` derives from
   the constant. Every protocol route registers as `app.get(v1('/runs'), …)`;
   the four protocol entries in the public-path allowlist read `v1(...)`.
2. **Host-extension and seam routes keep their literals on purpose.** A shared
   prefix would flip them with the protocol by accident. The exemption is
   spelled in the ratchet.
3. **A ratchet keeps it single-owner.** `test/v1-path-prefix-single-owner.test.ts`
   walks `src/routes`, `src/middleware`, `src/features` and fails — naming the
   file and line — on any `app.<verb>('/v1/…')` outside the exemption.
4. **No behaviour changes.** `v1('/x')` is `/v1/x`; the wire, every test that
   asserts a `/v1/` URL, and the v1 OpenAPI document (which lists `/v1/…` paths
   as *content*, not registrations) are untouched.

December's work becomes: flip the constant + invert the rewrite (the
unversioned key becomes native, `/v1` the alias for whatever survives), with
the 300 non-protocol routes explicitly out of scope by construction.

## Alternatives

- **Mount a `/v1` router once** (`app.use('/v1', router)`). Rejected: Express
  sub-routers change `req.baseUrl`/`req.path` for every downstream gate that
  reads them (the negotiator, the CSRF origin guard, the public-path allowlist),
  and the change would not be behaviour-neutral. A helper leaves the mounted
  paths byte-identical.
- **Do it in December.** Rejected: that is exactly the deadline archaeology
  ADR 0642 was written to avoid, and a codemod is safest when nothing else is
  moving.
- **Include host-extension routes in the constant.** Rejected — see Decision 2.

## Implementation record

| what | where |
|---|---|
| `V1_PATH_PREFIX`, `v1()`, derived `isV1Path` | `backend/typescript/src/middleware/protocolVersion.ts` |
| 46 registrations in 14 route files | `backend/typescript/src/routes/*.ts` |
| 4 allowlist entries | `backend/typescript/src/middleware/auth.ts` |
| ratchet | `backend/typescript/test/v1-path-prefix-single-owner.test.ts` |

Applied by a scripted codemod and then **diff-passed by hand**: 16 files,
+85/−62, every changed line is an `app.<verb>(v1(...)` registration, an added
import, or an allowlist entry — nothing else moved. One merged import
(`discovery.ts`) came out malformed and `tsc` caught it. The ratchet is
sabotage-verified: a reintroduced `app.get('/v1/probe', …)` reddens it with
`workflows.ts:<line> /v1/probe`.

## Correction 2026-09-12 — the collision guard was hand-listed, and had drifted

This ADR gave the negotiator one more job than the prefix itself: refuse, at
boot, to mount a v2 path space over a root this host already serves
unversioned, because the rewrite would shadow that route silently. The guard
shipped reading a constant, `HOST_OWN_UNVERSIONED_MOUNTS`, and a constant is
right — the derivation runs at module import, before any route has registered,
so it cannot ask Express what is mounted.

What was wrong is that the constant was **maintained by memory**. Measured on
`origin/main` it named four roots. The host occupies **eleven**, and the gap
came in two layers.

The first layer was ordinary rot: `/p` (`features/publishing/routes.ts`) and
`/llms.txt` (`features/docs/routes.ts`) are plain registrations added after the
guard was written, and nobody added them to it.

The second layer is the one worth recording. **"Registered" is only one of the
three ways this host takes a name**, and the other two answer no grep for
`app.get('/…')` at all:

| mechanism | roots it holds | where |
| --- | --- | --- |
| path-literal registration | `/health` `/llms.txt` `/p` `/readiness` `/schemas` `/scim` | route modules |
| anchored-regex **rewrite** | `/conformance` `/blog` `/pod` | `routes/conformanceSeams.ts`, `middleware/customDomain.ts` |
| exact-string **comparison** | `/api` `/pricing` | `index.ts`, `middleware/customDomain.ts` |

A rewrite holds a name exactly as firmly as a registration does. `/conformance`
is the sharpest case: `conformanceSeams.ts` aliases the whole RFC 0168 §C.2 v2
seam space onto its v1 address, and `/api` is sharper still — `index.ts` strips
that prefix **before the negotiator runs**, so a colliding manifest operation
would be swallowed before the guard could ever see it.

None of the eleven collides with today's manifest (15 top-level segments), so
nothing was broken. But a guard covering four of eleven is not a guard, it is a
coincidence, and its failure mode is the exact silent shadowing it exists to
prevent.

Found by applying a finding `myndhyve-1` raised on the bus: a retirement or
collision check keyed on `/v1` is looking at the wrong set entirely, because
what is at risk is precisely what is served **without** a version. Their host
implemented the intersection check; this one had it, and had let the operand
rot.

The fix keeps the constant — the derivation runs at module import, before a
route or middleware has registered, so it cannot interrogate Express — and pins
its completeness in `test/unversioned-mount-guard-complete.test.ts`, which
scans all three mechanisms and reddens when the constant disagrees.

**What that test does not claim.** It pins the constant against three known
mechanisms. A fourth way of taking a name would escape it, and no scan of this
kind can promise otherwise. Saying so in the test is the point: the previous
version of this check was trusted well past what it actually measured.

Each mechanism carries its own floor, because a sub-scan that goes inert
returns an empty set whose roots the other two scans still cover — the union
assertion would stay green while a third of the check had gone dark.
Empty-and-green is how a check goes inert without ever saying so.

Five sabotages, each reddening only what it should: dropping `/conformance`
(a rewrite-only root) fails the union alone; breaking each of the three scans
fails that mechanism's floor plus the union; disabling the comment stripper
fails the union alone.

**The comment stripper earned its place immediately.** The first run reported a
twelfth root, `/x`, read out of the comment written one file over to *explain*
mechanism 1 (`app.get('/x')`). Documentation about a check must not be an input
to it.

Two transferable halves:

1. **The mechanism was correct and the data feeding it was stale.** A guard
   reading a hand-written list inherits that list's decay, and nothing in a
   review of the guard's own code would surface it.
2. **The first mechanism that answers is not the only mechanism.** Scanning
   registrations found six roots and felt complete; the question "what else
   takes a name?" found five more, including the two that run *before* the
   guard. A census is only as wide as the question that generated it.
