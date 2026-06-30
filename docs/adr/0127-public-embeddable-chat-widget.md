# ADR 0127 — Public embeddable chat widget (external-site, domain-allowlisted)

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): the `WidgetConfig` store + authed admin CRUD. `features/chat-widget/` — provision/list/get/patch/rotate-token/delete (authorizeOrgScope, IDOR-404), MANDATORY non-empty `allowedDomains` (DEFAULT-DENY), `caps`, an unguessable `wgt_` capability token (rotatable), toggle `chat-widget` OFF/tenant. **Phase 2a (allowlist matcher) implemented** (2026-06-24): `originAllowlist.ts` — the pure, security-critical Origin/Referer domain matcher. A bare-domain entry admits apex+subdomains; a subdomain entry admits only that host; host-suffix matching on a `.`-boundary REJECTS the eTLD+1 spoof class (`acme.com.evil.com` ∌ `acme.com`). DEFAULT-DENY (empty allowlist / absent / unparseable → false). The public gateway routes (calling this) + cap enforcement + untrusted visitor input + PUBLIC_PATH_PREFIXES (Phase 2b) — still NOTHING public ships. Phases 2b–6 pending. **Date:** 2026-06-23
**Toggle:** `chat-widget` · default **OFF** · `bucketUnit: tenant` (a per-tenant public-facing surface; a widget instance must additionally be explicitly provisioned + domain-allowlisted before it serves).
**Surface:** a feature-package `src/features/chat-widget/` exposing **authed admin/config** routes (`/v1/host/openwop-app/chat-widget/*`) + a **PUBLIC, capability-token-gated** runtime surface (`/v1/host/openwop-app/widget/*`) added to `PUBLIC_PATH_PREFIXES`. Host-extension, non-normative — no new wire contract.
**Depends on / composes (all implemented — this is a public gateway over existing chat, NOT new chat):**
- **ADR 0073 (Embeddable conversation view)** — the public widget renders the **same** slimmed `ConversationView` / `EmbeddedConversation` (`frontend/react/src/chat/`). It is the **ONE chat**, embedded — see the explicit "does not reimplement chat" declaration below.
- **ADR 0013 (Sharing — capability token + public-surface pattern)** — the unguessable token recipe (`randomBytes(32)`), the `PUBLIC_PATH_PREFIXES` discipline, tenant-from-resource, and uniform-404 are reused for the widget's public gateway.
- **ADR 0024 (Connections — credential broker) / BYOK** — **which agent + which key backs a public widget.** A public visitor has no BYOK; the widget binds to a host-managed or designated agent whose provider key is resolved by the broker for a **host/widget-owned identity**, never a visitor's. This is the load-bearing decision (it is why the widget is OFF by default and tightly governed).
- **ADR 0058-pattern (chat-drivability = agent + nodes) / ADR 0073 agent scoping** — the widget is **scoped to one designated agent** (persona + tool allowlist via `agentProfile`); it cannot reach arbitrary agents, tools, or conversations.
- **ADR 0027 (content trust)** — visitor input is untrusted external content; the agent's prompt assembly fences it (the existing `promptInjectionGuard` wrap site).

