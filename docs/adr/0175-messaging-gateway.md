# ADR 0175 — Messaging Gateway (Slack/Discord/Telegram) as a Connections + Triggers extension

**Status:** implemented (Phases 1–3 — 2026-07-01). P3 conversational resume: a per-connection session tracks the active run; `pickResumeInterrupt` resolves-and-resumes an open interrupt on that run (feeding the follow-up message) instead of starting a new run — inside the dedup wrapper, via the host `resolveAndResume`. Tests +5 (resume decision). **P1** — `InboundProvider` extended to
`slack|discord|telegram`; `verifyDiscordSignature` (Ed25519, replay-windowed) +
`verifyTelegramSecret` (constant-time token) added to `connections/inboundWebhooks.ts`;
per-provider verify/handshake (Discord PING→PONG via a new `respond` outcome)/dedup
(event_id · interaction id · `tg:update_id`), all normalizing to the SAME trigger-bridge
dispatch (`TriggerEvent{source:webhook}`, ADR 0034) — MyndHyve's M5 execution gap closed
for free. **P2** — host-local Discord slash commands (`/help`,`/status`,`/pair` reply
synchronously, no run/outbound; `/run` + app commands fall through to fire the workflow).
Tests: `messaging-gateway-inbound.test.ts` (8 — Ed25519 accept/tamper/stale/cross-key,
Telegram token, slash-reply). **P3 (conversational resume) + the full slash matrix
(Telegram/Slack OUTBOUND replies, `/pair` linking) are sequenced follow-ons** — they ride
the existing RFC 0083 §C interrupt-correlation + outbound-integration surfaces (no new
store). Rides Accepted RFC 0099/0083/0006 — no new RFC; `TriggerEvent.source` stays `webhook`.
**Date:** 2026-07-01

> **§Deferred-work follow-on landed (2026-07-01):** `/pair` linking + the outbound-send seam (`messagingOutbound.ts` — pluggable transport, mock-tested) shipped. Live platform delivery + the Discord persistent gateway socket remain operator/transport last-mile.
**Track:** A (Software & App Architecture). **No OpenWOP wire change → no RFC**
(rides Accepted RFC 0099 + RFC 0083/0006).
**Extends (does NOT fork):** ADR 0024 (Connections — `features/connections/inboundWebhooks.ts`,
the inbound-webhook seam; Slack already wired), ADR 0034 / RFC 0099 (external-event
trigger ingestion — `host/triggerIngestionService.ts` + `host/triggerBridgeService.ts` +
`POST /v1/trigger-subscriptions`), RFC 0083/0006 (interrupt external-event correlation),
ADR 0126 (Team Channels — channel model), RFC 0005 (the one chat).
**Owner:** EXTENDS `features/connections/` + the host trigger seam — **NOT a new
`messaging-gateway` feature package.**
**MyndHyve baseline:** `functions/src/messaging-gateway/` (24 files — `pipeline.ts`,
`verification.ts`, `normalizers/*`, `dispatcher.ts`, `commands.ts`); FEATURES.md
§ "Messaging Gateway" (dispatch execution marked **Partial — M5 TODO**).

> **Boundaries-audit headline (2026-07-01): openwop-app already implements the
> inbound leg.** `features/connections/inboundWebhooks.ts` is nearly verbatim the
> MyndHyve gateway — provider-signature-verified public endpoint per connection →
> ride the RFC 0083/0099 trigger bridge → start a per-tenant run. **Slack is already
> built.** A standalone `messaging-gateway` package would duplicate connections-inbound
> + triggerBridge + triggerIngestion. This is an **extension**, not a gateway port.
> MyndHyve's "Partial" (the run doc is created but execution is never dispatched — M5)
> is **already closed for free** by openwop's `executeRun` thunk on the trigger path.

---

## Context — boundaries & duplication audit (done first)

Per-concern owner map (compose/extend, never fork):

| Gateway concern | Existing openwop-app owner |
|---|---|
| Inbound signature-verified ingress | **`connections/inboundWebhooks.ts`** — `verifySlackSignature` (HMAC v0, `timingSafeEqual`, replay window), public `/connections-inbound/:connectionId`, `InboundProvider` type (Slack wired; Discord/Telegram are additive members). |
| Normalize platform payload | **`host/triggerIngestionService.ts`** → RFC 0099 `TriggerEvent{ source:'webhook' }`. Platform-specific field mapping is host-private normalization. |
| Dispatch-to-run | **`host/triggerBridgeService.ts`** `deliver()` / `registerSubscription()` (RFC 0083 §C dedup→causation→retry); `inboundWebhooks.ts` already imports these. **`executeRun` already runs it** (ADR 0034), closing MyndHyve's M5 gap. |
| Session / conversational resume | RFC 0005 chat + the **interrupt external-event correlation** surface (RFC 0083 §C / RFC 0006). Feeding a message to an in-flight run is already-Accepted wire — not a new session store. Channel model → ADR 0126. |
| Credential brokerage (signing secret / bot token / Discord pubkey) | **Connections** (ADR 0024, RFC 0095 connection packs) + BYOK secret resolver. Not a new secret store. |
| Slash `/run` | Trigger→run (workflow start). |
| Slash `/help /status /pair` | Host-local synchronous request/response — **no run, no wire.** `/pair` reuses connection linking. |

