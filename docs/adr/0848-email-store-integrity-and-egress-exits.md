# ADR 0848 — Email: one id owner per row, and the egress exits a member can reach

Status: implemented (2026-10-07, feature loop round 2 row 30, branch `feat/fl2-30-email`; `/architect` pass before code, then grade-ux and grade-code — see the corrections table, the correction notes and the implementation record)

Fixes #4485. Builds on ADR 0019 (email feature), ADR 0193 (brokered send), ADR 0241
(bounce webhooks), ADR 0242 (HTML part + tracking), ADR 0256 (safe Markdown), ADR 0655
(the round-1 email Blockers), ADR 0832 (the surface org floor) and ADR 0838 D1 (the
documents id-owner fix this generalises).

## Context

Round 1 closed the email feature at B+ / A− / A− after ADR 0655 closed five Blockers. This
pass re-measured it on `origin/main` @ `e5088d4ae` and found the following. Each claim was
read at the cited line before it was written down.

1. **A caller-chosen id overwrites another tenant's row (#4485).** `email:template` and
   `email:campaign` are keyed by id alone (`emailService.ts:75-76`). `createTemplate` /
   `createCampaign` look for a prior row through the tenant+org-FILTERED getter, which answers
   `null` for a row another tenant holds, and then `put` blindly. In prod all 8 demo templates
   and 6 demo campaigns sit in one tenant, consistent with a seed that took them. The demo
   seeder was fixed in row 24; the store was not.
   - The ids are not only attacker-chosen. `feature.campaign-channels.nodes.publish-email-sequence`
     builds `idemBase = ${nodeId}:${briefKey}`, where `briefKey` hashes the subject lines and
     nothing tenant-specific (`packs/feature.campaign-channels.nodes/index.mjs:521-522`). Two
     tenants who publish the same subject lines collide **with no attacker present**.
   - `createCampaign` does not check that `templateId` belongs to the caller's (tenant, org).
     The HTTP route checks it (`routes.ts:202`); the service, which is the exit, does not.
   - `listTemplates` / `listCampaigns` scan every tenant's rows (`templates.list()`), because
     neither collection arms the tenant secondary index.
2. **A run can write drafts its starter could not write over HTTP.** The ADR 0832 seam floor
   checks `workspace:read` for every surface method unless the surface declares more. The
   email surface's `createDraftCampaign` writes a template and a campaign but declares nothing,
   while its HTTP twin needs `workspace:write`. A viewer's run creates drafts.
3. **One org can re-key another org's bounce webhook in the same tenant.**
   `setWebhookConfig` accepts a caller-chosen `webhookId` and checks only the tenant
   (`bounceWebhooks.ts:110-111`), then rewrites `orgId` to the caller's and REPLACES the
   verification secret. `removeWebhookConfig(tenantId, webhookId)` takes no org at all. An
   editor in org B can stop org A's suppression ingest, or re-key it to a secret B knows and
   forge bounces.
4. **Test-send is an unmetered relay.** `POST …/campaigns/:id/test-send` takes any `to`
   address, checks only its format, and has no rate limit; its idempotency key includes
   `Date.now()` so nothing dedups. The egress floor still runs (tombstone + suppression), but
   the consent leg applies only to an address that resolves to a CRM contact, so an outside
   address always passes. Any editor can send unlimited mail with arbitrary template content
   from the org's sender identity.
5. **Sender identity is an editor setting, and a comment claims a check that does not exist.**
   `PUT …/settings` is `workspace:write`; `setSenderAddress` validates shape only. The
   sendgrid/postmark APIs refuse an unverified sender on their side, but the SMTP lane relays
   whatever its mailbox server accepts. `brokeredProvider.ts:126` says "no verified sender
   configured", implying a verification step that is not there.
6. **A contact field becomes a working link on the tenant's trusted domain.** `interpolate`
   inserts `contact.name` / `contact.company` into the body BEFORE `instrumentBody` mints click
   tokens and before the HTML renderers autolink. A contact created from a public form with the
   name `https://evil.example` — or, in a Markdown template, `[Verify your account](https://evil.example)`
   — is delivered a tracked `/c` link that 302s to the attacker. Escaping is correct (no markup
   injection); the defect is that contact DATA is promoted to a LINK. Subjects also carry
   contact values with no CR/LF stripping (providers sanitise today; we rely on that).
