# ADR 0061 — Priority Matrix: app↔app federated portfolio (cross-host, no RFC)

**Status:** implemented (this conversation)
**Date:** 2026-06-16
**Toggle:** none new — extends the existing **`priority-matrix`** feature (ADR 0058/0060).
The federated view is gated by the same toggle + RBAC.
**Depends on / composes:** ADR 0060 (intra-host portfolio — `buildPortfolio`), ADR 0024
(Connections / brokered egress precedent), ADR 0006 (RBAC), the **webhook SSRF egress
guard** (`host/webhookEgressGuard.ts` — `isDeniedWebhookHost` + `webhookEgressDispatcher`).
**Surface:** host-internal, under `/v1/host/openwop-app/priority-matrix/*`.
**RFC gate:** **NO new RFC** — this is the **Option A** federation the `/plan` settled on:
both ends run *this* host, so host A reads host B's **non-normative** `/v1/host/openwop-app/
priority-matrix/portfolio` route. No OpenWOP wire surface is added or relied upon. (A
*normative* cross-vendor prioritization capability — Option B — would need an RFC; it stays
parked, ADR 0058/0060.)

## Why this exists

ADR 0060 shipped the intra-host portfolio (rank ideas across a workspace's lists). The
parked follow-on was "cross-host". On revisiting (`/plan`, this conversation) the caller chose
**Option A — app↔app federation**: a portfolio leader sees priorities across several
**openwop-app instances** (e.g. regional deployments) in one ranked view, without each being
a separate OpenWOP-normative participant. Because Priority Matrix is a host extension on both
ends, federating it is purely host work — no RFC.

## Decision

A per-tenant registry of **federated peers** (other openwop-app origins) and a
`GET /portfolio/federated` read that merges the local portfolio with each peer's
`/priority-matrix/portfolio`, tagging every item with its `source`.

### Security model (load-bearing)

- **No secrets at rest in the new store.** A `FederatedPeer` holds only **non-secret**
  config: `{ id, label, baseUrl }`. The per-peer **bearer credential is a deploy-time env
  secret** — `OPENWOP_PM_PEER_TOKEN_<ID>` (per peer) or `OPENWOP_PM_PEER_TOKEN` (shared
  fallback) — resolved at fetch time, never persisted. This mirrors how the app already
  handles VAPID / session / superadmin secrets (env, not DB) and sidesteps a secret-at-rest
  surface entirely. A peer with no configured token is called unauthenticated (and typically
  reported unreachable/forbidden — fail-soft).
- **SSRF-guarded egress (reused, not reinvented).** `baseUrl`'s host is validated at
  registration with `isDeniedWebhookHost` (rejects loopback / RFC-1918 / link-local / cloud
  metadata unless `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true`), and every peer fetch dials through
  `webhookEgressDispatcher()` (pinned, denied-range-checked DNS at connect — RFC 0093 §A.1).
  GET only, hard timeout, response-size cap.
- **Privileged peer management.** Adding/removing a peer enables outbound calls, so
  `POST`/`DELETE /peers` are **superadmin-gated** (`requireSuperadmin`, fail-closed). Listing
  peers + reading the federated portfolio require an **authenticated workspace member**
  (`resolveCallerUser`).
- **Read-authorization asymmetry (reviewer note, by design for v1).** The **local** slice of
  the federated read is per-caller RBAC-filtered (`readableLists` — only the caller's readable
  orgs). The **peer** slice is fetched with the *shared deploy-time bearer* and is therefore a
  **workspace-level view**, not filtered to the caller — every authenticated member sees the
  full peer portfolio, and any member can trigger the outbound fan-out. This is accepted for
  v1 (the bearer is workspace-level and federation is a leadership aggregation); the proper
  fix is **per-user / Connections-backed peer credentials** (open question below). Operators
  who need per-caller peer filtering should not enable federation until that lands.
- **Fail-soft, never fail-open.** A peer that times out, errors, or returns malformed JSON is
  dropped from the merge and reported in a per-peer `status[]` — it never blocks the local
  portfolio or leaks a stack trace.

### Data model

```
FederatedPeer { id, tenantId, label, baseUrl, createdBy, createdAt }   // NON-secret
FederatedItem = PortfolioItem & { source: string }                     // source = 'local' | peer.label
```

### Surface

- `GET  /priority-matrix/peers` — list peers (`workspace:read`).
- `POST /priority-matrix/peers` `{ label, baseUrl }` — add (superadmin; host validated).
- `DELETE /priority-matrix/peers/:id` — remove (superadmin).
- `GET /priority-matrix/portfolio/federated?topN=` — local (RBAC-filtered lists, ADR 0060)
  + each peer's portfolio, merged + re-ranked by `computedPriority`, each item tagged
  `source`; returns `{ items, peers: [{ label, ok, count, error? }] }`.
- **FE:** an "Include federated peers" toggle + a Source column on the Portfolio section, with
  a per-peer status line; a compact superadmin peers admin (add/list/delete).

### Comparability caveat (carried from ADR 0060)
Cross-*host* priorities are even less comparable than cross-list (different lists, criteria,
AND deployments). The federated view sorts by raw priority and **surfaces `source` + source
list + model**; the same normalization opt-in (ADR 0060) applies per-origin. No invented
global score.

## Alternatives weighed
- **Store the peer token in the DB (sealed via KMS).** Rejected for v1 — env secrets are the
  app's existing pattern and avoid a secret-at-rest surface; a Connections-broker-backed
  credential (ADR 0024) is the natural upgrade if per-user peer auth is ever needed.
- **Ride A2A instead of a direct GET.** Rejected — A2A is agent task delegation; a portfolio
  read is a plain authenticated GET of a host-extension route. A2A adds nothing here.
- **Option B (normative prioritization capability).** Out of scope; the genuine RFC case,
  parked.

## Open questions
- [x] **Per-user / Connections-backed peer credentials** (vs the deploy-time env token) — DONE
  (2026-06-16, **ADR 0062**). Peer bearers moved to the BYOK envelope, keyed per-`(peer)` and
  per-`(peer,user)`; `resolvePeerCredential` resolves per-user → tenant-shared → env. The
  per-user path **closes the read-authorization asymmetry** above (the peer authorizes on the
  caller's own token, so its slice is filtered to their access). The Connections broker was
  evaluated and rejected for N dynamic peers (provider-keyed + apiHosts-pinned); only its BYOK
  secret primitive is reused. Host-internal, no RFC.
- [x] **Caching / fan-out cost** — DONE (2026-06-16, enterprise hardening). The per-peer fetch
  now runs through a process-local **single-flight + short-TTL + bounded + jittered** cache
  (`federationCache.ts`; default TTL 30s via `OPENWOP_PM_FED_CACHE_TTL_MS`, `0` disables). The
  **load-bearing correctness rule**: because ADR 0062 makes a peer's slice depend on the
  resolved credential (a per-user bearer filters the peer to THAT user), the cache key carries
  `(tenantId, peerId, topN, identity)`, where `identity` is the tier reported by the new
  `resolvePeerCredential` (`u:<userId>` / `shared` / `env` / `none`) — so one caller's filtered
  slice can never be served to another identity. Only successful fetches are cached
  (fail-soft drops are never sticky); single-flight gives thundering-herd protection on the
  peer; entries are bounded (1 000 keys, insertion-order eviction) and jittered (±20%) to
  avoid synchronized re-stampede. Cache wraps only the PEER fetch — the local slice and the
  merge stay live. A federated read is a live, fail-soft read, so process-local (no
  cross-instance coherence) is acceptable; nothing is persisted or replayed. Host-internal,
  no RFC. Stale-while-revalidate is a further follow-on if even the first post-expiry caller's
  latency matters.
- [x] **Peer-response streaming cap** — DONE (2026-06-16, enterprise hardening). The fetch now
  sends `accept-encoding: identity` (removes the decompression-bomb vector, undici advisory
  GHSA-g9mf-h72j-4rw9) and reads the body through `readCapped()` — a streaming reader that
  aborts past a hard byte cap (Content-Length stays an untrusted fast-path reject). OWASP SSRF
  cheat-sheet control; undici has no built-in max-response-size (issue #1692).
- [ ] **Option B** — a normative cross-vendor prioritization RFC (still parked).
- [x] **Per-user / broker-backed peer credentials** → graduated to a real decision under the
  enterprise lens and SHIPPED in **ADR 0062** (broker-managed (b) + per-user scope (c1),
  host-internal). The cross-host SSO/OBO delegation (c2, RFC 8693) remains the parked RFC track.

## Implementation ledger
Shipped 2026-06-16. `features/priority-matrix/federationService.ts` (peer store + SSRF-guarded
`fetchPeerPortfolio` + `buildFederatedPortfolio` with an injectable fetcher for tests); peer
CRUD + `/portfolio/federated` routes (superadmin peer mgmt; `workspace:read` reads); FE
federated toggle + Source column + peers admin; tests in `test/priority-matrix-federation.test.ts`
(host validation, peer-CRUD RBAC, federated merge + fail-soft via an injected fetcher).
Backend `tsc` + frontend build green. Host-extension, no new RFC.

**Fan-out cache (2026-06-16):** `features/priority-matrix/federationCache.ts` (generic
`coalesce(key, ttl, fn, cacheIf)` — single-flight + jittered short-TTL + bounded);
`resolvePeerCredential` (token + identity tier) + `cachedPeerFetch` (resolves identity,
keys `(tenantId, peerId, topN, identity)`, caches only `r.ok`) in `federationService.ts`;
`defaultPeerFetcher` now goes through it (route unchanged — it already passes `actingUserId`).
Tests added: TTL hit (inner runs once), identity-keying anti-leak, fail-soft not cached,
`TTL ≤ 0` bypass, concurrent single-flight coalescing.

**Correction (code-review 2026-06-16):** three hardening follow-ups. (1) The cache key now
`encodeURIComponent`-escapes each component before joining on `::`, so the delimiter cannot
appear inside a `tenantId`/`peerId`/`identity` and no two tuples can collide. (2) `setPeerCredential`
and `deletePeer` now call `invalidateWhere` to bust this peer's cached entries — a rotated
credential authorizes a different slice under the same `identity` tier, so the ≤TTL window must
not keep serving the old token's slice (regression test added). (3) The bounded store is now
true LRU (touch-on-read moves an entry to the MRU end) rather than FIFO.
