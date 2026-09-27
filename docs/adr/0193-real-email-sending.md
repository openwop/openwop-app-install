# 0193 — Real email sending (beyond the SendGrid-only path)

Status: implemented (Phase 1 + Phase 2; Phase 3 SMTP deferred to its own ADR)

> Renumbered from 0192 → 0193 to resolve a concurrent ADR-number collision
> with `0192-channels-ux-identity-parity` (a separate in-flight change). No
> content change; this ADR was not yet referenced by code.

## Context

The day-1 UX audit and the template work (ADR 0190/0191) surfaced a gap: a
template that "sends the follow-up email" can only actually **send** if the
operator has configured **SendGrid**. Everything else is a *draft*.

Today's email surface (verified in code):

- **Sending** — `ctx.email.send` (`host/emailAdapter.ts`) →
  `core.openwop.integration.email-send` node. The adapter dispatches by
  `args.provider`, defaulting to `'sendgrid'`, and **rejects every other
  provider** (`emailAdapter.ts` — `email_provider_unsupported`). It sends over
  HTTP through the connector broker (`brokeredPost`), so it already rides the
  provider `apiHosts` pin + the ADR 0187 egress firewall. The adapter's own
  comment: *"other providers are a future manifest + a branch here — they're
  all api_key Connections."*
- **Drafting (never sends)** — `core.email.draft` (Gmail + Microsoft Graph,
  ADR 0081 P6) writes to fixed literal draft endpoints (`…/drafts`,
  `…/messages`), **never a send endpoint**, with header-injection guards. This
  is deliberate: Gmail has no scope that permits draft-but-not-send
  (`gmail.compose` also allows send), and Graph uses `Mail.ReadWrite`, not
  `Mail.Send`. Drafting is the safe default; a human sends from their mailbox.
- **Gating** — the workflow-chain templates gate every external send behind a
  `core.chat.approvalGate` at authoring time (marketing/lighthouse/exec-ops
  packs). Send-gating is a workflow-authoring convention, **not enforced by the
  send node itself**.

The invariant to preserve across any change: **OpenWOP never silently sends as
you.** A send is legitimate only when either (a) the operator configured a
transactional provider whose sending identity the *operator* owns
(SendGrid/SES/…), or (b) the acting human granted an explicit send re-consent
*and* a human approved the specific send.

## The three options

| | What | Fits existing model? | New risk surface | Audience |
|---|---|---|---|---|
| **A** | HTTP transactional providers — **SES / Mailgun / Postmark** as `api_key` connection packs (RFC 0095) + a `send()` branch each | **Yes, exactly** — the adapter already dispatches by provider over `brokeredPost`; these are all HTTP api_key Connections | **None** — HTTP through the broker + ADR 0187 firewall, same as SendGrid | Any operator with a transactional-email account (most) |
| **B** | **Raw SMTP** — a nodemailer TCP transport in the adapter, `basic` (user+pass) Connection | Partly — `basic` is a supported `CredentialKind`, but SMTP is **TCP, not HTTP**, so it cannot ride `brokeredPost`/the HTTP firewall | **New TCP-egress surface** (SSRF/exfil to arbitrary host:port), a new `nodemailer` dependency, its own egress allowlist | The fully-self-hosted operator with only a mailbox (narrow) |
| **C** | **Provider-native send** — lift the draft-only guard on Gmail/Graph behind `gmail.send` / `Mail.Send` write re-consent | Reuses ADR 0024 §3 write re-consent, but **reverses the ADR 0081 P6 draft-only posture** | Behavioral, not egress — a run can now send *as the connected human*; needs the strongest gating | A user who connected their own Gmail/Outlook and wants to send from it |

## Decision — phased, safe-by-default

**Phase 1 (Option A): generalize `email-send` to a provider table.**

