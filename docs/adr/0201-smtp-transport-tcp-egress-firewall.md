# ADR 0201 — SMTP email transport + TCP-egress firewall

Status: implemented — the SMTP TCP-egress firewall shipped (`host/smtpEgress.ts` — the raw-TCP SMTP dial is guarded, mirroring the ADR 0187 HTTPS brokered-egress firewall). *(Status-corrected 2026-07-21 — header lagged the shipped module.)*

## Context

ADR 0193 shipped real email sending in two phases — a transactional HTTP
provider table in `emailAdapter` (SendGrid/Postmark, Phase 1) and a
provider-native send-as-you node (Gmail/Graph, Phase 2). It recorded **Phase 3
(raw SMTP) as deferred (YAGNI)** with an explicit gate: *"if built, it needs its
own ADR (TCP-egress allowlist with per-connection host:port pinning + a
`nodemailer` dependency review). Do not open the egress surface speculatively."*

This ADR is that record. The maintainer has scoped SMTP in, so the question is
no longer *whether* but *how to build it without weakening the egress-security
invariant that the rest of the app depends on.*

**Why SMTP is different from every prior egress.** The whole host security model
funnels **all** outbound traffic through one HTTPS chokepoint:
`host/brokeredEgress.ts` (`token over https only`, returns `insecure_base` on any
non-`https:` URL — `brokeredEgress.ts:98,198`) guarded by the application-layer
ADR 0187 firewall (`host/egressPolicy.ts` — a per-tenant host allow/deny policy
+ an always-on SSRF baseline, enforced *before any connection is dialed*). SMTP
is **raw TCP** (465 implicit-TLS / 587 STARTTLS), so it structurally **cannot**
ride that chokepoint — and a naive `nodemailer.createTransport(...).sendMail()`
opens a **new, un-firewalled TCP egress surface**: SSRF/exfil to arbitrary
`host:port`, invisible to the ADR 0187 policy. Its credential is also a
**long-lived `basic` user+password** — often the user's real mailbox password, a
materially larger blast radius than a scoped OAuth token or a revocable api_key.

## Decision

Build SMTP as a **transport branch inside the single send owner
(`emailAdapter`)**, gated by a **new TCP-egress firewall that reuses the existing
SSRF/policy predicates** (no second egress-security system) and a **sealed
`basic` connection**. The firewall is the load-bearing prerequisite — it ships
*with* the transport, never after.

### 1. TCP-egress firewall (built FIRST) — `host/smtpEgress.ts`

A `assertSmtpDialAllowed(tenantId, host, port)` chokepoint, fail-closed, called
before any dial:

- **Tenant policy reuse.** The host is evaluated against the *same* per-tenant
  ADR 0187 ruleset via a host-based core factored out of `egressPolicy.ts`
  (`evaluateEgressHost`) — SMTP does not get a second allow/deny model.
- **Port allowlist.** Only the SMTP submission ports `{465, 587, 2525}` (25 is
  cloud-blocked and plaintext; excluded by default). A non-listed port is
  `egress_blocked` before resolution.
- **Rebind-safe SSRF baseline (the load-bearing bit).** Dialing goes through a
  **guarded DNS lookup** (the exact `webhookEgressGuard.ts` pattern — RFC 0093
  §A.1): the host is resolved, **every** resolved address is validated with the
  shared `isDeniedWebhookHost` predicate (loopback/RFC1918/link-local/metadata),
  and the socket connects to the **validated address** — validation and connect
  share one resolution, so there is **no check-then-dial DNS-rebinding TOCTOU**.
  We pass this `lookup` to nodemailer's connection options so nodemailer dials
  exactly what the guard approved (no second resolution to race).

### 2. Sealed `basic` SMTP connection — no schema change

- A builtin `smtp` provider manifest (`kind: 'basic'`), a **custom-server**
  connection (not a connection *pack* — packs are schema-locked to
  `https://`-only `mcp`/`openapi` reach, `connectionPackLoader.ts:16-17`, so SMTP
  *cannot* be a pack).
- The connection's secret is a **JSON blob `{host,port,secure,user,pass}`**
  sealed in the BYOK envelope — mirroring the oauth2 token-blob precedent
  (`connectionsService.ts:176`). Host/port are not secret, but sealing them is
  free defense-in-depth and avoids a `Connection`-schema change. `displayName`
  surfaces the host for the UI. **The password is never logged and is redacted
  in errors.**

### 3. Transport branch in `emailAdapter` — single send owner preserved

