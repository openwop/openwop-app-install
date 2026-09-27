# Outbound channels (webinars + whatsapp) — chat-first port review

**Unit E7.** Scope: `backend/typescript/src/features/{webinars,whatsapp}`,
`frontend/react/src/features/webinars`, and the WhatsApp UI "wherever it lives"
(finding: it lives nowhere — see WA-BLOCK-1). Context: webinars = Zoom-first
connector (ADR 0404 §a); whatsapp = official BSP-only lane (ADR 0394).

**Bottom line.** These are two honest **connector/compliance packages**, not
intelligence surfaces. Neither declares a workflow, neither ships a
`registerFeatureAgentTool`, and both correctly *instantiate* the shared owners
(connections inbound seam, forms submission-sink, CRM activities, the messaging
service gates, `startWorkflowRun`) rather than shadowing them. There is almost
nothing to "port to chat" here because there is almost no bespoke intelligence
UI to demolish — the webinars page is operator connector-config, and whatsapp
has no page at all. The two real defects are both **honesty gaps, not parallel
architecture**: (1) the WhatsApp customer-service *agent* is a declared,
loadable persona with **no shipped ignition** binding it to the inbound lane it
exists for, and (2) the WhatsApp compliance surfaces (no-training attestation +
health) are backend-only routes with **zero operator UI**, so the entire
inbound→AI dispatch path is fail-closed with no in-product way to open it.

---

## Verdict table

| # | Capability | Today | Verdict | Port target / note |
|---|---|---|---|---|
| 1 | Connect Zoom | `WebinarsPage` button → `navigate('/connections')` (`WebinarsPage.tsx:115`) | PAGE-LEGIT | Deep-links the Connections owner; nothing to build |
| 2 | Register/create marketing event | intake form → `POST …/events` (`routes.ts:41`, `WebinarsPage.tsx:120`) | PAGE-LEGIT | Operator id-mapping config (Zoom webinar id ⇄ CRM); genuinely config-shaped, not intent |
| 3 | Bind registration form to event | form → `POST …/bind-form` (`routes.ts:59`) → `bindFormToEvent` | ADAPTER | Rides the forms binding; webinars-owned soft ref, FormDef untouched (`formsSubmissionSink.ts:3`) |
| 4 | Registration capture on public submit | forms submission-sink (`formsSubmissionSink.ts:21` `registerSubmissionSink`) → CRM activity + contact + best-effort push | RIDES | Correctly rides the forms sink + CRM activities owner |
| 5 | `feature.webinars.nodes.register` | node → `ctx.features.webinars.registerRegistrant` (`surface.ts:31`, `index.mjs:20`) → adapterOnly zoom broker | RIDES | Catalog action node over the broker; authoritative push path |
| 6 | Sync attendance (backfill) | button → `POST …/events/:id/sync` (`routes.ts:72`) AND `feature.webinars.nodes.sync` (`index.mjs:39`); both call `syncEvent` | ADAPTER | One owner (`webinarSyncService.syncEvent`), two thin callers (route + node) — not parallel |
| 7 | Registrant/attendee/no-show counts | derived-on-read from CRM activity stream, batched (`routes.ts:34` `computeEventCountsBatch`) | PAGE-LEGIT | Honest read; every displayed number has a real backing scan |
| 8 | Inbound Zoom webhook | shared seam, provider `zoom-webinar`, **observer-only, no run** (`inboundWebhooks.ts:627-650`, `feature.ts:32`) | RIDES | Rides the connections inbound seam; idempotent deterministic-id activities |
| 9 | Outbound WhatsApp send | `feature.whatsapp.nodes.send` (`index.mjs:24`) → `ctx.features.whatsapp.send` (`surface.ts:18`) → gated service | RIDES | Every gate lives in `whatsappService.sendWhatsApp`; node fails typed, never success-with-empty |
| 10 | Inbound WhatsApp → start/resume workflow | shared seam, `whatsapp-twilio`/`whatsapp-cloud` are workflow-dispatch providers (`inboundWebhooks.ts:675` `startWorkflowRun`; `:669` resume-into-interrupt) | RIDES | Real ignition through the connection's configured `workflowId`; conversational resume rides the interrupt machinery |
| 11 | Customer-service AI answering (inbound) | agent pack `feature.whatsapp.agents.customer-service` (`pack.json`), allowlist `openwop:knowledge.search` | **THEATER** | Persona is loadable + tool is a real chat tool, but **no shipped workflow/AI-node binds it to the WA inbound lane** — the claimed "inbound messages answered by scoped agent" capability is unassembled (see WA-BLOCK-2) |
| 12 | No-training attestation (record/revoke) | routes `PUT/DELETE …/attestation` (`routes.ts:37,55`); ungates `registerInboundGate` (`feature.ts:53`) | RIDES | Real fail-closed gate — **but headless** (see WA-BLOCK-1) |
| 13 | WhatsApp health read | `GET …/health` (`routes.ts:68` → `readWhatsAppHealth`) | PAGE-LEGIT | Honest read of binding + tier + attestation — **but headless** (see WA-BLOCK-1) |
| 14 | STOP/START ladder + 24h window ledger | inbound observer (`feature.ts:42-54`) → `applyInboundKeyword` + window rows | RIDES | Real service state; every inbound message in a batch processed |
| 15 | Subject erasure + connection cleanup | `registerSubjectEraser` / `onConnectionRevoked` (`feature.ts:57-62`) | RIDES | Lifecycle seams wired to parents (E.164 subjectKey purge, revoke drops binding) |