> **Correction (implementation, architect-ruled).** The draft said "SES first."
> SES authenticates with **AWS SigV4 request signing** (per-call HMAC over a
> canonical request), which is NOT a static header the brokered-egress spine
> injects (`brokeredEgress.ts` writes one header per `authScheme`
> bearer/basic/raw). So SES is a **non-fit** for Phase 1 — it needs a signer in
> the adapter, tracked as a follow-up. Phase 1 instead adds **Postmark**, chosen
> because it exercises the `raw` + custom-header path (`X-Postmark-Server-Token`)
> the table didn't yet prove (SendGrid already covers `bearer`). Resend (bearer)
> and Mailgun (basic, form body) are trivial follow-on rows.
>
> **Follow-up update (post-Phase-3).** The SES SigV4 signer follow-up is now
> **largely superseded**: Amazon SES exposes an **SMTP submission endpoint**
> (`email-smtp.<region>.amazonaws.com:587`, STARTTLS), so an SES operator sends
> today through the **`smtp` provider (ADR 0201 Phase 3)** using SES SMTP
> credentials — no SigV4, no new code. SES-*native*-HTTPS (SigV4) remains only a
> convenience gap and is treated as **YAGNI** unless a real operator needs the
> native API specifically. Turn the `provider === 'sendgrid'` branch into a small dispatch table
(`{ url, body, parseAccept }` per provider); add Amazon SES (widest reach,
cheap, HTTP api_key) as the first sibling, then Mailgun/Postmark as manifests +
table rows. Ship each as an `api_key` connection pack in
`examples/connection-packs/`. **No new risk surface, no wire change** — it is
the future the adapter comment already anticipated. This alone closes the gap
for most operators.

**Phase 2 (Option C): a distinct `core.email.send` node behind two gates.**
Sending from a *user's own* Gmail/Outlook is real value but reverses a safety
posture, so it is a **separate node** (the draft node stays unambiguously
draft-only) that requires BOTH:
1. the provider's **write re-consent** (`gmail.send` / `Mail.Send` — ADR 0024
   §3, the existing separate-consent model), and
2. a **mandatory host-side approval interrupt** on the send itself — not merely
   the authoring convention. The node suspends via the normative interrupt
   primitive (the ADR 0189 pattern) with an "approve sending as you" card
   carrying the rendered message; a run cannot send provider-native without a
   human approving *that* message. Use a **distinct `openwop-send-approval`
   interrupt profile** (the message preview is the point — not the 0189
   `openwop-connection` family), reusing ADR 0189's headless/expiry semantics:
   headless runs cannot self-approve and **expiry → draft, never send**
   (fail-closed, mirrors ADR 0033).

   Two **replay/idempotency requirements are load-bearing** (a side-effecting
   send behind an interrupt is re-dispatched on resume — the double-send trap;
   architect review of this ADR):
   - **Deterministic idempotency.** The send MUST carry a deterministic
     `idempotencyKey` (`EmailSendArgs.idempotencyKey` exists) derived from
     `runId + nodeId + recipients + subject` — never `randomUUID` — so a
     replay / `:fork` / post-approval retry does **not** re-send. SendGrid has
     no native dedup, so the host keeps a **sent-ledger keyed by that key**
     (SES/Postmark can also use their own dedup). *This also fixes a
     pre-existing gap: today's `sendgridBody` does not forward
     `idempotencyKey`, so the current transactional path can double-send on
     retry — Phase 1 MUST close it, and Phase 2 inherits it.*
   - **Approved bytes = sent bytes.** The post-approval send MUST send the
     **exact rendered message the human approved**, stamped into the interrupt
     resume and read **verbatim** — never re-rendered from inputs after
     approval (which can differ on replay or if inputs mutated). Same
     stamp-in-resume / read-verbatim rule ADR 0189 used for `providerId`.
     Otherwise a human approves message A and the run sends message B.

> **Correction / prior-art note (post-merge recon).** Phase 2 for **Gmail is a
> GENERALIZATION, not net-new.** A provider-native Gmail send already ships as
> the assistant's approved `email.send` action (ADR 0023): the run executes AS
> the approving human (`metadata.actingUserId` = the decider), the resolver
> picks THEIR `gmail.send`-scoped connection and **fails closed without write
> re-consent**, the approval claim makes it **exactly-once**, and the confirm
> node **fails the run on non-2xx** so a false "sent" can't be projected
> (`features/assistant/actionExecution.ts:14-19,32-33`; scope at
> `providerRegistry.ts:86`). Phase 2 lifts that pattern from an assistant-action
> workflow to a first-class `core.email.send` node and inherits its guards +
> exactly-once idempotency precedent. **Microsoft Graph is the genuinely
> net-new half** — `Mail.Send` is deliberately absent from the manifest
> (`providerRegistry.ts` — only `Mail.ReadWrite` for drafts), so Graph send
> needs a new write-scope group + the same gating. And there is **no
> capability-dispatch `send` node today** (ADR 0186 shipped only read nodes),
> so the provider-agnostic send is a real gap this fills, not a duplicate.

