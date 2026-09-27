# ADR 0252 — Gmail inbox → CRM activity sync (per-user opt-in, refs-only, scheduler-driven)

Status: implemented (P1+P2+P3)
Date: 2026-07-04
Depends on: ADR 0211 (email→activity bridge — the reused shape), ADR 0107 (knowledge-sync — the per-connection external-pull precedent), ADR 0024/0037 (Connections + connector broker), RFC 0095 (connection packs — the Accepted `google` provider), ADR 0046 (generic scheduler `ownerSubject`), ADR 0208 (`ctx.features.crm` verbs + `crmMutated`).

## Context

ADR 0211 shipped the outbound half (a sent campaign email lands as a `kind:'email'`
activity) and explicitly DEFERRED the inbound Gmail half pending a per-user consent
decision and an email-body PII decision. A consumer pulled; this ADR makes those
decisions and builds it.

## Decisions

### 1. PII posture — refs + minimal metadata, never content (operator decision)

Per matched message, the activity stores ONLY: `contactId`, Gmail `messageId`,
`threadId`, `direction` (`in`/`out`), and the message timestamp. **No subject, no body,
no snippet, and not even the participant email** — the matched contact already holds the
email (`declarePiiFields('crm.contact', ['name','email'])`). The timeline body reads
"Email exchanged · [open in Gmail]". This is the same sensitivity class as the existing
`call`/`meeting` activity kinds (they log *that* an interaction happened, no content, and
are not PII-declared) — so `crm.activity` gains **no** `declarePiiFields`; metadata-only
is genuinely `internal`. The `messageId` only deep-links back to Gmail, visible to the
connected user. Mirrors ADR 0211 §1's "template name only, never rendered content".

### 2. Scope — matched contacts only, never create

A message is recorded ONLY when a participant email matches an EXISTING CRM contact
(`listContacts(tenantId)` + in-memory find — no index exists; bounded by the tenant cap).
Unmatched / personal mail is never touched or stored. The sync never creates contacts.

### 3. Opt-in — explicit, per-user, off by default

A user with a connected `google` connection (the built-in provider carrying
`gmail.readonly` — the `gmail` provider is draft/send-only and unusable for reads)
explicitly opts in, binding `{orgId, connectionId, cadence}`. Off until they do.

### 4. Scheduler-driven, NOT a bespoke daemon (the architectural correction)

`ARCHITECTURE.md`: "Schedules must use the scheduler service and daemon… not poll its own
private cron loop for work the scheduler already models." The snapshot/knowledge-sync
sweep daemons are justified because their work is per-(tenant,org) — no per-subject job
fits. **Gmail sync is per-USER**, which is *exactly* the scheduler's per-subject model,
so a bespoke daemon is NOT justified. Instead:
- Opting in registers a **per-user scheduler job** (`ownerSubject = {kind:'user', id:userId}`,
  `cronExpr` from cadence, `metadata.actingUserId = userId` + `gmailSyncId`,
  `workflowId` = the gmail-sync workflow) — the `projectScheduleService` pattern.
- The scheduler daemon fires it as a real run acting as the user; the run resolves the
  user's own Gmail token via the connector broker. Replay-safe (a real run with events).
- Pause/resume = disable/enable the job; opt-out = delete the job + the opt-in row.
- "Sync now" = `startWorkflowRun` on the same workflow on demand.

### 5. The work is a NODE, so it is agent/chain-drivable (ADR 0058)