**Counts:** RIDES = 8 · ADAPTER = 2 · PARALLEL = 0 · THEATER = 1 · PAGE-LEGIT = 4.

**Cross-cutting silent-drop check (agent allowlist vs projected tools):**
the WhatsApp agent's only allowlisted tool is `openwop:knowledge.search`, which
**is** a registered conversational tool (grep of `openwop:*` tool ids confirms
`openwop:knowledge.search`), not an un-projected node typeId — so this agent is
**not** silently dropped at dispatch. It passes the check. (Webinars ships no
agent, so the check is N/A there.)

---

## Blockers (from scouting) — each with the honest alternative

**WA-BLOCK-1 — the WhatsApp operator surface is headless; the inbound-AI path
is un-openable in-product.** `feature.ts` ships NO frontend feature package, and
a repo-wide search finds no SPA code calling `…/whatsapp/orgs/:orgId/attestation`
or `…/health` (the only frontend "whatsapp" hits are the *relay* CLI lane in
`CliPage.tsx:266`, an explicitly-distinct feature per `feature.ts:14`). The
no-training attestation is what flips `registerInboundGate` from fail-closed to
allow (`routes.ts:8-11`, `feature.ts:53`). With no UI to `PUT` it,
**every verified inbound WhatsApp message is acked and dropped**
(`inboundWebhooks.ts:594` `status:'ignored'`) — the feature's headline
capability ("inbound customer messages start or resume workflows",
`feature.ts:70`) cannot be turned on except by a raw API call.
*Honest alternative:* this is a small operator page, not a chat surface — a
compliance attestation is a deliberate, durable, admin-only human act
(`host:whatsapp:manage`, `routes.ts:39`), correctly page-shaped. Build the
attestation + health page (or fold it into the Connections detail for the bound
number) and stop claiming an enable-able inbound lane until it exists.

**WA-BLOCK-2 — the scoped customer-service agent has no igniter.** The agent
pack is in `requiredPacks` (`feature.ts:80`) so the persona loads into the
roster, and its one tool is real — but *nothing wires it to the WhatsApp inbound
lane*. Inbound dispatch calls `startWorkflowRun` with the connection's
operator-configured `workflowId` (`inboundWebhooks.ts:675`); no shipped workflow
exists, and no shipped workflow references `feature.whatsapp.agents.customer-service`
(grep finds it only in `feature.ts`/`pack.json`). So the ADR-claimed shape
"inbound WhatsApp → scoped agent answers from the knowledge base" is a set of
correct parts with **no assembly**. This is the ignition-test failure the skill
calls out: capability declared, no execution path.
*Honest alternative:* ship a **template inbound workflow** (`trigger →
AI-answer node scoped to `feature.whatsapp.agents.customer-service` → whatsapp.send`)
and a one-click "bind this workflow to the WhatsApp number's inbound config" so
the operator gets the assembled capability, not a parts bin. Until then, mark
the customer-service loop **deferred-visibly** in the ADR rather than implying it
works. (The agent being read-only is *correct* for an FAQ answerer — the defect
is the missing binding, not the toolset.)

