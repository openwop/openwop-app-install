# ADR 0470 â Anonymous lead capture: the non-deliverable anon write tool (best-in-class, evidence-led)

| | |
|---|---|
| **Status** | Accepted — P1 + P2 implemented + ALL follow-ons (OQ5/P3/OQ4 resolved; Lead Concierge pack sourced); PoW deferred with rationale — see Implementation record |
| **Feature** | EXTENDS `crm` (a new anon-safe `crm.lead.capture` agent tool over the ADR 0449 `ensureContact` seam) + `chat-widget` (visitor consent/disclosure UX) + a **Lead Concierge** agent pack. **No new toggle** â rides the existing `crm` toggle + the ADR 0469 `OPENWOP_ANON_ACTOR_ENABLED` anon-write tier. |
| **Composes** | **ADR 0469** (anon write tier: holdâapproveâdeferred-exec + rate-limit-session-cap auto-run, no-secret floor, egress fail-closed, per-session+per-day caps, OD4 erasure, OQ2 TTL) Â· **ADR 0449** (`ensureContact` shared seam) Â· **ADR 0456** (participant lifecycle â CDP) Â· **ADR 0127** (public widget + `embed.js`) Â· **ADR 0058** (chat-drivability = agent + tools) |
| **RFC verdict** | **Host work, no RFC.** No wire surface â a feature-registered agent tool + a persona pack + a public-widget UX enhancement. Nothing on the OpenWOP wire, no capability advert. |
| **Source** | This session's 4-stream competitive + best-practice research (competitive teardown of Intercom Fin / Ada / Sierra / Salesforce Agentforce / Chatbase / Drift / Tidio / Crisp; conversational-UX/CRO; AI-agent guardrails/HITL; GDPR/CCPA privacy) â the Â§Evidence table maps every decision to a cited finding. |

## 1. Why this exists â the Â§N3 gap + the market whitespace

ADR 0469 shipped a **correct, safe, tested** anonymous write tier â but Â§N3 recorded that it has **no production tool that actually lands a write**: every current tenant-write tool is an ADR 0308 *deliverable* that fails closed `actingUserId`-undefined. The write tier is an inert rail.

The competitive research names the **canonical** anon-write use case and the winning shape: an anonymous visitor **captures a lead** (an email a human follows up on), delivered *value-first* through conversational qualification, gated by **structural guardrails** (eligibility-before-action + human approval), with **consent-at-capture** â and it identifies a genuine **market whitespace**: in-chat consent is **under-built** across the leaders (Chatbase, Ada, Sierra ship none). This ADR makes the write tier real with the one tool that matters, and does the consent/disclosure the market skips â turning a gap into a differentiator.

## 2. Decision

Three composable pieces, each riding an existing seam:

- **D1 â `openwop:crm.lead.capture`: the first NON-DELIVERABLE anon write tool.** A `crm`-registered `BuiltinTool` (via `registerFeatureAgentTool`, same seam as `documents.draft`), with **NO `actingUserId` gate** â a public visitor authoring their OWN contact detail needs no acting user. **Closed schema `{ email (required, RFC-validated), name? , note? }` â and NOTHING else**: no price/offer/discount/commitment field exists, structurally (the Chevrolet "$1 Tahoe" + Air Canada-liability lesson â *no authority the agent can be argued into using*). `run` calls `ensureContact({ tenantId, email, name, leadSource: 'anon-widget' })` (ADR 0449) and returns **only** the opaque `contactId` + a success flag (never PII on the result boundary). Granted as a **write** on a widget's `anonToolGrant`, it flows through ADR 0469's hold/auto path unchanged.

- **D2 â `captured*` population + operator visibility.** When the held/auto tool is `crm.lead.capture`, the chat-widget `holdGrantedWrite` hook extracts `email`/`name`/`note` from the call args into the approval's `capturedEmail`/`capturedName`/`capturedNote` (the ADR 0469 fields built for exactly this â flat, OD4-redactor-covered). The review projection (ADR 0469 Phase C) surfaces the captured lead + a risk chip so the operator triages + approves; **approve â `ensureContact` runs**. Data-minimized: email required, name/note optional, **the raw transcript is never copied** into the approval or the Contact.

