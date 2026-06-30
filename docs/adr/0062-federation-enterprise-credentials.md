# ADR 0062 — Federated Portfolio: enterprise credentials + per-user authorization

**Status:** implemented (Phases 1+2 — b + c1); Phase 3 (c2) is a tracked RFC
**Date:** 2026-06-16
**Toggle:** none new — hardens the existing `priority-matrix` federation (ADR 0061).
**Depends on / composes:** ADR 0061 (federated portfolio), ADR 0024/0028 (Connections + the
BYOK secret envelope), `byok/secretResolver` (`setSecret`/`resolveSecret`, KMS-enveloped),
the federation SSRF egress guard (`host/webhookEgressGuard.ts`).
**Surface:** host-internal, `/v1/host/openwop-app/priority-matrix/peers/*`.
**RFC gate:** **(b) + (c1) need NO RFC** (host-internal credential management + resolution).
**(c2) cross-host identity delegation DOES need an openwop RFC** — see § c2.

## Why this exists (enterprise lens)

ADR 0061 shipped federation for a single-host demo with a **deploy-time env bearer**
(`OPENWOP_PM_PEER_TOKEN`) and a documented **read-authorization asymmetry**: the local
portfolio slice is per-caller RBAC-filtered, but the peer slice uses a *shared* bearer and is
shown in full to any authenticated member. The deployment is now moving to an **enterprise
installation**, where two demo-acceptable shortcuts become non-negotiable defects:

1. **Secrets in env / not managed** — enterprise requires KMS-sealed, rotatable, per-tenant,
   policy-gated credentials, not a process env var.
2. **The authorization asymmetry** — a junior member must NOT see cross-host data via a shared
   bearer; per-user, fail-closed authorization is mandatory.

So the parked "per-user peer credentials" open question graduates to a decision.

## Decision

### Credential storage — the BYOK envelope, not the provider broker
Store each peer's bearer via **`byok/secretResolver`** (`setSecret`/`resolveSecret` — KMS-
enveloped for signed-in tenants; the same enterprise secret-at-rest path Connections uses),
keyed by a `credentialRef`:

- **Tenant-shared:** `pm-peer:<peerId>`
- **Per-user:** `pm-peer:<peerId>:user:<userId>`

**Why not the Connections broker (ADR 0024) directly?** The broker is **provider-keyed** —
one credential per `(tenant/user, provider)` — and `brokeredFetch` **pins egress to the
provider's fixed `apiHosts`**. Federation has **N peers, each a distinct dynamic origin with
its own credential**; that doesn't fit a single provider + fixed host allowlist. Forcing it
would either need a synthetic provider-per-peer (registry abuse) or lose the per-peer
credential separation. So we reuse the broker's **secret primitive** (the BYOK envelope) —
the genuinely shared, enterprise-grade part — while keeping federation's **own** SSRF egress
(validated at registration + the pinned `webhookEgressDispatcher`), which is already correct
for dynamic peer URLs. Single-source-of-truth for *secret material* is preserved (BYOK
envelope); we do not stand up a second secret store.

### Resolution precedence (closes the asymmetry — c1)
At fetch time, `resolvePeerToken(peer, { tenantId, actingUserId })` resolves:
**per-user (`pm-peer:<peerId>:user:<userId>`) → tenant-shared (`pm-peer:<peerId>`) → env
`OPENWOP_PM_PEER_TOKEN[_<ID>]` (deprecated back-compat)**.

- **(b) tenant-shared** replaces the env token: KMS-sealed, rotatable, per-tenant.
- **(c1) per-user** — when a caller has their own peer credential, the peer authorizes on
  **their** token, so that peer's slice is filtered to **their** access on the peer →
  **the authorization asymmetry is closed per-(peer, user)**, host-internally, no RFC. When
  only a tenant credential exists, the slice is the (documented) workspace-level view.

### Authority
- Set/rotate the **tenant-shared** credential → **superadmin** (it's workspace-wide outbound auth).
- Set your **own per-user** credential → the authenticated member (self).
- Reading the federated portfolio → authenticated member (unchanged); the peer slice it sees
  now depends on which credential resolves for them (per-user if configured).

### c2 — cross-host SSO/OBO delegation (the RFC track)
True enterprise SSO — host A asserts user B to peer C **without B holding a C credential**
(OAuth 2.0 Token Exchange, RFC 8693 `act`+`sub` delegation) — requires the **remote host to
trust A's assertion of B's identity**. That is cross-host identity propagation: a **normative
wire contract**, not a host extension. It is the enterprise-native long-term answer (users
shouldn't hand-provision a per-peer token at scale), and is hereby escalated from "parked" to
a **tracked openwop RFC** (author via `/prd`); host work follows once it reaches Accepted. Until
then, (c1) per-user connections is the host-internal path that satisfies enterprise per-user
authorization.

## Alternatives weighed
- **Keep env token (a).** Rejected for enterprise — unmanaged secret, no rotation, no per-user.
- **Connections broker provider-per-peer.** Rejected — provider/apiHosts model fights N dynamic
  peers; reuse only its secret primitive.
- **Seal a raw token in the FederatedPeer store.** Rejected — that's a second secret store
  beside the BYOK envelope (the boundary the architecture forbids).

## Phased plan
- **Phase 1 (b):** `setPeerCredential` (tenant scope, superadmin) via `setSecret`;
  `resolvePeerToken` (tenant → env fallback); thread `{tenantId, actingUserId}` to the fetcher.
- **Phase 2 (c1):** per-user scope on `setPeerCredential` (self) + per-user resolution
  precedence; the peer slice is then per-caller. FE: a per-peer "set credential" affordance
  (Workspace-shared = superadmin / My own = member).
- **Phase 3 (c2):** the RFC (out of this ADR; `/prd`).

## Open questions
- [ ] **(c2) RFC 8693 cross-host delegation** — the normative SSO/OBO track (parked behind an RFC).
- [ ] **Env-token removal** — keep as deprecated fallback through one release, then remove.
- [ ] **Per-user credential lifecycle UI** (rotation/expiry surfacing) — minimal affordance v1.

## Implementation ledger
Phases 1+2 shipped 2026-06-16. `federationService`: `peerCredentialRef`/`peerUserCredentialRef`,
`setPeerCredential(scope)`, `resolvePeerToken` (per-user → tenant → deprecated env), credential
cleared on peer delete; `PeerFetcher`/`buildFederatedPortfolio` thread a `{tenantId, actingUserId}`
context; `defaultPeerFetcher` resolves per-caller. Route `PUT /peers/:id/credential` (tenant =
superadmin, user = self). FE per-peer credential form (My own / Workspace-shared). Tests
(`priority-matrix-federation.test.ts`, BYOK ephemeral): resolution precedence per-user > tenant
> env; credential-set RBAC; + the existing streaming-cap/SSRF/merge tests. Backend `tsc` + full
suite green; frontend build green. Phase 3 (c2 RFC 8693) remains a tracked openwop RFC.