`send()` keeps its one ledger + one accept path; provider `smtp` dispatches to a
new `sendViaSmtp()` (nodemailer) instead of the HTTP `PROVIDERS`/`brokeredPost`
path. Both share the **Phase-1 idempotency ledger** (fork-stable
`idempotencyKey`, get-before-send / put-on-accept — nodemailer's returned
`messageId` → `recordSend`) and `stampConnectionUse` on success. SMTP is just
another `config.provider` for the transactional `core.openwop.integration.email-send`
node; it does **not** touch the Phase-2 send-as-you node.

### 4. `nodemailer` dependency

Add `nodemailer` (+ `@types/nodemailer`), pinned + lockfiled. It is the
ubiquitous, well-audited Node SMTP client; the ADR records the supply-chain
surface (one runtime dep, no native addons). No other transport lib.

## RFC gate — no new RFC

SMTP touches **no OpenWOP wire**: no run-event field, capability advert, event
type, endpoint contract, or normative `MUST`. It is host egress + a `basic`
Connection kind (RFC 0095 connection credentials are provider auth, not the
wire — ADR 0193 §"RFC gate"). `host.email` is already advertised send-capable.
So this is host work under an ADR, no `../openwop` RFC needed.

## Boundaries & single-source-of-truth

- **One send owner:** `emailAdapter` — SMTP is a transport branch inside it, not
  a parallel sender.
- **One SSRF/policy predicate:** `smtpEgress` reuses `isDeniedWebhookHost`
  (`webhookEgressGuard.ts`) and a host-core factored out of `egressPolicy.ts`.
  SMTP does **not** stand up a second firewall — it extends the one seam to a new
  transport (TCP) the HTTPS chokepoint structurally can't cover. This is the
  legitimate-new-seam case, not a parallel-system boundary violation: the policy
  data, SSRF ranges, and dev/test private-egress flag are shared.
- **Credentials:** stay host-side in the BYOK envelope; never in `run.metadata`,
  event payloads, logs, or error bodies.

## Alternatives weighed

- **A — SMTP as a connection pack.** Impossible: pack reach is schema-locked to
  `https://` `mcp`/`openapi` (`connectionPackLoader.ts`). SMTP is host code by
  construction.
- **B — un-firewalled `nodemailer` dial (naive).** Rejected: opens SSRF/exfil to
  arbitrary `host:port`, invisible to ADR 0187. This is the "do not open the
  egress surface speculatively" failure mode.
- **C (chosen) — transport branch + rebind-safe TCP firewall reusing the SSRF
  predicate + sealed basic connection.**

## Replay / fork / idempotency

Unchanged from Phase 1: the `email:sent` ledger keyed on the fork-stable
`idempotencyKey` dedups a replay/`:fork`/retry before the dial. A synchronous
nodemailer send reconciles cleanly (get-before-send, put-on-accept with the
returned `messageId`). No clock/random in the transport.

Retention: the shared `email:sent` ledger's TTL sweep (`sweepExpiredEmailSent`,
`OPENWOP_EMAIL_LEDGER_TTL_DAYS` default 30) covers SMTP-recorded rows too — it
sweeps by `createdAt` regardless of which transport wrote the row (closes the
ADR 0193 §Retention follow-up).

## Falsifiability / the one no-go condition

If application-layer IP validation cannot be made rebind-safe for the SMTP dial —
i.e. nodemailer re-resolves the host independently of the guarded `lookup`, so
the validated address is not the dialed address — then SMTP cannot be made safe
at this layer and this ADR reverts to **deferred** (network-level egress control
required). The implementation MUST prove the guarded `lookup` is honored (a test
that a host resolving to a denied IP is refused at dial).

## Phased plan

| Step | Scope | Gate |
|---|---|---|
| 1 | `smtpEgress.ts` — port allowlist + tenant-host policy reuse + rebind-safe guarded lookup | security-critical; built + tested first |
| 2 | `smtp` builtin manifest (`basic`) + sealed `{host,port,secure,user,pass}` blob | reuse BYOK envelope |
| 3 | `emailAdapter` `sendViaSmtp()` transport branch + shared ledger | single send owner |
| 4 | `nodemailer` dep + pin + lockfile | supply-chain review recorded |
| 5 | Backend tests (dial-allow/deny/SSRF-baseline/port/rebind, sealed-cred non-logging, replay dedup) | mock transport, no real network |
| 6 | Frontend "Add SMTP server" connection form (host/port/user/pass/secure) | `/ux-review` surface |

## Open questions

- [ ] Should port 25 ever be allowed (plaintext MX submission)? Default **no**
      (cloud-blocked, plaintext). Revisit only on a concrete need.
- [ ] Per-connection host:port pinning is enforced by the connection blob being
      the sole source of the dial target (an agent/config can't supply a host).
      Confirmed — the send reads host/port only from the resolved sealed blob.