**WEB-NOTE-1 (not a blocker) — the `register`/`sync` webinar nodes have no
shipped workflow either,** but this is fine: they are catalog action nodes for
operator-composed journeys, and the *primary* registrant path (the forms sink,
#4) does not need them. The ADR is honest that journey enrollment on
`host.webinar.*` is Phase 2 (`feature.ts:53` comment). No theater — a catalog
node with a real surface behind it and no obligatory igniter is a legitimate
primitive, unlike an orphaned *workflow*.

**WEB-NOTE-2 (chassis constraint, not a defect) — the public forms sink cannot
resolve a Zoom credential** (no acting user → broker fail-closes,
`formsSubmissionSink.ts:9-13`), which is exactly why the authoritative push is
the `register` node run under an operator identity. The local CRM registration
is always recorded regardless of push outcome (`surface.ts:38`,
`index.mjs:32`) — honest degraded state, not a painted-green loop.

---

## Demolition list (with regression pins to add)

Nearly empty by design — there is little bespoke intelligence UI to remove.

- **Nothing in webinars is a demolition target.** The `WebinarsPage` form is
  connector-config (id mapping, form binding, manual sync trigger), all
  PAGE-LEGIT/ADAPTER over real owners. It is *not* a bespoke "talk to AI"
  surface and does not substitute for a primitive. Keep it.
- **No WhatsApp UI exists to demolish.** The demolition-shaped work here is the
  *inverse*: build the missing attestation/health page (WA-BLOCK-1).
- **Regression pins to ADD (not remove):**
  - a test asserting `feature.whatsapp.agents.customer-service`'s allowlist
    resolves to a projected chat tool (guards the silent-drop regression if the
    tool is ever renamed) — pairs with the repo-wide `agent-prompt-tool-ids`
    parity test.
  - a test that inbound WhatsApp with **no attestation** returns
    `status:'ignored'` and fires **no** run (pins the fail-closed gate,
    `inboundWebhooks.ts:594`).
  - if WA-BLOCK-2's template workflow ships: a test that the template's AI node
    is scoped to the customer-service agent and its terminal `whatsapp.send`
    rides the governed node (pins the Meta primary-functionality scoping).

---

## New-code inventory (small, as expected)

1. **WhatsApp operator page** (frontend feature package): attestation
   status/record/revoke + health read, over the *existing* routes. Admin-gated.
   (WA-BLOCK-1.)
2. **One template inbound WhatsApp workflow** built from the existing catalog
   (trigger → structured-AI node scoped to the customer-service agent →
   `feature.whatsapp.nodes.send`) + a "bind to inbound config" affordance.
   (WA-BLOCK-2.) No new nodes, no new agent, no new envelope.
3. **Three regression tests** above.

No new stores, no new owners, no wire/RFC surface — both features already rode
the accepted RFC 0095/0120 (webinars) and the ADR 0175 messaging seam (whatsapp).

---

## Phased plan (real gates; compliance-first; never demolish before replacement)

- **Phase 1 — close the WhatsApp honesty gaps (no demolition first).**
  Build the attestation + health operator page (WA-BLOCK-1) over the existing
  routes; add the fail-closed-gate regression test. Gate: `npm run ci` green +
  `/code-review` + `/ux-review` (a11y + 4-locale i18n parity for the new page).
- **Phase 2 — ignite the customer-service agent (WA-BLOCK-2).**
  Ship the template inbound workflow + bind affordance + scoping regression
  test; update ADR 0394 to record the assembled loop (or keep it
  deferred-visibly if not shipping). Gate: `npm run ci` + `/code-review`.
- **Phase 3 — grade + fixes.** `/grade-code` + `/grade-data` over both packages
  (webinars is already the model to copy: derived-on-read counts, deterministic
  activity ids, lifecycle unlinks on form/contact/connection delete). Apply
  fixes. No webinars phase is needed — it already rides the engine.

---

## Deferred honestly

- **Native webinar delivery** — never ships here; the ADR is explicit ("No
  native webinar delivery", `feature.ts:53`). Livestorm/StreamYard ride a future
  connection pack. Deferred-visibly, correct.
- **Journey enrollment on `host.webinar.*`** — Phase 2 per the ADR; the
  `register`/`sync` nodes exist for the operator-composed chain but no shipped
  journey binds them. State as deferred, not as a working loop.
- **WhatsApp inbound→AI answering** — parts exist (send node, inbound ignition,
  scoped agent) but the assembled capability is **not shipped** (WA-BLOCK-2).
  Must be marked deferred-visibly until the template workflow + attestation UI
  land; today it is dark end-to-end (fail-closed gate + no UI to open it).
- **Meta Cloud API transport** — code path present (`whatsapp-cloud`,
  `inboundWebhooks.ts:597`) but the ADR frames Twilio BSP as the shipped
  transport first; Cloud is a later phase. Honest.
