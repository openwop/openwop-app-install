# ADR 1018 — public widget conversations: a snippet that loads, a thread the model sees, a record the operator can read

Status: implemented (2026-10-31, row 68; accepted after the `/architect` pass below)

Date: 2026-10-31 · Feature: `chat-widget` (extension; toggle id unchanged) · Feature loop
round 2, row 68 · Extends ADR 0127 (public embeddable chat widget), ADR 0469 (anonymous-actor
operator surface), ADR 0470 (anonymous lead capture), ADR 0707 (widget LLM caps)

## Context

Row 68's workflows grade (`docs/steward/workflows-assessment/2026-10-31-chat-widget-row68.md`)
re-measured the widget on `origin/main` @ `02b2df2e1`. The gates on the visitor path (token,
Origin allowlist, caps, fenced input, managed key) are sound. The path itself is not:

- **`CW68WF-1`: the snippet cannot load in production.** `embedSnippet()`
  (`frontend/react/src/client/chatWidgetClient.ts:61`) prefixes `config.baseUrl`, which in
  production is the relative `/api` (`frontend/react/.env.production:20`). On a customer's
  site the `<script src="/api/…">` resolves against the customer's origin. Measured: 0
  requests to any `public/widget` path in 30 days of Cloud Run logs, while the gateway itself
  answers `200 application/javascript` and reflects CORS.
- **`CW68WF-2`: the transcript lies.** The embed shows a running conversation, but each
  `POST /widget/message` carries one message and both lanes build the model input from that
  message alone (`publicGateway.ts:251-256`; `anonymousActor.ts` `runAnonReadTurn` starts from
  `[{role:'user', …}]`). ADR 0127 OQ-1 deferred multi-turn and never told the visitor.
- **`CW68WF-3`: the operator sees nothing.** The default (no tool grant) lane is runless, so
  nothing records what visitors asked or what the agent answered.
- **`CW68WF-4`: the per-day session cap overshoots under concurrency.** `checkWidgetTurn`
  reads the day count, CAS-creates the session, then increments the day count unconditionally
  (`capsTracker.ts:188-199`); its increment loop also reports `allowed` after 12 lost CASes.

Two further code findings ride the same change: `allowedDomains` accepts any non-empty string
(`widgetService.ts:96-106`), so a bare `com` admits every `.com` site and a pasted
`https://acme.com/` never matches anything; and the gateway logs the raw `Origin`/`Referer`
(`publicGateway.ts:76`), and a Referer carries the visitor's full page URL, query string
included.

## Boundaries audit

- **Routes.** The operator routes live under `/host/openwop-app/chat-widget/orgs/:orgId/…`
  (`features/chat-widget/routes.ts`) and the public ones under `PUBLIC_EMBED_PREFIX`
  (`middleware/cors.ts:125`). The new routes extend these two prefixes. No other feature
  registers under either (`grep -rn "chat-widget/orgs\|public/widget" backend/typescript/src`).
- **Conversation store.** The RFC 0005 conversation primitive (`chat/`, `conversationExchange`)
  is an AUTHED, user-owned store: every conversation has an owning principal, BYOK resolution
  and the in-app panel. An anonymous visitor has none of those. Putting visitor threads into it
  would mint a conversation owner per page load and expose them to every in-app conversation
  lister. The visitor thread is therefore a feature-owned `DurableCollection`, the same shape as
  the widget's existing counters (`capsTracker.ts`).
- **The model loop.** The tool lane already rides the ONE shared `runChatToolLoop`
  (`anonymousActor.ts`); the default lane rides `dispatchManagedChat`. Both stay. This ADR
  adds history to their message arrays; it adds no dispatch path.
- **Age-out.** `registerKvAgeOut` (`host/kvAgeOut.ts:149`) is the default-ON size-hygiene
  lane; `registerRetentionPurger` is the opt-in governance lane the counters use today. The
  thread store takes the default-ON lane, because its retention is part of the privacy promise,
  not an operator option.
