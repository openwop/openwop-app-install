# ADR 0394 — WhatsApp business messaging via the official BSP channel (Meta compliance-first)

**Status:** implemented (2026-07-17 — Phases 1–4; see § Implementation record)
**Date:** 2026-07-17
**Track:** A (Software & App Architecture).
**Decision source:** `docs/steward/MYNDHYVE-DECISIONS.md` § "Decision 6 — Bundled products … WhatsApp
official-BSP-only, drop iMessage/Signal bridges" **(6e)** — adversarially verified 2026-07-17.
This ADR implements 6e's v1 ruling: route WhatsApp through an official Business Solution
Provider (Twilio BSP **or** Meta Cloud API) on the existing ADR 0175 messaging-gateway seam,
technically + contractually guarantee no-training on WhatsApp data across BYOK **and** managed
keys, scope the WhatsApp-facing agent to defined functions, and track Meta's AI terms as a
**live** compliance dependency.
**Extends (does NOT fork):** ADR 0175 (Messaging Gateway — Connections + Triggers extension),
ADR 0024 (Connections credential brokerage + RFC 0095 connection packs), ADR 0034 / RFC 0099
(trigger bridge → `executeRun`), RFC 0083/0006 (interrupt external-event correlation), the
**consent** feature (opt-in ledger), ADR 0104/0324 (agent tool-grant + scoped tool provider),
ADR 0201 (TCP/HTTP egress firewall), ADR 0292 (governed vendor-write `adapterOnly`), the
`host/adsAdapter.ts` fork-stable-idempotency precedent, ADR 0126 (channel model), ADR 0148/0176
(metering + BYOK-first).
**Owner:** EXTENDS `features/connections/` (inbound + outbound seams) + a new small
`features/whatsapp/` compliance/health surface — **NOT a parallel gateway.**
**MyndHyve baseline:** none portable — MyndHyve shipped no compliant WhatsApp channel; 6e is a
net-new, compliance-led decision. iMessage/Signal/unofficial bridges are recorded as permanent
**non-goals** (Beeper precedent: Apple repeatedly broke Beeper Mini's reverse-engineered bridge
until Beeper ceased development Dec 2023; no credible SaaS position exists).

> **Compliance is the heart of this ADR.** Meta's WhatsApp Business Solution Terms effective
> **2026-01-15** add AI constraints: (i) general-purpose AI assistants are barred as **primary
> functionality**; (ii) external LLM providers (OpenAI, Anthropic, Perplexity named) are
> prohibited from **training on WhatsApp message data**; (iii) purpose-specific AI
> customer-service bots are **allowed**. GoHighLevel — the closest mid-market comparable — ships
> WhatsApp via the official Cloud API and self-attests no-training compliance. The design below
> is organized around making those three constraints **structurally true**, not aspirational.
>
> **Refuted-claims guardrails (do NOT design against these):** Meta does **not** pre-approve each
> business or use case — the verified reality is **contractual policy compliance + post-hoc
> enforcement** via a graduated ladder (quality rating → messaging-limit tiers → warnings →
> temporary blocks → **permanent removal**). Do not build or document a "Meta approval" gate; do
> build the **enforcement-awareness health surface** and the **opt-in / template discipline** the
> policies actually require.

---

## Context — boundaries & duplication audit (done first)

WhatsApp is a **new channel adapter inside ADR 0175's model**, not a second gateway. The
per-concern owner map (compose/extend, never fork):