- **D3 â the Lead Concierge agent pack + consent/disclosure UX (the differentiator).** A persona pack that qualifies **value-first** (an answer/benefit *before* any ask; email-only; â¤4 conversational questions), **discloses it is AI** and that a **human may follow up** (legitimate-interest basis, GDPR Art. 13 notice-at-collection), with the `embed.js` widget rendering a one-line **consent/disclosure notice at capture** + a privacy-policy link. **v1 is follow-up only â no marketing opt-in** (a separate consent lane, deliberately out). Visitor "queued for a person" state is explicit and honest (never a spinner, never silence); the widget meets WCAG 2.2 (`role="log"` + polite live region, APG dialog focus, â¥24px targets, `prefers-reduced-motion`).

**HITL posture (D1):** lead capture is a HIGH action (creates a record + reaches the operator inbox) â **default `hitl` hold-then-approve**; `rate-limit-session-cap` auto-run stays an explicit per-widget operator opt-in, bounded by the ADR 0469 per-session + per-day caps that deny **independently of the reviewer** (the anti-rubber-stamp structural floor).

## 3. Evidence â decision map

| Decision | Cited finding |
|---|---|
| Value-first, email-only, gate late; â¤4 Qs | Conversational-UX rules 1â3; competitive P1/P3 (Tidio 3Ã after help; Drift skip-form 2Ã meetings; Baymard 23%â7% by field count) |
| Structured capture, natural conversation | UX rule 4; competitive P11 (Drift 53%/47% button/open-text) |
| Closed schema, no offer/price authority | Guardrails F2/F3 + incidents (Chevrolet $1 Tahoe; Air Canada liability) |
| Hold-then-approve default for a HIGH action | Guardrails F1 (three-tier gate), OWASP LLM06; competitive P7 (Sierra supervisor / Agentforce human-approval) |
| Rule-of-Two satisfied (drop secrets + egress, keep untrusted+state under HITL) | Guardrails F8 (Meta Rule of Two) â validates ADR 0469 |
| Structural caps independent of the reviewer | Guardrails F5/F15 (Anthropic: 93% rubber-stamp) â ADR 0469 caps |
| Consent-at-capture + AI-disclosure (the whitespace) | Privacy F1/F2; competitive P9/P10 (Fin discloses; Chatbase/Ada ship none) |
| Legitimate-interest for follow-up; email-only; no transcript-as-PII; no marketing in v1 | Privacy F1/F2/F3/F6 (EDPB 1/2024; GDPR Art. 13; PECR) |
| Erasure cascade + TTL-matches-notice | Privacy F4/F5 â ADR 0469 OD4 (cancel+redact) + OQ2 (TTL) + CRM subject eraser |
| Explicit "queued for a person" state; a11y | UX rules 7â9 (NN/g response limits; WCAG 2.2 SC 4.1.3/2.5.8/2.3.3; APG dialog) |
| Honeypot + PoW bot-flood floor (P3) | Guardrails F9/F10 (ALTCHA; GNOME 97% bot drop) |

## 4. Feature-evaluation matrix (deltas)
| Dim | Decision |
|---|---|
| Package/toggle | Extends `crm` (tool) + `chat-widget` (UX) + a pack. No new toggle â rides `crm` + `OPENWOP_ANON_ACTOR_ENABLED`. |
| Node/agent packs | New **Lead Concierge** agent pack (persona + `crm.lead.capture` in its anon-grantable allowlist). The tool is a built-in (not a node pack â it needs the host `ensureContact` seam, not a pure compute node). |
| Public surface | The `embed.js` widget gains the consent/disclosure line + honest pending state; the capture runs through the EXISTING origin-gated public gateway. No new public route. |
| RBAC | Reads/decides of the lead approval ride ADR 0469's `workspace:write` decider gate; the tool self-enforces its closed schema. |
| Replay/fork | N/A â the tool is a deferred/auto anon write; no run-event shape change. |
| Data/purge | `captured*` (flat) + the Contact (email/leadSource). Erasure: OD4 (approval) + CRM subject eraser (Contact); OQ2 TTL on the hold. No transcript persisted as PII. |