**No new stores:** MyndHyve's `messagingSessions` / `messaging_delivery_log` /
`messagingConnectors` map onto existing **connection rows** + **trigger-delivery**
collections + the **chat/channels** model — do not re-create them.

## Decision

Deliver the Messaging Gateway as three additive extensions:

1. **Connections inbound providers** — extend `InboundProvider`
   (`inboundWebhooks.ts:35`) with `'discord'` (Ed25519 verify) and `'telegram'`
   (secret-token verify) alongside the wired `'slack'` (HMAC). Each is a signed
   RFC 0095 connection pack; the Slack path is unchanged.
2. **Host normalizers** — per-platform payload → RFC 0099 `TriggerEvent{ source:'webhook',
   contentTrust:'untrusted', webhook:{method,headers,body} }`; platform identity is
   host-private metadata, NOT a wire `source`. Registration via the already-wired
   `POST /v1/trigger-subscriptions`; dispatch via the existing bridge + `executeRun`.
3. **Slash commands** — `/help`, `/status`, `/pair` as **host-local synchronous
   replies** (no run, no wire); `/run` sets the trigger→run path (workflow start).

### Port-not-clone corrections
- **Not a new gateway package / engine.** Reuse connections-inbound + the trigger
  bridge; a parallel pipeline/dispatcher/session store violates the no-parallel-
  architecture rule (and ADR 0034 §Boundaries).
- **MyndHyve's M5 execution gap is not inherited** — the trigger path already executes.
- **Raw-body + timing-safe signature discipline** is the existing seam's; Discord
  Ed25519 / Telegram secret-token are additive verifiers, honesty-gated in
  `triggerBridge.ingestion.verification[]` (advertised only when wired).

## Phased plan
- **Phase 1 — Discord + Telegram inbound.** Add the two `InboundProvider` verifiers +
  connection packs + host normalizers → `TriggerEvent{source:webhook}`; route-harness
  tests (signature verify pass/fail, replay-window, SSRF, run-start causation).
- **Phase 2 — Slash commands.** `/help /status /pair` host-local replies; `/run` →
  trigger→run; per-connection command policy (allowlist).
- **Phase 3 — Conversational resume.** Feed a follow-up platform message to an in-flight
  run via the interrupt external-event correlation surface (RFC 0083 §C); scoped to a
  connection's linked conversation (RFC 0005 / ADR 0126). No new store.

## /prd five-architect compatibility pass

| Architect | Verdict |
|---|---|
| **Spec** | No new wire vocabulary. Inbound events normalize to the **already-Accepted** RFC 0099 `TriggerEvent{source:'webhook'}`; slash `/help /status /pair` touch **no** wire (no run). |
| **Schema** | No new/changed wire schema. `triggerBridge.ingestion.verification[]` **widens additively** (RFC 0099 UQ1: the enum is extensible, an advertised check MUST be performed, consumers tolerate subsets). Discord Ed25519 / Telegram secret-token are additive host verifiers. |
| **Security** | Signature-verify-before-dispatch (timing-safe, replay window) on the existing raw-body seam; inbound body fenced `untrusted` + redacted out of `trigger.*` events (RFC 0099 §F invariant); secrets via BYOK. Public endpoint rides `PUBLIC_PATH_PREFIXES` (the connections-inbound carve-out). |
| **Conformance** | Rides the existing `triggerBridge.ingestion` conformance surface + `interrupt-external-event-correlation` fixture; a widened `verification[]` is honesty-gated under `OPENWOP_REQUIRE_BEHAVIOR`. No new scenario needed. |
| **Compatibility** | **Additive.** New `InboundProvider` members + normalizers + host-local slash handlers; Slack path + every existing wire contract unchanged. |

**RFC gate: none.** ⚠️ **Explicitly rejected (would need an RFC):** promoting
`slack`/`discord`/`telegram` to first-class `TriggerEvent.source` enum members (so a
portable workflow could gate on "came from Slack") — that widens a normative closed
enum + adds per-source sub-objects. We normalize to `source:'webhook'` and carry the
platform in host-private metadata (mirroring ADR 0034 §Alternatives 3).

## Alternatives considered
1. **A standalone `messaging-gateway` feature package.** Rejected — duplicates
   connections-inbound + trigger bridge + ingestion; a parallel engine/session store.
2. **First-class per-platform `TriggerEvent.source`.** Rejected — widens a normative wire
   enum (needs an RFC) for no host benefit; `webhook` + metadata suffices.
3. **A new session store for conversational resume.** Rejected — the interrupt
   external-event correlation surface + the chat primitive already model it.

## Open questions
- [ ] **Discord interactions vs gateway.** Ship the Interactions webhook (Ed25519) first;
  the persistent gateway socket is a separate transport concern, deferred.
- [ ] **Outbound replies.** `/help` etc. reply synchronously; async run-result delivery
  back to the platform composes the outbound Connections integration nodes (ADR 0024 §4).
- [ ] **Per-connection command policy.** Allowlist which slash commands a connection may
  invoke — a connection-config field, not a new gate.