7. **`EMWF-13` is still open, and its read path reports a false green.**
   `deleteSubjectEngagement` erases event rows only where `contactId === subjectKey`
   (`engagementService.ts:607-608`). A DSAR keyed by email or analytics session deletes the
   token rows (the only link to the contact) and leaves the contact's events behind. Both loops
   read with `.catch(() => [])`, so an unreadable store returns `{removed: 0, failed: 0}` — a
   green receipt over data that was never read.
8. **No RFC 8058 one-click header is sent.** The host emits no `List-Unsubscribe` /
   `List-Unsubscribe-Post` header on any send (`engagementService.ts:13-23`). Gmail and Yahoo
   require one-click unsubscribe from bulk senders since 2024; Mailchimp, Klaviyo and HubSpot
   all send it. The POST endpoint is already one-click-shaped (`routes.ts:368-398` accepts an
   Origin-less form POST), so only the header is missing.
9. **The public unsubscribe and preference pages set no framing or content-type headers.**
   `/u` and `/p` render forms that change consent. Escaping is correct, but nothing stops a page
   from framing them (clickjacking a token-holder).

Re-measured and **closed** since round 1: `EMWF-12` (the schedule daemon pauses plan-refused
jobs per fire, `scheduleDaemon.ts:103-124`; the segment-entry daemon checks toggle + plan,
`segmentEntryDaemon.ts:64-69`) and the `EMWF-17` pin drift (every email pin equals its pack
version and its steward-manifest digest).

## Boundaries audit

- **Owner of the stores:** `features/email/emailService.ts`. Every create path (HTTP route,
  workflow surface, agent tool, demo seeder) goes through `createTemplate` / `createCampaign`,
  so fixing the service covers the surface.
- **Owner of "an id another principal holds":** ADR 0838 D1 solved this once, privately, in
  `documentsService.ts`. A second private copy is the drift generator. This ADR lifts it into
  one host helper and moves documents onto it.
- **Owner of the egress floor:** `host/emailAdapter.ts` (ADR 0655 D1). The header lands there
  as a closed-world field, never as a free header map a workflow author could fill.
- **Owner of the surface org floor:** `host/featureSurfaces.ts` `gate()` (ADR 0832). Email only
  declares `methodScopes`; it adds no check of its own.
