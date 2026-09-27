# ADR 0468 — Anonymous-actor authorization: the RFC 0132 reference-host implementation

Status: implemented

## Context

The embeddable public chat widget (`features/chat-widget`) serves anonymous website
visitors. Today those visitors get single-turn persona text and **no agent tools** —
the deliverable/action tools fail closed without an authenticated acting user
(RFC 0003 / ADR 0308 / ADR 0309), and there was no wire notion of what an
unauthenticated, tenant-external principal may do. The chat-first-port sweep
(openwop-app A5, see [[chat-first-port-sweep]]) deferred tool-enabled public dispatch
behind exactly that missing wire concept.

That concept is now **OpenWOP RFC 0132 — anonymous-actor authorization**
(`../openwop/RFCS/0132-anonymous-actor-authorization.md`, authored + flipped to Active
by the spec-half session). RFC 0132 defines: §A an opaque, non-PII anonymous principal
kind; §B an `anonymousActor` capability advertisement; §C two authority tiers (`read`
and `bounded-write-egress`) behind a mandatory per-surface, default-deny grant; §D an
`authorization.decided` audit record. This ADR records the **host** decisions for
implementing RFC 0132 conformantly — it does not change the wire (that is the RFC).

## Decision

Implement RFC 0132 as a **host-side authorization module with one owner**, gated
entirely behind `OPENWOP_ANON_ACTOR_ENABLED` (default OFF, honest-off), and prove it
against the conformance suite via a non-normative sample seam.

1. **One authorization owner — `host/anonymousActor.ts`.** It owns: the opaque
   principal (`mintAnonPrincipal` — an HMAC of the surface session key, never an
   IP/fingerprint/PII, non-forgeable, non-cross-linkable); the default-deny grant
   resolver (`resolveAnonGrant`, never the ADR 0315 default-on baseline); the two
   decision primitives `authorizeAnonTool` (read/write tiers) and `guardAnonEgress`
   (RFC 0079 SSRF + audience binding, `credentialAttached:false` always); the RFC 0049
   `authorization.decided` emitter; the `owner.principalKind:"anonymous"` run-snapshot
   projection; and the production widget tool turn `runAnonReadTurn`.

2. **The anon tool turn is a real run.** `owner.principalKind` and the audit records
   need a durable anchor, so a tool-granting anon surface creates a run owned by the
   surface tenant with the opaque principal stamped on `run.metadata` and **no**
   `actingUserId` — the fail-closed floor. The turn drives the *existing* shared tool
   loop (`runChatToolLoop`) with the tools compiled to exactly the surface grant, so
   ADR 0308 deliverable/secret tools fail closed for free and no secret/BYOK/cross-
   tenant material is reachable.

3. **Honest-off advertisement.** `discovery.ts` advertises `anonymousActor` only when
   the env flag is set (mirrors the `dataResidency` pattern). When advertised, the host
   truthfully lists **both** tiers — it behaviorally honors read (tenant-scoped, no
   secrets) and bounded-write-egress (behind the `hitl` RFC 0051 control + the SSRF/
   audience egress guard) on the sample seam.

4. **Conformance witness seam — `routes/anonSurfaceSeam.ts`.** A non-normative
   host-extension test seam (`GET/POST /v1/host/sample/anon-surface/{tools,dispatch}`,
   unauthenticated by construction, 404 when the flag is off) exercises both tiers
   non-vacuously for the RFC 0132 conformance scenarios. It owns **no** authorization
   logic: `decideAnonToolCall` is a thin adapter that maps the seam's per-tool grant
   fixtures onto the two primitives in `anonymousActor.ts`, so the seam and the
   production widget path share one decision core (no parallel architecture —
   see [[no-parallel-architecture]]).

### Alternatives weighed

- **Read-tier only in the host, defer write/egress.** Rejected for the *capability*:
  the reference host must prove the full RFC to graduate the conformance invariants, so
  the sample seam honors both tiers. The *production widget* still uses read-only by
  config choice — a per-surface decision, not a capability limit.
- **A separate anon tool executor.** Rejected — reuse `conversationToolLoop` + the
  capability firewall with `actingUserId:undefined`; fail-closed = free no-secret-reach.
- **Two decision functions (seam vs widget).** Rejected — collapsed to one owner via the
  delegating adapter; two encodings of the same rules drift (the bug class the
  chat-first-port sweep was built to kill).

## Security invariants (all test-enforced)

- Default-**deny** grant, never the ADR 0315 baseline.
- Read tier = tenant-scoped, no egress, no secrets (`actingUserId` undefined is the
  structural witness; a planted tenant canary never appears in any dispatch output).
- Write/egress only behind a mandatory control; egress is SSRF- + audience-bound with
  `credentialAttached:false`.
- Audit rides the existing `authorization.decided` event — no new event type.
- Unknown-surface dispatch returns a **uniform 404** (no cross-tenant existence oracle);
  a missing tool on a *known* surface is a 400 (the caller already reached it).

## Implementation record

| Phase | What | Where |
|---|---|---|
| Read tier + production path | mint/resolve/owner/audit + `runAnonReadTurn` + honest-off advert + widget `anonToolGrant` | `host/anonymousActor.ts`, `features/chat-widget/*`, `routes/discovery.ts`, `routes/runs.ts` |
| Bounded-write-egress + witness seam | `authorizeAnonTool` + `guardAnonEgress` + `decideAnonToolCall` adapter + the sample seam + public-path prefix | `host/anonymousActor.ts`, `routes/anonSurfaceSeam.ts`, `routes/registerAllRoutes.ts`, `middleware/auth.ts` |
| Verification | `test/anonymous-actor.test.ts` boots the real app and probes the live seam over HTTP (all four reasons, canary, owner projection, flag-off 404) | 34 tests green |

## Open questions

1. **OQ1** — Production widget write/egress: the widget path currently wires the read
   tier only. Enabling bounded-write-egress on the *widget* (not just the seam) is a
   follow-on once an operator surface for per-widget write grants + audiences exists.
   → **Resolved by [ADR 0469](0469-anonymous-actor-operator-surface.md)** (architected
   phased plan; implementation pending).
2. **OQ2** — `rate-limit-session-cap` control: advertised in the type surface but this
   host wires only `hitl`; the rate-limit control is a follow-on.
   → **Resolved by [ADR 0469](0469-anonymous-actor-operator-surface.md)** (Phase A cap +
   Phase D control).

Gated OFF (`OPENWOP_ANON_ACTOR_ENABLED` unset) until RFC 0132 reaches Accepted.