## 5. Phased plan
| Phase | Ships | Gate |
|---|---|---|
| **P1** | `crm.lead.capture` built-in tool (non-deliverable, closed schema, `ensureContact`, `leadSource`) + `captured*` population in the hold hook + review-projection surfacing of the lead + tests. **Closes Â§N3 â the write tier lands a real write.** | /architect on the tool schema + the no-authority guarantee |
| **P2** | The **Lead Concierge** agent pack (value-first SDR persona, AI-disclosure, consent-aware, `crm.lead.capture` allowlisted) + the `embed.js` consent/disclosure line + honest pending state + WCAG 2.2 a11y hardening | P1; /ux-review on the visitor widget |
| **P3** | Bot-flood floor: honeypot + a privacy-preserving proof-of-work on the public widget message endpoint (guardrails F9/F10), reserving any challenge for velocity anomalies | P2; abuse-surface review |

## 6. Alternatives, corrections, open questions
- **Alternative (rejected): make `lead.capture` a deliverable (acting-user-gated) like `kanban.add-todo`.** That reintroduces the Â§N3 fail-closed â the whole point is a *non-deliverable* write. The visitor authors their own data; no acting user is needed or wanted.
- **Alternative (rejected): capture into free-form CRM fields / persist the transcript.** Violates data-minimization (Privacy F3) + expands the erasure/breach surface. Email + optional name + note only.
- **Correction to the market default:** Chatbase/Ada ship the capture with **no** consent UX; we treat consent-at-capture + AI-disclosure as **first-class** (the whitespace), not an afterthought.
- **OQ1 â auto-run vs always-hold default.** Default **hold** (HIGH action); auto-run is the operator's explicit, capped opt-in. Revisit if operators find the hold latency hurts conversion (the Drift <2-min speed-to-human lever) â but auto-run without a human still lands a *pending* Contact, so the follow-up SLA is the operator's, not the AI's.
- **OQ2 â marketing consent lane.** Deliberately out of v1 (follow-up/legitimate-interest only). A separate `marketingConsent` flag + double-opt-in is a follow-on (Privacy F6).
- **OQ3 â booking/handoff as the conversion event.** The research's #1 conversion moment is a booked meeting / live handoff, not the email. CRM public booking links already exist (ADR 0402); wiring the Concierge to offer a booking link post-capture is a strong P2+ enhancement (deferred).

Everything visitor-facing stays behind the widget's per-widget `enabled` + `allowedDomains` + `OPENWOP_ANON_ACTOR_ENABLED`. Nothing auto-mutates: a captured lead is a `status=pending` Contact-intent held for the operator (or an auto-capped pending Contact), never a price/offer/commitment.

## Implementation record

| Phase | Status | Artifact |
|---|---|---|
| **P1** â the `crm.lead.capture` tool + `captured*` population + operator lead summary | â implemented | `features/crm/agentTools.ts` (`CRM_LEAD_CAPTURE_TOOL_ID`) / `chat-widget/publicGateway.ts` (hold hook) / `host/reviewProjection.ts` (`leadSummary`) |
| Tests (P1) | â | `test/adr0470-lead-capture.test.ts` (4): **the anon tier lands a REAL Contact** (Â§N3 closed), invalid-email rejected, anon-exclusive boundary, operator lead summary |
| **P2** â best-in-class `embed.js` visitor widget (AI-disclosure, `role=log` live region, reduced-motion typing indicator, APG dialog focus + Escape, â¥44px targets, honest error) + Lead Concierge persona guidance | â implemented | `chat-widget/publicGateway.ts` (`EMBED_JS`) + Â§Lead Concierge persona below |
| Tests (P2) | â | `test/adr0470-embed-widget.test.ts` (7): syntax-valid + every a11y/disclosure marker |
| **P2-follow-on** — the Lead Concierge agent pack SOURCE | ✅ authored + repo-loader-validated | `packs/core.openwop.agents.lead-concierge/` (pack.json + prompts/lead-concierge.md); every granted tool id resolves (agent-prompt-tool-ids test). Ed25519/SRI SIGNING + publish is the Working-Group pipeline step (source packs are unsigned in-repo) |
| **P3** â honeypot + PoW bot-flood floor | â³ pending | â |

