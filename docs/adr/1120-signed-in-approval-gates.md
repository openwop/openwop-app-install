# ADR 1120 — Signed-in approval gates (Book AI P53)

Status: Accepted (2026-11-14, David: "do all of these 'still waiting' items", which
scheduled P53). Implemented in this PR.

## Context

Book AI applies an AI-drafted change only when an owner or co-author approved it while
signed in (its ADR 0009 option C). Its apply check reads `interrupt.resolved.resolvedBy`
and requires a person Subject (RFC 0259 §A.1). The host's approval email carried
Approve/Reject links that resolve the gate by presenting its resume token, as a guest. So
a one-click approve from the email closed the gate, Book AI then refused to apply it
(`approval-needs-sign-in`), and the author had to start again.

Book AI asked for (a) a per-gate setting under which the email cannot decide, and (b) a
stable link that opens one approval after sign-in (`bookai/docs/upstream-proposals.md`
P53). bookai-c4 reviewed the design on 2026-11-13. One change came from that review:
under the new setting the email carries no token at all, not even a view-only one,
because Book AI's gate data can hold manuscript text and a forwarded token would let
anyone read it.

## Decision

**This is host policy, not an RFC.** `interrupt.md` §Tokens: "A host MAY mint
`intent: inspect` tokens; a resolve with one MUST be refused with `403`". The resolve
door that presents a token is a SHOULD surface, and refusing a token resolve under a
gate's own policy changes no wire shape and advertises nothing. Deciding through
`resolveInterruptByRun` (an authenticated session holding `approvals:respond`) gives an
authenticated `resolvedBy` (RFC 0259 §A.1).

- **D1 — the config.** `core.approvalGate` and `core.chat.approvalGate` take
  `decide: 'signed-in' | 'link'`, default `'link'`. It is closed-world: any other value is
  an `invalid_config` failure at the writer, like `rejectionPolicy` (ADR 0600 §6).
  `'signed-in'` is copied into the interrupt RECORD's data (`decide: 'signed-in'`).
  `'link'` writes nothing, so a gate without the key is byte-identical to before.
  `host/approvalGateDecide.ts` owns the reader and the predicate
  (`gateRequiresSession`).
- **D2 — the token doors refuse.** On a `'signed-in'` gate, every resolution that
  presents the resume token (`reviewer.tokenPresented`: `POST /interrupts/{token}` and
  the email confirm form's POST) is refused in `resolveAndResume` with `403`, reason
  `interrupt_requires_session`, before any claim. The confirm form's GET renders a "Sign
  in to decide" page instead of a decide form. The refusal is keyed on the RECORDED
  gate data, so a leaked or newly minted token cannot bypass it, and a replay fork keeps
  it.
- **D3 — the run-scoped door decides.** Unchanged. A signed-in member decides in the
  app (the inbox card and the chat card both use it). An API key on that door is still
  accepted: it authenticated, and Book AI's apply check refuses a non-person resolver
  anyway (bookai-c4, 2026-11-13).
- **D4 — the email.** For a `'signed-in'` gate, `emitInterruptNotification` mails
  without the token. The email's only link is a **Review** link to that person's own
  row: `/inbox?notification=<id>`. `deliverApprovalEmail` accepts a `reviewPath`
  only under `/inbox`. A `'link'` gate's email is unchanged: the same token argument
  and no `reviewPath`.
- **D5 — back to the request after sign-in.** `/inbox` joins the `signInReturn`
  allowlist (same-origin, exact path, query kept). When the inbox is opened signed out
  with a deep link, it shows "Sign in to review this request" with a Sign in button that
  remembers the exact URL. After sign-in it follows the remembered return. The copy is
  in 4 locales.

### Scope kept out

- **Opening an approval the person was not notified about.** The design's (b) also
  proposed resolving `?approval=<id>` directly when the caller holds no matching row.
  Book AI's link is always to the recipient's own notification row, which D4 and D5
  cover. The direct resolve, with its eligibility check, is a follow-up.
- **MCP and inbound-webhook resumes** (`capabilityToken` without a presented token)
  are not token doors. They are left as they are.
- **Mobile universal or app links** are per white-label product, a follow-up once Book
  AI has an app id.

## Alternatives weighed

- **An RFC 0170/0259 revision** (a wire member saying "this gate needs a session"). It
  isn't needed: the refusal is already allowed, and nothing about the gate's policy has
  to cross the wire.
- **Mailing an `intent: inspect` token** so the email opens the request read-only. This
  was rejected on bookai-c4's privacy point: gate data can hold private text, and since
  deciding needs sign-in anyway, opening it after sign-in costs nothing.
- **Refusing every `capabilityToken` lane.** That would also refuse an API key on the
  run-scoped door, which was decided to stay allowed.

## Verification

- `test/adr1120-signed-in-gates.test.ts` (7 tests, born for this ADR):
  - the closed-world reader;
  - the chat gate forwarding `decide` and failing typed on an unknown value;
  - the email lane: `'link'` mails the token and no review path, and `'signed-in'` mails
    no token and `/inbox?notification=<id>`;
  - a real `core.approvalGate` run: a leaked token gets `403 interrupt_requires_session`
    on `POST /interrupts/{token}`, on the confirm POST ("Sign in to decide") and on the
    confirm GET (no form). The run stays waiting, and the run-scoped door then completes
    it;
  - a replay fork keeps the refusal;
  - `'link'`: the token decides and the form renders.
- `test/approval-notice-delivery.test.ts`: under `reviewPath` the mailed link is that
  path, with no `interrupt-action` link. A `reviewPath` outside the inbox is ignored.
- Frontend: the `signInReturn` allowlist accepts `/inbox` with its query and refuses
  look-alikes. The inbox prompt appears only signed out with a deep link, and remembers
  the exact URL.
- Sabotage: removing the door refusal reddens the door and fork tests, and removing the
  email gate reddens the email test.
- Pack `vendor.myndhyve.chat` 1.4.2 → 1.5.0 (`decide` in `approvalGate.config.json`,
  12 schema `$id`s, steward manifest).