> **Implementation correction (Phase 2 landed — code-review recon).** Three
> details the decision above stated more cleanly than reality allows:
> - **Gmail has no separate send re-consent — the approval interrupt is its sole
>   per-send gate.** The implemented node uses the narrow **`gmail`** connector
>   (pinned to `gmail.googleapis.com`), whose scope is **`gmail.compose`** — the
>   `gmail.send` scope named in gate #1 lives on the *separate* broad `google`
>   provider (`providerRegistry.ts:86`) the node does not use. And `gmail.compose`
>   (granted at draft-connect) **already permits send** — Google offers no
>   draft-only-without-send scope, so there is nothing to re-consent that would
>   actually restrict Gmail sending. The manifest label was corrected to drop the
>   now-false "never sends" claim. So for Gmail the dual-gate is really a **single
>   gate**: the mandatory approval interrupt. **Graph keeps the genuine dual gate**
>   — `Mail.Send` is a real, separate write-scope group (`Mail.ReadWrite` cannot
>   send), kept out of `defaultScopes`.
> - **Expiry fails the RUN, and only under an operator deadline.** The node passes
>   no `timeoutMs`, so a send gate waits for the human unless the operator sets
>   `OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC`; on expiry the gate auto-rejects and
>   the **run fails closed** (`approval_rejected`, reason `timeout`) — nothing is
>   sent (the "expiry → draft" phrasing above was aspirational; the guarantee holds).
> - **`:fork` idempotency differs by path.** The Phase 1 transactional adapter keys
>   on a fork-stable **content** `idempotencyKey`, so `:fork` *is* deduped there.
>   The Phase 2 node keys on **`tenant:send:run:node`**, so `:fork` (new runId) gets
>   a fresh key and correctly **re-hits the approval interrupt** (a human re-approves)
>   — the fork backstop, not a double-send hole.

**Three clearly-scoped email nodes** (send ≠ draft ≠ send-as-you) — a reader
tells them apart by node id, and a config flip can never silently turn a draft
workflow into a sender:
- `core.email.draft` — **never sends** (fixed draft endpoints, ADR 0081 P6);
- `core.openwop.integration.email-send` — **transactional send**, the
  *operator's* sending identity (SendGrid/SES/…), the widened Phase-1 path;
- `core.email.send` (Phase 2) — **provider-native send as the connected human**,
  the genuinely dangerous one, behind the two gates above.