`feature.crm.nodes.gmail-sync` (`role:"action"`): resolves the opt-in row, invokes
`ctx.connectors.invoke('google', {url: gmail messages.list/get, method:'GET'})`
(egress-pinned to `googleapis.com`, acting as the run's user), pages messages since the
row's cursor, matches participants → contacts, appends metadata-only activities via the
same idempotent path as ADR 0211 (deterministic id `act:gmail:<orgId>:<messageId>:<contactId>`
— **includes orgId** so the same message+contact can land in two orgs' timelines without a
cross-org id collision; `kind:'email'`, metadata-only body, `skipCapCheck:true`,
point-read-first, best-effort, `crmMutated` on a new row), then advances the cursor via a
new `ctx.features.crm.advanceGmailSyncCursor` verb. The scheduled workflow is a minimal
chain over this one node.

### 6. Security / IDOR

Opt-in routes require `workspace:write` on `orgId` AND verify the bound connection is the
**caller's own** (`connection.userId === caller.userId`) — a user cannot bind another
user's Gmail into a sync. The runner acts as `conn.userId` = the caller; the broker
enforces the provider allowlist + `apiHosts` egress pin.

**Owner-only mutation.** A sync binds ONE user's personal mailbox, so the by-id mutating
routes (PATCH / DELETE / sync-now) enforce `sync.userId === caller.userId` on top of the
org gate — org-write alone must NOT let a co-worker pause, delete, or trigger someone
else's mailbox sync. `GET` already lists the caller's own syncs only; the mutation guard
makes the whole surface consistently owner-scoped. (A foreign-tenant row is still a
uniform 404 before the org gate; an in-org non-owner is a 403.)

## Boundaries

- New `crm:gmailsync` opt-in store is the knowledge-sync SyncSource *shape*, not a
  duplicate entity. The `consent` feature is deliberately NOT reused (it models a
  data-subject opting OUT of receiving marketing — semantically wrong for an actor
  opting their own mailbox INTO processing).
- Schedules → the scheduler service. Node behavior → a pack. Run side effects → real runs.
  No private daemon, no parallel surface.

## Compatibility

Host-ext routes + connector reads over the already-Accepted RFC 0095 `google` provider →
**no `../openwop` RFC.** No wire-shape change. Replay-safe (the sync is a real scheduled
run; the cursor is durable state, read at run start).

## Phases

- P1 (implemented): opt-in store + service (CRUD creates/deletes the scheduler job) +
  routes + the cursor-advance surface verb. `features/crm/gmailSyncService.ts` (the
  `crm:gmailsync` opt-in store + scheduler wiring) + `features/crm/gmailSyncRoutes.ts`
  (`/v1/host/openwop-app/crm/gmail-sync/**`) + `surface.ts` verbs
  (`getGmailSyncForRun`/`advanceGmailSyncCursor`/`findContactByEmail`/`logGmailActivity`)
  + `contactsService.findContactByEmail`. Test: `test/crm-gmail-sync.test.ts`.
- P2 (implemented): `feature.crm.nodes.gmail-sync` node (pack v1.4.0) + the
  `crm-ops.gmail-sync` chain (`examples/workflow-chain-packs/crm-ops` v1.1.0) + `sync-now`.
  `gmailSyncId` reaches the node FROZEN into the node config at chain expansion
  (RFC 0013 Path A, `f27833d7`): `ensureGmailSyncWorkflow` calls
  `expandChain(chain, { params: { gmailSyncId } })`, `expandChain` substitutes the
  `{{params.gmailSyncId}}` config token with the literal value and persists no run-time
  token. Path A's workflowId hash already folds the params in, so each sync expands to a
  distinct id; `ensureGmailSyncWorkflow` still overrides it to a STABLE syncId-derived id
  (`crm-ops.gmail-sync:<syncId>`) so the scheduler/sync-now can address the per-sync
  workflow by recomputing the id from the syncId (not re-hashing params) — see that
  file's header. **Correction note:** this ADR was authored against the pre-Path-A model
  (`{{inputs.*}}` token + a run-overridable `variables[]` default); the RFC 0013 amendment
  (2026-07-04) made expansion-time freezing a MUST, so the node now reads a literal
  `ctx.config.gmailSyncId` and the override's rationale is addressability, not
  collision-avoidance. Tests: `test/crm-packs.test.ts` (node + chain-load).
- P3 (implemented): the frontend opt-in panel — a **new CrmPage tab** (`GmailSyncTab.tsx`,
  registered in `CrmPage.tsx`'s `TABS`), not a settings page. Placement rationale:
  `gmail-sync` takes `orgId` on every call and RBAC-gates on org scope
  (`requireOrgScope`) exactly like Companies/Deals/Tasks — the existing per-org tab
  shape (CrmPage's org picker already drives `needsOrg` tabs) fits with zero new
  chrome, unlike `EventBindingsPage`'s precedent (a tenant-wide, no-org registry —
  a different shape). Client: `gmailSyncClient.ts` (thin fetch wrapper, same
  `authedHeaders`/`asJson` pattern as `crmOrgClient.ts`); the connection picker reuses
  `features/connections/connectionsClient.ts`'s `listConnections`, filtered to
  `provider === 'google'`. UI: a leading privacy `<Notice>` (the §1 refs-only
  statement, verbatim), a create form (connection + cadence selects) that swaps for a
  designed `StateCard` ("Connect Google first" → `/connections`) when the caller has
  no `google` connection, a `DataTable` of existing syncs (connection label, cadence,
  a toggleable status chip, relative last-synced time, sync-now, delete w/ confirm),
  and a terminal error `Notice` on a load failure (never a stranded skeleton). i18n:
  `features/crm/i18n/{en,es,fr,pt-BR}.ts` (the `crm` namespace — identical key sets,
  `check-i18n` clean). Test: `features/crm/__tests__/GmailSyncTab.test.tsx` (loading /
  no-connection empty / no-syncs empty / list / create / toggle / sync-now / delete /
  load-failure). Rides the existing `features/crm/routes.tsx` lazy chunk (`CrmPage` is
  already `lazy()`-loaded) — no new route, no bundle-budget change.

## Open questions

- [ ] Gmail incremental sync via History API (`historyId`) vs a `messages?q=after:` time
  cursor — start with a time cursor (simpler, no history-scope), revisit if volume needs
  the History API. The node pages `messages.list` (nextPageToken) up to a per-run cap
  (`GMAIL_MAX_PAGES`, ≤500 msgs) and only advances the cursor past fully-processed
  messages; if the cap is hit it reports `truncated:true` and the next fire continues.
  A mailbox with a sustained backlog beyond the per-run cap is the case the History API
  would serve — deferred until a consumer hits it.
- [ ] Per-org "which contacts' mail syncs" scoping (today: all tenant contacts matched) —
  defer until a consumer needs finer control.