| Concern | Existing owner (file:line) — WhatsApp is additive here |
|---|---|
| Inbound signature-verified ingress | **`features/connections/inboundWebhooks.ts:58`** — `InboundProvider = 'slack' \| 'discord' \| 'telegram'`; `inboundSupported()` at `:108`. WhatsApp adds `'whatsapp-twilio'` / `'whatsapp-cloud'` as **additive `InboundProvider` members** with their own verifiers (Twilio `X-Twilio-Signature` HMAC-SHA1 over URL+params; Meta Cloud `X-Hub-Signature-256` HMAC-SHA256 over the **raw body**), exactly as Discord (Ed25519) / Telegram (secret-token) were added. |
| Normalize platform payload → run | **`host/triggerIngestionService.ts`** → RFC 0099 `TriggerEvent{ source:'webhook', contentTrust:'untrusted' }`; **`host/triggerBridgeService.ts`** `deliver()` + `executeRun` (ADR 0034). Inbound WhatsApp message maps to a `TriggerEvent` — **no new dispatch engine**. Platform identity (`whatsapp`) is **host-private metadata**, never a wire `source` (ADR 0175's explicitly-rejected enum widening stands). |
| Outbound send + number pairing | **`features/connections/messagingOutbound.ts:13`** (`OutboundProvider`), `:27` `pairConnection`, `:43` `sendOutbound`. WhatsApp adds outbound members + a **broker transport**; per-tenant **number binding** rides `pairConnection` (connectionId ↔ WhatsApp phone-number id). |
| Credential brokerage (Twilio auth token / Meta app secret + WABA token) | **Connections** (ADR 0024, RFC 0095 connection packs) + BYOK secret resolver + the ADR 0201 egress firewall. **No new secret store.** The `whatsapp.send` node is `adapterOnly` (ADR 0292, `features/connections/providerRegistry.ts:68`,`:311`) so a generic `http.fetch` cannot bypass the governed send. |
| Opt-in / opt-out records | **`features/consent/consentService.ts`** — `recordConsent` (`:116`), `isPermittedForPurpose` (`:152`), `MarketingChannel` (`:21`), `DefaultMode` opt-in/opt-out (`:86`). WhatsApp opt-in is a **new additive `marketing.whatsapp` channel category**, keyed by the E.164 phone `subjectKey` (ADR 0263 identifier), capturing timestamp/source/method for Meta's opt-in audit. **No new ledger.** |
| Scoped agent (defined functions) | **ADR 0104** superadmin tool-allowlist (full-replace pins the agent) + **ADR 0324** `createScopedAgentToolProvider` (the ONE composer). The WhatsApp-facing agent is a **constrained agent profile** with a minimal tool allowlist — **NOT** the open-ended chief-of-staff. |
| Channel model / conversational resume | RFC 0083 §C interrupt external-event correlation + RFC 0005 chat / ADR 0126 channels (ADR 0175 P3 precedent). **No new session store.** |

**No new stores, no new gateway.** A standalone WhatsApp gateway/pipeline/session store would
duplicate connections-inbound + trigger bridge + outbound + consent and violate the
no-parallel-architecture rule (memory: `no-parallel-architecture`).

---

## Decision

Deliver WhatsApp as **(1) two additive BSP channel adapters** on the ADR 0175 seam, **(2) a
compliance layer** (a–d below) that makes Meta's 2026-01-15 constraints structurally true, and
**(3) a small `features/whatsapp/` health + enforcement-status surface**. No new wire vocabulary.

### Channel adapter (the ADR 0175 extension)

- **Inbound.** `whatsapp-twilio` / `whatsapp-cloud` `InboundProvider` members; per-provider
  signature verify on the existing raw-body seam (Twilio HMAC-SHA1 URL+params; Meta Cloud
  HMAC-SHA256 raw body), replay-windowed, timing-safe. Verified inbound → RFC 0099
  `TriggerEvent{source:'webhook', contentTrust:'untrusted'}` → `executeRun`. Inbound body is
  `<UNTRUSTED>`-fenced and redacted out of `trigger.*` events (RFC 0099 §F invariant).
- **Outbound send with the template ⁄ session-message distinction + the 24h window (hard Meta
  rule).** The outbound seam tracks **last-inbound-timestamp per recipient conversation**.
  Within **24h** of the customer's last inbound message → a free-form **session message** is
  allowed. Outside the window → **only a pre-approved template message** may be sent
  (template id + parameters). The `whatsapp.send` node enforces this pre-send and returns a
  **typed failure** (never success-with-empty) when a session message is attempted outside the
  window.
- **Opt-in / opt-out ledger.** Send is gated `isPermittedForPurpose(tenant, phoneSubjectKey,
  'marketing-whatsapp')` fail-closed; an inbound `STOP`/opt-out writes a `revoke` consent record;
  opt-in is captured at collection time with source/method for the Meta audit trail. Default
  mode is **opt-in** for `marketing.whatsapp` regardless of tenant region (Meta requires explicit
  opt-in per number — stricter than the regional default).
- **Per-tenant number binding.** Each tenant binds its own WhatsApp phone-number id via a
  Connection (`pairConnection`); a message routes to the run of the tenant that owns the number.

### Compliance mechanisms (the heart)

**(a) No-training guarantee across BYOK AND managed keys.**
- **Managed keys:** the platform contractually + technically configures **no-train + zero-data-
  retention** on the managed provider accounts used for any WhatsApp-scoped run (Anthropic
  zero-retention, OpenAI zero-data-retention/no-train, Google API no-train-by-default). A model
  whose provider offers **no** no-train / zero-retention option is **excluded from the WhatsApp
  agent's model allowlist** (technical enforcement, not a footnote).
- **BYOK:** the platform cannot control the tenant's provider-account settings, so the BYOK
  WhatsApp path is **attestation-gated** — enabling WhatsApp with a BYOK model surfaces a
  **blocking warning** ("Meta prohibits your LLM provider from training on WhatsApp message
  data; confirm your provider account has training disabled / zero-retention enabled") and
  records the tenant attestation. Where the provider API exposes a per-request no-train flag,
  the WhatsApp path sets it regardless of BYOK/managed.
- **Disclosure:** the no-training posture (which providers, which retention mode) is surfaced in
  operator docs + the health surface so the operator's own Meta attestation is truthful.

**(b) The WhatsApp-facing agent is SCOPED to defined functions (Meta "primary functionality"
ban).** A dedicated `feature.whatsapp.agents` pack ships a **constrained agent profile** — a
purpose-specific customer-service persona, **not** the chief-of-staff — driven through the ONE
chat (RFC 0005) via the ADR 0058 chat-drivability pattern. Its tool grant is a **minimal
allowlist** composed by `createScopedAgentToolProvider` (ADR 0324) and pinned by the ADR 0104
full-replace grant: only the defined-function tools (e.g. order status, appointment, FAQ
lookup), **never** the open-ended web/exec/authoring tools of a general assistant. This is the
structural answer to open question 6e-4 ("where an open-ended agent falls under Meta's primary-
functionality ban").

**(c) Template messaging + opt-in rules.** Templates are pre-registered with the BSP/Meta and
referenced by id; the 24h-window rule (above) is enforced in the node. Marketing-category
templates require an opted-in recipient; utility/authentication templates follow their category
rules. Opt-in is captured and honored through the consent ledger; opt-out is immediate and
fail-closed.

**(d) Meta enforcement-ladder awareness (health surface + operator docs).** A
`features/whatsapp/` health surface reads the WABA **quality rating** (high/medium/low) and
**messaging-limit tier** from the BSP/Cloud API and renders them in the admin health panel, with
the graduated ladder documented (quality drop → tier throttle → warning → temporary block →
**permanent removal**). Operator docs state the verified reality: **no pre-approval**;
compliance is contractual + post-hoc-enforced. A low quality rating or an active block raises an
operator alert.

### Feature evaluation matrix (10 rows)

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package architecture | Channel adapter extends `features/connections/`; a small `features/whatsapp/` owns only the compliance/health surface. No parallel gateway; no global mutation. |
| 2 | Toggle + admin UI (bucketing) | **New `whatsapp` channel toggle, OFF, `bucketUnit: tenant`** — NOT an extension of a `messaging` toggle. Justification: WhatsApp carries a distinct **compliance + BSP-terms + billing + opt-in** surface an operator must be able to gate **independently** (run Slack/Discord/Telegram without accepting Meta's BSP terms); number binding, WABA, and per-conversation billing are tenant-level (matches ADR 0126/0175 tenant bucketing). Category **Integrations**. |
| 3 | Workflow + node packs | `feature.whatsapp.nodes`: a `whatsapp.send` node — **gated + governed** (`adapterOnly`, ADR 0292; egresses only via the broker + ADR 0201 firewall, never generic `http.fetch`), enforces template-vs-session + 24h window + opt-out pre-send, typed-failure on violation. Inbound reuses the trigger path (no inbound node). |
| 4 | AI-chat envelopes + agent packs | `feature.whatsapp.agents` = the **scoped** customer-service agent (b). No new RFC 0021 envelope kind — rides the existing chat dispatch + tool loop; the agent's schema/tools are allowlisted, never added to the ADR 0315 default-on baseline. |
| 5 | RBAC (fail-closed, IDOR, uniform-404) | read `workspace:read`; **send** `workspace:write`; number binding / template management / toggle = **tenant-admin**; opt-out honoring enforced pre-send fail-closed; tenant-prefix scoping on every store; uniform 404. |
| 6 | Replay / fork safety | **Outbound idempotency key is fork-stable per the `host/adsAdapter.ts` precedent** (`idemKeyFor` at `:404`, `ads:dispatch` `DurableCollection` at `:225`): key = `tenant + recipient(+conversation) + template/message-hash`, **NEVER `runId`** — a `:fork` reuses the recorded id so a **paid** WhatsApp message is never double-sent (same paid-side hazard as an ad publish). Store `whatsapp:dispatch` keyed by `idemKey`. Inbound dedups on the provider message id (like `tg:update_id`). |
| 7 | Privacy / secret-stripping | Inbound body `<UNTRUSTED>`-fenced + redacted from `trigger.*` (RFC 0099 §F); phone PII rides the ADR 0263 `identifiers` declaration (already `declarePiiFields`); secrets via BYOK/Connections, never in events/dry-run plans; no-train/zero-retention on the model path (a). |
| 8 | Reuse-not-recreate | Reuses inbound webhooks, trigger bridge, `executeRun`, outbound seam, `pairConnection`, consent ledger, `createScopedAgentToolProvider`, `adsAdapter` idempotency shape, egress firewall. Net-new: two verifiers + broker transport + the compliance/health surface. |
| 9 | RFC gate honesty | **Host work only, no wire change.** Inbound normalizes to the already-Accepted RFC 0099 `TriggerEvent{source:'webhook'}`; the platform stays host-private metadata (ADR 0175's rejected-enum-widening precedent). No capability advertised. |
| 10 | Public surface hardening | ONE public endpoint: the connections-inbound webhook (existing `PUBLIC_PATH_PREFIXES` carve-out) — signature-verify-before-dispatch, replay window, raw-body discipline, rate-limited, uniform failure. No other public route; the health surface is authed tenant-admin. |

---

## Phased plan

**Order: Twilio BSP first, then Meta Cloud API direct.** Rationale: Twilio BSP abstracts Meta's
embedded-signup / WABA onboarding, template submission, and number provisioning behind one
integration and one signature scheme — **fastest time-to-value and lowest onboarding burden**.
The Meta Cloud API direct adapter (added in a later phase) removes the Twilio per-message markup
for margin; both are additive `InboundProvider`/`OutboundProvider` members behind the **same**
channel model, so the second adapter is incremental.

- **Phase 1 — Twilio BSP inbound + outbound.** `whatsapp-twilio` verifier (`X-Twilio-Signature`)
  → `TriggerEvent`; broker outbound transport; per-tenant number binding via `pairConnection`;
  the `whatsapp.send` node (governed, template/session + 24h window); route-harness tests
  (signature accept/tamper/stale, opt-out-fail-closed, window enforcement, fork-stable
  idempotency = no double-send).
- **Phase 2 — Compliance layer.** `marketing.whatsapp` consent category + opt-in/opt-out flows;
  the scoped `feature.whatsapp.agents` pack + ADR 0104/0324 tool allowlist; no-train enforcement
  (managed model allowlist filter + BYOK attestation gate); operator docs.
- **Phase 3 — Health + enforcement surface.** WABA quality-rating + messaging-tier read;
  admin health panel; low-rating/block alerts; enforcement-ladder docs.
- **Phase 4 — Meta Cloud API direct adapter.** `whatsapp-cloud` verifier
  (`X-Hub-Signature-256`, raw body) + Cloud API broker transport; the compliance layer and node
  are unchanged (reused). Operator chooses Twilio **or** Cloud API per number.

---

## Implementation record (2026-07-17)

| Phase | Landed as | Gate result |
|---|---|---|
| 1 — Twilio BSP in/out | `whatsapp-twilio` InboundProvider + `verifyTwilioSignature` (URL+params HMAC-SHA1; urlencoded parser on the inbound prefix) + `features/whatsapp/` (service + surface + toggle + seedCoverage ACK) + `feature.whatsapp.nodes` + SMS-adapter hardening | `test/whatsapp-channel.test.ts` (signature trio, window, consent, idempotency, bypass) |
| 2 — Compliance layer | `compliance.ts` (attestation store + `registerInboundGate` fail-closed dispatch gate + STOP/START ladder), `host:whatsapp:manage` scope + attestation routes, `feature.whatsapp.agents` scoped persona, `marketing.whatsapp` STRICT consent | gate/keyword/RBAC tests green |
| 3 — Health surface | `health.ts` (Twilio Senders read, tolerant parse, `openwop-app.whatsapp.health-degraded` event) + the health route; `twilio` manifest gains `messaging.twilio.com` | tolerant-read path unit-covered via route |
| 4 — Meta Cloud direct | `whatsapp-cloud` InboundProvider (`verifyMetaCloudSignature` raw-body HMAC-SHA256 + GET `hub.challenge` handshake) + the `whatsapp-cloud` adapterOnly manifest + the Cloud graph send transport (template name + language) | Cloud verifier/handshake/inbound/send tests green |

**Correction notes (as-built deviations, architect-ruled):**

1. **The send node carries no gates.** Matrix row 3 put enforcement "in the node"; the
   capability firewall cannot see node calls (the standing invariant), so every gate —
   consent, window, template rule, idempotency — lives in `whatsappService.sendWhatsApp`,
   and the pack node is a thin `ctx.features.whatsapp.send` caller. `sideEffecting` rides
   the executor pattern list (the pack-manifest schema has no such field).
2. **No second Twilio identity.** The Twilio transport rides the EXISTING `twilio`
   connection (`AccountSid:AuthToken`, basic; `messaging.twilio.com` added for the health
   read) — the credential is identical and a parallel manifest would double-provision.
   The bypass this opens (SMS path → `whatsapp:` recipient) is closed in `smsAdapter`
   instead. The Cloud transport gets its own `whatsapp-cloud` `adapterOnly` manifest.
3. **v1 no-train enforcement = ONE tenant attestation** gating inbound AI dispatch
   fail-closed (`registerInboundGate` — a verified message for an unattested tenant is
   acked and dropped, so WhatsApp data structurally never reaches a model path). This
   supersedes the (a) managed-allowlist/BYOK split until a per-run model-policy seam
   exists; the managed no-train posture is disclosed in `OPENWOP-WHATSAPP.md` so the
   operator's attestation is truthful.
4. **Boundary vs the demo relay gateway** (missed by the § Context audit): `src/messaging/`
   models `whatsapp` as a self-hosted device-relay channel. It is a disjoint lane (the
   operator's own CLI owns the platform connection) and gains no coupling to this channel.
5. **Consent strictness is IN the single evaluator** (`STRICT_EXPLICIT_OPT_IN` inside
   `isAllowed`) — no second evaluator; the umbrella grant, the `opt-out` policy default,
   and the consent-toggle-off permissive escape never permit `marketing.whatsapp`. The
   email preference-center page scopes to its own channels for the same reason.
6. **Observer/gate hooks** (`registerInboundObserver` / `registerInboundGate`) were added
   to the connections seam as the dependency-inversion mechanism (the `onConnectionRevoked`
   pattern) so connections never imports a feature.

## Alternatives considered

1. **On-device / on-Mac relay (iMessage-style).** Rejected — **verified** dead end: Apple
   repeatedly broke Beeper Mini until Beeper ceased development (Dec 2023, never restored; the
   2025 relaunch requires the user's own Mac). No SaaS position exists. Permanent **non-goal**.
2. **Unofficial WhatsApp bridges (web-automation / reverse-engineered).** Rejected — violates
   Meta's terms and risks number bans; no credible SaaS product ships this. Permanent **non-goal**.
3. **Wait for RCS Business Messaging instead.** Rejected as a *replacement* — RCS is a
   complementary future channel, not a substitute for the WhatsApp install base; the ADR 0175
   channel-adapter seam makes RCS a later additive adapter, not a reason to defer WhatsApp.
4. **Meta Cloud API direct first (skip Twilio).** Rejected as the *first* step — higher
   onboarding burden (embedded signup, WABA, template submission) for the same v1 outcome;
   sequenced as Phase 4 for margin once the channel is proven.
5. **Extend a generic `messaging` toggle rather than a dedicated `whatsapp` toggle.** Rejected —
   conflates Meta's BSP-terms/compliance/billing surface with the terms-free Slack/Discord/
   Telegram channels; the operator must gate WhatsApp independently (matrix row 2).
6. **A parallel WhatsApp gateway package.** Rejected — duplicates inbound/trigger/outbound/consent
   (no-parallel-architecture rule; ADR 0175 §Port-not-clone).

---

## Open questions

- [ ] **Meta terms evolution = a live compliance dependency.** The 2026-01-15 AI constraints will
  change; the health surface + operator docs must be revisited on each Business Solution Terms
  revision. Assign an owner to track (mirrors 6e residual Q4).
- [ ] **Per-tenant WABA vs a platform-owned WABA.** Per-tenant WABA (each operator/tenant owns
  its Meta Business + number) isolates quality-rating/enforcement blast radius but raises
  onboarding friction; a platform WABA is turnkey but shares the enforcement fate across tenants.
  Lean per-tenant for isolation; decide with the first design partner.
- [ ] **Pricing pass-through.** WhatsApp bills per-conversation (Meta) + per-message markup
  (Twilio). Compose the ADR 0148/0176 metering + transparency surfaces (real dollars, no
  "unlimited"); disclose the pass-through. Managed-markup-vs-at-cost mirrors Decision-5 open Q2.
- [ ] **BYOK no-train attestation strength.** Attestation + best-effort per-request flags vs
  hard-blocking BYOK for WhatsApp entirely. Ship attestation-gated in v1; revisit if Meta
  tightens enforcement of the provider-training clause.

## RFC verdict

**None — host work only.** Inbound rides the **already-Accepted** RFC 0099 trigger bridge
(`TriggerEvent{source:'webhook'}`) + RFC 0083/0006 interrupt correlation, exactly as ADR 0175;
the platform stays host-private metadata (the first-class per-platform `TriggerEvent.source`
enum widening remains **explicitly rejected** — that alone would need an RFC). Credentials ride
ADR 0024 Connections / RFC 0095 packs; the send node rides ADR 0292 governed-write. No new
run-event field, capability flag, event type, or normative `MUST` on the wire. Advertising no
capability keeps `OPENWOP_REQUIRE_BEHAVIOR=true` honest.

Cross-references ADR 0175 (messaging gateway), ADR 0024/0034, RFC 0099/0083/0006/0095, ADR
0104/0324 (scoped agent), ADR 0201/0292 (egress + governed write), ADR 0263 (identifiers),
ADR 0148/0176 (metering/BYOK), `host/adsAdapter.ts` (fork-stable idempotency),
`docs/steward/MYNDHYVE-DECISIONS.md` §6e.