**Phase 3 (Option B): raw SMTP — YAGNI until proven, and structurally host-code.**
SMTP **cannot be a connection pack at all**: the egress broker is HTTPS-only
(`host/brokeredEgress.ts` — undici `fetch`, `token over https only`) and
connection-pack `reach` is only MCP or OpenAPI-over-HTTP
(`connectionPackLoader.ts`). So SMTP is host transport code by construction, not
a manifest — a stronger reason to defer than demand alone. (The `basic`
user+password `CredentialKind` it would need already exists — Twilio uses it —
so the credential model fits if it is ever un-deferred.) Two costs the earlier
draft undercounted: SMTP opens a **TCP egress surface the ADR 0187 HTTP
firewall does not cover** (SSRF/exfil to arbitrary host:port), and its
credential is a **long-lived `basic` user+password** — often the user's real
mailbox password, a materially larger blast radius than a scoped OAuth token or
a revocable api_key (store sealed, never log; SMTP passwords are higher-value
than the connections model's usual secrets). And its genuine audience **shrinks
hard once A+C ship**: Google/Microsoft self-hosters are covered by Phase C
(their own mailbox via OAuth, *no password*), and anyone with a transactional
account is covered by Phase A — leaving only "self-hoster whose mailbox is
neither Google/Microsoft nor a transactional provider." So treat B as **YAGNI
until a real user proves the need**; if built, it needs its own ADR (TCP-egress
allowlist with per-connection host:port pinning + a `nodemailer` dependency
review). Do not open the egress surface speculatively.

## RFC gate — no new RFC

- `ctx.email` is a **host capability** (`host.email`); the send node is
  `core.openwop.integration.*`. Adding providers to the dispatch table and a new
  gated send node change **no wire shape, event, or capability advert** — the
  `host.email` capability already exists and is already advertised as
  send-capable.
- Transactional providers + SMTP are **RFC 0095 connection packs** (accepted);
  their credentials are provider auth, not the OpenWOP wire.
- Provider-native send scopes (`gmail.send` / `Mail.Send`) are **OAuth scopes**,
  not OpenWOP fields — a host concern under ADR 0024 §3.

So this is host work under this ADR. The Phase-2 approval interrupt rides the
already-normative interrupt primitive (no new interrupt type).

## Boundaries & single-source-of-truth

- **One send owner**: `emailAdapter` stays the single send seam; Phase 1 extends
  its provider table, Phase 3 adds a transport branch (HTTP vs SMTP) *inside*
  it. No second send path.
- **Draft ≠ send**: `core.email.draft` remains draft-only and untouched; sending
  is additive (`core.email.send` for provider-native; `email-send` for
  transactional). A reader can always tell drafting from sending by the node id.
- **Capability dispatch**: a future `send` capability could resolve the acting
  user's send-capable provider (transactional vs their own mailbox) the ADR 0186
  way — noted, not required for Phase 1.
- **Converge the stub senders, don't grow a third transport.** Two other
  in-tree senders MUST route through the Phase-1 provider table rather than
  standing up their own transport: the Email-Marketing console stub
  (`features/email/emailService.ts`, ADR 0019) and the Commerce transactional
  transport (`features/commerce/transactionalEmail.ts`, ADR 0177 — its own
  comment already asks for "an operator SMTP/provider"). `emailAdapter` stays
  the single send owner; these become consumers of it.

## Phased plan

| Phase | Scope | Risk | Gate |
|---|---|---|---|
| 1 | **LANDED** — `email-send` provider table in `emailAdapter` + **Postmark** builtin manifest (SES reclassified: SigV4 non-fit, follow-up); `email:sent` `DurableCollection` idempotency ledger (mirrors `ads:dispatch`) dedups on the node's fork-stable `idempotencyKey`, closing the pre-existing SendGrid double-send-on-retry gap; `OPENWOP_EMAIL_DEFAULT_PROVIDER` env. Retention: **TTL sweep LANDED (follow-up closed)** — `sweepExpiredEmailSent` deletes rows past `OPENWOP_EMAIL_LEDGER_TTL_DAYS` (default 30, ≫ any replay window), bounded + fail-contained, riding the webhook-worker tick like `sweepExpiredApprovalGates`. | none (HTTP via broker + firewall) | ships behind the operator's own transactional account |
| 2 | **LANDED** — `core.email.send` provider-native node: write re-consent (`Mail.Send` offerable-not-default write scope group on `microsoft-graph`; Gmail `gmail.send` already present) **+ mandatory approval interrupt** (`ctx.suspend` `kind:'approval'`, `profile:'openwop-send-approval'` carrying the rendered to/subject/body preview; a frontend `ApprovalCard` branch renders it) + **deterministic idempotency** (shared `email:sent` ledger keyed `${tenantId}:send:${runId}:${nodeId}`, dedups on replay/`:fork`/resume) **+ approved-bytes-verbatim** (send bytes come from `renderEmailRequest`, a pure function of replay-stable inputs — the same render feeds the preview, so nothing re-renders differently post-approval). Headless / reject / expiry **never send** (fail-closed). Draft + send share `renderEmailRequest`/`parseEmailConfig` (one CR/LF header-injection guard, no drift). | behavioral (reverses draft-only) — contained by the two gates, the two replay guards, and headless-drafts-never-sends | a real phase gate — reverses a safety posture |
| 3 | raw **SMTP** transport (nodemailer, `basic` conn) — **DEFERRED (YAGNI)**: transactional providers (Phase 1) + provider-native send (Phase 2) cover the real self-hoster; no demand yet. Its own ADR is required before building (TCP egress allowlist + dep review). | **new TCP egress surface + long-lived password credential** | **YAGNI until proven**; own ADR required (TCP egress allowlist + dep review) |

## Open questions

- [ ] Should Phase 1 read a host **default send provider** env
      (`OPENWOP_EMAIL_DEFAULT_PROVIDER`) so a template's `email-send` with no
      `config.provider` picks SES on an SES-only host, not the hard-coded
      `'sendgrid'`? (Leaning yes — a one-line adapter change.)
- [x] Phase 2: does the approval card reuse the ADR 0189 `openwop-connection`
      profile family, or warrant a distinct `openwop-send-approval` profile with
      a message preview? **RESOLVED — distinct `openwop-send-approval`.** It is a
      `kind:'approval'` suspend (inheriting the fail-closed timeout + exactly-once
      CAS + the existing `ApprovalCard`), enriched by the `profile` discriminant
      that carries a `message` envelope (to/subject/bodyPreview/provider) so the
      approver confirms the *exact bytes* — the content preview is the whole point
      of the gate. Same discriminated-by-`data.profile` pattern as ADR 0189's
      connection card.
- [x] Is there demand for Phase 3 (SMTP) at all, or do transactional providers
      (Phase 1) cover every real self-hoster? **RESOLVED — deferred (YAGNI).**
      Phase 1 (transactional) + Phase 2 (provider-native send-as-you) cover the
      real self-hoster; no concrete SMTP demand surfaced. Left unbuilt behind its
      own future ADR (TCP egress allowlist + nodemailer dep review) rather than
      opening a new TCP egress surface + long-lived password credential speculatively.