**RFC verdict:** **host-extension (non-normative public route) — NO new RFC.** The widget embeds the existing chat behind a host-owned public gateway under `/v1/host/openwop-app/*`; it advertises no capability and touches no OpenWOP wire surface. A normative cross-host "public embed" contract would earn an RFC then — not now.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §11 (gap catalog, item B19): OpenWOP can embed chat **in-app** (ADR 0073's `EmbeddedChatPanel`, BYOK-gated) but has **no PUBLIC, external-site embeddable widget** — the lead-gen / support-bot surface every competitor ships. Competitor impl path: **AnythingLLM** `server/models/embedConfig.js` + the `embed/` submodule (per-embed domain allowlist, per-session/per-day message caps, model/prompt overrides, a JS snippet). The boundaries audit (below) shows the *chat* is 100% existing; the net-new is the **public gateway + governance**.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a public chat: a new chat UI, a new message loop, a new provider call, a new public API." **Every one of those already exists** — and rebuilding the chat is the exact fragmentation `CLAUDE.md` forbids ("ONE AI chat … do NOT build a new chat panel"). What is genuinely missing is the **public gateway + abuse governance + the public-identity key binding** around the existing chat.

| Concern | Existing owner (file:line) | How the widget reuses it |
|---|---|---|
| The chat UI (feed + composer + interrupt cards, no rails) | ADR 0073 — `chat/ConversationView` + `EmbeddedConversation` (`frontend/react/src/chat/`) | The widget renders **`EmbeddedConversation`** verbatim. It is the in-app embed minus the BYOK gate, plus a public config provider. **No new chat component.** |
| Turn dispatch / streaming / interrupts / persistence | `useChatSession` (`chat/`), `conversations/open` (`routes/chatSessions.ts:665`) | A widget session is a normal conversation, scoped to the widget's agent. No new message loop. |
| Capability token + public-surface pattern | ADR 0013 — `randomBytes(32)`, `PUBLIC_PATH_PREFIXES` (`middleware/auth.ts:85,145`) | The embed **capability token** authorizes a public widget session; tenant from the widget config (never the request). No new token recipe. |
| Which provider key backs the chat | ADR 0024 broker + BYOK | The widget resolves a **host/widget-owned** connection/key (not a visitor's) — the one new binding decision (below). |
| Agent persona + tool allowlist | ADR 0073 scoping / `agentProfile` | The widget binds to ONE designated agent; tools are that agent's allowlist. No new agent. |
| Untrusted-input fencing | ADR 0027 — `promptInjectionGuard.wrapForLLMPrompt()` | Visitor messages enter the prompt fenced as untrusted. |
| SSRF-safe egress for any tool calls | RFC 0076 — `ctx.http.safeFetch` | Inherited by the agent's nodes; unchanged. |

**Net new (the gateway + governance, NOT chat):** a `WidgetConfig` entity (which agent, which key-binding, the **domain allowlist**, per-session + per-day **message caps**, optional model/system-prompt overrides), an **embed capability token** + a tiny JS snippet that loads `EmbeddedConversation` in an iframe/shadow root, the **public runtime routes** (start session → bounded message loop) with **domain allowlist + Origin/Referer check + caps + abuse mitigation**, and the admin UI to provision/rotate/revoke a widget. **Zero new chat code.**

---

## Decision

Ship a **`chat-widget` feature-package** that exposes the **existing `EmbeddedConversation`** (ADR 0073) on **external sites** behind a **public, domain-allowlisted, capability-token-gated, rate-capped gateway**. The widget is a *governance + delivery* layer over the one chat — it **does NOT reimplement chat**. It is **distinct from ADR 0073's `EmbeddedChatPanel`** (which is **in-app, authenticated, BYOK-gated**); the widget is **public, unauthenticated-visitor, host-key-backed, and tightly governed**.

> **Explicit non-reimplementation declaration (the load-bearing constraint).** The widget renders `frontend/react/src/chat/EmbeddedConversation` — the *same* `ConversationView` feed/composer/interrupt-cards the full chat and the in-app embed use (ADR 0073). It supplies only: (a) a **public config provider** (resolving the widget's agent + host-key binding instead of a logged-in user's BYOK), and (b) the **public gateway** that fronts it. If any reviewer sees a second message feed, composer, or provider-dispatch loop in this package, the design has failed. The `CLAUDE.md` "reuse, never recreate" rule is the acceptance test.

### The public-identity key binding (the real new decision — why this is OFF by default)

A public visitor has **no BYOK**. So the widget must answer: *whose key pays for the inference?* Decision: a `WidgetConfig` binds to **either** a **host-managed provider key** (the `OPENWOP_MANAGED_*` path, governed by the existing managed daily-usage cap) **or** a **designated org Connection** (ADR 0024) the org admin explicitly grants the widget identity (`connections:use` for a host/widget service principal, NOT a human visitor). The run acts as a **widget service identity**, never as a human; the broker's confused-deputy guard (ADR 0024 §D2) applies. Because this spends the host's/org's money on behalf of anonymous traffic, the feature is **default OFF**, each widget is **explicitly provisioned**, and per-session + per-day caps + the domain allowlist are **mandatory** (not optional) on every config.

### Data model

```
WidgetConfig                              // tenant/org-scoped config
  { widgetId, tenantId, orgId,
    agentId,                              // the ONE designated agent (ADR 0073 scoping; persona = agentProfile)
    keyBinding,                           // 'managed' | { connectionId }   (ADR 0024 — never a visitor key)
    allowedDomains: string[],             // exact eTLD+1 / host allowlist (Origin/Referer checked)
    caps: { perSessionMessages, perDayMessages, perDaySessions },
    overrides?: { systemPromptAppend?, model? },   // bounded; persona stays the agent's
    embedToken,                           // the public capability token (rotate/revoke)
    status,                               // active | paused | revoked
    createdBy, createdAt, updatedAt }

WidgetSession                             // per public visitor session (ephemeral, capped)
  { sessionId, widgetId, tenantId, conversationId,  // → a real conversation (conversations/open)
    origin, startedAt, messageCount }
```

### Public runtime surface (capability-token + domain-gated)

```
# PUBLIC (added to PUBLIC_PATH_PREFIXES) — the embed token is the credential
POST /v1/host/openwop-app/widget/:embedToken/session     # start a session: Origin/Referer ∈ allowedDomains, caps not exceeded → conversationId + a short-lived session token
POST /v1/host/openwop-app/widget/:embedToken/message     # one bounded turn (session-token-bound; caps enforced) → routes to the existing chat dispatch for the scoped agent
GET  /v1/host/openwop-app/widget/:embedToken/config.js   # the loader snippet (renders EmbeddedConversation in an iframe/shadow root)
# AUTHED admin (NOT public)
POST/GET/PATCH/DELETE /v1/host/openwop-app/chat-widget/orgs/:orgId/widgets[/:widgetId]  # provision/list/rotate-token/revoke
```

### Public-surface discipline (fail-closed)
- **Tenant from the resource:** derived from `WidgetConfig` (looked up by `embedToken`), **never** the request.
- **Domain allowlist:** every public call checks `Origin`/`Referer` against `allowedDomains` at an eTLD+1/host boundary (the ADR 0024 `apiHosts` matching discipline — exact/subdomain, never substring); a non-allowlisted origin → uniform 404 (no existence leak), and the response carries the correct `Access-Control-Allow-Origin` only for allowlisted origins.
- **Caps mandatory:** per-session + per-day message caps + per-day session caps enforced server-side per `widgetId` (and per visitor where derivable); over-cap → a graceful "limit reached" turn, never an open spigot. The managed daily-usage cap is the second backstop on spend.
- **Uniform 404** on missing/revoked/paused/feature-off `embedToken`.
- **Rate-limit + payload caps:** the per-IP rate-limit middleware budget applies; message payloads are size-capped; no file upload on the public surface (v1).
- **Abuse mitigation:** an optional turnstile/captcha hook on session start, per-origin + per-IP throttles, and a kill-switch (pause/revoke the token) that takes effect immediately.

### RBAC & isolation
Provisioning/rotating/revoking a widget is `workspace:write` (+ `host:connections:use` on the bound Connection when `keyBinding` is a Connection) — **admin/owner only**, IDOR-guarded. The **public runtime is unauthenticated-visitor** but capability-token + domain + cap gated; a visitor session is confined to the widget's **one agent** and **one conversation** — it cannot enumerate or reach other conversations, agents, tools, or tenants. Tenant from the resource, fail-closed.

### Replay / fork safety
A widget turn is a normal scoped run; if the widget config influences a run (the agent/override), stamp `run.metadata.featureVariant`/widget binding at creation, read verbatim on `:fork` (ADR 0073/0014 precedent). The bound key is resolved as the **widget service identity** every time (never re-bound to a forker). Visitor input is `untrusted` (ADR 0027) — fenced before the LLM.

---

## Evaluation matrix

| # | Criterion | Verdict |
|---|---|---|
| 1 | Feature-package architecture | **Feature-package** `src/features/chat-widget/` (ADR 0001); composes `chat/` (lazy import direction respected) + Sharing-token + Connections; core untouched. |
| 2 | Toggle + admin/UI | `chat-widget` default OFF, `bucketUnit: tenant`; admin UI to provision/domain-allowlist/cap/rotate/revoke; each widget explicitly enabled. |
| 3 | Reuse-not-recreate | **Renders `EmbeddedConversation` verbatim** — zero new chat code; net-new is the gateway + governance + key-binding (explicit non-reimplementation declaration above). |
| 4 | Workflow + node packs | None new — the scoped agent uses its existing node/tool allowlist. |
| 5 | AI-chat envelopes + agent packs | Scoped to ONE designated agent (persona = `agentProfile`, ADR 0073); the widget does not add capabilities, it gates an agent. |
| 6 | Public surface discipline | New PUBLIC prefix `/v1/host/openwop-app/widget` on `PUBLIC_PATH_PREFIXES`; tenant from the resource; domain allowlist; capability token; uniform 404; per-IP + per-day caps; payload caps. |
| 7 | RBAC fail-closed | Admin-only provision/rotate/revoke; visitor confined to one agent + one conversation; `connections:use` for a bound key; tenant from resource. |
| 8 | Replay/fork safety | Scoped run; widget binding stamped on `run.metadata`; key resolves as the widget service identity; visitor input untrusted-fenced. |
| 9 | Caps / rate-limit / payload | **Mandatory** per-session/per-day message + session caps; managed daily-usage cap backstop; per-IP rate-limit; size-capped payloads; no public uploads (v1). |
| 10 | RFC gate | **Host-extension (non-normative public route) — NO RFC.** No capability advertised; no wire surface touched. |

---

## Phased plan

1. **`WidgetConfig` store + admin REST.** `features/chat-widget/{service,routes,feature}.ts`: provision/list/patch/rotate-token/delete (`workspace:write`, IDOR-404), mandatory `allowedDomains` + `caps` validation, `keyBinding` validation (managed available, or `connections:use` on the Connection). Toggle `chat-widget` OFF/tenant. +service + route tests.
2. **Public gateway (backend).** Add `/v1/host/openwop-app/widget` to `PUBLIC_PATH_PREFIXES`; implement `session`/`message` with Origin/Referer allowlist, capability-token resolve (tenant-from-resource), cap enforcement, uniform 404, the per-IP/per-day throttles, and the widget-service-identity key resolution (managed or bound Connection). Visitor input untrusted-stamped. +public-surface tests (allowlist bypass, cap exhaustion, revoked-token 404, cross-tenant isolation).
3. **Embed delivery.** `config.js` loader snippet + the public render that mounts **`EmbeddedConversation`** (ADR 0073) in an iframe/shadow root with the public config provider (widget agent + session token). **Lazy-import** `chat/` from this package (respect the import-direction rule; the package is not imported back by `chat/`). +the "does not reimplement chat" review gate.
4. **Admin UI.** A widgets page (provision a widget, set agent + key binding + domains + caps, copy the embed snippet, pause/rotate/revoke). `npm run build` gate green; `ui/` cohesion + a11y.
5. **Abuse hardening.** Optional captcha/turnstile hook on session start; per-origin throttle tuning; the immediate kill-switch; managed-spend dashboards. +abuse/load tests.
6. **Tests + docs.** Domain-allowlist enforcement (incl. eTLD+1 spoof reject), cap exhaustion → graceful limit turn, revoke → immediate 404, visitor confinement (cannot reach other agents/conversations), untrusted-fencing of a hostile visitor message, the no-second-chat-component review assertion.

## Alternatives weighed

1. **Build a new lightweight public chat UI + message loop (the obvious "it's just a widget" path).** Rejected outright — it forks the one chat (`CLAUDE.md`), drifts from interrupt/streaming/agent behavior, and doubles the maintenance + security surface. The widget embeds `EmbeddedConversation`; the only net-new is the gateway.
2. **Extend ADR 0073's `EmbeddedChatPanel` to "just work publicly."** Rejected — `EmbeddedChatPanel` is **BYOK-gated, in-app, authenticated**; a public visitor has no BYOK and no session. The public-identity key binding, domain allowlist, caps, and capability token are a *different* governance posture that must not weaken the in-app embed's gate. The widget composes the slimmer `EmbeddedConversation` with its own public provider, leaving `EmbeddedChatPanel` untouched.
3. **Back the widget with a visitor-supplied key.** Rejected — public visitors can't be asked for keys; the spend decision (host-managed or a designated org Connection, governed by caps) is the whole point of the governance layer.
4. **Open the widget to any agent / any tool by config.** Rejected — a public surface must be scoped to ONE designated agent with its own tool allowlist (ADR 0073 scoping); a configurable-any-agent public surface is an escalation vector.

## Open questions

1. **OQ-1 — Anonymous-visitor identity + persistence.** Does a returning visitor resume their prior widget conversation (a cookie/localStorage session token) or always start fresh? v1: ephemeral per page-load session; durable visitor identity is a follow-on (needs a privacy + retention decision).
2. **OQ-2 — Spend governance depth.** Per-widget budget ceilings + alerting beyond the per-day message caps (the managed-usage cap is the backstop) — how granular before v1?
3. **OQ-3 — Tool exposure on a public agent.** Which tool classes are safe for an anonymous-driven agent (read-only KB/RAG yes; write/integration tools almost certainly no)? Propose a curated public-safe tool allowlist as a hard default.
4. **OQ-4 — Lead capture / handoff.** Capturing a visitor email or escalating to a human (the support-bot pattern) — a follow-on that rides Notifications/CRM, not v1.
5. **OQ-5 — CSP / framing.** The snippet's iframe vs. shadow-root tradeoff and the host CSP a customer site must allow — pin in Phase 3.

> **Phase 2d (visitor dispatch) implemented** (2026-06-24):** POST `/widget/message` — the public, unauthenticated, STATELESS single-turn visitor dispatch. Fail-closed at every gate (unknown/disabled token → uniform 404; off-allowlist/absent Origin → 403; per-session/day caps (2c) → 429; deleted agent → uniform 404), all BEFORE any LLM call. HOST-OWNED key ONLY: dispatch rides `dispatchManagedChat` (managed `openwop-free`, charged to the widget's tenant) — a visitor can never supply/influence the key, and the key/tenantId/token never appear in the response (public projection = `{reply}` only). The untrusted visitor message is FENCED (`fenceUntrustedBlock`, ADR 0027) as the USER turn so it cannot override the agent persona (system turn). Input/reply bounded (4000 chars / 512 tokens); the global per-IP rateLimit also applies. STATELESS = no per-visitor run accumulation. /architect GO (security focus — managed-key-only + fail-closed + injection-fence + stateless-v1 confirmed; multi-turn sessions + tool-enabled dispatch are deferred follow-ons, each its own security pass). /code-review clean (0 banned; no secret on the boundary). 6 fail-closed gate tests (404/403/400/413/429) + 12 prior widget tests green. The embed JS snippet + FE widget UI (Phases 3+) pending — the public backend now functions end-to-end.

> **Phase 3 (embed snippet) implemented** (2026-06-24):** GET `/widget/embed.js` serves a self-contained vanilla-JS widget a site owner pastes (`<script src=".../widget/embed.js" data-token="wgt_…">`). IDENTICAL for every widget (token read at runtime from its own tag) → a static, cacheable (`max-age=300`), NON-normative served string — no SPA bundle, ZERO entry-budget impact. SECURITY: renders ALL message text via `textContent` (NEVER innerHTML → XSS-safe on the third-party host page); styles via JS `.style` props (no injected `<style>` → no host-CSP style-src violation); derives its API base from its own src origin; only ever calls the origin-gated 2b/2d endpoints. The token in the markup is the ADR 0013 capability token (origin-gated server-side, not a secret); no tenantId/key reaches the snippet. Basic a11y (aria-label, Enter-to-send, focus-on-open). /architect GO (security focus — textContent-only XSS-safety + token-by-design + served-JS posture confirmed), /code-review clean. 2 served-JS tests (content-type/cache; textContent-not-innerHTML + endpoints + no baked secret). The embeddable widget now FUNCTIONS end-to-end (config → bubble → dispatch → reply). Multi-turn sessions + tool dispatch remain deferred follow-ons.

> **Phase 4 (widget admin UI) implemented** (2026-06-24):** `WidgetsPage` — the operator surface to provision/list/rotate-token/delete the org's embeddable widgets + COPY THE EMBED SNIPPET (`<script src=".../public/widget/embed.js" data-token="wgt_…">`). The proven admin-page pattern (PageHeader + org picker + create form (agentId + comma-separated allowedDomains) + DataTable + canonical `confirm` for rotate/delete + StatusBadge status-as-label). Gated on `useFeatureAccess('chat-widget')` (no fetch when disabled — the reviewed gate). Registered as a FrontendFeature (lazy route `/widgets`, nav featureId `chat-widget`); the token shown is the ADR 0013 capability token (origin-gated, not a secret). /architect (inline — the reviewed admin-page precedent over the Phase-1 CRUD routes; no new backend), /code-review + /ux-review clean (0 banned/hex, status-as-label, confirm, i18n×4, entry 162.9 kB). 2 tests (fetch-when-disabled gate; list + embed-snippet reveal). ADR 0127 is now substantially complete (config + gateway + dispatch + embed + admin UI).
