# ADR 0915 — A feature declares its own public paths, confined to its namespace

Status: Accepted (implemented in this PR)

## Context

This ADR implements Book AI upstream proposal P4 (`bookai/docs/upstream-proposals.md`).

Book AI's beta-reader links are feature-owned capability tokens. A reader has no
account; the reader page posts the token to
`/host/openwop-app/bookai-author-suite/reader/*`, and the route resolves it to
one pinned edition.

In the default posture, a request without credentials gets an anonymous
session, so the links work. Under `OPENWOP_AUTH_ENFORCE_BEARER=true` or
`OPENWOP_AUTH_DISABLE_COOKIES=true`, `authMiddleware` answers 401 before the
route runs, so the links cannot open.

The middleware skips only its closed `PUBLIC_PATH_PREFIXES` list. That list is
a constant in `middleware/auth.ts`, and `BackendFeature` had no way to add to
it. Mounting the reader under another feature's public prefix (`/shared`,
`/public`, …) would borrow that feature's security boundary.

## Decision

- **D1 — `BackendFeature.publicPaths?: readonly string[]`.** `registerBackendFeatures`
  registers each declared path before it mounts the feature's routes, via
  `registerFeaturePublicPaths(featureId, paths)` in `middleware/auth.ts`, and
  `isPublicPath` consults the result.
- **D2 — confinement, checked at boot.** A declared path must sit strictly
  below `/host/openwop-app/<featureId>/`, as one to six lowercase segments, with
  no wildcard, no trailing slash, no `..` and no uppercase. Anything else throws
  at registration, so a feature can never open its own whole namespace, another
  feature's namespace, or anything outside the vendor tree. Matching is the same
  as for the closed list: the path itself or a deeper path, so `/reader` does not
  match `/reader-admin`.
- **D2a — only canonical paths match** (raised in review by the release
  manager). `startsWith` on an un-normalized path would count
  `<prefix>/..%2F..%2Fother` as public, and the Firebase `/api` rewrite decodes
  `%2F` (measured). A proxy that normalizes after this check could then route the
  request to a session-only handler. So a feature path matches only when the
  request path has no dot segment (`.` / `..`) and no `%` anywhere. A reader
  token is opaque, so this costs a real route nothing.
  - The closed `PUBLIC_PATH_PREFIXES` list keeps its old matching. Tightening it
    is a separate change, because existing public routes may carry escapes.
  - The first real consumer still needs its own witness test: under bearer
    enforcement, a dot-segment or encoded-slash path below its public prefix must
    reach no session-only route.
- **D3 — public means "no session", nothing more.** The owning routes MUST:
  - authenticate their own capability (the token is the credential, hashed at
    rest, revocable);
  - answer a uniform 404 for an unknown or revoked token, with no existence leak;
  - stay on the global per-IP limiter.

  This follows the ADR 0013 share-link precedent. The same predicate exempts the
  path from CSRF, which is correct for a route that carries no cookie
  credential.
- **D4 — a ratchet.** `test/adr0915-feature-public-paths.test.ts` asserts that no
  shipped feature declares a public path today. Book AI is a downstream feature,
  outside this repo's `BACKEND_FEATURES`. Adding one here is a reviewed change
  that updates that list.

## Alternatives

- **Add Book AI's prefix to `PUBLIC_PATH_PREFIXES`.** Core would then name a
  product: the ADR 0001 boundary problem `defaultOrg` (ADR 0684) also avoided.
- **A wildcard or a regex per feature.** It is easier to over-grant, and harder
  to read in review.

## Consequences

- Book AI can declare `/host/openwop-app/bookai-author-suite/reader`, and its
  reader links will open under bearer-enforced and cookie-less deployments. It
  can then drop `linksAvailable: false` (G42).
- `featurePublicPaths()` lists the declared paths, for diagnostics and the
  ratchet.

## Implementation

| Part | Where |
| --- | --- |
| D1–D2 | `backend/typescript/src/middleware/auth.ts` (`registerFeaturePublicPaths`, `isPublicPath`); `src/features/types.ts` (`publicPaths`); `src/features/index.ts` (registration) |
| D4 | `backend/typescript/test/adr0915-feature-public-paths.test.ts` |

## Checklist

- [x] D1–D4 with tests
- [ ] Tell Book AI the PR number
