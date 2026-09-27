# ADR 0646 — content negotiation on shared names

Status: Accepted (implemented; see § Implementation record)

## Context

Three top-level names on this host are simultaneously an SPA page and a v2
protocol operation: **`/agents`, `/prompts`, `/runs`** — the intersection of the
14 top-level segments in `schemas/v2/path-manifest.json` with the 101 routes the
SPA serves. Both reach the same origin: Firebase rewrites every v2 root to Cloud
Run (`firebase.json`, guarded by `check-hosting-wire-rewrites.cjs`).

Until this ADR, one line told them apart (`middleware/protocolVersion.ts`):

```js
let major: 1 | 2 = 1;
if (!versioned && requested === 2) major = 2;   // the header, and ONLY the header
```

Header-less ⇒ major 1 ⇒ not a `/v1/` key ⇒ the shell. **The separator between
the app and the wire was the v1 default.** `versioning.md` §5 (errata 2026-09-10)
now says it by name: *retirement flips every header-less request's contract*.
On cutover day the same three URLs that render pages would answer JSON — a
breakage with a date (v1 EOS 2026-12-04), and one the ADR 0642 inventory cannot
see, because it counts `/v1/` paths and this defect contains no `/v1/`.

**Measured live on 2026-09-10, before the change:**

| request on `/agents` | got | should be |
|---|---|---|
| browser (`Accept: text/html`, no header) | `200 text/html` **carrying `openwop-version: 1.1`** | shell, **no** version header (§1.4 errata) |
| header-less, `Accept: application/json` | **`404 application/json`** | the operation under `preferredVersion`'s major (§1.3) |
| `OpenWOP-Version: 2` | `200 application/json` | ✓ |

The first is a §1.4 violation (a non-protocol response on a shared name MUST
NOT carry the version); the second is a §1.3 violation — a header-less JSON
client got neither the page nor the operation.

The corpus ruling (openwop-1, crosstalk `5041`; §1.4 errata openwop #1315):
content negotiation is **permitted iff** (1) a request identifying as a protocol
client — `OpenWOP-Version` present, or an `Accept` admitting `application/json`
without preferring `text/html` (absent and `*/*` included) — gets the protocol
response; (2) the shell carries no `OpenWOP-Version` and is not
`application/json`; (3) `Vary: Accept, OpenWOP-Version` on the shared name.

## Decision

1. **The negotiator decides whose request it is, by ONE predicate.**
   `isProtocolClient(req)` = header present, or `req.accepts(['application/json',
   'text/html']) !== 'text/html'` — Express's `accepts` already implements the
   ruling's q-value rule (absent → first type; `*/*` → first; ties → list order;
   nothing acceptable → `false`, and a client accepting neither JSON nor HTML is
   not a browser). It is exported and the publishing shell route uses the same
   function instead of restating it; two copies of a decision this close to
   authorization drift.
2. **A protocol client on a shared name is served the operation under the
   NEGOTIATED major** — `preferredVersion`'s when the header is absent (§1.3) —
   by the same `/v1`-twin rewrite that previously ran only for `major === 2`.
   The bound-run-id re-encode (ADR 0631) stays a major-2 concern.
3. **The version header is withheld on the shell branch** and `Vary: Accept` is
   added on shared names. Every other path is unchanged: `/v1/*` and
   non-shared unversioned paths stamp the header exactly as before.

This survives retirement: when header-less flips to major 2, a browser still
prefers `text/html` and still gets the shell; a JSON client gets the operation
under major 2. The v1 default is no longer load-bearing for anything.

## Alternatives

- **Move the three SPA routes off the shared names** (`/console/agents`, …).
  Rejected: breaks every bookmark and deep link for a problem the wire already
  solves with `Accept`; and the collision set is derived from the corpus
  manifest, so a future v2 segment could collide again — negotiation handles
  that structurally, renaming handles it once.
- **Serve the SPA under a prefix.** Same cost, larger.
- **Do nothing until EOS** — "the v1 default separates them today". Rejected:
  that is the hazard, not a mitigation, and both violations above exist today.
- **Decide in the publishing route only** (where ADR 0631 had put the
  browser half). Rejected: the route runs after the negotiator has already
  stamped the version header, and cannot un-stamp it; the decision belongs where
  the header is set.

## Consequences

- A bare `curl https://host/agents` (no header, `Accept: */*`) is a protocol
  client and gets JSON under major 1 — the ruling's intent, and what the suite
  already assumes (every unversioned-path scenario sends `Accept: application/json`).
- `reachedUnderMajor2` (conformance) is now also prose: a `text/html` response,
  or one without `OpenWOP-Version`, is not a protocol response and is not counted.
- Host-extension paths (`/v1/host/openwop-app/*`) are not shared names and are
  untouched; whether a non-manifest response may carry the version header is not
  decided here.

## Implementation record

| what | where |
|---|---|
| predicate + gated stamp + §1.3 rewrite + `Vary: Accept` | `backend/typescript/src/middleware/protocolVersion.ts` |
| shell route uses the shared predicate | `backend/typescript/src/features/publishing/routes.ts` |
| 8 wire-level cases through the real listener, production-shaped (cookie) auth | `backend/typescript/test/adr0646-shared-name-negotiation.test.ts` |

Sabotage-verified: restoring the unconditional stamp reddens the browser case;
restoring the `major === 2` rewrite condition reddens the header-less JSON case.

A harness note worth keeping: under `OPENWOP_AUTH_DISABLE_COOKIES=true` (the
usual v2 test harness) an anonymous browser GET on `/agents` is a **401** before
any shell route runs. Production issues an `anon:` `__session` cookie to that
same request (measured live). The test runs in cookie mode for that reason —
a green browser case under the bearer-only harness would have been vacuous.