## Â§Lead Concierge persona (recommended system prompt)

The lead-capture UX is best-in-class only with a **value-first** persona. This works
**today** as the `systemPrompt` of any agent an operator points a widget at (with
`crm.lead.capture` + `knowledge.search` in the widget's `anonToolGrant`); the signed
pack (P2-follow-on) is packaging convenience, not a prerequisite.

> You are a helpful assistant on **[business]**'s website, speaking with an anonymous
> visitor. **Always be transparent that you are an AI.** Answer their questions helpfully
> and specifically from what you know â **deliver value first**. Only AFTER you have
> genuinely helped, and only if it is useful to them, offer to have a person follow up:
> *"Want me to have someone from the team follow up? If so, what's the best email?"*
> Ask for an **email only** (name/what-they-need are optional and only if they offer
> them). When they give a valid email, tell them plainly that **a team member will
> follow up** and roughly when, then call `crm.lead.capture`. **Never** promise or imply a
> price, discount, refund, availability, deadline, or any commitment â you cannot make
> offers; a human decides those. If you don't know something, say so and offer the
> follow-up. Never pressure anyone for their email as a condition of chatting.

Grounds every research rule: value-first + gate-late (UX 1), email-only (UX 2),
AI-disclosure + human-follow-up (privacy F2 / competitive P9), no-authority (guardrails
F2 / Chevrolet + Air-Canada), no coercive gate (privacy Â§7 dark-pattern).

### Design correction (architect boundary check, P1)

- **`lead.capture` is ANON-EXCLUSIVE, not merely "gate-skipping" (the load-bearing correction).** The architect boundary audit surfaced that `crm/agentTools.ts` DELIBERATELY keeps `create-contact` off the chat tools â governed high-blast-radius writes ride the ADR 0208 human-approval chain. A general built-in would let a *signed-in* agent bypass ADR 0208. So the tool runs **only when `actingUserId` is undefined** (returns `use_governed_write` otherwise) â the **inverse of the ADR 0308 deliverable gate**. On the anon path it is itself gated by the ADR 0469 hold/auto tier + caps. This preserves the ADR 0208 boundary AND makes it the anon-write keystone.
- **No-PII-echo result boundary:** the tool returns only the opaque `contactId` + `success` â never the email back (RFC 0048 posture), test-pinned.
- **Closed schema, no authority:** `{ email, name?, note? }` and nothing else â no price/offer/commitment field exists (the Chevrolet "$1 Tahoe" / Air-Canada lesson enforced structurally).

### OQ4 — unified anon-lead erasure. ✅ RESOLVED (proportionately; premise corrected)

Investigation corrected the premise: the CRM Contact is DELIBERATELY excluded from the
shared subject-eraser (`contactsService.ts:481-488`) — it is the tenant-CONTROLLER’s
third-party record; a full "DSAR-by-email" is scoped as its own route/ADR, and overloading
the shared principal-keyed seam is explicitly warned against. So an atomic cascade that
auto-erased the Contact would be WRONG. The pending approval is already bounded by OD4
(erase-by-principal) + OQ2 (TTL). The one residual OQ2 did not cover — a RESOLVED anon
approval retaining `capturedEmail` as audit PII — is now closed: `decideAnonSurfaceWrite`
redacts the platform-held PII on BOTH resolved paths (reject immediately; approve AFTER
execution, since the CRM Contact becomes the canonical lead record), reusing the OD4
redactor keyed by the approval’s own opaque principal. The row stays a PII-free audit
(tool + decision + approver + timestamp). The CRM Contact stays the tenant-controller’s
record (its own retention/erasure); a full DSAR-by-email ROUTE remains the documented
follow-on. Test: `adr0469-anon-surface-write.test.ts` OQ4 (reject + approve redact).

### OQ4-original-note (superseded above)

- **Unified anon-lead erasure cascade.** A captured lead exists in TWO stores with TWO erasure paths: the held **approval** (erased by anon principal via OD4 cancel+redact) and the created **CRM Contact** (erased by email via the CRM subject eraser). Both are independently erasable and OQ2 expires the pending hold, but they are not a single atomic cascade â a DSAR on the visitor's email erases the Contact but not a still-pending approval holding the same email in `captured*` (and vice-versa). A unified anon-lead erasure that cascades both by the opaque session id is a follow-on (Privacy stream F4).

### OQ5 â per-widget privacy-policy link + brand. â RESOLVED

Optional `businessName` + `privacyUrl` on `WidgetConfig` (operator-set via
`WidgetGrantEditor`), returned by the public `/widget/config` route, rendered by
`embed.js` as `"<businessName> Â· AI assistant Â· a team member may follow up Â· Privacy"`
(Privacy = a link to the policy). **Security (the load-bearing check):** `privacyUrl` is
rendered as an `<a href>` on visitors' browsers, so it is validated **http/https ONLY
server-side** (`cleanUrl` â rejects `javascript:`/`data:`/other schemes, a stored-XSS
defense) AND the embed **re-checks the scheme client-side** before setting the href
(defense in depth) + uses `rel="noopener noreferrer"`. `businessName` is `textContent`-
rendered (XSS-safe) + capped. Tests: `adr0470-oq5-disclosure.test.ts` (5 â javascript:/
data:/ftp: refused server-side, http(s) persisted, null-clears) + the embed markers.

### OQ5-original-note (superseded above)

The `embed.js` chrome shows the always-visible AI-disclosure + human-follow-up notice
(the core notice-at-collection). The **linked full privacy policy** (privacy F2) is
currently delivered by the Lead Concierge persona's message (operator-controlled) rather
than a widget-chrome link â a per-widget `privacyUrl` + `businessName` config field
(surfaced in `WidgetGrantEditor`, returned by `/widget/config`, rendered as a link in the
disclosure line) is the immediate follow-on, alongside optional operator brand colour on
the widget. Neither blocks the compliance floor (disclosure IS shown); both raise polish.

### P3 â bot-flood floor. â RESOLVED (proportionate; PoW deferred with rationale)

The `/architect` review of P3 surfaced a **real security gap higher-value than PoW**: the
anon caps all default to `Infinity` when unset (`capsTracker.ts`), so an *unconfigured*
anon widget's operator inbox was **unbounded** â a distributed bot could flood held
lead-approvals. The proportionate P3:

- **Secure default write ceiling (the actual missing floor).** `checkAnonWrite` applies
  `OPENWOP_ANON_WRITE_DEFAULT_PER_DAY` (default **25**) when the operator sets no
  `maxWritesPerDay`, so an unconfigured widget's inbox is bounded by default. The
  operator's explicit cap (up or down) still wins. Safe now (the tier is flag-OFF/
  undeployed â zero live impact). Test: unconfigured widget bounded at 25, operator cap
  honored.