- **Not owned here, found by the census, reported not fixed:** `host/canvasSurface.ts`
  `ensureCanvasForTenant` (a global demo id moves one tenant's canvas into another) and
  `features/cms/surface.ts` `createDraftPage` (cross-org, same tenant). Both go to the
  orchestrator as issues; they are other rows' features. Filed: canvas #4514, CMS #4515.

## Decision

### D1 — One id owner: an existing row is returned only to its owner, never overwritten

- **New host helper** `insertOwnedOrConflict(collection, row, id, owns)` in
  `host/ownedInsert.ts`:
  1. read the RAW row by id;
  2. if it exists and `owns(existing)`, return `{ row: existing, created: false }` (the replay
     convergence every caller relies on);
  3. if it exists and is not owned, throw `409 conflict` ("That id is already in use."), with
     no tenant or org in the message or details beyond the id the caller sent;
  4. otherwise insert with `compareAndSwap(null, row)`; on a lost race re-read and apply 2–3.
- `createTemplate` and `createCampaign` use it with `owns = same (tenantId, orgId)`. Random ids
  take the same CAS path, so a concurrent creator of the same id cannot overwrite either.
- `documentsService.createDocument` moves onto the helper (its `ownedOrConflict` is deleted).
  One predicate, two adopters, one ratchet (below).
- `createCampaign` refuses a `templateId` that `getTemplate(tenant, org, …)` does not return
  (`400 validation_error`, the route's existing answer), so the check sits at the exit, not
  only at the HTTP door.
- Both collections arm the tenant secondary index (`tenantOf = row.tenantId`), and
  `listTemplates` / `listCampaigns` read `listForTenantIndexed`. `ensureTenantIndex` backfills
  legacy rows on first read; no migration and no re-keying.
- **The workflow surface mints tenant-qualified ids.** `createDraftCampaign` derives
  `tpl:${h}:${base}:email-N` / `cmp:${h}:${base}:email-N`, where `h` is a short stable hash of
  `tenantId:orgId`. It first tries the legacy id: if THIS (tenant, org) owns it, it is reused,
  so a replay of a pre-change run still converges and never duplicates. This is the row-24
  seeder precedent. Without it, D1 would turn today's silent cross-tenant overwrite into a
  `409` for the second tenant to publish the same subject lines — honest, but a new failure
  for an innocent user.
- **Prod data is NOT repaired.** Rows that already moved stay where they are (Open question 1).

### D2 — A run writes drafts only if its starter could

The email surface declares `orgPolicy.methodScopes = { createDraftCampaign: 'workspace:write' }`.
The ADR 0832 floor then holds a run to its starter's write access, exactly like the HTTP route.
The three reads keep the default `workspace:read`. A run with no subject (a system job) is
unchanged, as ADR 0832 specifies.

### D3 — A bounce webhook belongs to one org, and only an admin can (re)key it

- `setWebhookConfig` treats a supplied `webhookId` as owned only when the row's `tenantId`
  AND `orgId` match the caller. A supplied id held by another org or tenant is refused with
  `404 not_found` (the same answer as an unknown id on the delete), never re-keyed and never
  silently replaced by a fresh id the caller did not ask for.
- `removeWebhookConfig` takes `orgId` and deletes only an owned row.
- `POST` / `DELETE …/webhook-configs` require `webhooks:manage` (admin and owner), the scope
  the platform already uses for webhook secrets. Reads stay `workspace:read`.

### D4 — The sender identity is an admin setting, and the code says what really verifies it

- `PUT …/settings` requires `host:members:manage` (admin and owner). `GET` stays
  `workspace:read` and gains `canEdit: boolean` so the page can disable the field for an editor
  instead of letting them type and then fail.
- The comment at `brokeredProvider.ts` is corrected: the host does not verify sender
  ownership; sendgrid and postmark refuse an unverified sender at their API, and the SMTP lane
  sends whatever its mailbox server accepts. Domain verification (SPF/DKIM checks on the
  sender's domain) is recorded as a follow-up, not invented here.

### D5 — Test-send is metered per member

- A durable, CAS-counted window: at most `OPENWOP_EMAIL_TEST_SEND_PER_HOUR` (default **20**)
  test sends per (tenant, acting user) per clock hour. Over the cap the route answers
  `429 rate_limited` with `Retry-After` (seconds to the next hour) BEFORE any provider is
  resolved. The counter row is `email:test-send-window`, keyed
  `${tenantId}:${userId}:${hourBucket}`, tenant-indexed, swept by the retention purger.
- Recipient restriction (only verified or member addresses) was weighed and rejected: every
  competitor allows a test to any address (Mailchimp caps the count, it does not restrict the
  address), and agencies test-send to clients.

### D6 — Contact data never becomes a link, and never breaks a header line

- One `neutralizeContactValue(v)` in `emailService.ts`, applied to every interpolated contact
  value (name, email, company) on the real send, the test send and the `render` node:
  - removes CR, LF and other C0 controls (so a value can never start a header line);
  - defangs URL schemes: `scheme://` → `scheme:​//` and `mailto:` → `mailto​:`, so
    neither the text autolinker, the Markdown linkifier nor `instrumentBody` can recognise it,
    and most mail-client autolinkers stop too;
  - neutralises Markdown link brackets by replacing `[` and `]` with their full-width forms, so
    `[text](url)` in a NAME cannot render as a disguised anchor.
- Template-authored text and links are untouched: they are the operator's content.
- The `email` value is a real address. Its only rewriting is the control-character strip, and
  it is never a URL, so the defang is a no-op on a well-formed address.

### D7 — RFC 8058 one-click unsubscribe headers on every campaign send

- `EmailSendArgs` gains `listUnsubscribe?: { url: string }`, a closed-world field. It is never
  a free header map, so a workflow author cannot inject headers through it. The adapter turns it
  into `List-Unsubscribe: <url>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` for
  sendgrid (`headers`), postmark (`Headers`) and SMTP (`headers`).
- The URL must be `https:` and must point at this host's `/public-email/u/` path. Anything else
  is dropped (logged), never sent.
- `sendCampaign` passes the same `/u/:token` URL `instrumentBody` appended. `EmailMessage`
  carries it through `brokeredProvider`. Test sends carry no header: they have no unsubscribe
  token, and a test is not bulk mail.
- The existing `POST /u/:token` is the one-click endpoint. It already accepts an Origin-less
  form POST and answers 503 on a partial write so the provider retries.

### D8 — The public consent pages refuse to be framed

Every HTML response from `/u`, `/p` and their error pages sets
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
One helper, called by every renderer. The pages carry no script, so nothing breaks.

### D9 — Engagement erasure follows the subject, and an unread store is a failure

- The token loop records the `contactId` of every token it matched (by contact, address or
  session). The event loop then erases events whose `contactId` is the subject key OR one of
  those contact ids. This closes `EMWF-13` for both the email and the session lanes.
- A failed read is counted in `failed` (one per unread store), never swallowed into
  `removed: 0`. The email eraser already throws on `failed > 0`, so the DSAR receipt goes
  red instead of green.

## The ratchet

`test/adr0848-owned-insert-ratchet.test.ts`:

- **Behaviour:** for `createTemplate`, `createCampaign` and `createDocument`, tenant A creates
  id X, tenant B creating X gets `409`, and A's row is byte-identical afterwards.
- **Structure:** no source file under `src/features/{email,documents}` contains the old idiom
  (a filtered `get*` "prior" short-circuit followed by a `put` in a `create*` function), and
  every `create*` in those two services that accepts a caller-chosen id calls
  `insertOwnedOrConflict`. Every new guard is sabotage-witnessed: remove it, and the named test
  goes red.

## Architect review (pre-code, 2026-10-07) — corrections to the decisions above

An adversarial `/architect` pass read every decision against the code before any was
implemented. It returned **2 Blockers, 4 High, 9 Medium**. Each is answered here; the
decision text above is left as written so the trail shows what changed and why.

| # | Finding | Resolution |
|---|---|---|
| B1 | The title's "egress exits a member can reach" is false: the workflow node `core.openwop.integration.email-send` takes `from` from node config (13 chains use a free `{{params.senderEmail}}`), lets the author pick `purpose:"transactional"`, and is unmetered. | **Narrowed, not fixed here — named residue `EM2-WF-1`, #4517.** *(CLOSED 2026-10-15 by ADR 0895: `from` binds to the tenant's configured senders when any exist, `transactional` is admin-only, and chain sends are metered.)* Binding the node's `from` to the org sender would fail all 13 shipped chains, and a run has no single org. What the run lane DOES already hold: tombstone + suppression on every purpose (an unsubscribe writes a suppression row, so `transactional` cannot reach an unsubscribed recipient), marketing consent when not declared transactional, and an approval gate upstream of all 13 shipped sends. The D4/D5 claims are scoped to the email feature's own routes. |
| B2 | D7's "every campaign send" is unreachable without a link base: with no `OPENWOP_EMAIL_LINK_BASE_URL`/`…CALLBACK…`/`OPENWOP_PUBLIC_BASE_URL`, `instrumentBody` never runs, so a campaign ships with **no unsubscribe link at all** and EM-19's refusal never fires. | **New D7a:** `sendCampaign` refuses with `501 capability_not_provided` ("set a public base URL") before resolving the audience when the link base is empty. A marketing send with no opt-out is refused, not degraded. |
| H1 | D6's "the email value is never a URL" is false: CRM does not validate address shape, and the forms regex accepts `https://evil.example/x@a.co`. | D6 applies the full neutralisation to `email` too, in body and subject. The `to` field is never neutralised. |
| H2 | A LOST `compareAndSwap(null, row)` race leaves the loser's tenant-index marker pointing at the winner's row; `listForTenantIndexed` does not re-check the tenant. | Two fixes: the list reads keep the `tenantId && orgId` filter after the indexed read, and `compareAndSwap`'s failed-swap repair deletes `next`'s marker when `next` and the stored row belong to different tenants (host fix, own witness). |
| H3 | "Try the legacy id first" through `createTemplate` would 409 on a foreign legacy id, and would CREATE at the legacy id when absent. | The probe is READ-ONLY (`getTemplate`/`getCampaign` with the caller's tenant + org): own row ⇒ reuse; otherwise create at the hashed id. Template and campaign are probed independently. |
| H4 | D9 misreads EMWF-13: the subject resolvers already expand an email and a session to the contact, and collecting contact ids from SESSION-matched tokens lets a forwarded newsletter's reader erase the real contact's history, including retained `unsubscribed` rows. | D9 is re-scoped: (a) failed reads count as failures (the false green), (b) contact ids are collected ONLY from tokens matched by ADDRESS, never by session, which covers the residue where the contact row is gone or its address changed. |
| M1 | `insertOwnedOrConflict(collection, row, …)` forces the row to be built before the ownership check, so a replay at the documents cap or with a deleted segment would newly 400. | Signature is `(collection, id, owns, build: () => Promise<T>)`; `build` (with its caps and validation) runs only on the create branch, preserving both adopters' replay order. |
| M2 | `test/teardown-reachability-coverage.test.ts` lists `email:template`/`email:campaign` by hand; once indexed, the stale-entry assertion fails. | Remove both entries in the same change. |
| M3 | A superseded revision keeps writing after the one-shot index backfill sentinel is set. | Stated hazard, not fixed: those rows are written through the NEW code only after the new revision serves; the old revision's writes predate the index in the same way any unindexed write does. Recorded as `EM2-WF-7`. |
| M4 | A durable counter would never be swept by default (email purgers fire only for the opt-in `confidential-pii` class). | D5 uses the in-memory per-instance fixed window, the `analytics/routes.ts:90` and `consent/routes.ts:101` precedent. The cap is per instance (stated). |
| M5 | Changing `instrumentBody`'s return type breaks 9 test call sites. | A sibling `instrumentBodyWithUnsubscribe` returns `{ body, unsubscribeUrl }`; `instrumentBody` keeps its signature. Postmark's `MessageStream: 'outbound'` for bulk is recorded as `EM2-WF-8`, not changed (a broadcast stream is not guaranteed to exist on every Postmark server). |
| M6 | `updateTemplate` and the final `campaigns.put(next)` in `sendCampaignSerialized` are blind read-then-put: a delete during a send resurrects the row. | Both become `compareAndSwap(existing, next)`. The send's final write re-reads on a lost race and re-applies status + stats to the fresh row, up to 3 times. A row deleted mid-send stays deleted and the call returns `null`. |
| M7 | Headers "set by every renderer" miss the `next(err)` and `'Unknown link.'` exits. | D8 is route-scoped middleware on the `/u` and `/p` prefixes, so every response on them carries the headers. |
| M8 | Bare `www.` domains are still autolinked by Gmail; agent-tool ids are not tenant-qualified. | D6's claim is narrowed to "our renderers and `instrumentBody` never link it"; mail-client autolinking of a bare domain is a stated residue. Agent ids add `tenantId` to the hash, with the same read-only legacy probe. |
| M9 | The route's local `Scope` type needs widening; compute `canEdit` by catching the scope check; the webhook UI needs the flag too. | Done that way. There is no webhook UI today (EM-SP-8 deferred), so only the sender field consumes `canEdit`. |

## Feature evaluation matrix (`/feature-refinement`, 2026-10-07)

Decomposition: ONE feature, an **extension** of `email` (toggle `email` unchanged, no new
toggle, no new package). The competitive input is `docs/steward/UX_UPGRADE-email.md`
(Mailchimp / Klaviyo / HubSpot / Brevo, rounds 1–3). Of its named deferrals this ADR takes
only what is a compliance or egress floor: one-click unsubscribe (every competitor; required by
Gmail/Yahoo bulk-sender rules since Feb 2024), admin-held sender identity (Mailchimp and
Klaviyo both put verified-sender and domain settings at admin/owner) and metered test sends
(Mailchimp caps test sends per campaign and per day). Scheduling, A/B, reports and
preview-as-contact stay deferred with their R2 reasons.

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | All changes inside `features/email/` plus one new host helper (`host/ownedInsert.ts`) and an additive adapter field (`host/emailAdapter.ts`, `host/smtpSend.ts`). No core route or nav edits. |
| 2 | Toggle + admin UI | `email`, unchanged (OFF, `tenant`). Public routes stay toggle-independent (a recipient must always be able to opt out). |
| 3 | Workflow surface | `ctx.features.email` keeps its four methods; D2 declares `createDraftCampaign` as `workspace:write` on the ADR 0832 floor. |
| 4 | Node pack | `feature.email.nodes` unchanged (reads). `feature.campaign-channels.nodes` unchanged: the tenant-qualified ids are minted in the surface, so no pack bump. |
| 5 | AI chat + envelopes | No envelope. The two chat tools are unchanged; they already create through the service, so D1 covers them. |
| 6 | Agent pack | `vendor.openwop-app.email.agents` unchanged. |
| 7 | Public surface | `/u`, `/p` gain the D8 headers. `POST /u/:token` becomes a real RFC 8058 target (already Origin-tolerant). No new public path. |
| 8 | RBAC + isolation | D1 (cross-tenant id), D3 (cross-org webhook), D4/D3 tiers raised to `host:members:manage` / `webhooks:manage`, D2 run floor. Fail-closed: absent caller gets nothing; a principal-only caller (no user row) is still answered by `authorizeOrgScope` as today. |
| 9 | Replay / fork | D1 keeps id-convergence for an owned id; the surface tries the legacy id first so a pre-change run replays onto its own rows. `listUnsubscribe` does not enter the ledger key (`hashBody` covers text/html only), so a replay still dedups. |
| 10 | Frontend | `EmailPage` reads `canEdit` and disables the sender field with a hint; a 429 test-send shows the server's message. Strings in the lazy `features/email/i18n` chunk, four locales. |

## Alternatives weighed

- **Tenant-qualify the storage key** (`${tenantId}:${id}`) — rejected, as in ADR 0838: it
  needs a data migration over prod rows and changes every point read; the owner check closes
  the hole with no migration.
- **Restrict test-send recipients to member addresses** — rejected (D5).
- **Strip URLs from contact fields entirely** — rejected: a company called `example.com` is a
  real company. Defanging keeps the visible text and removes only the link.
- **Free `headers` map on `EmailSendArgs`** — rejected: a workflow author could then set
  `Bcc`, `Reply-To` or forged headers. The closed-world field allows exactly one header pair.
- **Keep sender and webhook writes at editor** — rejected: both are org identity and
  verification-secret settings. The platform puts webhook secrets at `webhooks:manage`.

## User-visible behaviour changes (product decisions for the user)

1. **Editors can no longer change the sender address or add, rotate or delete bounce
   webhooks.** Admins and owners can. An editor sees the sender field disabled with a hint.
2. **Test sends are capped at 20 per member per hour** (operator-tunable). The 21st answers
   "Too many test sends — try again in N minutes."
3. **A workflow run started by a viewer can no longer create email drafts**
   (`publish-email-sequence` / `createDraftCampaign`). It fails with a typed `forbidden`.
4. **A contact name or company that contains a URL or Markdown link is shown as plain text in
   sent mail**, not as a clickable link.
5. **Campaign mail now carries `List-Unsubscribe` + `List-Unsubscribe-Post` headers**, so Gmail
   and Yahoo show their native "Unsubscribe" button. A click on it unsubscribes the recipient
   through the same path as the link in the footer.
6. **A create that names an id another workspace already holds now fails with 409** instead of
   silently moving that row into the caller's workspace.
7. **(D7a, from the architect review) A campaign send on a deployment with no public base URL
   is refused** with "set a public base URL so recipients get an unsubscribe link", instead of
   going out with no unsubscribe link. Prod sets `OPENWOP_PUBLIC_BASE_URL`, so prod is
   unaffected; a self-hosted white-label install without it can no longer send campaigns.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 helper + email + documents + surface ids; D2 | `adr0848-owned-insert-ratchet.test.ts`, `adr0848-email-surface-write-floor.test.ts` — both RED on `e5088d4ae` |
| P2 | D3, D4, D5 (routes) + `canEdit` UI | `adr0848-email-route-tiers.test.ts` RED on `e5088d4ae` |
| P3 | D6, D7, D8 | `adr0848-email-egress-exits.test.ts` RED on `e5088d4ae` |
| P4 | D9 | `adr0848-email-engagement-erasure.test.ts` RED on `e5088d4ae` |

## Open questions

1. **Prod rows already moved by the 2026-07-09 seed** (8 templates, 6 campaigns in
   `user:c5118…`). Not repaired here. The orchestrator sizes it with prod reach (currently
   blocked on auth). Repair needs an approved data change.
2. **Domain verification for the sender** (SPF/DKIM lookup) — follow-up, not decided here.
3. **`recordUnsubscribe` reads the tenant's whole engagement ledger on every public POST**
   (`engagementService.ts:491,517`) — recorded as `EM2-WF-6`, not fixed: a deterministic event
   id needs a dedup story for the legacy random-id rows.
4. **`clientIp` trusts the leftmost `X-Forwarded-For` entry** (`middleware/rateLimit.ts:304-313`),
   which a client controls behind Google's front end — cross-cutting, filed as #4516 (HIGH),
   not fixed in an email ADR.

## RFC verdict

No RFC. Every change is host-internal: storage ownership, route scopes, a host-extension
surface policy, an adapter field the integration pack does not see, and response headers on
`/v1/host/openwop-app/*` pages. Nothing on the OpenWOP wire changes.

## Correction notes (implementation, 2026-10-07)

1. **D5 is per-instance, in memory** (architect M4), not the durable `email:test-send-window`
   collection D5's text names. No such collection exists.
2. **D7's URL check is "https + this host's `/public-email/u/<token>` PATH"**, not "this host".
   The adapter cannot know the deployment's public origin, so it checks the scheme, the
   path shape, the absence of credentials, and that no `<`, `>`, `,` or whitespace can break
   the header value. A foreign host with the same path would pass; only the campaign send
   sets the field, from `instrumentBodyWithUnsubscribe`.
3. **D6's bracket mapping applies only to a Markdown body** (grade-code finding 6). In a
   subject or a text template, brackets cannot form a link, so "Q&A [beta]" stays as typed.
4. **H2 is fixed twice** (grade-code finding 2): the failed-CAS repair deletes the loser's
   marker, AND `listForTenantIndexed` now drops (and heals) any row whose `tenantOf` is not
   the tenant being listed. The reader check is host-wide defence in depth: it also covers a
   crash between the marker write and the CAS, which no repair step can. Consequence for
   the witness: sabotaging ONE of the two leaves the H2 test green; sabotaging both turns it
   red. The CAS half was witnessed alone before the reader check landed (sabotage run S2).
5. **A campaign deleted mid-send now answers `409 deleted_during_send`**, not `null` / 404
   (grade-code finding 10): mail already went out in that pass, so "not found" was false.
6. **The 429 carries `details.limit = 'email_test_send'`** so the page tells the email meter
   apart from the global per-IP budget (grade-code finding 8).
7. **The link-base chain uses `||` over trimmed values** (grade-code finding 4): an empty
   `OPENWOP_EMAIL_LINK_BASE_URL` must not hide a valid `OPENWOP_PUBLIC_BASE_URL`, or D7a would
   501 every send.
8. **UX pass:** the editor's sender field is `readOnly`, not `disabled` (a disabled field
   leaves the Tab order, so its reason was never read); a 429 renders inside the dialog,
   localized from `Retry-After`; the unconfigured-sender notice tells an editor to ask an
   admin; the public pages pin `color-scheme: light`.

## Implementation record

| Phase | Commit (subject) | Witness |
|---|---|---|
| P1–P4 | `fix(email): one id owner per row, run write floor, org-bound webhooks, admin sender, metered test-send, contact data stays data, RFC 8058 headers, framed-page refusal, honest engagement erasure (ADR 0848 P1-P4)` | `adr0848-email-integrity.test.ts` — 19 of 22 RED on `e5088d4ae` (the 3 green were the replay-convergence and list positives) |
| fixtures | `test(email): campaign-send fixtures set a public link base (ADR 0848 D7a); real templates for campaigns (D1)` | the full backend run that found them: 23 reds in 5 files, all from D7a/D1/the unused seam |
| D4 UI + ratchet | `feat(email): sender field read-only for non-admins (canEdit) + the D1 structural ratchet (ADR 0848 D4 / D1)` | `adr0848-owned-insert-ratchet.test.ts`; `emailRound2.test.tsx` "ADR 0848 D4" |
| UX | `fix(email-ux): read-only (not disabled) sender for editors, inline localized 429 in the test-send dialog, admin-aware notice, light color-scheme on public pages (ADR 0848 / grade-ux row 30)` | `emailRound2.test.tsx` "ADR 0848 D5" |
| code grade | `fix(email): grade-code pass — reader-side tenant check on indexed lists, stale RFC 8058 comments corrected, empty env falls through, brackets only in markdown, 429 marker, 409 deleted_during_send, tighter witnesses (ADR 0848)` | integrity file 23/23 |

**Sabotage:** 14 backend guards (S1–S14) and the frontend read-only guard, each removed in
turn: every one turned its named test RED, and every `-t` pattern was confirmed to match and
pass on the unsabotaged tree (so no red came from "no tests found").