- **Public-surface helpers.** `originAllowed`/`hostOf` (`originAllowlist.ts`) stay the one
  matcher; the domain normaliser reuses `hostOf`.

## Decision

### D1 — The snippet is absolute (`CW68WF-1`)

`embedSnippet()` resolves `config.baseUrl` against `window.location.origin` before it builds
the tag (`new URL(base, origin)`), so a relative `/api` becomes
`https://app.openwop.dev/api/…`. An absolute `baseUrl` (dev, white-label) is unchanged. The
FE test asserts the snippet's `src` parses as an absolute `https?:` URL whose origin is the
page origin when the base is relative. `embed.js` already derives its API base from its own
`src`, so nothing else changes.

Why the client derives it rather than the server (`/architect` #6): `publicBaseUrl` names the
OAuth origin and knows nothing of the Hosting `/api` rewrite, so a server-built URL would drop
the prefix the SPA itself uses. The console can only load where `/api` reaches the backend, so
"the console's own origin + its own base" is correct by construction wherever the operator is
looking at it (production, a preview channel, a white-label domain). The test covers a relative
base, a trailing-slash base (`/api/`), a versioned base (`/api/v1`) and an absolute base.

### D2 — A bounded, server-held visitor thread (`CW68WF-2`)

- **Store.** `chatwidget:thread`, key `${tenantId}:${orgId}:${widgetId}:${threadId}`, row
  `{ tenantId, orgId, widgetId, threadId, messages: [{ role: 'visitor'|'agent', text, at }],
  startedAt, updatedAt }`. `threadId` is `sha256(widgetId + ':' + sessionId)` truncated to 32
  hex: the raw session id never reaches storage, logs or the operator view. It is NOT the ADR
  0469 anon principal: `mintAnonPrincipal` HMACs with a per-process secret unless
  `OPENWOP_ANON_ACTOR_HMAC_SECRET` is set (`anonymousActor.ts:124`), so it is not stable across
  instances or restarts, and a thread key must be. No `tenantOf` index (none is read).
- **Only a real session id threads.** A thread is kept only when the visitor sends a
  `sessionId` matching `^[A-Za-z0-9_-]{16,128}$`. The gateway's existing `'anon'` fallback
  (one shared bucket for every visitor without an id) would otherwise put many visitors in one
  thread, and the model would answer one visitor from another's messages. Without a qualifying
  id, the turn stays stateless as today.
- **Bounds (bytes, not just counts — `/architect` #3).** Each stored message is cut to 1,000
  characters (the model still sees the visitor's full current message, up to the existing 4,000).
  A row keeps the last 20 messages, so a row is at most ~20 KB. Sent to the model: the last 8
  stored messages before the new one. There is no separate inactivity window: a thread lives as
  long as the visitor's tab keeps its session id and the row survives the 7-day TTL (D3). (The
  first draft replaced a row's messages after 24 hours idle, which deleted a conversation the
  operator had been promised for 7 days — `/architect` #7.)
- **Stored text is redacted.** Visitor text and replies both pass `sanitizeFreeText` before
  they are stored (secret-shaped strings; `/architect` #4).
- **Model input.** Prior visitor messages are re-fenced with `fenceUntrustedBlock` exactly as
  the current one is; prior agent replies go in as `assistant` turns, already
  `sanitizeFreeText`-ed when stored. The history carries text only: no run, ask or conversation
  id, and no timestamps, so the model input is run-independent (ADR 1002).
- **Both lanes.** The default lane prepends the history to its `messages`. The tool lane passes
  it through a new optional `history` parameter on `runAnonReadTurn`, prepended before the
  current fenced message. `runAnonReadTurn` stays feature-agnostic: it accepts message pairs,
  not a store.
- **Write order.** The visitor message and the reply are appended in ONE CAS write after the
  reply is produced. A failed dispatch writes nothing, so the thread never holds an unanswered
  turn. A lost CAS re-reads and re-appends (bounded retries); exhaustion logs and still returns
  the reply (the reply is the visitor's; losing one history entry is the lesser failure).
- **Embed.** `embed.js` keeps the session id and the visible transcript in `sessionStorage`
  (every access in `try/catch`; absent storage degrades to today's per-page session), so a
  visitor who navigates within the customer's site keeps one thread. The restored transcript is
  rendered through the same `textContent`-only `add()`. There is NO public read endpoint for a
  thread: the transcript a visitor sees is their own tab's copy. A tab duplicated by the
  browser inherits a copy of `sessionStorage`, so two tabs can write one server thread while
  each shows its own transcript; the model then sees turns that tab never displayed. Accepted:
  it is one visitor's own messages.
- **Threat model (`/architect` #2, stated rather than avoided).** Server-held history makes the
  session id a credential: whoever holds it can append to the thread and can ask the model to
  repeat earlier turns. The id is 122 random bits (`crypto.randomUUID`) and lives in the
  customer page's `sessionStorage`, where any script on that page can read it — and that same
  script can already read everything the visitor types. The id is never logged, never put in a
  URL, and never returned by any route. A server-minted id would not change who can read
  `sessionStorage`, so this ADR accepts the risk instead of claiming the restore-endpoint
  rejection (Alternatives) avoided it. A client choosing its own id only reaches its own thread.
- **Disclosure.** The embed's notice line already says "a team member may follow up on what
  you share". It gains nothing new; the operator view (D3) is what that sentence promised.

### D3 — The operator reads recent conversations (`CW68WF-3`)

- `GET …/chat-widget/orgs/:orgId/widgets/:widgetId/conversations` returns SUMMARIES of the
  widget's threads (`threadId`, `startedAt`, `updatedAt`, message count, a 140-character
  preview of the first visitor message), newest first, at most 50. It reads
  `listByPrefix(`${tenantId}:${orgId}:${widgetId}:`)`, never `list()`.
  `GET …/conversations/:threadId` returns one thread's messages. Gate for both:
  `authorizeOrgScope(…, 'workspace:write')`. Visitor text can carry personal data, so the read
  sits at the tier of editing the widget, the same tier as the sibling anon-write review
  projection (`anonymousActor.ts:574-578`).
- `DELETE …/widgets/:widgetId/conversations/:threadId` (`workspace:write`) removes one thread,
  for a visitor who asks.
- `deleteWidget` deletes the widget's threads. Tenant teardown reaches them through the
  generic walk because each row carries `tenantId` (`REACHABLE_ROW_TENANTID`);
  `test/teardown-reachability-coverage.test.ts` gains the namespace.
- **Plan lapse (`/architect` #5).** The operator routes gate on toggle + plan; the visitor
  gateway on the toggle only. On a lapsed plan visitors can keep writing threads while the
  operator cannot read or delete them. Threads still expire at 7 days, and turning the
  `chat-widget` toggle off stops new ones. Recorded, not fixed here: no erasure-exemption
  precedent for a plan-gated route was found.
- **Retention.** `registerKvAgeOut({ id: 'chatwidget:thread', prefix:
  'hostext:chatwidget:thread:', ttlDays: 7, timestampField: 'updatedAt' })`: default ON, no
  operator opt-in. It runs on the retention daemon's tick, which starts by default because
  `idempotencyTtlDays()` defaults to 7 (`retentionSweepDaemon.ts:56-61`) and runs age-out
  before its opt-in early returns (`retentionSweepDaemon.ts:585`). Two exceptions, stated: a
  tenant under legal hold keeps its rows (the row carries `tenantId`, `kvAgeOut.ts:238-252`),
  and an operator who zeroes every daemon gate stops the sweep. The rows carry no subject
  identifier (no `userId`, `email` or `subjectKey` field), so a DSAR by subject cannot find
  them; the 7-day hard TTL plus the per-thread delete is the erasure story, and this ADR says
  so rather than claiming coverage.
- **FE.** WidgetsPage gains a "Conversations" action per widget that opens a read-only list
  (visitor/agent bubbles rendered as plain React text: no markdown renderer, no
  `dangerouslySetInnerHTML` — visitor text is attacker-controlled; a delete per thread through
  `confirm`). Not a chat panel: there is no composer, and the operator cannot reply from it.

### D4 — The day cap is claimed before the session (`CW68WF-4`)

`checkWidgetTurn` claims a day slot by CAS (`sessions + 1 ≤ max`) BEFORE it creates the
session. If the session create then loses (a concurrent first turn of the same session won),
it releases the slot by CAS-decrement. If the day claim exhausts its retries it fails closed
(`session_cap`). The session record stays the anchor for `newSession`. A release that exhausts
its retries, or a crash between claim and create, leaves the day OVER-counted by one: the
conservative direction, logged (`/architect` #8).

> **CORRECTED during implementation (2026-10-31).** The claim-then-release shape above
> refused concurrent first turns of the SAME session: five parallel first turns at a cap
> of 2 each took a slot, three were refused before any could see the session their
> sibling created (the PUB-3 test went red). The shipped claim is **idempotent per
> session**: the day row keeps a 12-hex hash of every session it admitted, a claim for
> an already-admitted session succeeds without counting, and a lost session create
> needs no release at all. `maxSessionsPerDay` is clamped to 2,000 (`MAX_SESSIONS_PER_DAY`)
> so the member list stays bounded.

### D5 — `allowedDomains` is a host list

Each entry is normalised through `hostOf` (so a pasted `https://Acme.com/path` becomes
`acme.com`) and must then be `localhost` or a dotted hostname of `[a-z0-9-]` labels with no
port, wildcard or path. A bare label (`com`) is refused with a 400 naming the entry. Existing
rows are not rewritten, but the MATCHER applies the same grammar (`/architect` #1): each stored
entry is normalised through `hostOf` and a single-label entry other than `localhost` is
skipped. So a legacy `com` row fails closed at once and a legacy `https://acme.com/` row starts
matching `acme.com`, without waiting for a save.
A public-suffix entry such as `co.uk` still passes (no PSL in the host); the ADR records that
as a known limit.

### D6 — The gateway logs a host, never a URL

`widget_origin_rejected` logs `hostOf(origin)`, not the raw header.

### D7 — The abuse counters age out by default

`chatwidget:session`, `chatwidget:day`, `chatwidget:anonwrite:day` and
`chatwidget:anonautowrite:session` register on `registerKvAgeOut` (each with its own `id`) with `ttlDays: 2` on
`updatedAt`. Their decision windows are one day or one visitor session (now a tab, D2), and
an active session refreshes `updatedAt` on every turn, so two days loses nothing a live visitor
needs. The existing opt-in retention purger stays (it is the governance lane; this is size).

### D8 — A widget answers on the owner's own key; the managed key is for superadmins only

> **DECIDED 2026-10-31 (user, via the release manager; follow-up to #5430/#5432).** Until
> this line every widget answered visitors on the platform's MANAGED key (`openwop-free`),
> whoever owned it, behind a public token. Now ONE resolver,
> `resolveWidgetCredential(tenantId)` (`features/chat-widget/widgetCredential.ts`), shaped
> after `resolveStorefrontSettlement` (ADR 0877), answers for all three sites:
>
> - `byok` — the workspace's active chat binding (ADR 0517) names a stored key of a
>   selectable provider. The widget answers on that key, under the workspace's ADR 0178
>   daily BYOK budget. This holds for a superadmin tenant too.
> - `managed` — no own key, and the tenant is listed in `OPENWOP_SUPERADMIN_TENANTS`
>   (exact match; the dev-open switch is not consulted).
> - `refused` — anyone else (`no_own_key`, `managed_binding`, `subscription_binding`, or
>   `key_unavailable` for a bound key that no longer resolves).
>
> Create and PATCH (any PATCH that leaves the widget enabled) return a 400 with
> `details.field: 'credential'` and `details.code: 'widget_byok_required'`; the console
> maps the code to "This widget needs your own model key." in all four locales. Turning a
> widget off is never refused. The public message turn asks before a cap is claimed and,
> on `refused`, stops (503, the embed's generic "could not respond"; log
> `widget_credential_refused` with the reason). There is no fallback to managed. Prod had
> 0 widgets at decision time (measured for #5430), so there is no migration.

## Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | All code in `features/chat-widget/` + the one optional `history` param on `host/anonymousActor.ts`. No core route or nav edits. |
| 2 | Toggle | Unchanged: `chat-widget`, default ON, tenant-bucketed, Support bundle (ADR 0820 §8.2). No sub-toggle: multi-turn and the operator view are the feature working as its UI already claims. |
| 3 | `ctx.<feature>` surface | None added. The widget has no run surface; the threads are operator data, read by the operator route. |
| 4 | Node pack | None. |
| 5 | Envelopes | None. |
| 6 | Agent pack | Unchanged (the widget is driven by the operator's chosen agent). |
| 7 | Public surface | No new public route. `POST /widget/message` gains the thread read/append; the token + Origin + toggle + caps gates run first, unchanged. No thread read is public. |
| 8 | RBAC | Conversations read + delete at `workspace:write`, org-scoped through `authorizeOrgScope` (IDOR: the key includes tenant + org + widget). |
| 9 | Replay | The default lane has no run. The tool lane's model input gains history that is run-independent text (ADR 1002). |
| 10 | Frontend | WidgetsPage conversations drawer + snippet fix. 4-locale i18n, tokens only. |

## RFC verdict

Host extension under `/v1/host/openwop-app/*`. No wire change, no RFC.

## Compatibility with CLAUDE.md "one AI chat" (decided 2026-10-31, lead + this ADR)

CLAUDE.md forbids a second IN-APP chat panel or a bespoke "talk to AI" textarea, and says a
surface that wants chat inside it renders `chat/EmbeddedChatPanel`. The public widget is not
an in-app surface: it runs on a THIRD-PARTY page, for an anonymous visitor, with no session,
no BYOK and no access to the SPA bundle, so it cannot import `EmbeddedChatPanel`. What the
rule protects is one model loop and one set of capabilities, and that holds: every model call
the embed causes runs server-side through the shared managed dispatch or `runChatToolLoop`
(the anon tool lane), with the same firewall and fencing. `embed.js` is the anonymous lane's
thin client and holds no model logic. The operator's Conversations view is a read-only record
with no composer, and testing an agent deep-links into the ONE chat (`/chat?agent=`). The
iframe option (B below) is recorded, not chosen. A later disagreement is a revisit, not a
block.

## Alternatives weighed

- **Store visitor threads as RFC 0005 conversations.** Rejected (boundaries audit): an
  authed, user-owned store; anonymous owners per page load would leak into in-app listers.
- **(B) Iframe the in-app `EmbeddedChatPanel` / `EmbeddedConversation`.** Rejected for this row: needs anonymous
  conversations in the RFC 0005 store, per-widget dynamic `frame-ancestors`, the SPA chunk on
  every customer page and a BYOK-gate bypass. Recorded as a future option, not a follow-up the
  feature needs. The vanilla embed is the anonymous lane's thin client; every model call it
  causes runs through the shared server-side loop.
- **Client-held history (the embed sends the transcript).** Rejected: a visitor could forge
  "assistant" turns and steer the agent, and the operator would still see nothing.
- **A public thread-restore endpoint.** Rejected: it would hand back the stored text verbatim to
  whoever holds a session id. The session id is still a credential for appending and for asking
  the model about earlier turns (D2 threat model); this rejection narrows that, it does not
  remove it.

## Phased plan

| Phase | Scope | Gaps |
|---|---|---|
| P1 | D1 snippet + test; D5 domains; D6 log | `CW68WF-1` |
| P2 | D4 day-cap claim | `CW68WF-4` |
| P3 | D2 thread store + both lanes + embed `sessionStorage`; D7 counter age-out | `CW68WF-2` |
| P4 | D3 operator routes + FE drawer | `CW68WF-3` |

## `/architect` pass (adversarial, before code) — 2026-10-31

Verdict on the first draft: NO-GO, GO after text changes. All cited `file:line` refs verified.
Folded in above: #1 (D5 at match time), #2 (threat model stated; the Alternatives wording no
longer claims the risk was avoided), #3 (byte caps, summaries, `listByPrefix`), #4 (redaction;
the suggested anon-principal link was rejected because that HMAC is per-process), #5 (lapse
recorded), #6 (client derivation kept, with the reason and the URL-shape tests), #7 (no
24-hour replacement; tab duplication stated; D7 wording), #8 (D4 overcount direction), #9
(`id`, legal hold, daemon caveat), #10 (teardown mechanism + test), #12 (operator view renders
plain text). #11: `runAnonReadTurn` has one caller (`publicGateway.ts:190`), so `history`
reaches no other anon surface; P3 adds a test that the history a model receives is text only.

## Implementation record

| Phase | What shipped | Witness (sabotage-checked: each test goes red with the guard removed) |
|---|---|---|
| P1 D1 | `embedScriptUrl` resolves the base against the console origin | `embedScriptUrl.test.ts`, `WidgetsPage.test.tsx` (anchored `src="http`) |
| P1 D5 | `normalizeAllowedDomain` at write (400 naming the entry) and match time | `widget-origin-allowlist.test.ts`, `chat-widget-service.test.ts` |
| P1 D6 | rejection log carries `originHost` only | — (log shape) |
| P2 D4 | idempotent per-session day-slot claim | `chat-widget-caps.test.ts` (10 concurrent → exactly 3; PUB-3 same-session) |
| P3 D2 | `visitorThreads.ts`; history in both lanes; embed `sessionStorage` | `adr1018-widget-conversations.test.ts`, `anonymous-actor.test.ts` (tool lane) |
| P3 D7 | counters on `registerKvAgeOut` (2 days) | — (registration) |
| P4 D3 | conversations list/read/delete, summaries index, `deleteWidget` cascade, FE panel | `adr1018-widget-conversations.test.ts`, `WidgetConversations.test.tsx` |
| D8 | `resolveWidgetCredential` at create, PATCH and the public turn; console copy | `adr1018-d8-widget-credential.test.ts`, `WidgetsPage.test.tsx` |

Independent `/grade-code` and `/grade-ux` passes then ran on the first cut. Fixed in the
same PR: the list read every transcript (now a per-thread summary row,
`chatwidget:threadsum`); the abuse counters keyed on the RAW session id (now the same
hash as the thread, `visitorSessionKeys` — the raw id is stored nowhere); an empty or
failed reply was stored as a turn; an unservable agent id was accepted (now a 400 at
create and re-assign, and the console offers a roster picker); the embed mounted a chat
that could never answer (it now mounts only after its config answers, and warns the
site owner in the console); no close control, a stale launcher label, 14 px input
(iOS zoom), no phone layout, no 429 copy; the visitor notice did not say the chat is
kept (it now states the server's TTL); a disabled widget could not be re-enabled and
showed a raw `disabled` key; stale comments in five places. Filed with reasons in the
row-68 per-run file.

## Open questions

1. Should the 7-day retention be operator-configurable per widget?
   Default: no, fixed, until someone asks; a longer retention is a privacy decision.
2. Should a thread whose visitor gave an email (an ADR 0470 lead) link to that approval? Not in
   this ADR.