- **Honeypot on `/widget/message`.** A hidden decoy field (`aria-hidden`, off-screen,
  `tabindex=-1`, `autocomplete=off`) the real widget always sends empty; a non-empty
  value â a form-scraper bot â rejected with a GENERIC error (never reveals the
  honeypot). a11y-safe (invisible to AT + keyboard). Test: filled â 400; empty â not-400.
- **PoW â DEFERRED (architect proportionality gate, NOT scope-cutting).** Once the write
  target is default-bounded + per-IP rate-limited + HITL-gated, a server-issued-challenge
  PoW only helps against distributed *LLM-turn* floods (already bounded by the per-IP
  limit + the managed free-tier's own limits). Against that modest marginal value sits
  real cost: bundling crypto into the lean CSP-safe widget (bloat) or an async solve loop
  (latency), + a challenge endpoint + HMAC verification + a single-use seen-set. The
  cost/benefit doesn't clear. **Turnkey design for a future high-value surface:** config
  issues `{challenge: base64(salt|expiry), sig: HMAC(sessionSecret, challenge), difficulty}`;
  the widget finds a nonce s.t. `sha256(challenge+nonce)` meets `difficulty`; the message
  POST includes `{challenge, sig, nonce}`; the server verifies the HMAC (unforgeable) +
  freshness (bounds precompute) + difficulty, with a short-TTL seen-set for single-use.
