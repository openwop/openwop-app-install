# ADR 0187 — Application-layer egress firewall (per-tenant allow/deny rules)

**Status:** implemented — 2026-07-02
**Surface:** host runtime (a per-tenant egress policy at the brokered-fetch chokepoint) + a superadmin governance route. **NON-NORMATIVE — no new RFC.** It advertises nothing on the wire; it is an operator/superadmin security policy that composes with the existing SSRF baseline (RFC 0093) and BYOK/Connections brokered egress.

> **Why application-layer.** A network-layer egress firewall (an L7 MITM proxy + CA that filters a sandboxed subprocess's outbound traffic) has nothing to intercept here: openwop-app has **no local subprocess** whose traffic could be MITM-proxied — it is a Cloud-Run host that **brokers all outbound egress through its own host fetch paths** (`brokeredEgress`, the webhook worker, connectors, ads). The faithful equivalent is therefore an **application-layer** egress firewall at that chokepoint, not a network MITM.

## Decision

A per-tenant egress **allow/deny host policy**, enforced at the host's brokered-fetch chokepoint, **layered on top of the always-on SSRF baseline**.

### The SSOT (`host/egressPolicy.ts`)
- `EgressRuleSet { tenantId, mode: 'off'|'allowlist'|'denylist', hosts: string[] }` — superadmin-managed runtime state in a `DurableCollection` (**never** agent- or caller-settable).
- `evaluateEgress(url, rules)` — a pure decision:
  1. **SSRF baseline first** — reuse `isDeniedWebhookHost` (loopback / RFC 1918 / link-local / cloud-metadata). **Denied for every tenant, always** — an allowlist can never relax it.
  2. **Tenant mode** — `off` → allow; `denylist` → deny on a host match; `allowlist` → deny unless a host match (default-deny). A rule host matches its exact host **and any subdomain** (suffix), so `example.com` covers `api.example.com`.
- `assertEgressAllowed(tenantId, url)` — fail-closed gate: throws `egress_blocked`/403 (added to the canonical `OpenwopErrorCode`) **before** any connection is dialed.

### Enforcement points (`host/brokeredEgress.ts`)
- `brokeredPost` (connector/messaging/ads POST path) → `await assertEgressAllowed(deps.tenantId, url)` after URL resolution, before `undiciFetch`.
- `brokeredFetch` (connector GET path) → the non-throwing `evaluateEgress` mapped to its existing `host_not_allowed` outcome (on top of the provider `apiHosts` eTLD+1 restriction — a tenant may denylist even a provider host).

### The admin surface (`routes/governance.ts`)
`GET`/`PUT /v1/host/openwop-app/governance/egress-rules` — `requireSuperadmin`, mirroring the byok-chat-budget/media-budget governance routes; PUT normalizes + de-dupes hosts and audit-logs the change.

## Boundaries & alternatives

- **Single source of truth.** One predicate (`evaluateEgress`) behind both the throwing gate (POST path) and the non-throwing branch (GET path) — the two enforcement styles can't drift, mirroring the `isDeniedWebhookHost` "one predicate, two call sites" discipline it reuses.
- **Composes, does not replace.** The SSRF baseline (RFC 0093) and the connector `apiHosts` restriction stand; the firewall only *narrows* egress further. It never widens (an allowlist cannot re-permit a private range).
- **Rejected — a network-layer MITM proxy.** A Cloud-Run host has no local subprocess egress to intercept; a MITM proxy + CA would be dead infrastructure. The application-layer policy at the brokered chokepoint is the honest fit.
- **Fail-closed.** Denied host → 403 before dial; the default `off` policy pays only the SSRF-baseline check (no behavior change for existing tenants).

## Verification
- `test/egress-policy.unit.test.ts` (9): SSRF baseline never relaxed (even when an allowlist names a private range), off/allowlist/denylist semantics, subdomain suffix match, invalid-URL deny, store normalize/de-dupe round-trip, `assertEgressAllowed` throws `egress_blocked`/403.
- `test/governance.test.ts` (+block): superadmin GET default-`off` / PUT normalize / mode+hosts validation (400s).
- Regression: brokered-egress / connections / webhook / byok-chat-budget suites green (52) — the `off` default is transparent to existing tenants. tsc clean; 0 banned patterns.

## Open questions / path to A+
- [ ] Adopt the same `assertEgressAllowed` predicate in the remaining egress sites (the webhook worker's delivery path, the `HostSafeFetch` seam) so **every** host-brokered outbound consults the tenant policy — currently the connector/ads brokered paths do.
- [x] A frontend surface (a GovernancePanel section) to edit the rules — **shipped**: `GovernancePanel.tsx` renders a superadmin-only egress section (mode chips off/allowlist/denylist + one-per-line hosts editor) wired to GET/PUT `…/governance/egress-rules`, skipped on 403 like its byok/media siblings; 4-locale i18n; SSRF-baseline note surfaced in the UI.
- [ ] Per-run (not just per-tenant) egress scoping if a use case needs it.
