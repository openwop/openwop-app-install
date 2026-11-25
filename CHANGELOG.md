# Changelog

All notable changes to **openwop-app** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project follows
[Semantic Versioning](https://semver.org/) per **ADR 0052**. Pre-1.0 caveat: while
on `0.x`, a `0.MINOR` bump MAY carry breaking changes (SemVer §4).

What bumps which part (ADR 0052 §D1): **MAJOR** = a breaking change to a
customer-facing contract (route/config/env removal or rename, dropped capability,
a migration unsafe for the prior binary); **MINOR** = additive & backward-compatible
(new feature/route/capability, **any** forward-only schema or app migration);
**PATCH** = a fix with no contract or migration change.

The operator upgrade contract lives in **`DEPLOY.md` § "Upgrading"**. Each released
section below — and its **"Upgrading from"** block — is generated from Conventional
Commits by the `/cut-app-release` skill; required upgrade stops are tracked in
**`RELEASES.md`** / `releases.json` (ADR 0052 §D2/§D7).

## [Unreleased]

## [0.22.0] — 2026-11-25

A MINOR release under ADR 0052, for new features (ADR 1099 P3a, ADR 1161, ADR 1160 P3's primitives). There is **no migration** (sqlite 54 / postgres 52, app-migration 27), and **no route, env var or config key is removed or renamed**. The urgent part is #6269: every OpenAI image generation or edit without an explicit model has failed since OpenAI shut down `gpt-image-1` on 2026-10-23. Read "Upgrading from 0.21.0" for two behaviour changes:

- OpenAI images default to `gpt-image-2.6-sunburst`, and a vendor refusal now answers its real error instead of `provider_unavailable` (#6269);
- the remaining canvas lanes decide in the canvas's org (ADR 1160 P2), so a few cross-org paths stop working for P0-stamped canvases.

### Security

- **The stray canvas lanes decide in the canvas's own org (ADR 1160 P2, #6265).** The collab ticket, claim-seed and upgrade now use `canvasReadAllowed`, as the REST editor does (before: the owner half only). A present-remote token's org must be the canvas's. A share link's org must be the canvas's, at mint and in the publisher re-check that keeps a public link serving. Comments on `canvas_document` / `canvas_slides` require the path org to be the canvas's, then `canvasReadAllowed`. A document's `promotedCanvasId` must be a canvas the caller may read in the document's org. An app-builder sync binding from another org no longer writes the canvas. The ui-plugin `demo-artifact` checks `artifacts:read`. `test/adr1160-canvas-raw-read-ratchet.test.ts` pins every raw canvas read per file. `ctx.canvas.invoke` is not an access lane (its id is only a causation tag), so it is unchanged.

### Added

- **A collaborator's proposals write nothing before a member approves them (ADR 1099 P3a, #6273).** A client tool may declare `effect: 'propose'`. In a collaborator turn its `run` returns proposals, and each becomes one approval of the new host kind `collab-proposal` (audience: `workspace:write` in the project's org). Approval ids are derived from grant, tool and idempotency key, so rerunning an interview adds nothing. Limits: 10 proposals per call, 20 propose calls per grant per day (`OPENWOP_COLLAB_PROPOSE_CALLS_PER_GRANT_DAY`), payload ≤ 16 KB with scope keys dropped. Deciding goes through the shared claim and reject routes: the decider needs `workspace:write` and passes the tool's optional `mayDecide` (403 `collab_not_decider`). Approve re-checks the grant (409 `collab_grant_ended` when it has ended) and then calls the tool's `apply`; an `apply` that throws reopens the row. Reject writes nothing and redacts the summary and payload. A collaborator's erasure redacts their proposals and cancels the pending ones.
- **`onOrgDeleted` hooks (ADR 1161, #6272).** A feature can register a hook that removes its own per-org rows that carry no `orgId` (which `deleteOrg`'s refuse-while-populated guard cannot see). Hooks run after the org is deleted, each in its own try. A failure is logged, audited with ids only (`org.deleted.hook-failed`), and never blocks the delete or the other hooks. Failures are retried by the default-window sweep, which gives up after 10 attempts (`org.deleted.hook-gave-up`), and skips legal holds and an org id that exists again. No feature registers a hook in this release; this is the seam CasaVoga's per-org rows will use.
- **`claimCanvasOrg` and the canvas backfill plan (ADR 1160 P3, code only, #6266).** `claimCanvasOrg` places an unplaced, tenant-shared canvas in an org by CAS: it never re-homes a placed canvas, refuses another tenant's org and a project-owned canvas outside its project's org, leaves content, version and `updatedAt` alone, and is audited. `planCanvasOrgBackfill` is a dry run (counts and ids only) that places only what is certain: a one-org tenant's canvases and project-owned canvases. `applyCanvasOrgPlan` performs a plan. **Nothing runs the backfill in this release.**

### Fixed

- **OpenAI image generation and edits work again (#6269).** `gpt-image-1` was shut down on 2026-10-23, and the default still named it, so every call without an explicit model failed with "The model 'gpt-image-1' does not exist". The default is now `gpt-image-2.6-sunburst`; the request contract is unchanged. A vendor refusal is no longer reported as an outage: a 400, 404 or 422 that names a missing model is `model_not_supported`, another 400, 404 or 422 is `invalid_request`, and a 429 is `provider_rate_limited`. A 401, a 5xx or a network fault is still `provider_unavailable`. All three are existing codes, and the image routes map them onto existing route codes: `invalid_request` to 400 `invalid_request`, `provider_rate_limited` to 429 `rate_limited`, and `model_not_supported` to the same 502 `host_capability_missing` as before, each with the provider code in `details.providerCode`. Edits now send the documented `image[]` field.

#### Upgrading from 0.21.0

- **Required stop:** no. **Rolling-safe:** yes. `node scripts/upgrade-plan.mjs 0.21.0` gives one step, no stop:
  1. back up the database (and object store);
  2. 0.21.0 instances may keep running alongside 0.22.0;
  3. start 0.22.0 (sqlite 54 → 54, postgres 52 → 52, app 27 → 27);
  4. check that `/readiness` reports version 0.22.0.
- **Migrations:** none.
- **OpenAI images (#6269).** No action. A host that pins its own image model is unaffected. Every image vendor refusal used to come back as 502 `host_capability_missing` with `details.providerCode: "provider_unavailable"`. Now a bad request is 400 `invalid_request`, a rate limit is 429 `rate_limited`, and a missing model is still 502 with `providerCode: "model_not_supported"`, so a client that retried every image failure as an outage now sees the refusal. The first live edit call is the check that OpenAI accepts the `image[]` field.
- **Canvas org enforcement, the remaining lanes (ADR 1160 P2).** Only canvases stamped since P0 (#6260) are affected. For those, a share link, present-remote token, app-builder sync binding or comment thread made through another org's path stops working, and a member who could read someone else's user-owned document or deck through comments or collab (but not through the editor) loses that inconsistent access. Public links minted through the canvas's own org keep serving. P2 writes no data, so a revert is the rollback.
- **Canvas backfill (ADR 1160 P3).** Code only. Unplaced canvases stay tenant-shared until an operator runs a plan, which is a separate, approved data write.
- **Org deletion (ADR 1161).** No change yet: the hook seam ships with no hooks registered. When a feature registers one, a failed hook never blocks the delete and is retried by the sweep.
- **Collaborator proposals (ADR 1099 P3a).** Nothing changes while `projects.client-portal` is off, which is the default; leave it off in production until P4.
- **Config:** nothing to change. `OPENWOP_COLLAB_PROPOSE_CALLS_PER_GRANT_DAY` (default 20) is optional.
- **Steps:** back up the database, deploy the new backend image and then the frontend, and check that `/readiness` reports `"version": "0.22.0"`.

## [0.21.0] — 2026-11-25

A MINOR release under ADR 0052, because it adds **app-migration 27**. **No route, env var or config key is removed or renamed.** Read "Upgrading from 0.20.0" for five behaviour changes:

- roster agents with no autonomy level are stamped `auto` so they keep running, while new agents default to `review` (ADR 1159);
- e-sign invites and completion emails are now really sent (#6248);
- an unpaged kanban read above 2,000 cards is refused (ADR 1155 P5b);
- a canvas created since ADR 1160 P0 opens only in its own org (ADR 1160 P1);
- the workspace switcher left the entry bundle (#6250).

There is no schema migration (sqlite 54 / postgres 52).

### Security

- **A canvas is read and written only in its own org (ADR 1160 P0 #6260, P1 #6262).** Every canvas create now stamps the org (workspace) it was made in, with creates and retries keyed per org. `canvasReadAllowed` / `canvasWriteAllowed` check `workspace:read` / `workspace:write` in the canvas's **own** org, ahead of the owner rule, and every lane that used them inherits the check: the editor, agent tools, run lanes, sharing mint, present-remote, the ui-plugin RPC and the MCP nodes. A path naming another org answers 404, even to a member of both. Agent canvas links carry `?org=`. Canvases created before P0 are unstamped, tenant-shared and unchanged. Runs with no person (a schedule, a webhook, app-builder inbound sync) declare `orgSystemLane` and keep their reach.
- **A switched-off collaboration surface admits no signed-in invite (ADR 1099 D1, #6258).** `createCollaborator` now checks the surface's switch as well as its org rule, which is what the accept lane already checked. The HTTP route was already safe; this closes the gap for direct service callers. Link-only collaborators keep their owner-feature gate.

### Added

- **A workflow's work-item proposal can carry card facets (ADR 1155 P2b).** `core.openwop.kanban-work-items` 1.3.0 accepts `facets` on each proposal item (at most 8 lower-case keys, values of 1–64 characters with no control characters), written at create and rewritten by `refresh`. `vendor.openwop.app-builder.workflows` 1.4.4 re-pins the node. Both are image-vendored packs; no production pin names them.
- **Transactional email carries a sender name, a Reply-To and the feature's own opt-out link (#6135).** `sendTransactional` / `sendTransactionalEmail` accept optional `fromName`, `replyTo` and `listUnsubscribe: { url }`, and the brokered transport passes them to the email adapter, which writes the name in each provider's shape (SendGrid `from.name`, Postmark `"Name" <addr>`, SMTP an address object). A `fromName` or `replyTo` with a control character (CR/LF), a display name or a list is refused: `invalid_header` at the seam, `email_header_invalid` at the adapter, with no provider request. `listUnsubscribe` is now also accepted for any `https:` path on the deployment's own `OPENWOP_PUBLIC_BASE_URL` origin; any other origin is still dropped. Existing callers are unchanged.
- **A client can talk to the project's agent (ADR 1099 P2, #6261).** `POST /host/openwop-app/collab/grants/:grantId/turn` runs one turn as an outside collaborator on a `project` grant. It answers only while the grant is usable (`checkGrantUse`, re-checked before every tool call) and the `projects.client-portal` switch is on (default off). It uses the firm's model credential, and a refused credential answers 503. Turns are capped per day at 50 per grant and 500 per tenant (`OPENWOP_COLLAB_TURNS_PER_GRANT_DAY` / `OPENWOP_COLLAB_TURNS_PER_TENANT_DAY`, 429 above). The run is owned by `collab:<collaboratorId>`, the message is fenced, and only tools from the new client registry (`registerClientProjectTool`, read-only `openwop:client.<kind>.*`) resolve; scope keys are dropped from model input at every depth. Each tool decision is audited (`collab-turn.tool`). The agent is the Project Guide (`vendor.openwop-app.projects.agents`) with one tool, `openwop:client.project.overview`. A grant can carry an `audience` label (registered by features), set on the Client access tab, and the projection and every client tool receive it; a grant without one gets the most limited view. A member cannot fork a collaborator's run: `409 collab_run_not_forkable`. The default-deny turn (`host/scopedToolTurn.ts`) and the outsider credential rule (`host/outsiderTurnCredential.ts`) are now shared with the anonymous chat-widget lane, which is unchanged. There is no thread yet: one turn, no history (P3).

### Changed

- **Agents propose, humans dispose, by default (ADR 1159).** A roster agent with no autonomy level used to run heartbeat picks with no human gate, because `autonomyOf()` read absent as `auto`. Absent now reads as `review`, new agents (API, hire screen, create wizard, agent author, portability import) store an explicit level defaulting to `review`, and existing agents keep their current behaviour through app-migration 27.
- **An unpaged kanban read above 2,000 cards is refused (ADR 1155 OQ-2, P5b). This is a contract change for API callers.** `GET /host/openwop-app/kanban/boards/:boardId` with no `limit` counts the board first, and `GET …/kanban/assigned` with no `limit` counts the caller's matching cards. Above 2,000 either answers `400 validation_error` with `details: { reason: "kanban_board_page_required", total, cap: 2000 }` and no cards. It never answers a truncated `200`, which an old client would render as the whole board. At or below 2,000 the response is unchanged, and a paged read (`?limit=`) is never capped. The SPA's agent board, agent view, "Assigned to me" list and dashboard tiles now read a page at a time, and `@openwop/cli` 2.2.0 `kanban board` and `kanban assigned` follow `nextCursor`. The personal board route (`/boards/personal`) is not capped.
- **The workspace switcher and client left the entry bundle (#6250).** `Sidebar` lazy-loads `WorkspaceSwitcher` behind its own static `/orgs` link, and `runsClient` / `exampleDataClient` load `workspaceClient` on first use. The host entry goes from 129.4 kB to 126.7 kB gzip, against its 130.0 kB budget.
- **Example data starts with nothing selected (#6231).** The page adds Select all and Select none. Load selected and Clear stay disabled until something is chosen, with a visible hint. The Clear dialog names the chosen types and the workspace.
- **The Project Guide (the agent an outside collaborator talks to) is no longer listed to a firm's members or on the A2A card; it still serves the collaborator turn (ADR 1099 P2, #6268).** The member agent list leaves out any agent whose every tool is a client tool (`openwop:client.*`), because in a member's chat it would have none. `vendor.openwop-app.projects.agents` 1.0.1 sets `a2aExposed: false`. The agent stays installed and resolvable by id.
- **Conformance suite pinned to 2.49.9 (#6253).** Schemas re-vendored at `v2.49.9`. No fixtures, capabilities or declarations change.

### Fixed

- **E-sign invites and completion emails are sent (#6135).** They went to the console stub, so no invite was ever emailed and `invitesEmailed` was always `false`. They now ride the transactional seam: the org's sender address and the requester's email Connection, with a per-signer ledger key so a retry never re-sends. `invitesEmailed` is `true` only when every signer's invite was accepted, and the signer's done screen promises the certificate email only when the org can send one.
- **Direct-host feeds carry the active workspace (ADR 1158 extension, #6232).** Kanban board events, notifications, channel presence and messages, and voice transcripts go straight to the backend host. They now send the `x-openwop-workspace-selection` header, so a signed-in caller in a shared workspace streams that workspace, not their personal one.
- **A site-tier, sign-in-required route can be the app home (#6245).** `resolveAppHome` accepts a `site` route whose `auth` is `required` (or omitted), so a white-label's `VITE_BRAND_APP_HOME_PATH` can point at a signed-in desk like DeckTalk's `/app/*`.

### Tests and tooling

- **The replay-safety fixture scrubs shell provider keys instead of refusing (ADR 1002, #6249).** A developer shell with `GOOGLE_API_KEY` or a similar key exported no longer turns the four `ai-replay-safety` files red, and the keys still never reach the run.
- **`reelNeedsKey` waits for the reel button under load (ADR 1039 D2, #6263).**
- **Docs:** v2 phase-1 sweep of the current docs, skills, scripts and UI copy (#6254); ADR 1160 (#6259); the release manager files user questions in the decision queue (#6257); Campaign Studio acceptance open items tracked (#6243).

#### Upgrading from 0.20.0

- **Required stop:** no. **Rolling-safe:** yes. `node scripts/upgrade-plan.mjs 0.20.0` gives one step, no stop:
  1. back up the database (and object store);
  2. 0.20.0 instances may keep running during 0.21.0's migrations;
  3. start 0.21.0 (sqlite 54 → 54, postgres 52 → 52, app 26 → 27);
  4. check that `/readiness` reports version 0.21.0.
- **Migrations:** app-migration 27 (`stamp-legacy-roster-autonomy`) runs once at first boot. It writes an explicit `autonomyLevel: "auto"` onto every roster agent that has no level stored, so those agents keep running heartbeat work automatically exactly as before. It touches only rows with no level, so expect one write per legacy agent and zero on a fresh install. Rolling back is safe without a reverse migration: older code reads an explicit `auto` as auto and an explicit `review` as review. This migration makes the next release a minor.
- **New agents now default to `review` (ADR 1159).** An agent created without an autonomy level proposes each heartbeat pick for approval instead of running it. The hire and create screens default to review, and every write stores the level explicitly. API callers that want an autonomous agent must send `autonomyLevel: "auto"`.
- **E-sign invites and completion emails really go out now (#6248).** Before this release none were sent. After it, any org with a sender address, whose requester has an email Connection, emails every signer their signing link and, once all have signed, the certificate link. An org without either keeps today's behaviour: the request is created, `invitesEmailed` is `false`, and the requester shares the link by hand. Check your sender addresses before deploying if a signer should not receive mail.
- **Canvas org enforcement (ADR 1160 P1).** Only canvases created since P0 (#6260) carry an org, and these open only through their own org: another org's path answers 404. A member of a different org loses access, which is intended. An MCP principal now needs membership in the org of a UI-created canvas. Public share links are unaffected. Minting a share link or a present-remote token needs write access in the canvas's org. P1 writes no data, so a revert is the rollback.
- **Deploy the new SPA together with this backend if any board, or any member's assigned list, holds more than 2,000 cards.** An older SPA reads the agent board and "Assigned to me" unpaged, and against this backend those reads fail above 2,000. The SPA's main board view pages above 500 cards, so it is unaffected either way.
- **API and CLI callers:** a script that reads a board or `/assigned` without `limit` gets the 400 above 2,000 cards. Page with `limit` and `cursor`, or upgrade to `@openwop/cli` 2.2.0 or later.
- **Client portal turns (ADR 1099 P2).** Nothing changes while `projects.client-portal` is off, which is the default; leave it off in production until P4 ships the portal UI. Two optional knobs cap turns per day: `OPENWOP_COLLAB_TURNS_PER_GRANT_DAY` (default 50) and `OPENWOP_COLLAB_TURNS_PER_TENANT_DAY` (default 500).
- **Entry bundle (#6250).** The host entry is about 2.8 kB gzip smaller. An adopter whose entry budget was tight (casavoga's was 445 B over after 0.20.0) gets that room back with no change of its own.
- **Config:** nothing to change. The two client-portal caps above are optional.
- **Steps:** back up the database, deploy the new backend image and then the frontend, and check that `/readiness` reports `"version": "0.21.0"`.

## [0.20.0] — 2026-11-24

A MINOR release under ADR 0052. **Nothing is breaking for API callers:** no route,
env var or config key is removed or renamed. It leads with a **security fix**: the
member Sharing API could mint capability links that only the host should mint,
including an e-sign signer link. Kanban boards group by a facet and page "Assigned
to me" (ADR 1155 P5). A held tool call is approved on a card in the chat (ADR 1156
P1). Two behaviour changes are worth reading (see "Upgrading from 0.19.0"): a replay
fork now refuses an AI call it has no record for, and the app reloads after a
confirmed workspace switch or create. No schema migration (sqlite 54 / postgres 52)
and no app migration (26). It is rolling-safe, not a required stop.

### Security

- **The member Sharing API can no longer mint host-only capability links (#6225).**
  `POST /host/openwop-app/sharing/orgs/:orgId/links` refused only `campaign_approval`
  and `client_report`. It now also refuses `sign_request`, `booking_manage`,
  `collab_invite` and `commerce_order` with the uniform 404. These are minted only by
  the host's own flows (requesting a signature, a booking, an admin's collaborator
  invite, a paid order), which are unchanged. `commerce_quote` stays shareable by
  members. The app's Sharing page never offered these types; the API did. Upgrade
  promptly if you expose the Sharing API.
- **A census keeps every share type classified (#6226).**
  `test/sharing-system-mint-only.test.ts` requires every share type to be either
  host-only or member-publishable content, and every visitor-lane mint to use a
  classified type, in host and `src/adopter/` code alike. A new share type fails it
  until it is classified. **Adopters: carry this test at sync.** It is the only
  reader of the `__assertMintAccessForTests` seam, so a fork without it reds
  `test-seam-export-ratchet`. A visitor-lane `document` mint in adopter code passes.

### Added

- **Approve a held tool call on a card in the chat (ADR 1156 P1, #6210).** A card
  appears under the turn that raised the held call, in the full chat, the tab deck
  and a persisted embedded chat. One press approves exactly that call and sends the
  Continue message. The card says whether the call ran, was refused (in the tool's
  own words) or was superseded because the model asked for different arguments. It
  is the existing conversation-tools approval, not a second path. Two host-extension
  run-log events place and settle it, carrying no arguments.
- **Kanban boards group by a facet, and a board page filters by facets and counts groups (ADR 1155 D3/D7, P5 backend, #6215).** `PATCH …/kanban/boards/:boardId` accepts `groupBy`, a facet key (`null` clears it), beside `name`. The paged `GET …/boards/:boardId?limit=` accepts `facet.<key>=<value>` (repeatable across keys, all must match; an empty value matches cards without the key) and `groupBy` (`column`, `assignee` or a facet key), which adds `groupCounts`. Cards' facets ride the card index's board markers, so changing a board's `groupBy` needs no rebuild. The index declaration is now versioned (ADR 1110, `version`): an index built before this change is rebuilt on its tenant's first read, or queued above 500 cards, never trusted.
- **`GET /host/openwop-app/me/workspaces` returns a short-lived `selectionToken` for a shared active workspace (ADR 1158, #6219).** See Fixed.

### Changed

- **A replay fork refuses an AI call it has no record for (ADR 1002, #6206).** When a
  `mode: 'replay'` fork reaches a model call whose request is missing from, or
  different to, what the source run recorded (including a source deleted or erased
  since), it now fails with `replay_source_missing` instead of calling the model
  live. This covers managed and bring-your-own-key calls, plain and with tools.
  Matching records are still served. A `mode: 'branch'` fork and ordinary live
  retries call the model as before. Each refusal logs a warning, sets the
  `openwop.replay_effect_blocked` span attribute and counts
  `openwop.effect.blocked{effect_kind="network-egress"}`. One case to know: forking a
  run after a twin-recall grant was revoked now fails rather than completing without
  the owner's data (ADR 0044 correction).
- **The app reloads after a confirmed workspace switch or create (ADR 1148, #6207).**
  The workspace switcher and workspace creation reload once the server confirms the
  change, unless a newer switch is pending; trial start reloads when the switch's
  outcome is uncertain. Auth listeners now all run
  before an error is reported, and the transition is owned by one state machine. The
  frontend entry-bundle budget rises from 129 to 130 kB gzip (129.3 kB today).
- **`pubsub_listener_recycled` logs a fixed `reasonCode` (ADR 0900 D2, #6230):**
  `pubsub_listener_ping_timeout`, `pubsub_listener_error` or `pubsub_listener_end`, so
  recycles can be counted by cause. `reason` is still logged, hashed as before.
- **Chain export keeps node layout (D1a, #6206).** The chain loader carries a node's
  `position` into the definition (it is not part of the definition hash), never its
  `name`, so no workflow's revision hash moves.
- **The unpaged kanban board read uses the card index, and `GET /host/openwop-app/kanban/assigned` pages (ADR 1155, #6220).** Once a tenant's card index is built and its legacy tenant index is verified, `GET …/boards/:boardId` (no `limit`) and every display read of a board read only that board's index slice and cards, not every card in the tenant. The response is unchanged. Otherwise the read is as before, so a legacy card with no tenant still shows. `GET …/kanban/assigned?limit=` (1–100; empty means 50) returns `{ cards, total, nextCursor? }`. A bad `cursor` or `limit` is a 400 with `details.reason`, and without `limit` the response is unchanged. The assigned list is now ordered by `updatedAt`, then card id, so ties have a fixed order.

### Fixed

- **The kanban due-date sweep visits every workspace that owns a board (ADR 1138 D4,
  #6212).** It took its workspaces from the agent roster, so a workspace with boards
  and assigned cards but no roster agents never got `task.due` notices. It now adds
  every workspace that owns a board, refreshed once an hour. Such a workspace's first
  sweep may send its overdue notices at once.
- **Example data writes land in the shared workspace you have open (ADR 1158,
  #6219).** With a shared workspace active, every streamed Clear, Load and demo
  provision was refused `409 example_data_workspace_mismatch`, because those writes go
  straight to the backend host, whose cookie still named the personal workspace. The
  page now sends a 10-minute workspace selection token in
  `x-openwop-workspace-selection`, signed with `OPENWOP_SESSION_SECRET`. It only
  chooses the workspace: it never signs anyone in, the membership check still decides,
  and the cookie is not rewritten. The page's error notice now sits beside its buttons
  and is announced.
- **A run that fails on a node's stated refusal now names the cause (#6229).** A node
  that threw a host error such as `conflict` (for example "Missing input: …") used to
  fail as `internal_error`, and the run-failed notice, the dead-letter `reason` and
  `run.failed.userMessage` said only "Something went wrong. Check the server logs."
  The node's own code is now kept, and for `conflict`, `not_found` and
  `validation_error` its message is what the user reads.
- **Escape closes the command palette as soon as it opens (#6227).** An Escape pressed
  before the first paint was lost and the palette stayed open.
- **The Email feature's not-found check, a stale route-collision entry and two
  identical stale-data notices (#6218).** `isEmailNotFound` now decides by the 404
  alone; the `/leaderboard` collision allowlist entry is gone (KickTodo left the repo);
  the operations page's two stale-data notices (service levels and run admission) now
  each name their panel, so a screen reader no longer hears one sentence for both.

### Tests and tooling

- **Test-only:** the w117–w121 grade-tests case asks (#6223), a midnight-safe
  usage-by-feature route test (#6222), the ADR 0145 `/leaderboard` reachability case
  scoped to in-tree routes (#6221), and ambient types for the notebooks pack, a
  checked `shaped()` accessor, an A2UI catalog derived from its schema and a test
  census that counts `it.for` (#6234).
- **`tracegate-ci` pinned to 0.10.6 (ADR 1028 P1, #6211).** It treats tests that start
  a process as opaque. The gate's shadow package decides nothing; its first run after
  upgrade selects the whole frontend lane once.

#### Upgrading from 0.19.0

- **Required stop:** no. **Rolling-safe:** yes. `node scripts/upgrade-plan.mjs
  0.19.0` → one step, no stop: back up the database (and object store); the schema
  permits 0.19.0 instances during 0.20.0 migrations; start 0.20.0 (sqlite 54 → 54,
  postgres 52 → 52, app 26 → 26); check `/readiness` reports version 0.20.0.
- **Migrations:** none. Schema stays sqlite 54 / postgres 52; app migrations stay 26.
- **Config:** nothing to change. If a proxy or CDN sits in front of the backend's
  direct host, it must pass the `x-openwop-workspace-selection` request header (the
  backend's own CORS allow-list already admits it).
- **Behaviour:** a `mode: 'replay'` fork that reaches an AI call with no matching
  record now fails with `replay_source_missing` instead of calling the model; use
  `mode: 'branch'` to re-run live. The app reloads after a confirmed workspace switch
  or create. Workspaces whose boards have no roster agents start getting due-date
  notices.
- **Adopters:** carry `test/sharing-system-mint-only.test.ts` at sync (it is the only
  reader of `__assertMintAccessForTests`). If your fork changed the entry-bundle
  budget, note that it is now 130 kB gzip.
- **Steps:** back up the database, deploy the new backend image and then the
  frontend, and check that `/readiness` reports `"version": "0.20.0"`.

## [0.19.0] — 2026-11-23

A MINOR release under ADR 0052. **Nothing is breaking for API callers or operators:**
no route, env var or config key is removed or renamed. Kanban boards get ready for
thousands of cards (ADR 1155 P1–P4): due dates can be cleared, cards carry `facets`,
the board read can be paged and filtered from a new card index, "Assigned to me"
reads that index, and host code gets batch create/patch commands. The 2,000-card
cap and its contract change (ADR 1155 P5b) are **not** in this release. Firms can
give a client access to one project (ADR 1099 P1, off by default). One behaviour
change is worth reading (see "Upgrading from 0.18.0"): approving a Campaign Studio
channel draft now creates that draft in the connected tool. No schema migration
(sqlite 54 / postgres 52) and no app migration (26). It is rolling-safe, not a
required stop.

### Security

- **Internal comment threads are shown only to members, failing closed (#6180,
  issue 6109).** `visibility: 'internal'` was stored but never filtered on read. A
  reader that does not say it is a member now gets shared threads only, and an
  internal comment read by id looks like a missing one. Every current door is a
  member door, so today's readers see no change.
- **An origin-denied browser-agent URL keeps origin and path only (ADR 1136 D8,
  #6181).** The log line and the stored session error used to carry the full URL,
  whose query or fragment can hold what was typed.
- **`POST /host/openwop-app/sales-maps/orgs/:orgId/geocode`: a miss (`503 capability_not_provided`) no longer returns `details.address`.** The caller already has the address it sent; the error envelope and logs no longer carry it (ADR 0464 §9, CHAN-F19 follow-up B).

### Added

- **`PATCH /host/openwop-app/kanban/cards/:cardId` accepts `dueAt: null` to clear a card's due date (ADR 1155 D6).** Clearing or changing the date archives the assignee's open due-date notices for that card, and the sweep sends a fresh one for a new date. An assignee with only assignment access still cannot change it.
- **Kanban cards carry `facets`, a small map of grouping keys (ADR 1155 D1).** At most 8 lower-case keys, each value 1–64 characters. Set them on `POST …/kanban/boards/:boardId/cards`, `PATCH …/kanban/cards/:cardId` (`null` clears the map; a key set to `null` clears that key) and on a work-item proposal, where `refresh` keeps them in step with the source. A bad map is a 400. The DSAR eraser clears them on the subject's cards.
- **`GET /host/openwop-app/kanban/boards/:boardId` serves one filtered page when you pass `limit` (ADR 1155 D3, P3c-1).** Query: `limit` (1–100; empty means 50), `cursor`, `column` (repeatable), `sort` (`order` or `dueAt`, undated last), `dueFrom` / `dueTo` (inclusive; a plain date covers the whole day), `overdue=true`, `assignee` (a user id, `me`, `none` or `role:<key>`) and `label` (repeatable, any of). The response adds `total` (every match) and `nextCursor`; `workItems` holds only the page's. A cursor reused with another query is a 400 with `details.reason: kanban_cursor_invalid`. The page reads the card index (P3b) and point-reads only its cards; a tenant whose index is still building gets the same page from today's read. **Without `limit` the response is unchanged.**
- **Kanban gains two batch board commands for host code (ADR 1155 D4/D5, P4).** `applyBoardCommand({ type: 'cards.create-batch', … })` creates up to 200 plain cards. Each card id derives from the item's `sourceId`, so a retried or resumed batch converges with no duplicates. `onExisting: 'refresh'` updates only source-owned facts, and `notifyAssignees` defaults to false. `applyBoardCommand({ type: 'cards.patch-batch', … })` re-dates or regroups up to 500 cards (`dueAt`, `priority`, `labels`, `facets`), each under its own compare-and-swap with an optional `expectedVersion`. Every item is reported on its own (`created` / `existing` / `refreshed` / `collision` / `failed`, and `updated` / `unchanged` / `conflict` / `not_found` / `invalid` / `failed`), and each batch fires one board event. There is no HTTP route; these are service commands for an in-process adopter.
- **Project client access (ADR 1099 P1, #6194).** A `project` grant kind (`view`,
  `comment`) and a **Client access** tab on the project page let a firm invite a
  client, or another firm, to one project. Behind the new `projects.client-portal`
  sub-toggle, default **off**. A project delete revokes its live grants.
- **Computer-use trajectory viewer and Connect-a-browser card (ADR 1136 P3b,
  #6192).** `/computer-use` lists a workspace's browser sessions and shows each step
  in host words, with URLs shown without query or fragment. Hidden behind the
  computer-use toggle.
- **A reallocation plan's proposer may withdraw it (ADR 1022 CP71WF-23, #6186).**
  Through the existing reject lane, in their own interactive session; the plan ends
  `withdrawn`. Approve is unchanged.
- **Shared quorum groundwork for two-party change-set review (ADR 0924 P2a / ADR
  0942 P3b, #6177).** One vote entry for member routes and the client portal, with
  per-party minimums and live re-checks. `client_and_agency` is still refused, so
  single-party behaviour is unchanged apart from the fixes.
- **Offline `onlineOnly` declaration (ADR 0873 D6, #6183).** A feature can keep a
  network-only lazy chunk out of its offline precache. No in-tree feature uses it, so
  no build output changes.

### Changed

- **Approving a Campaign Studio channel draft creates it in the real tool (ADR 0162
  correction, CMS2WF-6, #6200).** The four non-creative channel chains are now
  generate → approve → publish. The ad-variants chain creates the campaign
  **paused** when given an ad account, else a draft ad-copy document. Publish writes
  are keyed so a `:fork` or replay no longer makes a second draft.
  `core.openwop.workflows.marketing` is re-pinned to 1.2.3.
- **`GET /host/openwop-app/kanban/assigned` reads the card index (ADR 1155 P3c-2).** It used to scan every board in the table and read every card in the tenant. It now reads the caller's assigned cards and the tenant's role-addressed cards from the index, then only the boards those cards sit on, and checks board access once per board instead of once per card. The response is unchanged. A tenant whose index is still building is read the old way.
- **Kanban cards now keep a read index on every write (ADR 1155 P3b).** Each card create, move, re-date or delete also writes its ADR 1110 index markers: one per board, due date, assignee and role. That is about 10 extra kv writes per card write, measured in ADR 1155. The paged board read and "Assigned to me" read from it (below). Each tenant's index is built once, on its first indexed read: inline up to 500 cards, otherwise queued for the background sweep while reads take the old path.
- **One sweep now keeps every declared index (ADR 1155 P3a).** Commerce and media each ran their own copy of the ADR 1110 index upkeep: unfinished index writes, queued builds, and an hourly drift check of their own types. The upkeep now runs once, from the always-on entities feature, and its hourly drift check covers every indexed type. It drains two queued builds per tick, matching what the two copies did together. Its poll is `OPENWOP_SYSTEM_INDEX_SWEEP_MS` (default 60 s, minimum 10 s); an existing `OPENWOP_MEDIA_INDEX_SWEEP_MS` is still honoured. `OPENWOP_COMMERCE_INDEX_SWEEP_MS` now sets only commerce's own hourly step, which queues builds for product indexes that were never built.
- **An indexed read no longer rescans a verified collection (#6196).** The first
  read of a verified tenant index used to list the whole collection and rewrite
  every marker (25,001 writes on one board `GET`). It now records the backfill as
  done. Responses are unchanged.
- **Chat-widget counter rows written before ADR 0467 A5 are now erased.** They carried no `updatedAt` (and no `tenantId`), so neither the 2-day age-out nor the retention purger could see them, and they were kept forever. The kv age-out lane has a new opt-in, `stampMissingTimestamp`: a row with no timestamp is stamped with the time the sweep first sees it (compare-and-swap) and ages out from then, never sooner than its real last write. The four chat-widget counter stores use it, so their legacy rows go within 2 days of the upgrade (ADR 0464 §9, CHAN-F19 follow-up).
- **The CRM bounce breaker no longer reads the legacy raw-address dedup key.** That transition read had served its 2-day window after the hashed key shipped (CHAN-F19 #1). An instance that upgrades across both changes in one step may count one same-day redelivered bounce twice, once. Erasure still deletes both key shapes.
- **Five route families send their errors through the error envelope (ADR 1147
  GUARD-3, #6179):** media assets, admin, present-remote, memory and MCP's 401. Same
  status, code and message.
- **Conformance suite pinned to 2.49.8 (#6187).** No scenario, fixture or capability
  change.

### Fixed

- **Erasing a workspace member now reaches their booking links and territory rules** (ADR 0464 §9, CHAN-F19 follow-up B). A booking link they own is disabled, de-attributed and given a neutral slug (its public URL could carry their name); a link they only created for someone else keeps running. A territory assignment rule whose filter names them keeps its place but no longer matches them. Before this, nothing erased either, and the erasure census wrongly counted booking links as covered.
- **The sales-maps geocode cache no longer stores addresses.** Rows are keyed by a hash of the address, hold no raw address, and expire 90 days after their last write (manual rows used to be kept forever). Rows written before this change still hold a raw address, in the row and in its key, and expire on the same schedule. (An instance that already ran the v26 `rekey-geocode-cache` migration, including every v0.17.0 install, does not re-run it, so those rows are not re-keyed; they age out.)
- **Erasing a sales rep now always removes them from orphaned commission deal claims.** If another write touched a claim during the erasure, the rep's id could be left in it while the erasure reported success; the rewrite now retries (ADR 0464 §9, CHAN-F19 follow-up C).
- **Erasing a person now also blanks the decision suggestions the agent drafted from their chat messages.** The suggestion's title and summary paraphrase their words, and they used to survive the erasure even though the message itself was removed. A decision someone already recorded into the team ledger is kept as the team's record (ADR 0464 §9, CHAN-F19 follow-up D).

#### Upgrading from 0.18.0

- **Required stop:** no. **Rolling-safe:** yes. `node scripts/upgrade-plan.mjs
  0.18.0` → one step, no stop: back up the database (and object store); the schema
  permits 0.18.0 instances during 0.19.0 migrations; start 0.19.0 (sqlite 54 → 54,
  postgres 52 → 52, app 26 → 26); check `/readiness` reports version 0.19.0.
- **Migrations:** none. Schema stays sqlite 54 / postgres 52; app migrations stay 26.
- **One-time work:** each tenant's kanban card index is built on its first indexed
  read (a paged board read or "Assigned to me"): inline up to 500 cards, otherwise
  queued for the background sweep, and reads take the old path until it finishes.
  While 0.18.0 instances still run beside 0.19.0, cards they write carry no index
  markers; the hourly drift check rebuilds that tenant.
- **Config:** nothing to change. New optional `OPENWOP_SYSTEM_INDEX_SWEEP_MS`
  (default 60 s, minimum 10 s); an existing `OPENWOP_MEDIA_INDEX_SWEEP_MS` is still
  honoured, and `OPENWOP_COMMERCE_INDEX_SWEEP_MS` now sets only commerce's hourly
  step. Project client access stays off until you turn on `projects.client-portal`.
  The kanban board read pages only when a caller passes `limit`.
- **Behaviour:** approving a Campaign Studio channel draft now creates it in the
  connected tool (ads paused). If you install packs from the registry, the
  `core.openwop.workflows.marketing` 1.2.3 pin ships vendored in the image.
- **Not in this release:** the ADR 1155 per-board card cap (P5b) and its contract
  change.
- **Steps:** back up the database, deploy the new backend image and then the
  frontend, and check that `/readiness` reports `"version": "0.19.0"`.

## [0.18.0] — 2026-11-22

A MINOR release under ADR 0052. **Nothing is breaking for API callers or operators:**
no route, env var or config key is removed or renamed, and no default changes
meaning. A white-label can choose where a signed-in visitor lands
(`VITE_BRAND_APP_HOME_PATH`, requested by DeckTalk). Campaign Studio gains the
backend records and reads its guided flow will use (ADR 1154 P1/P2, D5/D7), with no
new screen yet. Client reports can be sent to a client's contacts as a view-only
link, behind two toggles that are off by default (ADR 0957 P2 slice 1). One behaviour
change is worth reading (see "Upgrading from 0.17.0"): a node-pack import that fails
on an I/O error now reports that error instead of `409 pack_restart_required`. No
schema migration (sqlite 54 / postgres 52) and no app migration (26). It is
rolling-safe, not a required stop.

### Security

- **A scheduled client report stops when its owner lost access (ADR 0957 P1
  security review, #6165).** A report slot set by a member who no longer has
  `workspace:write` on that client now skips before it starts a run (skip reason
  `client-access-lost`, shown in the schedules panel in four locales). Before, the
  slot kept starting runs that spent budget and failed.

### Added

- **`VITE_BRAND_APP_HOME_PATH` brand key** (`brand.appHomePath`, default `/dashboard`): where a signed-in visitor lands from "Open app", the app shell's `/` and the canvas editor's exit after a delete. Only a plain in-app path is accepted (no `//`, backslash, whitespace, scheme, query or fragment), and at navigation time it must be a registered workspace route whose feature is on and unlocked for the visitor, else `/dashboard`. When set, "Open app" goes through a new, reserved `/open-app` entry that does that check (a key of `/open-app` itself falls back). Unset, nothing changes. Requested by DeckTalk (#6166).
- **Link-only client report portal (ADR 0957 P2 slice 1, #6165).** Behind the
  `campaign-ops-client-portal` toggle and the client-reports sub-toggle, both off by
  default. `POST …/reports/:reportId/links` sends a PUBLISHED report to the client's
  active contacts as one view-only grant per contact, with an email that carries the
  link and no figures. Every view re-checks the grant, the report's state, both
  toggles and the sender's authority, so revoking or withdrawing takes effect at once.
- **Campaign records for the Campaign Studio guided flow (ADR 1154 P1, #6163).**
  `POST /campaign-studio/campaigns` creates a brief and its draft campaign together,
  `POST /campaigns/for-brief` creates or returns the campaign for an existing brief,
  review requests carry `campaignId` (`GET /reviews?campaignId=`), and a campaign row
  records each channel's outcome. The existing brief route is unchanged. All
  host-extension routes; no screen yet.
- **Campaign progress and home reads (ADR 1154 P2, #6167).**
  `GET …/campaigns/:campaignId/progress` and `GET …/home` fold a campaign's place on
  Brief → Plan → Create → Review → Launch → Measure from records the existing chains,
  gates and people already write. Nothing new is stored. A read that failed reports
  `unknown`, never "not started" or "done". The status agent tool answers through the
  same fold.
- **Spend approvals carry their campaign; attribution filters by campaign (ADR 1154
  D5/D7, #6171).** A `campaign-spend` approval raised in a campaign run, or for a
  one-campaign reallocation plan, records `campaignId` as a label (never part of the
  spend key). `/attribution?campaignId=` keeps only that campaign's row, after the
  client-scoped join.

### Changed

- **A node-pack import that fails on an I/O error reports that error (ADR 1152,
  #6164).** A missing or unreadable `pack.json`, an `EACCES` or a `realpath` failure
  used to answer `409 pack_restart_required`, which a restart cannot fix. It now
  answers the generic `502` with the real cause and still refuses the load. The
  guard's own refusals (changed manifest bytes or tree digest, a retargeted root, an
  already-bound path) stay `409 pack_restart_required`.

### Fixed

- **The e2e tenant-toggle pin retries a `409`** instead of failing when two
  Playwright workers pin the same toggle at once (#6170). Test-only.

#### Upgrading from 0.17.0

- **Required stop:** no. **Rolling-safe:** yes. `node scripts/upgrade-plan.mjs
  0.17.0 0.18.0` → one step, no stop.
- **Migrations:** none. Schema stays sqlite 54 / postgres 52; app migrations stay 26.
- **Config:** nothing to change. One new optional frontend build key,
  `VITE_BRAND_APP_HOME_PATH` (default `/dashboard`); rebuild the frontend only if you
  set it. The client-report portal stays off until you turn on both toggles.
- **Behaviour:** if you alert on `pack_restart_required`, an I/O failure during a
  pack import now arrives as a `502` with its own cause instead.
- **Steps:** back up the database, deploy the new backend image and then the
  frontend, and check that `/readiness` reports `"version": "0.18.0"`.

## [0.17.0] — 2026-11-21

A MINOR release under ADR 0052. **Nothing is breaking for API callers or operators:**
no route, env var or config key is removed or renamed, and no default changes
meaning. Four behaviour changes are worth reading before you upgrade (see "Upgrading
from 0.16.0"): an unpaged media list now comes back newest first, replacing a node
pack this process has already imported answers `409 pack_restart_required`, a
reallocation proposer can no longer decide their own plan, and an erased person
leaves every feature-toggle beta cohort. Subject erasure covers seven more stores
(ADR 0464 §9). An outside agent can propose a human-gated budget change over MCP
(ADR 0962 P2), collaborator grants can be renewed (ADR 0958), and the browser agent
can hand a sign-in to the person (ADR 1136 P3a). The CMS gains split columns, linked
gallery tiles, a video hero and a CTA photo band (ADR 1150, ADR 1153). Media assets
record their pixel size and their lists can be paged. Webhook retries arrive on
schedule, and the Postgres event listener recovers from a silent socket. No schema
migration (sqlite 54 / postgres 52) and no app migration (26). It is rolling-safe,
not a required stop.

### Security

- **A refused A2A push URL no longer echoes its credential (ADR 1147 GUARD-3,
  #6118).** The 30 direct error writes in `routes/agents.ts` now go through the error
  envelope. A `?token=…` in a refused push URL used to come back verbatim in the 400.
  The same move puts the job-search, podcasts, runtime-posture and tutorials error
  writes through the credential scrub and locale (#6116, #6117).
- **A reallocation proposer cannot approve their own budget plan (ADR 1022
  CP71WF-23, #6161).** The Intelligence route, the Analyst's chat tool and the
  reallocate chain wrote the approval with no named approvers, so the decide-time
  check passed the proposer. Every lane now binds approvers from the ADR 0942 policy,
  or else the client org's owner or admin. The sole-admin exception (ADR 1131) stays.
- **Subject erasure reaches seven more stores (ADR 0464 §9, CHAN-F19 #6–#12):**
  - private-prompt import claims (#6114);
  - a lead owner's capacity pools, which routing no longer re-creates (#6123);
  - notebook source summaries, with a strict backstop behind the best-effort seam
    (#6128);
  - a contact's name in deal titles and in companies named after them; a name-less
    convert now names the company after the email domain (#6129);
  - a connection's pairing, inbound-session and settings rows, deleted strictly
    (#6134);
  - stale builder-pair room keys (#6139);
  - feature-toggle beta cohorts and their pending replay copies (#6153).
- **The undeclared-key rewrite skips revoked and expired keys (#6138).** `report`
  counts live keys only, dead ones are counted as `inactive`, and `apply` never widens
  a dead key to `['*']`.
- **Dependencies:** the two stale desktop audit exceptions are deleted, so
  `scripts/audit-exceptions.json` is empty again (#6125). Desktop's Electron moves
  45.0.0 → 45.3.0 (#5435).

### Added

- **Campaign ops:** the MCP tool `campaign_propose_budget_change` creates a proposed
  reallocation plan and one Inbox approval. Nothing applies it until a person at the
  client approves and applies it (ADR 0962 P2, #6154).
- **Collaboration:** renew a collaborator grant, 180 days per renewal with no lifetime
  cap, at `POST /host/openwop-app/orgs/:orgId/collaborators/:id/grants/:gid/extend`
  (ADR 0958 Q1, #6145).
- **Browser agent take-over (ADR 1136 P3a, #6137).** In the host-loop lane, a sign-in
  step pauses the session and asks the person who opened it to sign in themselves.
  It expires after 15 minutes, allows at most 3 per session, and no field value
  reaches the model or the record. Production still constructs no browser adapter.
- **CMS:**
  - a `split` columns layout, linked gallery tiles and a same-origin `video` hero
    with a Pause/Play control (ADR 1150, #6132);
  - a `cta` can carry a photo behind the band (`imageToken`, `alt` required) and the
    hero's queue card (ADR 1153, #6160);
  - marquee cards with only a picture are drawn, named by their alt text (#6160).
- **Consent (ADR 1153, #6160):**
  - the built-in `/privacy` page shows and changes the visitor's analytics choice,
    exported as `VisitorConsentChoices`;
  - brand options `VITE_BRAND_CONSENT_CLEARANCE=off` and
    `VITE_BRAND_CONSENT_FOOTER=link`.
- **Media:**
  - every new asset records its pixel `width` and `height`, read from the image
    header; existing assets are not backfilled (#6141);
  - org caps and lists read an index, and lists take optional `?limit=` and
    `?cursor=` (#6112).
- **Notifications:** an approval names its project for board and campaign runs too
  (ADR 1109 D4, #6122).

### Changed

- **Media:** an unpaged asset list is now newest first; it used to be in id order
  (#6112).
- **Packs:** replacing a node pack this process has already imported answers `409
  pack_restart_required`; restart the host to load the new code (ADR 1152, #6157).
- **Consent:** in the grouped footer, "Privacy choices" sits in the bottom bar beside
  the utility links (#6160).
- **Pack versions:** `feature.campaign-ops.nodes` 1.5.0,
  `core.openwop.workflows.campaign-studio-mcp` 1.1.0, `feature.computer-use.nodes`
  1.2.0 and `feature.production.nodes` 1.2.1 (#6154, #6137, #6152).
- Planning docs: the film creative ADRs 1126–1131 (#5964), the Campaign Studio guided
  flow ADR 1154 (#6159), and the ADR 0942 D10.2 sole-admin correction (#6151).
- Test and tooling only: grade-tests waves 117–121 and floors, brand-agnostic public
  tests, a 375px CTA e2e case, and `tracegate-ci` 0.10.4 (#6127, #6130, #6140, #6143,
  #6149, #6120, #5729, #6115, #6131).

### Fixed

- **Production:** a campaign run in a workspace with Production off skips the plan
  step instead of failing, and run preflight no longer refuses it (ADR 0356 P1,
  #6152).
- **Webhooks:** retries arrive on their backoff schedule, not on the next free poll
  tick (RFC 0173, #6146).
- **Host events:** the Postgres listener survives a clean end, a half-open socket and
  a failed re-listen. `/host/events` had stopped delivering hours into a revision
  (#6133, #6136).
- **Campaign reports:** metrics a source never reported show as unavailable, not as a
  measured 0 (ADR 0159, ADR 0957, #5695, #6158).
- **Mobile:** the chat pocket and tutorial hints clear the mobile navigation bar (ADR
  0768, ADR 0488, #6158).
- **Admin:** a failed access or menu read shows a retry instead of looking like a
  denial or an empty menu (ADR 0203, ADR 0139, #5693).
- **Accessibility:** a scrolling table region is focusable in the same render that
  makes it overflow (#6144).
- **CDP:** a dropped purpose label counts as a violation in `isNonWidening` (RFC 0128,
  #6121).

#### Upgrading from 0.16.0

- **Nothing breaking.** No route, env var or config key is removed or renamed, and no
  default changes meaning. These behaviours change:
  - `GET` media asset and collection lists without `?limit=`/`?cursor=` still answer
    `{ assets }` / `{ collections }`, but the asset list is now newest first (#6112);
  - replacing an already-imported node pack in a running process answers `409
    pack_restart_required`. Boot installs, cold installs, same-version no-ops and
    agent, chain and data packs are unaffected (#6157);
  - the proposer of a reallocation can neither approve nor reject it (#6161). This
    applies only to plans proposed after the upgrade. **Plans still awaiting approval
    when you upgrade were created without named approvers, so their proposer can
    still approve them.** Reject every pending reallocation plan in the Inbox and
    propose it again after the upgrade. Plans expire 7 days after they were proposed,
    so after a week none are left;
  - an erased person leaves every beta cohort on the host, not only the erasing
    tenant's, including a same-string principal from another IdP (#6153);
  - protocol-route errors in `routes/agents.ts` gain `details: {}`, which the schema
    allows (#6118).
- **Schema:** no migration. SQLite stays at 54 and Postgres at 52.
- **App migrations:** none. It stays at 26.
- **Media index (not a versioned migration):** the first request after deploy builds
  the org index inline for a tenant with up to 500 assets. A larger tenant reads the
  old way until its background build finishes (#6112).
- **New optional environment variables.** Each defaults to today's behaviour:
  - `OPENWOP_MEDIA_INDEX_SWEEP_MS`: the media index upkeep poll (unfinished index
    writes, queued builds, and the hourly counter drift check). Default: 60 s,
    minimum 10 s.
  - `OPENWOP_PUBSUB_PING_INTERVAL_MS`, `OPENWOP_PUBSUB_PING_TIMEOUT_MS`: the Postgres
    listener's self-ping. Default: 60 s and 10 s.
  - `VITE_BRAND_CONSENT_CLEARANCE` (`off`) and `VITE_BRAND_CONSENT_FOOTER` (`link`):
    frontend build options. Default: unset, which keeps the 0.16.0 behaviour.
- **Forks that run the frontend tests:** reinstall the frontend (`npm ci`). A new
  `patches/cssstyle+4.6.0.patch` is applied by `postinstall`, and nothing else
  triggers it (#6158).
- **No env var or route is removed.** A rolling upgrade needs no downtime; back up
  first, as the planner says below.

`node scripts/upgrade-plan.mjs 0.16.0`: **1 step, not a required stop, rolling-safe.**
0.16.0 instances run against the unchanged schema. Back up the database (and object
store) first, because rollback is a restore, not a downgrade. Then start 0.17.0, and
its migrations replay on boot: sqlite 54 → 54, postgres 52 → 52, app 26 → 26. Check
that `/readiness` reports `version 0.17.0`.

## [0.16.0] — 2026-11-18

A MINOR release under ADR 0052. It carries one change that is **breaking for API
callers** (allowed in a 0.x minor, ADR 0052 §D1): a person is no longer added to an
org by their user id (#5945). See "Upgrading from 0.15.0". Every error response is
now `Cache-Control: no-store` (ADR 1147). A run's approval request reaches only
people who can open the run, and a share link can verify its recipient with an
emailed code (off by default). Stored API keys with an empty scope list can be
rewritten to an explicit `['*']`, and empty can then be made to deny, behind two
switches that are off by default (#6053). The Inbox gains Needs you / Updates /
Archived with one count. Collaboration, replay (RFC 0260 recipe 2), observability
(RFC 0262), Kanban due reminders, per-org media caps and the browser agent's
groundwork land, and a broad fix batch follows. One additive schema migration
(sqlite 54 / postgres 52); app migrations are unchanged (26). It is rolling-safe,
not a required stop.

### Security

- **Error responses are never cached (ADR 1147).** One guard, mounted first, stamps
  `Cache-Control: no-store` on every 4xx/5xx however it was written. That covers the
  126 direct `res.status(...).json()` writes, `.send`/`.end` and the catch-all 404.
  A route's stricter value stays; a weaker one is overridden and logged once per route.
  Behind Firebase, a header-less error used to be cached for 10 minutes on its URL
  (#5841, #6019, #6079, #6085, #6100).
- **A person is no longer added to an org by their user id (#5945, #6003).** See
  "Upgrading from 0.15.0" above.
- **A run's approval request reaches only people who can open the run (ADR 1140,
  #6020).** A named approver who cannot open the run is no longer asked. The run's
  operators are told instead, and if nobody named can open it, the request goes to
  them. SLA reminders follow the same rule.
- **A share link can require its recipient to enter an emailed code (ADR 1141,
  #6046, #6047, #6090).** It is off by default, so existing links are unchanged.
- **No path mints a new undeclared API key (#6053, #6056).** A stored one can be
  rewritten to an explicit `['*']`, and then empty can be made to deny (#6059; the
  switches are above).
- **Dependencies (#6099):** `qs` 6.16.1 (GHSA-6pq8) and `fast-xml-parser` 5.12.0
  (GHSA-474x) in the backend. Desktop's build-time `picomatch`/`minimatch` advisories
  have time-boxed, reachability-assessed exceptions: no fix exists upstream, and none
  ships in the app (#6092).
- **The free-text secret scrub keeps declared record-id prefixes whole (#6027).**

### Added

- **Kanban:** due reminders, and Open/Done on mirrored cards (ADR 1138, #5989).
- **Collaboration (ADR 1099 P0b/P0c):** firm collaborator routes gated per grant kind
  (#6078). Per-viewer projections, and a mint-time recipient check for grant kinds
  (#6101).
- **Replay:** the RFC 0260 LLM cache key recipe 2 on the effect ledger, behind
  `OPENWOP_LLM_CACHE_KEY_RECIPE_2` (ADR 1142, #6072).
- **Observability:** the v2 telemetry family behind `OPENWOP_TELEMETRY_FAMILY`, and
  resumed runs keep their trace (#6057). genAiSemconv 1.37.0, and spans carry the wire
  run id (ADR 1146, #6080).
- **Media:** per-org media caps set per deployment (#6107).
- **Chat:**
  - chain templates in the `/` picker (ADR 1143, #6067);
  - tool display summaries on a host channel, and feature links in chat (ADR 1040,
    #5545).
- **Campaign ops:** a house client for the firm's own business (ADR 1144, #6066), and
  set-up when clients already exist (#6082).
- **Preflight:** required features checked at run admission, in shadow mode first (ADR
  1134 P1, #6075).
- **Forms:** delete a clean submission from the list; refused under a legal hold
  (#6086).
- **Inbox (ADR 1125 P3, #6062):**
  - Needs you, Updates and Archived tabs with ONE count (#5909);
  - an empty state that names the last decision;
  - deep links that follow the tabs.
- **Browser agent groundwork (ADR 1136 P2).** Production constructs no browser adapter
  yet:
  - a session stops when a page script submits without approval (`unapproved_effect`),
    and a forked run never drives the browser (#6052);
  - the companion's `browser` mode (#6055);
  - the paired-device browser executor and one-capability pairing (#6077).
- **Film rehearsals:** private silent rehearsals and timing replay (#6069).

### Changed

- The conformance suite is pinned at 2.49.7 (#6045, #6083).
- `/pricing` serves the app shell when no pricing page is published (ADR 0391 b,
  #6061).

### Fixed

- **Public pages:** the PublicShell actions and CTA no longer overflow sideways at 360px
  with long CTA labels (#6110).
- **Inbox:** the fallback for an unknown request kind is truthful and links the
  activity log (#5843, #6050).
- **Auth:**
  - a sign-out in another tab takes the old account's data off this tab (#6043,
    #6044);
  - an open tab follows a sign-in made in another tab (#5842, #6041);
  - the session probe logs no failed request for a signed-out visitor (#5991, #6035).
- **Chat:**
  - finished runs keep no open wait, and the refusal banner is plain (#6068);
  - smoke-fixture agents leave the @ picker (#5799, #6024);
  - an agent's @handle comes from its name (#5800, #6023);
  - a finished run's outputs read as fields (#5849, #6040);
  - a turn's reply owns its writes, and the safe-mode copy says what it holds (#5908,
    #6033).
- **Reviews:** a wait that resumes on its own is not a review (#6081); an approval
  artifact reads as a document (#5844, #6025).
- **Chains:** bare param names bind for deferred workflows on every seeding (#6105).
- **CRM:** the reported v0 model pointer is accepted, and restoring v0 is allowed (ADR
  0954, #6104).
- **Agents:**
  - a repeated call is answered unless something wrote since it ran (#5932, #6018);
  - an agent's own board shows its kanban.add-todo cards (#5965, #6016);
  - the drawer's lane labels are translated (#5912, #6014);
  - a person's own workflow names show, not raw ids (#5911, #6029).
- **Profiles:** the twin tab loads its namespace (#5775, #6015).
- **Brand:** the footer text is editable in Appearance (#5913, #6039).
- **Email:** a stale template link shows not-found (#5962, #6037).
- **Admin:** refused and loading states use the full width (#5890, #6030).
- **Publishing:** the SPA shell refreshes as soon as its bundle is pruned (#5840, #6036).
- **Knowledge sync:** a changed file is replaced in place (#6031).
- **Connections:** the Google account id is recorded as `externalSubject` (#5983,
  #6028).
- **Memory:** "cannot" and apostrophe-less contractions are negators (#5774, #6011).
- **Tracegate:** a slow coverage take records "no footprint" instead of failing (#6064).

#### Upgrading from 0.15.0

- **Breaking for API callers (#5945, ADR 1123 follow-up).** A person is no longer
  added to an org by typing their user id:
  - `POST /host/openwop-app/orgs/:orgId/members` with a `user:` subject now answers
    `409 use_add_existing`;
  - a `PATCH` that binds a `user:` subject answers `409 use_link`.

  Use `POST …/members/add-existing` (a `candidateId` from `GET …/member-candidates`)
  and `POST …/members/:memberId/link`. openwop-cli 2.1.0 has `orgs members
  add-existing` and `link`. Exempt:
  - service and identity-provider subjects (`oidc:`, `saml:`, `scim:` …);
  - subject-less placeholders;
  - a host superadmin and the wildcard operator key.

  A fork's test fixtures must seed members through
  `/host/openwop-app/test/orgs/:orgId/members`.
- **Schema:** one additive migration. SQLite 54 and Postgres 52 add a NULLABLE
  `invocation_log.llm_cache_key` (RFC 0260 recipe 2), with no backfill. The 0.15.0 binary
  runs against the new schema unchanged.
- **Background job (not a versioned app migration):** `api-key-undeclared-rewrite`,
  idempotent. It does nothing unless `OPENWOP_API_KEY_UNDECLARED_REWRITE` is set:
  - `report` counts stored keys with an empty scope list, per tenant;
  - `apply` rewrites them to `['*']` (the same authority, now declared).

  Run `report` first.
- **New optional environment variables.** Each defaults to today's behaviour:
  - `OPENWOP_API_KEY_EMPTY_SCOPES`: `deny` makes an empty scope declaration deny
    instead of permit. Default: permit. Set it only after `apply` has run (#6053).
  - `OPENWOP_API_KEY_UNDECLARED_REWRITE`: `report` | `apply` (above). Default: off.
  - `OPENWOP_MEDIA_ORG_MAX_ASSETS`, `OPENWOP_MEDIA_ORG_MAX_BYTES`,
    `OPENWOP_MEDIA_ORG_MAX_COLLECTIONS`: per-org media caps for this deployment.
    Default: the built-in caps.
  - `OPENWOP_LLM_CACHE_KEY_RECIPE_2`: record the RFC 0260 recipe-2 key on each LLM
    effect. Default: off.
  - `OPENWOP_TELEMETRY_FAMILY`: advertise the v2 telemetry family. Default: off.
- **No env var or route is removed.** A rolling upgrade needs no downtime; back up
  first, as the planner says below.

`node scripts/upgrade-plan.mjs 0.15.0`: **1 step, not a required stop, rolling-safe.**
The schema permits 0.15.0 instances during the 0.16.0 migrations. Back up the
database (and object store) first, because rollback is a restore, not a downgrade.
Then start 0.16.0, and its migrations replay on boot: sqlite 53 → 54, postgres
51 → 52, app 26 → 26. Check that `/readiness` reports `version 0.16.0`.

## [0.15.0] — 2026-11-16

A MINOR release under ADR 0052. Run admission now checks a chain's required
parameters before a run starts (shadow-first: it logs, it does not refuse). A
sole admin can approve their own autonomy gate. Public-asset grants cover the
storefront, share links and e-sign, and the asset serve route gains its org
floor and signed reads, all behind `OPENWOP_ASSET_ACCESS` (off by default). A
client org's workflow definitions, and a private project's runs, are read only
by that client's or project's people. Kanban work items can carry an assignee or
a project role and be refreshed. Inbox requests name who asks and why, and
an open request cannot be archived away. Campaign Studio fixes land across market
intelligence, SEO briefs, campaign launch, the Strategist and approval waits.
The one-time legacy env-key id rewrite is removed, so **0.14.0 is now a required
stop** for an install that used env keys and never ran it. No schema or app
migration (sqlite 53 / postgres 51, app 26). It is rolling-safe. **New setting:**
`OPENWOP_ASSET_SIGNING_PREVIOUS_SECRET` (optional).

### Added

- **Run admission preflight (run admission preflight P0, #6005).** Before a run starts, the host checks that the chain's required parameters are supplied. P0 is shadow-first: a missing parameter is logged and the run proceeds, so nothing is refused yet.
- **A sole admin can approve their own autonomy gate (CC-GATE-2 G1, #6022).** When the person who would approve a gate is the only admin who could, they may approve it themselves. "A person" is read from the signed-in subject only, and the escape fails closed. A refused self-approval now says why and who can approve (CC-GATE-2 G0, #5996).
- Public-asset grants now also follow the commerce storefront, share links and e-sign (ADR 1122 P1b, #5952). With `OPENWOP_ASSET_ACCESS` on, a publicly listed product grants its images (not its downloads), a live share link grants every picture it shows (including on a draft page), and an open e-sign request grants the pictures in the signer's document and, once completed, the certificate. Unlisting, deleting, revoking or voiding takes them back. Nothing changes while the switch is `off`, the default.
- Signed asset reads (ADR 1122 P2, #5966): `signedAssetUrl(token, seconds)` mints a read of one asset that needs no session and lasts at most 15 minutes, for exports, renderers and model-provider fetches. The serve route admits a valid signature for exactly that asset, caches it no longer than it lives, and answers a bad or expired one with the same 404 as an unknown asset. Rotating the session secret keeps in-flight signed URLs working while `OPENWOP_ASSET_SIGNING_PREVIOUS_SECRET` holds the old one. Email pictures use public grants, not signatures.
- The asset serve route's org floor (ADR 1122 P1c, #5956). With `OPENWOP_ASSET_ACCESS` on, a signed-in read of a media-library asset owned by a client org also needs access in that org, so a workspace member outside client org X no longer sees org X's library. Workspace admins, personal workspaces, root-owned assets and assets a public page shows are unaffected. A lookup that cannot be read is refused rather than allowed. Nothing changes while the switch is `off`, the default.
- An operator can redact an affiliate's records for that affiliate's data-subject request (ADR 0464 §9, CHAN-F19 #5, #5978).
- **Inbox requests name who asks and why (ADR 1125 P1, #5922, #5958).** A request carries the asking automation's name (never its id, and never a person) and a host-composed reason; with no gate title the host writes one per kind. Only kinds a person can answer notify: an external-event wait no longer files a request. A credential request's Connect button opens the host's own connect route, never a link a pack supplied. An unknown request kind now tells the person to ask whoever runs the workspace to update the app.
- **An Inbox card names the ask and cannot silence an open request (ADR 1125 P2, #6001).** Unread is a labelled dot, priority shows only for high and urgent, and the second line reads "from {asker}" and the reason. A "…" menu holds Mark read/unread, Archive, Delete and View activity log. An open request offers no Archive or Delete, and "Archive read" leaves open requests alone (`:archive-read` takes an optional `keep` list of up to 500 ids). Repeated news with the same type, title and asker collapses into one card that expands in place; requests never collapse.
- **Kanban work items carry an assignee and can be refreshed (ADR 1137 P1–P3, #5985, #5987, #5988).** A work-item proposal may name an assignee (`assigneeId`) or a role (`assigneeRole`), with a reason, a source label and labels, all written only when the card is created. An assignee must be a workspace member who can read the board's subject, checked before any write (`kanban_assignee_invalid`), and is notified once. On a project's own board, `project:lead` and `project:contributor` address the card to that project's people; a role routes the card to "Assigned to me" and never grants access. `refresh` updates the title, description, due date and source label of existing work, and never touches the assignee, column, order or labels, a card in a terminal column, or a card a person deleted. `core.openwop.kanban-work-items` 1.2.0 carries all of this to workflow chains (`vendor.openwop.app-builder.workflows` 1.4.3).
- Groundwork for computer-use browser executors (ADR 1136 P1, #5997, #6000): an executor protocol, a closed-world tier table built from the executor's element report (credential fields are refused, unknown elements count as commit) and a host-run loop adapter. Nothing in production constructs the new adapter, so behaviour is unchanged.

### Changed

- **Market-intelligence digests read the pages they find (ADR 1116, ADR 1135; CC-CHAIN-7 #5900, CC-CHAIN-8 #5984).** `core.openwop.workflows.market-intel` 1.3.1: both chains fetch the discovered pages (`core.web.fetch`) and extract voice-of-customer per page. Discovery (`vendor.myndhyve.market-intel-discovery` 1.1.0) runs up to two live web searches and orders the fetch list so hosts that block automated reads go last; a run with no readable source fails typed `NO_FETCHABLE_SOURCES` at discover. The chains need a host that exposes `ctx.webResearch`.
- `seo.keyword-brief` saves its brief as a draft Document and searches its topic (CC-SEO-2, #5941); `feature.documents.nodes` 1.5.0.
- `core.openwop.ai` 1.5.2: chat nodes keep upstream fields after a port-less edge (CC-SEO-3, #5979).
- `marketing.campaign-launch` launches through the governed ad step, and `openapi-call` names a missing document (CC-CHAIN-1, ADR 1111, #5947).
- The host opts out of the `family.budget` and `family.production` conformance families at major 2 (#5977).
- The Meta Marketing API pin is re-read; its next review is due 2027-02-01 (ADR 0907 D0, #5982).

### Removed

- **The one-time legacy bearer-id rewrite job is gone (ADR 1045, CHAN-F18, #6006, #6021).** The `legacy-bearer-id-rewrite` background job and `OPENWOP_LEGACY_BEARER_REWRITE` no longer exist; 0.14.0 is the last release that carries them. **If you upgrade from before 0.14.0 and have not run the rewrite, upgrade to 0.14.0 first and run it there** (`OPENWOP_LEGACY_BEARER_REWRITE=report`, read the `legacy_bearer_rewrite` log line, then `apply`), then continue. Skipping it leaves records carrying a legacy `bearer:<8>` id (delegations an env key minted, run actors, scheduled jobs, env-key-created org members) without operator standing, with no tool left to rewrite them; they fail closed and nothing moves to the wrong key. An install that already ran the rewrite, or never used env keys, has nothing to do. A leftover `OPENWOP_LEGACY_BEARER_REWRITE` setting is ignored. `releases.json` now marks 0.14.0 a required stop for this, so `node scripts/upgrade-plan.mjs <from>` lands on 0.14.0 before going past it (RELEASES.md v0.14.0, corrected 2026-11-16).

### Fixed

- Campaign Studio: the Strategist opens with the campaign named (CC-HUB-2, #5994); personas are reachable in the hub and messaging prose is never cut (CC-HUB-1, CC-BRIEF-2, #5975); the creative-briefs step skips when its feature is off (CC-CHAN-3, #5981; `feature.campaign-channels.nodes` 1.19.2).
- Chat: an agent is told which runs in its history it started (CC-STRAT-2, #5986); run digests say a run waiting on an external event continues on its own (CC-STRAT-3, #6004); an external-event wait never asks for input (CC-ORCH-3, #5976).
- Inbox: a request about a deleted run is over too (ADR 1124, #5955).
- Crawlers get the pricing page's preview at `/pricing` (ADR 0391, ADR 0384, #6026). The shipped `firebase.json` gains a rewrite for it.

### Security

- **A private project's runs are read only by its people (ADR 1133, #5970, #5971).** An org viewer outside a private project could open and list its runs, read their events, and read what they delivered in the artifact library. A run a private project is working on now needs read on that project. The project is worked out from where the run came from (a card on the project's board, a project schedule, or a campaign) and is never stamped on the run, so a fork follows the same rule. A refused run or artifact reads as not found and drops out of lists. Runs with no project, or in an org-visible project, are unchanged.
- **A client's workflow definitions are read only by that client's people (ADR 1132, #5969, #5973, #5980).** Child runs inherit the client and carry no client content, the builder's template client choice reads orgs through the shared org selection, and the model-facing lanes apply the same client floor (`mayLaunchOwned` is required, so a caller without it does not compile).
- A person's settings preferences and BYOK counters are erased with them on a data-subject request (ADR 0464 §9, CHAN-F19 #4, #5948).
- **A campaign step's requester can no longer approve it themselves through the plan exemption (CC-GATE-3).** Campaign autonomy gates fell back to a plain approval when a plan-exempt operator ran a campaign in a workspace whose plan lacks the marketing bundle. The frozen policy now applies there too, so the person who requested a kernel, creative, spend or experiment-promote step cannot approve it, unless they are the only admin (the sole-admin rule above).

#### Upgrading from 0.14.0

- **No required stop at 0.15.0; rolling-safe.** `node scripts/upgrade-plan.mjs 0.14.0`
  gives one step. No schema or app migration (sqlite 53 / postgres 51, app 26).
- **From before 0.14.0, 0.14.0 is a required stop.** An install that used env
  keys (`OPENWOP_API_KEYS`) and never ran the legacy bearer-id rewrite must land
  on 0.14.0 and run it there (`OPENWOP_LEGACY_BEARER_REWRITE=report`, read the
  `legacy_bearer_rewrite` log line, then `apply`). `upgrade-plan.mjs <from>`
  plans that stop. A leftover `OPENWOP_LEGACY_BEARER_REWRITE` is ignored on 0.15.0.
- **Deploy the backend before the frontend.**
- **Client-scoped workflows:** a member who reads workflows only through one
  client org no longer sees other clients' definitions. Grant tenant admin to
  anyone who still needs them all.
- **Private projects:** a run a private project is working on, and what it
  delivered, need read on that project.
- **Run admission:** P0 only logs a missing required parameter; nothing is
  refused in this release. Check the logs before a later release enforces it.
- **Hosting:** if you forked `firebase.json`, carry the new `/pricing` rewrite.
- **Asset access:** `OPENWOP_ASSET_ACCESS` is still `off` by default. With P1b,
  P1c and P2 present, `report` now covers every public surface; set
  `OPENWOP_ASSET_SIGNING_PREVIOUS_SECRET` when you rotate the session secret.
- **Market intelligence:** the digest chains need a web-search provider
  (`ctx.webResearch`); without one, discovery fails typed.
- **Inbox:** external-event waits no longer file Inbox requests, and
  `POST …/notifications:archive-read` accepts an optional `keep` id list
  (without it the route is unchanged). The Inbox UI no longer archives open
  requests.
- Back up the database before upgrading. After the upgrade, check that
  `/readiness` reports `version: 0.15.0`.

## [0.14.0] — 2026-11-15

A MINOR release under ADR 0052. It adds readable Inbox requests that close
when their step ends, feature wording on approval cards, hideable menu entries,
paged product and order reads with a product cap you can set, and new CMS
sections and site-nav options. Private projects now admit only their members
and the org's admins. Listed operators keep their plan exemption inside runs and
chat tools. An agent no longer denies a tool call it made after an approval.
The model catalog is refreshed. One schema migration adds an index (sqlite 53 /
postgres 51); app migrations stay at 26. It is rolling-safe, with no required
stop. **New settings:** `OPENWOP_COMMERCE_MAX_PRODUCTS_PER_ORG`,
`OPENWOP_COMMERCE_INDEX_SWEEP_MS` and `OPENWOP_CMS_OVERLAY_REALIGN`, plus two
default-off flags, `OPENWOP_BOUNDED_LOOPBACK` and `OPENWOP_INTERRUPT_RESOLVED_VIA`.

> **Corrected 2026-11-16.** Three Added entries (ADR 1122 P1b, P1c and P2) were
> filed here after the v0.14.0 tag (8a2fcb0fbb). Their PRs (#5952, #5956 and
> #5966) merged after it, so the v0.14.0 bundle does not have them; they ship in
> 0.15.0 and moved to that section. The released v0.14.0 artifact is unchanged.

### Added

- Public-asset grants follow what public surfaces show (ADR 1122 P1a). With `OPENWOP_ASSET_ACCESS` at `report` or `enforce`, a published CMS page grants anonymous read of every picture its readers can reach: its own sections, shared sections, a running experiment's variants, and its SEO image. Unpublishing, deleting or editing it revokes what it no longer shows, within a minute for these paths and within about an hour for paths without a hook. A reconcile on a two-minute tick, under a lease and in bounded slices, keeps the grants in step and backfills pages published before the switch. A failing lookup keeps existing grants rather than revoking them. Nothing changes while the switch is `off`, the default.
- `OPENWOP_ASSET_ACCESS` (`off` by default, `report` or `enforce`): the asset serve route (`GET /host/openwop-app/assets/:token`) decides who may read an asset instead of serving anyone holding the token (ADR 1122 P0, issue 5929 item 3). A read passes for an operator, a person who still belongs to the asset's workspace, or an asset a public surface has granted. `report` serves everything and logs `asset_access_would_deny`; `enforce` refuses with the same 404 an unknown token gets. Session reads are `private` and vary on Cookie, and public-grant reads are cacheable for 60 s. A stale or refused session cookie reads as no session, so public pages' images keep loading. No public surface registers grants yet (P1), so `enforce` waits for P1, P2 and seven days of `report`.
- `OPENWOP_CMS_OVERLAY_REALIGN` (`report` or `apply`, unset by default): a one-shot background job, `cms-overlay-realign`, that puts the base's item states back into stored CMS translations saved before ADR 1038 D8 and ADR 1112 D6 aligned them (DG-1112-6). Until it runs, such a translation shows its own lock weeks, lead days and states. `report` logs the counts (`app_bg_job_cms_overlay_realign`) and writes nothing; `apply` repairs each page with a compare-and-swap, keeping its version, author and translation stamps, and marks the job done. The daily `staleItemOverlays` gauge then reads 0.
- A page's `siteNav.ctaHref` sends its header and footer button (`siteNav.cta`) to an app route or a `#fragment` on that page instead of the page itself (ADR 1113 D5). It needs `cta`; an external href is refused.
- A page's `siteNav.links` adds menu entries for destinations that are not CMS pages: an app route (`/discover`) or a `#fragment` on that page (ADR 1113). Each entry has its own label, group, optional description, order and group heading, so a site with two pages can fill a four-column mega menu and its grouped footer. Up to 12 per page; an external href is refused.
- CMS AI rewrite (improve, shorten, fix, …) handles larger `scheduleSim` sections the way translation does (ADR 1112 P6): words and ids only, up to 8 parts, joined by id, under one 45 s deadline. Translate and rewrite now share one parts runner.
- CMS AI translation handles larger `scheduleSim` sections (ADR 1112 P3): the model is sent the words and ids only, and a section still too large for one reply is translated in up to 8 parts (about 340 decisions), joined by id. Larger ones are still refused, with the number of parts they would take. The submit sweep counts each part against its budget.
- CMS `scheduleSim` reads a real catalog (ADR 1112 P2, #5816): up to 1,500 decisions on 40 milestones (fewer once translated: each translation is a whole copy, so about 1,500 with one translation and about 775 with three), grouped by `phases`, `categories` and `roles` (each a `key` and a `label`; a decision names them by key). Visitors set lateness per role, per phase × category cell, or per decision. A scenario's role-only rules fill the role controls. A grid counts each cell's decisions and its late ones; an open cell or milestone lists 12 decisions, then "Show all". Crawlers get milestone dates and counts by phase. Decisions no longer need `options`.
- CMS `scheduleSim` replays its schedule and reports what was missed (ADR 1112 P1, #5816). Set how late decisions come in, then play the result: a week every 0.6 s, stopping at the finish; under reduced motion a "next missed lock" step replaces the animation. The summary adds the locks missed, each naming the decision that held it longest and its rework, and the late decisions and late orders. The section opens on the first milestone that owns a decision.
- CMS `statusTable` can sit beside its copy (ADR 1080 D17, #5765): an optional `points` list under the head, and `head: 'split'` puts the head and its points in the first column and the table in the second. Unset, a section is unchanged.
- CMS `scheduleSim` can open on the scenario controls (`startMode: 'whatIf'`) and keep its summary in view while answers change (`stickySummary: true`), below the public site's sticky header (#5779 B5, ADR 1080 D18).
- CMS hero `visual: 'queue'` can set a photo: the queue card sits over the photo's lower edge from 900px and stacks under it on a phone (#5779 B7, ADR 1080 D19).
- A page's `siteNav.groupLabel` names its nav group in the public menu and the grouped footer, in place of the stock heading (Product, Who it's for, …); the first page in the group, by order, that sets it wins (ADR 1105 D11, #5779 item 8). It needs `siteNav.group`, and like every nav label it serves in the site's base language.
- CMS `marginCalc` and `allowanceGap` sections (ADR 1105 P1): a margin worksheet (cost and markup to client price and gross margin, and the markup a target margin needs) and an allowance worksheet (an allowance beside the expected spend, line by line, with the overrun total; lines under their allowance are not netted). The authored figures are starting values the reader edits, and crawlers get the worked answer.
- CMS `partyViews` and `stageChart` sections (ADR 1105 P2): a switch between the parties on a project, showing what each needs and a sample of what each sees, and a chart of counts by stage, grouped, with totals in the legend. Every party and every count reaches crawlers; a stage's count and group follow the base layer in a locale overlay.
- **Commerce catalog index (ADR 1110 P1).** The content kernel keeps declared indexes for
  system types, written inside its own writes and repaired after a crash, and
  `commerce.product` declares one: name order, category, tag, search token and low stock.
  The per-org product cap now reads a maintained counter instead of loading the catalog on
  every create, and the kernel's at-the-cap recount counts in the database. New reads for
  the next phase: `listProductsPage` (paged, filtered, searched), `getProducts` and
  `iterateCatalog`. A catalog-index sweep repairs unfinished index writes each tick and
  checks every tenant for drift hourly (a drifted one is rebuilt in the background); the `commerce-catalog-index` integrity gauge
  reports drift and the backlog. No caller moves yet and the cap is unchanged (5,000).
- **Signed-in approval gates (ADR 1120, #5920).** `core.approvalGate` and `core.chat.approvalGate` take `decide: 'signed-in' | 'link'` (default `'link'`, unchanged). Under `'signed-in'` a token resolve is refused with 403 `interrupt_requires_session`, and the approval email carries no token, only a Review link to the person's Inbox row. `/inbox` survives sign-in (`signInReturn`). `vendor.myndhyve.chat` 1.5.0.
- **Add a person who already has an account to an org (ADR 1123, #5944).** Org admins pick from the people in orgs they can act in (`GET /orgs/:orgId/member-candidates`), and superadmins can look up one vouched email. `POST …/members/add-existing` binds the person at once, and `POST …/members/:memberId/link` binds a row added without an account. Both are audited on the security chain, and only the person added is notified. Nothing links automatically at sign-in.
- **Create forms open from a header button (#5923).** `/projects` puts "New project" in the page header and opens a shared `ui/CreateDialog`, instead of a permanent form above the list.
- Approval gates can use a feature's own wording (ADR 1040 D7 phase D, #5542). `core.approvalGate` takes `actionLabels`, `promptKey` and `declineExpected`, checked closed-world (`invalid_config`); the chat, run-page and `/reviews` cards show them, and a key missing from the catalog falls back to the standard label. `declineExpected` swaps the red reject confirm for a neutral "Decline this?". A feature can register a result card for finished runs with `registerRunResultRenderer`.
- Inbox requests are readable (ADR 1109, #5797, #5832): a request shows the gate's own title and prompt under the chain's name, with a chip linking its project. The Needs-you banner no longer says "all clear" above waiting requests.
- An Inbox request is marked done once its step ends anywhere: chat, email link, API, CLI, a timeout or the run ending (ADR 1114, #5868, #5870). "Archive finished requests" (`POST /host/openwop-app/notifications:archive-resolved`) clears rows left over from before this release. The schema migration adds a partial index on `notifications` for it.
- Menu settings can hide any menu entry, not only feature-gated ones (ADR 1106 P1, #5903). Settings and Menu settings stay visible so a menu can always be fixed; they can still be moved. Hiding changes the menu only: the page still opens for whoever may open it.
- Campaign Operations can add a client's CMS page as a campaign asset from the Operations page (`GET /host/openwop-app/campaign-ops/clients/:orgId/asset-candidates`, CC-OPS-1, #5852). A 400 for an unknown editable field lists the valid field paths in `details.valid`.
- The builder shows config forms for the in-tree `core.email.draft` and `core.email.send` nodes (CC-SEO-1, #5862).
- Bounded refine loopback from an approval gate back to the node it reviews (ADR 1058, RFC 0258, #5583, #5850, #5886). Off by default behind `OPENWOP_BOUNDED_LOOPBACK`; with it off, a definition with a `loopback` edge is refused `capability_required`.
- Token resolutions can record `interrupt.resolved.resolvedVia` (ADR 1059, RFC 0259, #5585, #5848). Off by default behind `OPENWOP_INTERRUPT_RESOLVED_VIA=true`; with it on, a token resolution of an interrupt that has an approver list and no signed voter is refused `403 resolved_via_unbound`.

### Changed

- **Nav words have one source (ADR 0874 P3).** A menu entry carries a `nav` catalog key, or an English literal when it has no key (an adopter's feature), never both. Every menu surface reads it through `chrome/navText.ts`. The 198 duplicate literals were a second copy of the catalog's English in the entry chunk: 129.0 → 126.6 kB gzip. The entry ceiling stays at 129 kB by the user's decision, leaving about 2.4 kB of headroom. `FeatureNav.label` and `hint` are now optional: an adopter entry that sets `labelKey` drops its literal, and one without a key keeps it.
- CMS `scheduleSim` (ADR 1112 P1): the live "answer against the clock" mode is removed; it could not be played and never ended. `startMode` and the decisions' `choices` are no longer stored. A lead time is counted back from a lock only when the decision sets `back: true`; otherwise the lock is the decide-by date, so decisions on existing pages that set a lead time now fall due later. A decision with an unknown lead time is dated to its lock and can be late. Two milestones or two decisions sharing an id are now refused (400): the model keys both by id.
- CMS `scheduleSim` locale overlays change words only (ADR 1112 P2): a translation is matched to the base by id (an item the base lacks is dropped, one it lacks is the base's copy, so every language has the same decisions and finish), then ids, keys, references, numbers and flags (`back`, `leadUnknown`, `dependsOn`, …) follow the base. A decision's `decider` stays translatable, and a scenario rule that names one takes its translated name. Every saved decision gets an id. `startDate` is base-only; an impossible one is dropped. A section whose base and translations together pass 850 kB is refused with its size (a page saves as one 1 MB request, and each translation carries a whole copy of the decisions). A translation that leaves the milestones out, or was written before the base grew, now saves.
- CMS pages whose sections pass 975 kB are refused with their size (a page saves as one 1 MB request). AI translation and rewriting refuse a section over 12,000 characters up front, instead of failing after two full-size model calls; the publish-time auto-translate skips such a section and goes on. (About 40 scheduleSim decisions fit; a larger catalog is translated by hand for now.)

- A locale overlay can no longer change a number in a list item (ADR 1105 D5). A columns stat tile's `count` (ADR 1063) now follows the base layer like an item's `state`, as do the new worksheet figures; an overlay that set a different count is corrected on its next write.
- **Product lists are paged (ADR 1110 P2).** The admin product list, the public storefront,
  the UCP catalog, the Store Assistant's `list-products` tool and the commerce workflow
  surface return one page instead of the whole catalog. The admin list and storefront take
  `limit` and `cursor` and return `nextCursor`; the UCP catalog uses UCP's
  `pagination: {has_next_page, cursor}`; the tool returns 50 and a `nextCursor`; the
  workflow node returns the first 200 matches. The Products tab searches and filters on the
  server, says "Showing X of Y" and loads more on request; product pickers search as you
  type (a new shared `Combobox`).
- **Product search matches names, tags, categories and variant names, not descriptions**
  (ADR 1110 D3). Storefront search still finds products by description where semantic
  recall runs. Discovery search reads at most 1,000 candidates and says when a count is a
  floor.

- **No whole-catalog read remains (ADR 1110 P3).** `listProducts` is deleted. The
  data export pages products with a cursor (the export door accepts a paged exporter and
  the download follows `nextCursor`); the public product feed streams in batches; the
  feed settings count up to 10,000 items; a catalog push sends at most 10,000 changes per
  approved push and reports how many remain; product embeddings rebuild in batches, and a
  catalog over 5,000 products is re-embedded by a background sweep instead of inside a
  search; demo seeders and entities erasure read a page at a time.

- **The product cap is a setting (ADR 1110 P4).** `OPENWOP_COMMERCE_MAX_PRODUCTS_PER_ORG`
  sets how many products a workspace may hold: default 5,000, up to 500,000. An invalid
  value is logged and the default stays; the cap error names the setting.

- **Legacy env-key ids no longer match (ADR 1045, CHAN-F14).** An issuer id in the
  old `bearer:<first 8 key characters>` form now matches no configured key, even when
  only one key has that prefix. Records still carrying one (delegations an env key
  minted, run actors, scheduled jobs, env-key-created org members) lose operator
  standing until rewritten. **If you have not run the rewrite:** set
  `OPENWOP_LEGACY_BEARER_REWRITE=report`, read the `legacy_bearer_rewrite` log line,
  then set `apply`, before or after upgrading. The job is kept for this.

- **Order lists are paged (ADR 1110 P5).** The order cap counts live orders from a
  maintained index instead of loading them. The admin order list returns one page, newest
  first (`cursor`, `limit`, `total`), and filters by status on the server; the Store
  Assistant's `list-orders` tool returns 50 with a `nextCursor`; the workflow surface
  returns the newest 200; the data export pages orders. The Orders tab loads more on
  request and finds a full order id directly.
- A person added to an org through the older free-text `subject` lane of `POST`/`PATCH /orgs/:orgId/members` is now audited and notified like the new lanes (ADR 1123 interim, #5949). Service and IdP subjects are not notified.
- Project membership and visibility changes are recorded on the security audit chain (ADR 1118, #5914).
- Conformance suite and spec artifacts pinned to 2.49.1 (#5927).
- **Private projects admit only their members and the org's admins and owners (ADR 1118, #5904).** Before, every org editor could read and write every private project. A non-member editor now gets 404, documents the project owns included; a member still needs `workspace:write` to write. Making a project private adds the person who did it as a lead. Org-visible projects are unchanged.
- **Listed operators keep their plan exemption in chat tools and inside runs (ADR 1108; #5796, #5805, #5813, #5817, #5819, #5837, #5867, #5879, #5880).** `POST /runs` and `:fork` record it for a listed superadmin, and it is re-checked at each use; scheduled, triggered, heartbeat and sub-workflow runs never get it. A plan refusal from the campaign tools reads `not_entitled`, not `feature_disabled`.
- **The model catalog is refreshed (November 2026, #5760).** Added `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`, `gemini-4-argon` and `gemini-4-carbon`; the Anthropic `quick` default is `claude-haiku-5-5`. Removed as deprecated: `gemini-3.7-flash`, `gemini-3.5-flash`, `gemini-2.5-flash` and `gemini-2.5-pro`. A stored setting or agent that pins one of those needs a new model.
- **A pack can no longer replace a node the host registers itself (#5808, #5810).** `core.web.search` always runs the host's node (SSRF-guarded, BYOK `web-search` key), even once the web-search pack has loaded.
- **Adopter hook renamed (ADR 1099 P0, #5773):** `registerCollaborationOrgGate` is now `registerDefaultCollaborationSurface`, taking a collaboration surface. Only an adopter feature that called the old hook needs a change.
- `POST /runs` refuses a run input that contradicts a parameter the chain bound when it was instantiated: `400 validation_error`, `reason: bound_param_conflict` (ADR 0237, CC-CHAIN-5, #5818).
- Retired chain aliases are hidden from the chain gallery, and `from-chain` refuses them with 410 (`reason: retired_alias`). A background job, `retired-alias-seed-retract`, removes copies already seeded in /builder and the `/` picker, keeping any a user edited or scheduled (CC-CHAIN-4, #5826, #5834).
- Podcasts use one access rule on every lane (ADR 1115, #5895). A run with no person is refused. A run writes only to the episode it claimed, while that episode is unpublished. Publishing needs audio and no live run. A non-member gets 404 at a private notebook's episode write routes.
- Funnel steps refuse a stale messaging kernel with `kernel_stale`, as channel generators already did (ADR 1020 D8, CC-KERNEL-1, #5807).
- The Campaign Strategist reports a run's steps when it starts the run, then ends its turn instead of polling. Campaign Studio's strategist buttons open the chat with the brief already named (CC-AGENT-1, CC-AGENT-2, CC-UX-2, #5828, #5853, #5860).
- Each nav group gives its entries distinct icons, and Settings sorts last in Workspace. The Needs-you tile names a run's workflow instead of showing its id (#5786, #5788, #5791).
- Every native single-line `<select>` draws its arrow inside the field, mirrored for right-to-left; forced-colors mode keeps the system arrow (#5883, #5884, #5894). The base CSS now sets `appearance: none`, so a brand rule using `background` or `padding` shorthands on a select erases the arrow; a brand-CSS patch for this can be dropped.
- The Google font hosts are preconnected only when `VITE_BRAND_FONTS_HREF` points at Google Fonts, so a self-hosted font setup no longer contacts Google (#5762). `index.html` gains a `{{BRAND_FONTS_PRECONNECT}}` slot the build fills: a fork of `index.html` should take it and drop the hard-coded Google preconnect lines.
- `OPENWOP_COMMERCE_INDEX_SWEEP_MS` sets how often the catalog and order index sweep runs (default 60000 ms, at least 10000; ADR 1110).

### Fixed

- The media library's "used by" list now includes pages whose hero hub shows a picture, so deleting that picture warns that the page uses it (ADR 1122 P1a). It used to break the page without a warning.
- A CMS page or shared-section edit (`PATCH`) that names no editable field, an unknown field, or a non-string title, slug or name is refused with 400 `validation_error` naming the field, and writes nothing (issue 5937). It used to return 200 and still record a new version, `updatedAt` and `updatedBy`, so a typo such as `{"section": …}` for `{"data": …}` read as a successful edit and skipped the approval gate's check. The SPA and the CLI send only known fields.
- `GET /host/openwop-app/orgs` lists only the organizations the caller can act in (issue 5929 item 2). It listed every org in the workspace, so in a workspace holding several clients every member saw every client's name in each org picker. Operators and workspace admins (`host:members:manage` on the workspace root) still see every org. The Access hub's organization and endpoint counts follow the same list (ADR 0864 D2 correction).
- A workflow step that names a model but no provider now runs on the provider that offers that model, instead of quietly running the workspace's default model (ADR 1117 correction). Found live: a run that chose MiniMax M3.1 Flash ran on the free tier. If the workspace has no key for that provider, the step says so and names it. The "needs an API key" message also no longer says the provider is fixed when the workflow is created, since a deferred copy chooses it per run.
- A deferred workflow copy now runs with the AI provider and model chosen when the run starts, not the ones frozen when the copy was made (ADR 1117, #5897). Run `a7ee7b9a` asked for haiku and was billed sonnet. The run form also stops offering a copy's inputs that nothing reads (a frozen `orgId`, or the model of a copy made before this fix), and the builder shows a run-bound provider or model as "Set when the run starts". A fork keeps its source run's choice.
- **Spanish, French and Portuguese visitors saw the app's frame in English.** With one of those languages saved, the nav, the rail, the admin menu and the shell's notices were English while feature pages were translated. The lazy catalog backend answers a lazy locale's frame catalogs with an empty set, and boot took that empty set as "already loaded", so the real catalogs were never fetched (reproduced on app.openwop.dev). Boot now checks the catalog has content.
- A wide table no longer widens the whole page on a phone. Text kept for screen readers inside a table cell was positioned against the card rather than the table's scroller, so it escaped the scroller's clip: `/capabilities` measured 543 px wide on a 380 px screen and arrow keys scrolled the page instead of the table. The scroller is now the containing block.
- A CMS page's size limit (975 kB with its shared sections resolved) now also holds when content reaches readers outside a publish: approving a review (refused before the review is consumed), starting or promoting a page experiment, and editing a shared section that a published page uses (the refusal names that page, in the editor's language). ADR 1112 residue, DG-1112-13.
- The CMS editor's History list no longer downloads every saved version's content. A version can hold up to ~975 kB since ADR 1112, so a page at the 50-version cap could send ~48 MB to open its History. The list now asks `GET …/pages/:pageId/versions?summary=1` (title, slug, who and when) and Compare reads one version through the new `GET …/pages/:pageId/versions/:versionId`, with a busy button and a localized error toast. The list without `?summary=1` is unchanged, so an editor loaded before the deploy keeps working (ADR 1112 residue, DG-1112-12).
- CMS page history no longer reads every workspace's saved versions to show, cap or record one page's (ADR 1112 data residue, DG-1112-11). Version rows now have a per-workspace index carrying only what the list sorts on; reads switch to it once the hourly reconcile has verified it. A saved version can be up to about 975 kB since ADR 1112, and a publish read all of them three times.
- **Nine menu entries were English in every language** (`/webinars`, `/ai-video`, `/campaign-studio` and six `/job-search/*`). They now have `nav` catalog keys in all four locales, and every host menu entry must carry a key (`navCopyRatchet`). **Seven wide tables could not be scrolled from the keyboard** (sales map ×2, commission statements, territories, WhatsApp failures, CAD bill of materials, slide-deck tables, analytics nav report): they now render through `<TableScroll>`, and a `u-overflow-auto` div around a `<table>` is refused by `tableScrollRatchet` (grade residue NAV-1, A11Y-TS-3).
- A CMS page holding a `scheduleSim` saved before ADR 1112's id rules (two decisions or milestones sharing an id, a reference to a milestone, decision or group that no longer exists) can be published, scheduled, unpublished and erased again (ADR 1112 P4). The author's next save still names the problem.
- CMS `scheduleSim` grade residue (ADR 1112): a page whose shared sections resolve past the 975 kB page limit is refused at publish (`publish_blocked`, rule `too_large`); the section and page size refusals carry `details.reason` and the editor shows them, and the AI too-large and timeout failures, in its own language; a section may set `currency` (ISO 4217) for the cost of delay, which no longer hard-codes "$"; a decision in an open cell names its milestone; a page-lane save measures a section's bytes once, not twice.
- CMS submit with `autoTranslateOnPublish` no longer runs past the hosting proxy's 60 s (ADR 1112 P5): the auto-translate sweep stops at 40 s, keeps what it drafted, and the editor says the time limit was reached.
- CMS `scheduleSim` month axis no longer draws the month and year on top of each other at the year change (#5779 B6): the year sits on its own line under January, and a long plan labels every other month (at most about 12 labels), counted from January.
- **Catalog index hardening (ADR 1110 round fixes).** A workspace whose catalog was read or
  emptied can be deleted again (index rows no longer count as its data). A large existing
  catalog is indexed in the background after deploy instead of inside the first request,
  and is served by the previous read path meanwhile. An index is checked before it is
  trusted, so merging an anonymous sandbox into a signed-in workspace re-indexes it.
  Account deletion purges the index a page at a time. Discovery, recommendations and the
  feed settings stop after a page budget; a push of a catalog over 20,000 products points
  to the feed URL instead; the feed stream respects slow fetchers. Product pickers say
  "20+ matches", open on typing, can be cleared and retry a failed list; product and order
  filters no longer drop keyboard focus; a failed "Load more" keeps the list.
- **Products created in an anonymous sandbox are readable after sign-in.** The sign-in
  fold rewrites a stored row's top-level tenant only, so a folded product kept the
  anonymous tenant inside its stored copy and `getProduct` refused it. The product read
  now takes the tenant and org from the row (ADR 1110).
- A reopened agent conversation answers as the agent that answered last, not the default agent (CC-CHAT-4, #5938).
- The builder no longer offers "Fill with AI" on a field bound to a run value (ADR 1117 D4, #5907).
- The CMS approval-gate refusal reaches a non-English editor in their language (CMS-UX-1, #5917).
- **Every open chat filed an "Input needed" Inbox item nobody could answer or clear (#5922, #5943).** A chat between turns waits on a `conversation` step, and that step notified like a request. It no longer does, and a one-time background job (`retire-conversation-requests`) marks the items already sent as read and "No longer waiting" on the first boot after the upgrade. It never archives or deletes, and touches nothing else.
- **An agent denied a tool call it had just made.** A model round that called tools and wrote no text left no trace of the calls, so the next round read the result as if the person had pasted it; after an approved gated call the agent said it had made no call. Each round that calls tools now records an assistant turn naming each tool (`Called <tool>.`, never its arguments) before the results (ADR 1119, #5905). A replay fork of a run recorded before this release may call the model live from that agent's second tool round on; it can change the reply's text, never repeat a side effect.
- A turn that runs out of tool rounds mid-plan ends `tool_rounds_exhausted` instead of passing the model's preamble off as a reply (ADR 0975 D6, CC-CHAT-1, #5806). Any identical repeat of a read since the last write is answered from the earlier result, so two reads called in turn no longer use up the rounds (CC-AGENT-3, #5885).
- A rejected gate's decision record in chat reads Rejected, not Approved (CC-CHAT-2, #5809). The chat review strip drops a card once its gate is resolved anywhere; its buttons used to stay live and answer 409 (CC-CHAT-3, #5830). An agent opened with `?agent=` becomes a member of the conversation, so it is still there when the conversation reopens (CC-CHAT-4, #5831).
- `chatCompletion` never sends a request with no user turn: the system prompt becomes the user turn, and with neither it fails `invalid_inputs`. 19 shipped chains were affected; the market-intel digests now pass their topic through (CC-CHAIN-6, CC-CHAIN-3, #5822). An HTTP fetch with no URL fails with a typed `INVALID_URL` (CC-CHAIN-2, #5823).
- An approval gate shows the drafted deliverable, not a stray scalar such as "ItemsKey: emails"; gates already pending keep their stored data (CC-UI-3, #5824).
- Text cut through an emoji (a lone UTF-16 surrogate) no longer fails Postgres `jsonb` writes for run events, run inputs and metadata, annotations or vector metadata (CC-SEARCH-1, #5825, #5833).
- The run page shows a timer wait with its resume time, and a walkthrough step with a link to Guided walkthroughs, instead of "can't be shown here" (CC-UI-2, #5829).
- The builder no longer labels a pack node's undeclared outputs "Missing output" (CC-BLD-1, #5861).
- A wide table scrolls inside its own region, which keyboard users can focus and its caption names; every `DataTable` has a caption (#5863, #5865).
- `Notice` puts its dismiss control after the message and shows one status icon (CC-UI-1, #5795). Button and badge contrast holds under a light brand accent; at 380 px `/inbox` no longer scrolls sideways, and small close and remove controls have 24 px tap targets (#5845, #5851, #5859).
- The Campaign Intel budget planner gives a partial last week its share by days, not a full week's (CC-PERF-1, #5794).
- CMS public lists: Safari VoiceOver announces all 30 as lists, engines without alt-text CSS show the counter digits, and a hero flow can't drop below two steps (#5758). After ADR 1105: pressed pickers show on the accent band, the dateCalc preview follows edits, and a target margin of 100% or more explains itself (#5790).

### Security

- **A client's runs are read only by that client's people (ADR 1121, #5929 item 1, #5931 and #5935).** `runs:read` held in one client org used to read every client's runs in the workspace. A run stamped with a client org now needs the scope in that org, checked live, unless the caller holds a tenant-level grant. A refused run reads as `run_not_found` and drops out of lists. This also covers the workforce dashboards, trace search and agent-eval promote/history.
- Change requests (campaign-ops) and queued suggester text (team ledger) record their author and are erased with that person (ADR 0464 §9, CHAN-F19, #5940 and #5898).
- Notebook runs act for the person who started them, with the route's own access (ADR 1103, NBK92-1, #5768). A run with no person reads only org-visible notebooks and writes nothing, so a run can no longer read or write another org's notebooks. A node that writes nothing now fails with a code instead of reporting success.
- CRM sender-health bounce dedup rows (`crm:sender-health-seen`) were keyed by the raw email address and never expired. New rows are keyed by a hash of the address and age out after 2 days, and subject erasure deletes both key shapes (ADR 0464 §9, CHAN-F19, #5889). No migration.
- The legacy bearer-id rewrite (`OPENWOP_LEGACY_BEARER_REWRITE=apply`) no longer touches the hash-chained `cdp:audit-chain` log, which an earlier `apply` would have broken for `verifyChain`; its report logs `valueCount` unmasked (ADR 1045 CHAN-F14, #5761). Run `report` again before `apply`.

#### Upgrading from 0.13.0

- **No required stop; rolling-safe.** `node scripts/upgrade-plan.mjs 0.13.0`
  gives one step. One schema migration adds a partial index on `notifications`
  (sqlite 53 / postgres 51); no new app migration.
- **Inbox clean-up runs once on its own.** The first boot after the upgrade
  runs the background job `retire-conversation-requests`: open idle-chat
  "Input needed" items become read and "No longer waiting". It does not gate
  readiness, archives and deletes nothing, and a re-run changes nothing.
- **Deploy the backend before the frontend.** The SPA reads the new paged
  product and order responses and the new Inbox fields.
- **Private projects:** non-member editors lose access to a private project and
  its documents. Before upgrading, add as members anyone who still needs one.
- **Models:** a stored setting or agent pinning `gemini-2.5-flash`,
  `gemini-2.5-pro`, `gemini-3.5-flash` or `gemini-3.7-flash` needs a model that
  is still in the catalog.
- **Legacy env-key ids:** if you have not run the rewrite, set
  `OPENWOP_LEGACY_BEARER_REWRITE=report`, read the `legacy_bearer_rewrite` log
  line, then `apply`. Run `report` again first if you ran `apply` before this
  release.
- **Client-scoped runs:** a member who reads runs only through one client org
  no longer sees other clients' runs. Grant tenant admin to anyone who still
  needs every client's runs.
- **Asset access:** `OPENWOP_ASSET_ACCESS` is `off` by default. `report` logs
  what `enforce` would refuse; leave `enforce` until the public-grant phases ship.
- **New settings:** `OPENWOP_COMMERCE_MAX_PRODUCTS_PER_ORG` (default 5000, up to
  500000) and `OPENWOP_COMMERCE_INDEX_SWEEP_MS` (default 60000). Optional:
  `OPENWOP_CMS_OVERLAY_REALIGN=report`, then `apply`, repairs CMS translations
  saved before ADR 1112. The two new flags stay off unless set. Unset is fine
  for all of them.
- **API callers:**
  - campaign tools answer a plan refusal `not_entitled`;
  - a turn that runs out of rounds is an error, not a reply;
  - `POST /runs` may answer `400 bound_param_conflict`;
  - `from-chain` answers 410 for a retired alias;
  - a private notebook's podcast episode routes answer a non-member 404;
  - product and order lists are paged (`cursor`, `limit`, `nextCursor`).
- **Adopter code:** rename `registerCollaborationOrgGate` to
  `registerDefaultCollaborationSurface`. A fork of `index.html` takes the
  `{{BRAND_FONTS_PRECONNECT}}` slot. A brand rule styling `<select>` with
  `background` or `padding` shorthands should use the longhands.
- **Replay:** a fork of a run recorded before this release may call the model
  live from an agent's second tool round on.
- Back up the database before upgrading. After the upgrade, check that
  `/readiness` reports `version: 0.14.0`.

## [0.13.0] — 2026-11-11

A MINOR release under ADR 0052. It adds a public trial entry, unlisted
(quote-only) products, project health and read tools, a per-channel relay kill
switch, WhatsApp settings inside Connections, and three CMS sections and nav
options. It tightens who may write creative briefs, alt text, job-search
authority objects and WhatsApp sends, makes tool approvals cover one exact call
by default, and fixes WhatsApp double sends, knowledge-sync passes, crawlable
`/docs`, a BYOK run-default bug and knowledge-base replaces. There is no schema change and no new app
migration; schema stays at sqlite 52 / postgres 50 and app migrations at 26.
It is rolling-safe. **Two new settings:** `OPENWOP_CHANNEL_APPROVAL_TTL_MIN`
(default 1440, i.e. 24 hours) and `OPENWOP_INTEGRITY_GAUGES` (on unless
`false`). **Hosting changes:** `firebase.json` gains
`/docs` and `/docs/**` rewrites to the backend; see "Upgrading from 0.12.0".

### Added

- **Public trial entry (ADR 1097).** `/start-trial?plan=<pro|team|enterprise>`
  or `?bundle=<id>` (optional `&cadence=year`) signs the visitor in and sends
  them into the existing Stripe trial checkout. A new read,
  `GET …/billing/trial-offer`, has checkout's gates (billing toggle, then
  billing-manage) and never calls Stripe. No new env var, Stripe config or
  webhook (#5732).
- **Unlisted (quote-only) products (ADR 1098).** `Product.unlisted: true` hides
  a product from the public store, checkout, UCP, the ad catalog feed,
  discovery and recommendations. Funnel offers, campaign product links and ad
  variant sets refuse it with `400 product_unlisted`. Quotes and operator lanes
  keep it. Absent means listed (#5743).
- **Project health, read tools, portfolio and tab roles (ADRs 1091–1095).**
  `registerProjectHealthProvider`, `GET /projects/:id/health`,
  `GET /projects/portfolio`, memory proposals an agent can raise and a person
  approves on the Memory tab, the `openwop:projects.get`,
  `openwop:projects.knowledge.search`, `openwop:projects.portfolio` and
  `openwop:projects.memory.propose` tools (allowlisted for the chief-of-staff
  assistant), and `ProjectTab.forRoles` (#5728).
- **Relay channel kill switch (ADR 1043, CHAN-F11).** A workspace admin can
  switch WhatsApp, Signal, iMessage or Discord relay off without revoking
  devices. `GET …/messaging/relay/channels` (any member) and
  `PUT …/messaging/relay/channels/:channel` (admin; `403 relay_admin_required`).
  While off, inbound is dropped, the pull returns `paused: 'channel_disabled'`
  and enqueue is refused with `409 relay_channel_disabled` (#5725).
- **WhatsApp settings inside Connections (ADR 1053 D10).** Attestation,
  connected numbers and recent delivery failures, at
  `/access?tab=connections&view=whatsapp`, shown when the `whatsapp` toggle is
  on (#5749, #5750).
- **Revoke approvals; channel asks expire (CHAN-F17).**
  `DELETE …/conversation-tools/sessions/:id/approvals/:toolName?resolvedAt=…`
  revokes a given approval (`409 approval_changed` / `409 no_approval`). A
  pending or approved-but-unused approval from a messaging channel expires
  after `OPENWOP_CHANNEL_APPROVAL_TTL_MIN` minutes (default 1440); deciding it
  after that returns `409 approval_expired`. In-app asks do not expire (#5744).
- **CMS (ADR 1049, ADR 1069, ADR 1082).** A `resources` site-nav group (the
  auto Blog entry moves there only when a published page uses it) (#5735);
  named tier lists with status pills on plan cards (#5736); authored, price-less
  `pricing.plans` (up to 8) that skip the billing fetch (#5742); and a `films`
  section, a filterable gallery of click-to-play films with `VideoObject`
  JSON-LD (#5737).
- **Creative Director reads a brief (ADR 1039 P3).** A new
  `openwop:creative-briefs.get` tool, "Ask the Creative Director" on a brief's
  page (a deep link into the one chat), and readable version diffs (#5535).
- **A2A 1.0 push configs (ADR 1045 D6, CHAN-F7).** A 1.0 registration gets a
  1.0 `StreamResponse` body as `application/a2a+json`, and
  `Get`/`List`/`DeleteTaskPushNotificationConfig` are served. 0.3
  registrations are unchanged (#5726).

- **Daily integrity gauges (ADR 1104).** Once per UTC day, under one lease,
  the retention tick runs each feature's read-only data gauge and logs one
  `integrity_gauge` line of counts (CMS overlay and hero-flow probes, tutorial
  seed staleness). A failing gauge logs `integrity_gauge_failed` and the rest
  still run. `OPENWOP_INTEGRITY_GAUGES=false` turns it off (#5759).
- **Conformance suite 2.46.44.** The vendored schemas and fixtures move to
  `@openwop/openwop-conformance` 2.46.44 (RFC 0258 bounded loopback, RFC 0259
  `interrupt.resolved.resolvedVia`). The loopback fixtures are not advertised
  yet (#5757).

### Changed

- **Tool approvals (ADR 0834 FW2-D1, CHAN-F2).** An approval now covers the
  exact call shown, once (`grain: 'call'`, the default). "Allow for this
  conversation" (`grain: 'conversation'`) is a separate, in-app-only choice;
  asking for it on a channel request returns `400 grain_not_allowed`.
  Approvals given before this release read as conversation-wide in-app and are
  asked again on a channel turn (#5734).
- **Capability firewall (ADR 0135, CHAN-F16).**
  `openwop:core.openwop.http.fetch` is classified `read` / `safe-fetch` instead
  of the risky fallback. A tenant rule keyed on `host-mediated` egress no longer
  fires on it; one keyed on `safe-fetch` now does. Safe mode still asks for it
  by name (#5731).
- **WhatsApp (ADR 1053).** A message is paid for once (a concurrent duplicate
  fails `send_in_flight`); the send uses the bound connection's credential;
  delivery status comes only from verified provider callbacks; inbound is
  replay-proof, and START applies only through an org or workspace
  connection. `send` needs `workspace:write`. WhatsApp settings routes answer
  only at the workspace root (`404 not_workspace_root` otherwise). New reads:
  `…/whatsapp/orgs/:orgId/connections` and `…/delivery-failures` (admins).
  Verified provider ingest for a connection with an enabled WhatsApp inbound
  config no longer spends the per-IP write budget. Every WhatsApp store now
  ages out (#5746).
- **Knowledge sync (ADR 1101).** A pause made during a pass survives it, every
  call pins the bound connection, and org-shared connections are refused for
  new sources. **Removing a source now deletes the documents it synced**
  (resumable, `202` batches, honours legal hold). A pass whose person lost
  write on the org pauses (`creator-no-access`). The chain pack is `internal`
  (#5752).
- **Creative briefs (ADR 1039).** Surface writes need `workspace:write`.
  `POST …/reel` picks a Replicate key before creating a run and returns
  `422 credential_required` without one. The cap is checked before the paid
  call and the aspect ratio reaches the provider (#5532). `deleteBrief` owns
  every cascade; a failed child cascade now returns an error and keeps the
  brief, where it used to return `204`. A DSAR eraser re-attributes brief rows
  (#5533).
- **Accessibility (ADR 1100).** `generateAltText` needs `workspace:write`. A
  CMS picture with an empty alt takes the media library's description; the
  checker looks at every image placement and warns (does not block) on a
  file-name alt. The Accessibility Reviewer gets read tools, and the alt-text
  node is side-effectful, so a replay fork does not pay again (#5748).
- **Job search (ADR 1036).** A campaign pass acts for one person, deal ids and
  steering are per person, attestations and grants are revoked only by their
  issuer or subject, a grant unit is spent before the send, and subject erasure
  deletes the person's application deals (#5526).
- **Funnels (ADR 1023).** Revenue counts only paid orders, conversion is
  cohort-based and cannot pass 100%, bad offers are refused before any draft,
  and `PATCH` accepts `expectedUpdatedAt`. `funnels.generate` refuses
  `provider`/`model` with `400 invalid_params` (#5453).
- **Insights & Drafting (ADR 1102).** The recognition draft is checked and
  approved, with its text shown at the gate, before it reaches the mailbox. A
  talent review keeps only the subject's HR rows (`core.workday.query` with
  `requireWorkerId` refuses a missing id with `worker_id_required`). The suite's
  acting identity and schedule come from the caller, not the request body
  (#5754).
- **Docs KB (ADR 1057 P1).** Removal of a withdrawn page is no longer gated by
  the `docs` toggle, and chat citations for the site org
  (`OPENWOP_PUBLIC_SITE_ORG_ID`) carry a `/docs/<slug>` URL (#5580).

### Fixed

- A run started without `configurable.ai.credentialRef` uses the workspace
  BYOK binding's key, instead of failing its AI step with `byok_required`. This
  hit schedules, events, agent-offered chains and campaign stages (#5769).
- `/docs` and `/docs/:slug` serve crawlers a prerender, a `301` or a real
  `404`, the sitemap lists docs, and case and trailing-slash variants share one
  canonical URL (ADR 1057 P2) (#5581).
- A replace on a subject-bound knowledge collection no longer loses the prior
  document when the new one is refused or fails; media-collection ingest
  forwards its caller (#5771).
- The docs KB backfill route reaches the system site's docs for a superadmin,
  instead of answering `404 Organization not found` (ADR 1057) (#5767).
- The hero underline sits under the baseline, clear of the next line (#5740).
- Tests, grade waves, steward docs and CI tooling changed internally and are not
  itemized.

#### Upgrading from 0.12.0

- **No required stop; rolling-safe.** `node scripts/upgrade-plan.mjs 0.12.0`
  gives one step. No schema change and no new app migration.
- **Deploy the backend before the frontend.** Several SPA changes read new
  backend fields and codes.
- **Hosting:** if you keep your own `firebase.json`, add the `/docs` and
  `/docs/**` rewrites to the backend service. After the deploy, `/docs` shares
  `/`'s brief stale-shell window.
- **New settings:** `OPENWOP_CHANNEL_APPROVAL_TTL_MIN` (minutes, default 1440)
  sets how long a channel tool approval stays usable. `OPENWOP_INTEGRITY_GAUGES`
  runs the daily data gauges; set `false` to turn them off. Unset is fine for
  both.
- **Tool approvals** are now one call by default; existing approvals are asked
  again on channel turns.
- **Capability firewall rules** keyed on `host-mediated` egress no longer match
  `openwop:core.openwop.http.fetch`; rekey them on `safe-fetch` if you relied on
  that.
- **Knowledge sync:** removing a source deletes its synced documents.
  Org-shared connections are refused for new sources.
- **WhatsApp:** address settings routes at the workspace root. A send through
  another member's personal Twilio connection now fails `wa_not_connected`.
- **Creative briefs and alt text** writes need `workspace:write`; reels need a
  stored Replicate key.
- **API callers:** `funnels.generate` refuses `provider`/`model`, and a funnel
  offer, campaign link or ad variant set naming an unlisted product gets
  `400 product_unlisted`.
- **Optional:** a superadmin's `POST …/docs/orgs/<site org>/backfill` adds headings and
  `/docs` URLs to docs indexed before this release. It is not run at boot.
- Back up the database before upgrading. After the upgrade, check that
  `/readiness` reports `version: 0.13.0`.

## [0.12.0] — 2026-11-10

A MINOR release under ADR 0052. It adds public-site style tokens for white-label
sites, a seam for features to add project tabs and an Operations delivery panel.
It tightens who may write CDP events, merchandising rules and paid video, and
fixes channel races and the CMS. There is no schema change and no new app
migration; schema stays at sqlite 52 / postgres 50 and app migrations at 26.
It is rolling-safe. **One setting changes meaning:** `OPENWOP_MEDIA_DAILY_VIDEO_JOBS=0`
now disables paid video instead of lifting the cap; see "Upgrading from 0.11.0".

### Added

- **Public-site style tokens (ADR 1096).** The CMS site's surfaces read `--site-*`
  tokens an adopter sets in `brand.css`: content width, section spacing, card
  surfaces, media corners and the hero photo fade. Unset, the stock look is
  unchanged. The tokens are documented in `WHITE-LABEL.md` §2 (#5715).
- **Feature project tabs (ADR 1090).** A first-party or adopter feature can add a
  tab to the project detail page through `FrontendFeature.projectTabs`, with
  `?tab=<key>` deep links (#5721).
- **Operations: Kanban delivery (ADR 1081).** A superadmin-only delivery panel
  and summary built on a durable Kanban work-item projection (#5727).
- **Legacy env-key id rewrite (ADR 1045, CHAN-F14).** A one-time background job
  rewrites stored `bearer:<8>` ids to the id the same key presents today. It is
  off unless `OPENWOP_LEGACY_BEARER_REWRITE` is `report` (counts only) or
  `apply` (#5724).
- A `openwop.tutorials.stale_seed_served` metric (#5717).

### Changed

- **CDP collect (ADR 1024 P3).** `POST /cdp/collect`, `/collect/batch` and
  `/collect/import` need `workspace:write` (a Viewer could write before), and
  registering an event schema needs `host:org:manage`. Event types starting
  `funnel.`, `kicktodo.` or `forms.` are refused over HTTP with
  `422 reserved_event_type`. An identified event needs consent for its stated
  purpose (#5576).
- **Creative video (ADR 1051).** Generating video needs `workspace:write`, a
  person behind the run and `OPENWOP_CREATIVE_VIDEO_ENABLED` not `false`. The
  Runway contract is current (host, model, ratio, duration, CloudFront results),
  the daily cap is reserved before submit and defaults to 10 units, avatar
  likeness consent is recorded, and a retried submit is not paid twice (#5556).
- **Merchandising (ADR 1025).** Writes need `workspace:write`. An agent's rule
  lands as a proposal, rules can be edited, activated and paused, and a
  denominated promotion with no currency applies to no order (the console offers
  a fix). Write nodes are side-effecting, so a replay fork does not repeat them
  (#5469).
- **Document editor (ADR 1055).** The document schema is closed, DOCX import is
  budgeted by counting inflated bytes (shared with Slides), and the AI rewrite
  runs without tools (#5579).
- **Channels (ADR 1042, ADR 1043).** Approvals are claimed per turn so two
  instances cannot both spend one, a failed detached turn retries twice, and
  narrow channel turns get eleven reviewed read tools (#5722). Near-miss
  spellings of the untrusted-content fence are defanged, and undelivered relay
  egress older than 30 days is deleted (#5719).
- Tutorials serve the shipped text over a stale, un-customized workspace copy
  (#5712).
- Film captions are on by default (#5590).

### Fixed

- A public page's 404 is `no-store`, so a page is visible as soon as it is
  published instead of after the CDN's 10 minutes (#5720).
- Timeline badges are legible in dark bands (#5730), and the footer lockup
  follows the light/dark switch (#5711).
- The BYOK wizard no longer takes focus when it mounts in a development build
  (#5704).
- Tests, grade waves, steward docs and CI tooling changed internally and are not
  itemized.

#### Upgrading from 0.11.0

- **No required stop; rolling-safe.** `node scripts/upgrade-plan.mjs 0.11.0`
  gives one step. No schema change and no new app migration.
- **`OPENWOP_MEDIA_DAILY_VIDEO_JOBS` changes meaning.** Unset now means a
  default of 10 units per org per day (was 50). `0` now **disables** paid video
  (it used to mean uncapped); set `unlimited` for no cap.
- **CDP API callers** need `workspace:write` to collect, `host:org:manage` to
  register a schema, consent for identified events, and must not send the
  reserved `funnel.` / `kicktodo.` / `forms.` event types over HTTP.
- **Merchandising and creative video** writes need `workspace:write`. Check any
  promotion with an amount but no currency; it now applies to no order.
- **Optional:** set `OPENWOP_LEGACY_BEARER_REWRITE=report`, read the
  `legacy_bearer_rewrite` counts, then `apply` to retire legacy env-key ids.
- **White-label sites** can now set `--site-*` tokens in `brand.css`; the shipped
  `brand.css` is unchanged, so brand-seam hashes do not move.
- Back up the database before upgrading. After the upgrade, check that
  `/readiness` reports `version: 0.12.0`.

## [0.11.0] — 2026-11-09

A MINOR release under ADR 0052. KickTodo leaves openwop-app: its feature
packages, packs and chains are removed, and the new adopter feature seam is how a
downstream ships its own features. It adds channels into the main chat, SKILL.md
import, animated films, designed custom-domain pages and a large set of CMS
section options. Runs whose every final step was skipped now complete. It closes
several cross-tenant and cross-client paths in A2A, connections, ads and BYOK.
There is one schema migration (sqlite 51 → 52, postgres 49 → 50, an index) and
two app migrations (24 → 26). **This release is not rolling-safe** when the
dealers partner portal is in use; see "Upgrading from 0.10.0".

### Added

- **Adopter feature seam (ADR 1031, ADR 1048).** A white-label downstream
  registers its own feature packages from `src/adopter/features/<id>/` in the
  backend and frontend, and its pack pins from `src/adopter/packPins.ts`.
  `gen-adopter-features` writes the gitignored composition modules at build,
  test and dev time. A duplicate feature id, an id that does not match its
  directory, or an adopter re-pin of an upstream pack fails at boot. Features
  can declare daemons, demo seeders, dashboard tiles, review renderers, nav
  groups, approval kinds, KB namespaces and managed sources, and projected
  compute nodes. Adopter packs are attested in `packs/.adopter-manifest.json`
  under a new `adopter` trust tier, and any violation rejects the whole file.
  With no adopter directories, upstream composition is unchanged (#5495, #5502,
  #5547, #5550).
- **Channels into chat (ADR 1041, ADR 1042, ADR 1043).** Messages from
  connected Telegram, Discord, Slack and WhatsApp accounts, and from a user's
  own devices through the messaging relay, land in the paired owner's main-chat
  conversation, and replies go back to the chat they came from. Unknown senders
  are recorded as pending and never answered. Channel turns run in `safe`
  permission mode, so side-effect tools wait for the owner's in-app approval.
  Relay peers are approved per device by the device's owner. A "Chat channels"
  tab in the Access console manages connections, senders and relay devices.
  The device relay gets tenant-checked activation, rotating device tokens,
  presence and owner-or-admin revoke. A per-connection and per-device inbound
  limit defaults to 600/min (`OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN`).
  Everything is behind the `channel-ingress` toggle, which stays **off** by
  default (#5543, #5558, #5567, #5573).
- **SKILL.md import (ADR 1044).** A workspace owner or admin can preview and
  import an Anthropic / agentskills.io or OpenClaw SKILL.md (text, a folder map
  or a zip) as an unverified, tenant-owned `user.<name>` agent. Nothing in an
  import is run; scripts, shell and file tools and known lure patterns are
  refused, and install must send back the previewed `sourceSha256`. API only
  for now. The `marketplace.skill-import` sub-toggle stays **off** by default
  (#5530).
- **Agent packs from proposals (ADR 1033 P2, RFC 0253).** A reviewed proposal
  can install an agent pack per tenant. Its agents register as tenant-owned
  agents with the same limits as a member-authored agent, and a tenant chain's
  sub-chain refs resolve in the same installed pack or at an exact pinned
  version (#5516).
- **Animated films (ADR 1075).** A shared HTML film platform: a validated film
  timeline with grouped cues, keyboard control and reduced motion, private
  presenter notes and timer, and a paired audience view. Create one from
  Documents. The `films` toggle stays **off** by default (#5677).
- **Designed pages on custom domains (ADR 1030).** A bound custom domain can
  serve a styled page instead of the unstyled prerender, and use one of the
  workspace's own brands (a Site brand card on the domains page). The
  `custom-domains.designed-pages` sub-toggle stays **off** by default (#5484,
  #5486).
- **CMS sections and the public site.** New optional section fields; a section
  that sets none renders as before:
  - scroll motion per section and a brand motion preset in Appearance (ADR 1029,
    #5481, #5482, #5483), and a wider motion vocabulary: hero emphasis, count-up
    stats, progress fills, slide and zoom motions, and a `flow` process visual
    (ADR 1038, #5524, #5553, #5555, #5582). Only cards that are links lift on
    hover (#5582);
  - canvas layouts: a film pair, a framed screenshot, bento inset cards and
    try-it switches (ADR 1032, #5507); pictures and highlights on columns items
    (ADR 1037, #5523); feature cards and a hub hero (ADR 1047, #5536, #5650);
    seven illustrated hero visuals (ADR 1060, #5584);
  - grouped site navigation and a branded grouped footer from per-page
    `siteNav` (ADR 1049, ADR 1056, #5551, #5574), set through the API for now;
  - layouts and pieces for the public-site redesign (ADR 1062–1074, #5598,
    #5601, #5602, #5605, #5606, #5608, #5611, #5637, #5656, #5657, #5659, #5660,
    #5661, #5663, #5665, #5666, #5670, #5671, #5674, #5676, #5680, #5682), and
    "partly there" and "Not yet" states in columns lists (#5597, #5599);
  - design-led sections (ADR 1080, #5707): `statusTable`, `dateCalc`,
    `conversation`, `featureIndex`, `decisionTree` and `scheduleSim`, a live and
    what-if decision simulator. Also hero `placement` (band, card, panel) and a
    `queue` visual, a richText card and start side, gallery bleed and per-card
    tags, a 16-column cap, and a form card photo and `submitLabel`.
- **Forms.** A field can be marked `payment`, `health` or `credential`, which
  keeps the page out of session recording (ADR 0951 D2, #5501).
- **Campaign Ops.** Agency admins can register an existing organization as a
  client (#5629).
- **Embedded chat (ADR 1040).** An `EmbeddedChatPanel` can persist and reopen
  its conversation and is stamped with its agent, and the sessions list takes
  `?agentId=` (#5537). Features can register their own conversation focus
  kinds, authorized at bind and on every tool read (#5538).

### Changed

- **A run whose every final step was skipped completes (RFC 0257, ADR 1027).**
  0.10.0 failed these runs as `all_terminals_skipped`. They now end `completed`
  with `run.completed.skippedTerminals`, are not dead-lettered, send no failure
  notification and no longer fail a sub-workflow parent. A run with a failed
  node still fails. Chat and run detail show "Completed: no final step ran"
  (#5466, #5492, #5500).
- **Keyless workspaces run workflow AI steps on the managed tier** when the
  host's managed tier is ready, instead of failing `byok_required`. A
  structured-output step there now fails `host_capability_missing` (ADR 0903,
  #5477).
- **A streamed model reply that ends without its finish reason is a retryable
  `provider_unavailable` failure** (`reason: stream_incomplete`), not a complete
  reply. The OpenAI-compatible black-box lane only warns (ADR 1026, #5465).
- Three public reads (`docs`, consent posture, billing entitlements) answer
  `200` with an empty value when the feature is off, instead of `404` (#5493).
- Hosted media (`mp4`, `webm`, `vtt`, `m4a`, `mp3`) is cached for an hour and
  served with range support, so videos can seek (#5514).
- A production frontend build behind the `sign-in` gate refuses to build
  without its three `VITE_FIREBASE_*` variables (#5651).
- Signed-out visitors to several bare paths on a sign-in-gated deployment are
  forwarded to the published `/p/<slug>` page (#5648).
- The conformance pin moves to suite 2.46.42 (#5492, #5516).
- **Business intelligence (ADR 1052).** The metric catalog is per org. A stale
  metric (removed or retyped field, removed option, deleted type) is refused
  with `422 metric_stale` instead of returning a number, and capped, undated
  or truncated results say so. Edits are versioned (`409` on a stale
  `expectedUpdatedAt`). Metrics from 0.10.0 stay listed and read-only in every
  org until a manager adopts them into one (#5570).
- CAD `get-design` answers `validation_error` instead of `not_found` when the
  caller can no longer read the focused canvas (#5538).
- In an adopter repo, the default-distribution budget build measures host code
  only; the adopter's named-distribution build is still budgeted (#5703).

### Removed

- **KickTodo (ADR 1031 P3).** The `kicktodo*` and `challenge-outline` feature
  packages, `feature.kicktodo.nodes`, `vendor.openwop-app.kicktodo.agents`, the
  `kicktodo-*` chain examples and `distributions/kicktodo.json` are removed from
  openwop-app. KickTodo now ships them from its own `src/adopter/features/`.
  With them, openwop-app no longer reads `OPENWOP_CALENDAR_MCP_ENABLED`,
  `OPENWOP_CALENDAR_PROVIDER`, `OPENWOP_CALENDAR_PROVIDER_ENABLED`,
  `OPENWOP_CALENDAR_PROVIDER_ENDPOINT`, `OPENWOP_WEARABLE_PROVIDER_ENABLED`,
  `OPENWOP_WEARABLE_STALE_HOURS` or `OPENWOP_KICKTODO_VERIFIER_SAMPLING_ENABLED`
  (#5512).
- The four A2A workflow stubs (`publishAgentCard`, `emitStatus`,
  `emitArtifact`, `pushSend`) are withdrawn. Their pack nodes fail with
  `host_capability_missing`, and card routes serve only the host card (ADR 1045,
  #5531).

### Fixed

- **Sales ops (ADR 1034).** Commissions are computed in integer minor units and
  a deal pays at most once per plan. The dealer-approval and model-activation
  workflow nodes submit a review card instead of deciding. Active-model quota,
  territory and rule writes need `host:territories:manage`. Partner links are
  hashed at rest, expire after 180 days, can be revoked and stop working for a
  suspended dealer. App migrations 25 and 26 re-key the stored partner tokens
  and the geocode cache. All four features stay off by default (#5518).
- **Campaign Studio.** Approvals stay tied to their versions and stale
  finalization is refused, budgets use the currency's minor units, and client
  bindings, scopes and context survive reloads. A stored AI key can be chosen
  at launch. An event-triggered journey starts only for an event about its own
  client (#5562, #5609, #5610, #5612, #5613, #5622, #5623, #5624, #5626, #5628,
  #5636, #5658, #5664, #5687). Embedded-font compilation is bounded (#5621).
- **Customer data platform (ADR 1024).** Destination sync needs
  `workspace:read`/`workspace:write`, drops records whose labels permit nothing,
  and sends only to its stored URL. Warehouse-load approvals are bound to a rows
  digest and can be decided from the inbox. A person's own state ends a journey
  through a named no-op step instead of failing the run (#5473). A DSAR now
  reaches contacts merged into the subject, and erasing after an unmerge no
  longer erases another contact's data (#5575).
- **Webinars (ADR 1054).** A Zoom webinar belongs to one client, surface writes
  need `workspace:write`, an unconfirmed registration push is queued and
  retried, and only tracked webinars are ingested (#5571).
- **Promotions (ADR 1025).** The loss budget is reserved with holds, so
  concurrent checkouts can no longer spend past it (#5470).
- **Approvals.** `/inbox` approves an email send against the review digest it
  shows, every surface disables Approve when the digest is missing, and
  `/approvals` redirects to `/inbox` (ADR 0905, #5504, #5513).
- **Sign-in.** The page reloads out of the anonymous shell after an in-page or
  redirect sign-in, the tenant handshake runs once, and `/` no longer hangs on
  its splash when the auth SDK never answers (#5488, #5521, #5603). The
  anonymous-to-user tenant fold reads only rows that mention the source tenant
  (ADR 0003, #5522).
- **Builder.** Parallel port edges no longer read as a cycle, optional template
  inputs may be omitted, source-output bindings and launch defaults persist, and
  a run launch can declare a saved AI key (#5616, #5617, #5618, #5619, #5620,
  #5672).
- **Chat.** Saved agent membership is restored after the catalog loads, role
  context shows beside participant names, submitted turns survive reply gaps,
  labelled stored keys are adopted in setup, and feature assistant controls stay
  in the viewport (#5614, #5630, #5675, #5685, #5688).
- **Custom domains and SEO.** Custom-domain pages name their own address in
  canonical, `og:url` and JSON-LD (#5525). VideoObject `uploadDate` is kept for
  a second film and emitted as a zoned datetime (#5604, #5648).
- **Agents and packs.** An agent revision is numbered from the stored record
  under concurrent edits (#5559), and an archive fetch never sweeps its own temp
  dir (#5560).
- Channel ingress works with PostgreSQL compound keys (#5631).
- Page and feed watch reports reach the inbox message (#5644).
- Also fixed: email template creation (#5686), per-user undo in the document
  editor (COLLAB-UNDO-1, #5689), stopped-stream recovery guidance and refresh
  warnings in runs (#5641, #5681), CRM report and KB organization switching
  (#5646, #5668), CMS empty-org reads and Hero autosave (#5662), mobile drawer
  focus (#5667), walkthrough and tutorial launch (#5639, #5642), example-data
  workspace binding (#5640), canvas zoom controls (#5638), funnel detail
  (#5627), the desktop runtime selftest (#5497), and public-site layout fixes
  (#5494, #5499, #5510, #5546, #5654).
- **Public site.** The Blog link shows only when the site has a published post,
  and a photo hero keeps its picture on phones (ADR 1080, #5707).
- **Channel ingress.** Erasing a thread's owner or a DM writer now also deletes
  the other writers' sender-thread index rows for the deleted thread (CHAN-F5,
  #5697).
- Tests, grade waves, steward docs, Tracegate (ADR 1028) and CI tooling,
  including remote-gate work behind `OPENWOP_REMOTE_GATE` (off by default,
  ADR 0863 D9), changed internally and are not itemized.

### Security

- **A2A server (ADR 1045).** Callers must be authenticated, the tenant comes
  from the principal, derived task ids are per tenant, a foreign task reads as
  missing, and each method takes its HTTP route's scope. Run-starting methods
  get a per-principal limit (`OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN`, default 60).
  MCP refusal audit rows use the resolved tenant (#5531). A2A push sends the
  registered credential, stores it sealed and never follows a redirect (#5552).
- **Operator env-key principal (ADR 1045).** The principal id is derived from
  a hash of the full key, not its first 8 characters, so two env keys that
  share a prefix are no longer one principal (#5593).
- **Connections (ADR 1035, CHAN-F1).** A credential for an instance-scoped
  provider (ServiceNow, Workday, NetSuite, Zendesk, Salesforce) is attached only
  to its connection's own instance (#5517). A client run's instance-scoped
  connector calls use only that client's connection (#5541). A member who left
  a shared or declared default workspace no longer has their connections used
  (#5649, #5679).
- **BYOK (ADR 0779).** A run can no longer name a system-owned credential ref,
  such as another user's `connection:` ref (#5515).
- **Ads (ADR 1022).** Budget, delivery and metrics calls check that the run's
  org owns the campaign, at the adapter seam (#5467, #5491, #5577).
- **Approval gates (ADR 0773, ADR 0582).** A pack node with `role: "gate"` is
  an approval gate for Builder Pair and the MCP campaign lane (#5549).
- **Replay (ADR 1048).** A pack node no build classified is held on a replay
  fork unless its manifest says it is pure (#5547).
- **Messaging delivery log (ADR 1043).** Rows older than
  `OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS` (default 7) are deleted hourly,
  and erasure and device revoke delete their rows (#5589). Relay activation now
  checks the caller's tenant and registration (#5567).

#### Upgrading from 0.10.0

- **No required stop; NOT rolling-safe.** `node scripts/upgrade-plan.mjs 0.10.0`
  gives one step, 0.10.0 → 0.11.0. A 0.10.0 instance looks up a partner-portal
  token by its raw value. After app migration 25, and for any token 0.11.0
  issues, partner links return `404` on 0.10.0 instances. **If the dealers
  partner portal is in use, stop every 0.10.0 instance before starting 0.11.0.**
  The geocode re-key only costs cache misses on an old instance.
- **Migrations run on boot.** Schema sqlite 51 → 52 and postgres 49 → 50 add an
  index on `messaging_delivery_log(at)` (ADR 1043). On Postgres the index build
  blocks writes to that one table while it runs. App migrations 24 → 26:
  25 `rekey-partner-tokens-hashed` stores each partner token as
  `ptokh:<sha256>` with a 180-day expiry, and existing links keep working until
  then; 26 `rekey-geocode-cache` re-keys the sales-maps geocode cache. Both are
  idempotent and safe when two instances run them at once (ADR 1034).
- **KickTodo adopters.** The KickTodo packages, packs, chains and
  `distributions/kicktodo.json` are gone from this tree. In the same sync that
  takes 0.11.0, adopt the KickTodo packages under your own
  `src/adopter/features/`, pin your packs in `src/adopter/packPins.ts`, and
  generate `packs/.adopter-manifest.json`
  (`node scripts/gen-steward-manifest.mjs --adopter`). Without the manifest,
  the KickTodo packs are refused at boot. openwop-app no longer reads the
  calendar, wearable and verifier env vars listed under Removed; they belonged
  to the KickTodo packages and move with them.
- **The delivery log is pruned.** On the first hourly sweep, delivery-log rows
  older than 7 days are deleted. To keep them for now, set
  `OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS` to a large value before upgrading.
- **Env-key principals change once.** Old delegations, run actors and
  scheduled jobs keep working through a legacy rule, unless two configured keys
  share the old 8-character prefix. Owner and member rows recorded under the old
  id stop matching, the same as a key rotation.
- **Instance-scoped connectors need a data source.** ServiceNow, Workday,
  NetSuite, Zendesk and Salesforce connections without one fail
  `connector_instance_unbound`; set the data source on the connection.
- **A2A clients** must authenticate and hold the matching scope (`runs:create`,
  `runs:read`, `runs:cancel` or `webhooks:manage`).
- **Runs whose every final step was skipped now complete.** Anything that
  counted `all_terminals_skipped` failures will see `completed` instead.
- **Sign-in-gated frontend builds** need `VITE_FIREBASE_*` set, or the build
  fails.
- **BI metrics** created on 0.10.0 are read-only until a manager adopts each one
  into an org (`POST …/metrics/:id/adopt`). No data migration runs.
- **Self-hosted Firebase front ends.** `firebase.json` adds rewrites for
  `/installed-packs` and `/installed-packs/**`. Like every rewrite, they name
  `openwop-app-backend`, so map them to your own service id as you did the
  others. The SPA catch-all now also excludes media (`mp4`, `webm`, `vtt`,
  `m4a`, `mp3`), which get their own cache headers (#5514). Merge both changes
  into a customised `firebase.json`.
- Back up the database (and object store) before upgrading. Expect a short
  migration window on first boot.
- No other configuration changes are required. New behaviour behind flags and
  toggles stays off unless noted above.
- After the upgrade, check that `/readiness` reports `version: 0.11.0`.

## [0.10.0] — 2026-11-02

A MINOR release under ADR 0052. It removes the AI Envelope from the host, adds
versioned agent deployments, and adds the model router, a public chat-widget
conversation lane, agent clarification questions and session replay. Run
admission now fails closed under `auth`, and model text can no longer become an
executed tool. It also fixes Campaign Studio's approval and org-ownership paths.
There are no schema or
app migrations: schema stays at sqlite 51 / postgres 49 and app migrations stay
at 24.

### Added

- **Agent deployments and versions (RFC 0082, ADR 1005, ADR 1014).** Each agent
  version has a deployment record with a lifecycle, channel pins, an eval gate
  and an operator promotion policy with a 202 approval. Prior agent-pack
  versions are kept and resolve as `agentId@version`, a pinned version is the
  version that runs, and user-written agents get revisions. The agent workspace
  gains a deployment console. Both flags default off: `OPENWOP_AGENT_DEPLOYMENT`
  and `OPENWOP_AGENT_VERSIONS` (#5399, #5415, #5417, #5444).
- **Model router (ADR 1016).** One routing config per workspace, decided for
  each chat message. A rule can only target a callable model (#5427).
- **Chat widget conversations (ADR 1018).** Visitor threads, operator
  conversations and an absolute embed snippet, with a ceiling of 100 visitor
  turns per session. The managed key answers widgets for superadmin tenants only
  (#5430, #5432, #5437).
- **Agent clarification questions (ADR 1001, ADR 1006).** An agent missing
  information only a person has asks through `openwop:ask-user` in a run, or
  `openwop:chat.ask-user` in chat, and shows one question card on both lanes.
  The `agent-clarification` and `agent-clarification-chat` toggles stay **off**
  by default (#5372, #5379, #5413).
- **Session replay (ADR 0951 P2).** A geometry-only recorder, audited playback,
  a 10% sample and retention, with consent generations that fence withdrawal.
  `analytics.session-replay` stays **off** by default (#5398).
- **Tenant site visitor runtime (ADR 1015).** Custom-domain pages can load one
  same-origin script behind the `custom-domains.visitor-runtime` sub-toggle,
  which stays **off** by default. This is what lets a customer site show the
  consent banner (#5438).
- **Chat.** A chat turn shows the artifacts its tools saved (ADR 1017, #5428), a
  new chat's AI title reaches the rail and other tabs (ADR 1019, #5433), and a
  reply says when the assistant saw only the most recent messages (ADR 1003,
  #5424).
- **Campaign Studio.** The brief, Strategist and Channel Generator explain a
  waiting or stale kernel and say what approving does (ADR 1020, #5434, #5436,
  #5447). Connectors show the last successful sync, and a failed sync says so
  (ADR 1022, #5449).
- **KickTodo.** A live operator can remove a participant, a participant can leave
  a challenge, and a participant's new chat opens on KickBot (ADR 0910, ADR 0975,
  #5408, #5420, #5426).
- Sign-in re-authenticates in place on `requires-recent-login`, then retries
  (#5392).

### Changed

- **Run admission is shared across instances and fails closed under `auth`
  (ADR 0987).** Concurrency is counted inside the run insert on every creation
  lane (#5388), and the per-minute and per-day run windows now live in the
  shared counter, so a deploy or a second instance no longer resets them
  (#5403). Under the strict profile (`OPENWOP_DEPLOY_POSTURE=auth`), the run
  windows and the monthly plan limit **fail closed**: when their counter cannot
  answer, a run start gets a `503` instead of being let through (#5391, #5403).
  The evaluation profiles keep failing open. The admission transaction also
  holds its lock for less time (#5402).
- **Operations shows run admission (ADR 0987 D6).** A superadmin panel on
  `/operations` lists each limit's cap, its failure posture, the refusals since
  the instance started, and the number of runs holding a concurrency slot
  (#5462).
- **Interrupt forms (ADR 1013, RFC 0255 §E).** Forms are raised under `data.form`
  and checked (#5442).
- **Context economy (ADR 1003).** Adds a stepped transcript window and a
  tool-loop conversation cache. All levers stay off by default (#5384, #5424).
- The conformance pin moves to suite 2.46.38.

### Removed

- **The AI Envelope (RFC 0255, ADR 1007).** The host no longer accepts model
  envelopes or runs the fenced `schema.request` loop. Capabilities drop
  `envelopes`, `supportedEnvelopes`, `limits.schemaRounds` and
  `limits.envelopesPerTurn`. The `vendor.myndhyve.ai` pack is deleted, so a
  stored workflow naming one of its nodes fails with `host_capability_missing`
  (#5414, #5416).
- `OPENWOP_A2UI_DELTA_TRANSPORT` and `OPENWOP_CAMPAIGN_FANOUT_PARALLEL` are no
  longer read.

### Fixed

- **Campaign Studio approvals (ADR 1020).** The orchestration reaches its
  channels, a kernel is saved only after its approval, and creative briefs are
  created only after approval (#5434, #5436, #5447).
- **Campaign org ownership (ADR 1022).** Sync, budget changes and attribution are
  scoped to the org, and every budget change checks caps (#5449).
- A run whose every terminal was condition-skipped now fails as
  `all_terminals_skipped` (#5443).
- Gallery copies of a chain with sub-chains now pass the parent's mapped inputs
  to each child. Children used to run with those inputs missing (ADR 1023 D2,
  #5452).
- Service-worker install can no longer stall on HTTP/2 (OFF-PROD-1, ADR 0873 D6,
  #5459).
- Custom domains rate-limit per client, so one scanner can't take a site offline.
  New per-IP limits apply to served requests (default 120/min), misses (60/min)
  and beacons (240/min) (ADR 0295, #5446).
- Date-only strings render as their calendar date in every zone (#5406), mobile
  tab labels fit at 320px (#5460), and `<Trans>` slots render (#5396).
- Two packs that routed the wrong way now route correctly:
  `marketing.ad-optimization` and `support.sentiment-escalation` (#5386).
- KickTodo: a live operator can decide their own publication on `/reviews`,
  circles clients call the mounted prefix, and a participant may chat with KickBot
  under enforcement (#5390, #5405, #5421).
- The email send-blocked banner names the providers from provider status, and
  SMTP failures log a closed-world class (ADR 0994, #5394, #5395).
- An in-flight duplicate chat exchange returns `409 conflict` (ADR 1001, #5383).
- CI tooling: remote-gate groundwork (ADR 0863 D9), batch and gate-age fixes, and
  the entry bundle budget now ignores chunk-hash noise (#5376, #5418, #5429, #5445,
  #5450, #5451, #5454, #5461).

### Security

- **OAuth seam (DV-SEC-1).** Authorize-start refuses a provider it did not
  create, so a signed-in caller can't re-point a built-in provider where the test
  seam is enabled (#5458).
- **Job-search apply grants (DG-SEC-1).** An apply grant is self-consent at both
  the route and the lookup (#5412).
- **Approvals over untrusted content (ADR 1009).** An approval in a run that read
  untrusted content is decided in the app (#5409).
- **Replay (ADR 1012).** Provider-executed search is suppressed at dispatch on a
  replay fork (#5409).
- **UI plugins (ADR 1021).** The plugin frame's egress is measured and tightened,
  and the app `frame-src` drops `https://*.firebaseapp.com` (#5440).
- **Model text never becomes an executed tool (ADR 1010, RFC 0256).** The inline
  tool-call parser is deleted, so an `<invoke>` block a model repeats from an
  email or a web page can't run. Tool calls now come only from the provider's
  structured field (#5464).
- **Tool-turn admission (ADR 1011 P1, RFC 0256).** A round cut off by the output
  limit runs no calls, gets one repair, then fails
  `envelope_truncation_unrecoverable`. A provider refusal fails `envelope_refusal`
  without a retry. Arguments that aren't a JSON object are refused, and arguments
  are validated before the approval, permission and firewall gates (#5464).
- **Erasure (ADR 1014 D8).** Erasing a person reaches the agent text they wrote.
  A revision a deployment pins during the erasure is kept, redacted (#5457,
  #5468).

#### Upgrading from 0.9.0

- **No required stop; rolling-safe.** `node scripts/upgrade-plan.mjs 0.9.0`
  gives one step, 0.9.0 → 0.10.0: back up the database (and object store); the
  schema permits 0.9.0 instances during the upgrade; remove the two env vars
  below; start 0.10.0 (sqlite 51 → 51, postgres 49 → 49, app 24 → 24, so no
  migrations run); check `/readiness`.
- **`auth` operators, including KickTodo and Book AI: run starts now fail closed.**
  If the shared counter store is unavailable, starting a run returns
  `503 service_unavailable` (`plan_run_limit_unavailable` for the monthly plan)
  rather than proceeding uncounted. This is intended: the limits are contractual
  under the strict profile. Watch the Operations panel's "window counter could
  not answer" line after upgrading; it should stay at 0.
- **Check for the removed pack.** Find stored workflows that use
  `vendor.myndhyve.ai` nodes before you upgrade. They fail with
  `host_capability_missing` afterwards.
- **Check for envelope clients.** Anything reading `envelopes`,
  `supportedEnvelopes`, `limits.schemaRounds` or `limits.envelopesPerTurn` from
  capabilities must stop. Unset `OPENWOP_A2UI_DELTA_TRANSPORT` and
  `OPENWOP_CAMPAIGN_FANOUT_PARALLEL`; both are now ignored.
- **Check custom-domain traffic.** If many visitors share one IP, raise
  `OPENWOP_CUSTOM_DOMAIN_IP_REQS_PER_MIN` (default 120).
- No other configuration changes are required. New behaviour behind flags and
  toggles stays off unless noted above.
- After the upgrade, check that `/readiness` reports `version: 0.10.0`.

## [0.9.0] — 2026-10-29

A MINOR release under ADR 0052. It adds tool-output compaction for child runs
(off by default), client-report review and whole-workspace Connections, along
with model-call replay coverage and fixes to how tool errors are fenced. There
are no schema or app migrations: schema stays at sqlite 51 / postgres 49 and app
migrations stay at 24.

### Added

- **Tool-output compaction: child runs and editing (ADR 0999).** A sub-workflow
  child run now keeps the compaction decision its root run fixed. The output of
  a workflow called as a tool is fenced before it reaches a model. Read-before-write
  tool outputs are never compacted, and the panel gains a lossy-compaction
  editor. The `tool-output-compaction` feature stays **off** by default (#5356).
- **Client reports go through review (ADR 0957 P1b).** Scheduled and on-demand
  client reports run through the compute → review → publish workflow chain. The
  client, the report definition and its version, and the calendar period are all
  fixed when the run starts. Publishing a report requires the computed snapshot's
  digest to match, an explicit approval, and the client's fixed policy. Reports
  are not sent to clients automatically (#5364).
- **Whole-workspace Connections (ADR 0994).** Admins can share a Connection with
  the whole workspace, for sends that have no acting user, such as approval
  notices and campaigns (#5368).

### Changed

- **Model calls replay from the invocation log (ADR 1002).** Managed-tier
  `callAI` calls and tool-calling rounds (managed and BYOK) are now recorded in
  the invocation log, the same way BYOK `callAI` already was. A replay fork is
  served from the log rather than making live, paid model calls. If the log has
  no matching entry, the replayed node fails (#5362).
- Provider error codes are read from the whole response body, not from the
  shortened message, so a quota error now reports its code (ADR 0945 P2, #5369).
- DEPLOY.md now states that production in-process WASI code execution needs
  `OPENWOP_CODE_EXEC_RUNTIME=wasi` (ADR 0995 D8, #5366).

### Fixed

- KickTodo Challenge Factory reviews no longer show raw JSON. The outline
  approval and the final result are shown as readable fields, the plan's
  alternatives are listed, and a submitted request reads as awaiting review, not
  as published (#5365).
- Client-report notices name the report, not the engine that produced it
  (ADR 0926 D1, #5364).
- The creative-fidelity judge no longer sends unbranded products to review for
  no reason. An attribute missing from both the source and the edited image
  (for example, no logo on either) now counts as `match`. `not_visible` now
  means the source has the attribute and the edit hides it, and an attribute
  added in the edit is a `mismatch` (ADR 0945 P2, #5375).
- CI tooling:
  - Tracegate now invalidates on changed, added or removed value imports, and
    rejects observations from interrupted runs.
  - Shutdown probes keep each boot's log, and serial mode now sequences the
    frontend lanes.
  - The release-bus INT self-test now passes when the gate runs it as a
    background job (#5360, #5361, #5363, #5367, #5371).

### Security

- **Tool errors are fenced by where they came from (ADR 1000, TOC2CD-11/14).**
  Every thrown tool error is fenced before it reaches a model, on every lane:
  the chat tool loop, the built-in executor, the realtime voice bridge and the
  provider dispatchers. A returned error from an untrusted tool is shown
  unfenced only when a host helper vouched for its message. The refusals of the
  nine default-on trusted tools are unchanged (#5358, #5359).
- **Replay egress guards (ADR 0531).** On replay forks, `workflows.compose-and-run`
  / `workflows.propose`, `ai.research.web` and native web search are all refused
  at the existing effect guard. A refused replay no longer leaves a stray draft
  behind, falls back to example data, or makes a live model call (#5373).

#### Upgrading from 0.8.0

- **No required stop; rolling-safe.** `node scripts/upgrade-plan.mjs 0.8.0`
  gives one step, 0.8.0 → 0.9.0: back up the database (and object store); the
  schema permits 0.8.0 instances during the upgrade; start 0.9.0 (sqlite
  51 → 51, postgres 49 → 49, app 24 → 24, so no migrations run); check
  `/readiness`.
- **No configuration changes are required.** `tool-output-compaction` stays
  off by default.
- After the upgrade, check that `/readiness` reports `version: 0.9.0`.

## [0.8.0] — 2026-10-28

A MINOR release under ADR 0052, including breaking startup requirements under
its pre-1.0 policy. Configure the two security decisions below before deploying
to an `auth` posture. This release adds schema migrations sqlite 51 / postgres
49 for durable run admission; app migrations remain at 24.

### Added

- **Durable run admission, first phase (ADR 0987).** Main and evaluation run
  creation count pending/running runs inside the storage transaction, preserving
  concurrency limits across instances and beyond the old 60-second window
  (#5327). Existing rows keep a null admission key and drain without counting
  toward the new cap. Other creation lanes and load qualification remain later
  phases; this is not complete coverage of every run-creation path.
- **Production security profile (ADR 0981).** Startup reports missing controls
  together; readiness reports `strict` or `evaluation`. A superadmin-only census
  reports callers the membership and MFA rules would refuse (#5262, #5265,
  #5272). Missing decisions now refuse an `auth` deployment before its build.
- **Durable host-event replay (ADR 0973, RFC 0250).** Replay uses the durable
  event log across instances. Legacy `Last-Event-ID` resumes from that log when
  the current process lacks the cursor (#5182, #5187, #5322). Failed appends
  retry, oversized events are retained as dead letters, and operators can
  inspect dead-letter counts without exposing event payloads (#5323).
- **Proposal operations and eval evidence.** RFC 0249 proposal operations
  (#5168, #5173), RFC 0244 eval counters and isolated memory (#5225, #5291),
  RFC 0251 regression-baseline selection (#5256), and RFC 0252 fixtures from
  recorded runs (#5261). Conformance is pinned to 2.46.33 (#5313).
- **Eval leaderboard and arena (ADR 0986).** Server-attributed results and
  run-bound, credential-bound comparisons replace client-supplied claims (#5282).
- **Chat and agent tools.** Per-workspace multi-tab chat with protected busy
  tabs (#5231, #5237), scoped agent knowledge (#5234), personal chat-memory
  extraction (#5250), and scheduled chats using the job's real state (#5270).
- **Campaign collaboration (ADR 0958).** Client approver grants, vendor asset
  intake, a ClamAV upload scanner, and collaborator erasure that anonymizes
  accepted files while respecting legal holds (#5268, #5276, #5303, #5309).
- **Funnels and experiments (ADRs 0948–0949).** Lead-magnet and tripwire
  blueprints, post-purchase offers, campaign-bound publishing, persisted step
  experiment pointers, and journey splits (#5255, #5293, #5296, #5307,
  #5254, #5253, #5257, #5288).
- **Managed tier selection (ADR 0990).** The site owner can select its provider
  and model in the managed-tier administration surface (#5285, #5305).
- **Creative fidelity judge check (ADR 0945 P2).** Workspace admins can test
  their chosen BYOK vision model against four synthetic product edits and see
  which changes it detected. The check uses the production judge, bounds provider
  calls and stops on provider failure (#5316). This does not certify a model's
  accuracy on the workspace's own product images. Provider failures now report a
  bounded diagnostic code (#5340).
- **Chat export and import (ADR 0992).** Exports preserve message roles and
  content, imports are visibly identified and cannot impersonate native system
  messages, and archive selection uses the current conversation's permissions
  (#5312).
- **Team prompt library (ADR 0993).** Workspace members can manage library
  entries; private entries remain owner-only, tenant templates survive restarts,
  and `/p-<slug>` inserts text into the invoking composer for review before sending
  (#5329). Portability exports and erasure respect private ownership.
- **Collaborator operations (ADR 0958).** The client Collaborators panel,
  activity review, expiration notices and archive-time suspension share the live
  grant rules (#5331–#5336, #5341, #5343). The collaboration feature remains
  behind its existing toggle; upgrading does not enable it.
- **Email routing and SES feedback (ADR 0994).** Operators can prefer separate
  providers for transactional and marketing messages. SES uses the existing SMTP
  Connection; signed SNS bounce/complaint notifications update suppression
  (#5339). Existing single-provider connections continue to work.
- **Bounded code execution (ADR 0995).** Workflow reviews show the submitted
  program and can complete their gate; sandbox memory, scratch space, output and
  concurrency have explicit limits, and execution reserves budget before running
  (#5346). Production WASI execution requires explicit operator opt-in.
- **Operator and CI tooling.** Upgrade planning, portable adopter-owned browser
  baselines, adaptive CI width, batch branches, Tracegate red-reader packets,
  and the advisory cross-machine release bus (#5185, #5279, #5326, #5181,
  #5214, #5274, #5295, #5302). Deploys, configuration updates and certification
  cuts now queue only when their configured targets overlap; waits are bounded
  and fail open, while gates and releases to different targets proceed (#5319).

### Fixed

- Vector/search workflow calls accept the published pack argument names before
  applying the reserved workflow namespace; canonical arguments take precedence
  and conflicting aliases are removed (#5354).
- CI tooling isolates its fixture processes, avoids accidental dependency installs
  from a progress banner, and reports advisory browser failures separately.
  Configured merge trains retain gate evidence for the exact candidate tree
  (#5292). Tracegate records import-time work separately in its boot shadow
  measurements (#5320). Live CI claims survive an unreadable process-start
  timestamp, and preflight fixtures use an isolated marker store. Tracegate
  checks global invalidations before per-file inputs (#5330).
- Merge trains reject PR heads that changed after gating. Required and advisory
  browser runs preserve separate failure artifacts, and deployment diagnostics
  distinguish historical job activity from measured revision drain (#5337, #5342).
- The desktop client uses Electron 45 and electron-builder 26.18 (#5183).
- Upgrade plans put required configuration before starting the new version,
  so operators can satisfy the startup checks before the backend boots.
- A malformed chat import returns `400 validation_error` instead of 500 (#5301).
- `/privacy` redirects to the brand's configured privacy policy (#5314).
- Stream and SPA run IDs use the run's tenant, preventing request-scope tenant
  mismatches (#5299, #5236). Node outputs containing NUL can be stored, and a
  starter-dispatch exception marks its run failed (#5300).
- KickTodo's operator can use the Challenge Author chat; Factory plans must
  cite evidence before building lessons (#5289, #5235).
- Public author bylines omit unidentified authors and the system site's byline
  uses the host operator (#5277, #5278).
- White-label deployment checks preserve the adopter's hosting target and
  branding defaults (#5224, #5238). The registry's connection-pack revisions
  are synchronized (#5241).

### Security

- **OpenSearch physical names.** Tenant and index segments use separate encoded
  components instead of lossy lowercase replacement, separating the previously
  colliding ASCII names and preserving the workflow boundary (#5355). Existing
  OpenSearch deployments need a reviewed rebuild; see the upgrade warning below.
- **Workflow storage isolation (ADR 0998).** Workflow nodes use a reserved `wf:`
  namespace for vector, search, NoSQL and blob storage. Host features cannot use
  that namespace, and workflows cannot address host-owned data through these
  surfaces (#5351). Existing workflow-written data needs an operator-reviewed
  transition; see the upgrade warning below.
- **Conversation search privacy (ADR 0997).** Search reads messages from the
  durable conversation store after checking current conversation visibility,
  then applies the same message projection as chat. It removes the derived
  tenant-wide search index and purges its legacy rows (#5349). Results identify
  when the bounded candidate scan was truncated; SQLite's case-insensitive
  matching remains limited to its native `LIKE` behavior.
- **Chat artifact visibility (ADR 0996).** Artifacts created by chat tools follow
  the originating conversation's current visibility. Outputs without a
  conversation are readable only by their bound user; anonymous outputs remain
  unreadable. Code results and interactive artifacts no longer inherit a wider
  workspace audience (#5347).
- **Prompt-template tenancy (ADR 0993).** User templates belong to one tenant
  and persist in storage; reads preserve existing `Vary` headers (#5324).
- **Superadmin MFA and enrollment.** A required second factor, QR enrollment,
  correct otpauth encoding, and a single-factor backup guard (#5158, #5156,
  #5157, #5159, #5171).
- Authorization, erasure and reference checks are tightened across campaign
  collaboration, agent memory, commerce account ownership and run approvals
  (#5248, #5234, #5255, #5090). The DSAR matcher covers the doubled legacy
  subject spelling (#5306).
- Dependency advisory fixes include body-parser, undici and Azure MSAL
  (#5164, #5165, #5192, #5233).

#### Upgrading from 0.7.x

- **No required stop; rolling-safe schema.** Back up the database before an
  upgrade. Schema sqlite 51 / postgres 49 adds a nullable `runs.admission_key`
  column and its `(admission_key, status)` index, without a backfill. App
  migrations remain at 24. A breaking configuration decision can be made before the
  deploy and does not require stopping on this version before later upgrades.
- **Plan the index build.** PostgreSQL's normal boot migration uses a plain
  `CREATE INDEX`, which blocks writes to `runs` while scanning it. Measure the
  table and active transactions first. For a large database, arrange the nullable
  column addition and a concurrent index build before starting the new binary;
  verify the index is valid, not merely present. Keep the schema-version marker
  managed by the migration runner. Measure old-revision drain before claiming
  fleet-wide admission behavior.
- **Preserve rollback consistency.** Follow the forward-only backup/recovery
  policy in RELEASES.md. Dropping the new column/index alone leaves schema
  51/49 recorded and prevents a subsequent boot from recreating them. Do not
  manually decrement the marker or run that incomplete rollback snippet.
- **Breaking startup requirements apply to `OPENWOP_DEPLOY_POSTURE=auth` and
  legacy `OPENWOP_AUTH_ENFORCE_BEARER=true`.** Cookie-per-visitor and
  bearer-shared deployments are unaffected. Only the exact value `true` counts.
- Set `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`, or explicitly accept the
  temporary risk with `OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION=true`.
- If `OPENWOP_SUPERADMIN_TENANTS` is set, require enrolled superadmins' MFA with
  `OPENWOP_SUPERADMIN_REQUIRE_MFA=true`, or explicitly accept the temporary
  risk with `OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA=true`. Enroll every listed
  superadmin and sign in with the factor before requiring it. Break-glass
  remains the recovery path.
- Set these plain environment flags **before deploying**; older releases
  ignore them. Preflight Gate 5c refuses a missing or unmeasurable decision.
  Use incremental `scripts/update-env.sh` updates to preserve other settings.
- To stage membership enforcement, deploy with the explicit override, allow
  real traffic, then read the superadmin
  `GET /host/openwop-app/operations/profile-census`. Grant the reported callers
  the roles they need before enabling enforcement and removing the override.
- **Postmark campaign stream:** marketing and unlabelled mail now uses
  Postmark's Broadcast stream (default `broadcast`). Confirm that stream exists
  on the connected server, or set `OPENWOP_POSTMARK_BROADCAST_STREAM` to its
  existing Broadcast stream name, before upgrading. Missing streams refuse with
  `email_stream_missing`; transactional mail remains on `outbound`. Purpose
  preferences use `OPENWOP_EMAIL_TRANSACTIONAL_PROVIDER` and
  `OPENWOP_EMAIL_MARKETING_PROVIDER`; unset preferences preserve the current
  default provider. No provider Connection is created automatically.
- **Production WASI is opt-in:** deployments that relied on the bundled runtime
  must explicitly select `OPENWOP_CODE_EXEC_RUNTIME=wasi` to retain it. Review
  instance memory and the documented concurrency/resource limits before enabling
  it; merely including the WASM asset no longer activates production execution.
- **Breaking workflow storage boundary (ADR 0998):** vector namespaces, search
  indexes, NoSQL datasources and blob keys used by workflow nodes now resolve
  under `wf:` internally. Node inputs and returned names remain unprefixed.
  Previously stored, unprefixed data is not automatically moved and is no longer
  accessible through those nodes. Before upgrading, inventory affected workflows
  and their data, back up the relevant stores, and arrange an operator-reviewed
  transition for data proven to belong to those workflows. Never bulk-copy host
  feature data into `wf:`: that would expose private data to workflow runs.
  Quiesce affected workflows during the transition; mixed old/new instances
  address different stores. The rolling-safe declaration above covers the schema,
  not this workflow data transition. Deployments without affected workflows need
  no data move. No migration command is supplied or run automatically.
- **Existing OpenSearch indexes require a rebuild (#5355).** This applies only
  when the search adapter is OpenSearch. The new binary uses different physical
  index names and does not read the old indexes. Inventory affected tenant/index
  pairs, back up their data and mapping/settings, and arrange a reviewed rebuild
  from authoritative tenant-scoped source data before switching traffic. Old
  physical indexes may contain data from multiple logical tenant/index pairs
  because of the previous naming collisions: do not copy an entire old index
  into one tenant without proving every document belongs there. Quiesce affected
  writers while transitioning and verify tenant isolation, counts and queries
  before resuming. Preserve backups and old indexes until the reviewed rollback
  window ends. Apply the workflow `wf:` transition as well where relevant. This
  release supplies no automatic data migration; the rolling-safe schema claim
  does not cover mixed-version OpenSearch reads and writes.
- After the upgrade, verify both deployed build stamps and `/readiness`
  reporting `version: "0.8.0"`.

## [0.7.0] — 2026-10-23

PRs since v0.6.0. No schema or app migrations, rolling-safe, no required stop.
A MINOR release under ADR 0052 §D1: it adds features (callAI attempt
accounting and retry policy, the operator-access panel and sweep, an animated
journey hero). It also carries two security fixes: a patched Node.js runtime and a
sub-workflow interrupt guard.

### Added

- **callAI attempt accounting and a per-call retry policy (ADR 0966, RFC 0248).**
  `ctx.callAI` reports every provider attempt it made (count, output tokens, usage
  completeness, whether a reply was replayed) and honours a per-call `retry`
  policy, capped (#5139). Advertised as `aiProviders.callAccounting` with the
  conformance suite pinned to 2.46.19 (#5142). Certified in production: major-2
  cut `f98d673d761f`, 468/0/11/372.
- **`OPENWOP_CONFORMANCE_CALLAI_FIXTURE` (ADR 0967).** An operator opt-in, off by
  default and ignored in the `auth` posture, that registers the one conformance
  node witnessing RFC 0248. Without it, the advertised behaviour is real but
  unwitnessed. Its mock scripts are scoped to the run, and a replay reads the
  recorded attempts (#5147).
- **Operator access for KickTodo (ADR 0910 P2–P3).** A boot and hourly
  operator-access sweep with a readiness check (#4995), and an Operator access
  panel with step-up re-authentication, MFA and a countdown (#4994).
- **CMS journey hero animation.** The journey visual draws in, days pop and one
  goal pulses; reduced motion is respected (#4993).

### Fixed

- **Secret redaction** keeps readable word slugs out of the opaque-blob rule, so
  public URLs (such as blog canonical URLs) are no longer replaced with a
  placeholder (#4992).
- An adopter bundle's default frontend build is budgeted without its
  `.env.production` (#5140).
- Tracegate's daemon re-runs its own misses alone and keeps its logs (#5138).

### Security

- **Node.js 22.23.4 base image.** The backend image's digest-pinned `node:22-slim`
  moves to the 2026-10-21 security release: CVE-2026-111497 (Brotli decoder
  out-of-bounds write), CVE-2026-105482 and CVE-2026-106069 (TLS/DNS hostname
  bypasses), four medium/low CVEs, and the CA store update for the compromised
  eMudhra intermediate (#5146).
- **Sub-workflow interrupts.** A child workflow's mirrored gate can no longer be
  resolved through the parent run (#5127).
- **Dependencies.** dompurify 3.4.17 (GHSA-cg2g-xh64-v4q7, critical; plus two
  more) (#5143); markdown-it denial of service (#5130).

#### Upgrading from 0.6.0

- **No required stop.** Schema (sqlite 50 / postgres 48) and app migrations (24)
  are unchanged, so a rolling deploy is safe.
- **Rebuild your image.** The Node.js fix only reaches you when the backend image
  is rebuilt from this release's `Dockerfile`. A running 0.6.0 image keeps the old
  base. If you build from your own base image, move it to Node 22.23.4 or later
  (or 24.22.1 / 26.12.1).
- **No breaking config.** `OPENWOP_CONFORMANCE_CALLAI_FIXTURE` is new and off by
  default. Leave it unset unless you publish conformance evidence.
- After the upgrade, `/readiness` reports `version: "0.7.0"`.

## [0.6.0] — 2026-10-20

PRs since v0.5.1. No schema or app migrations, rolling-safe, no required stop.
A MINOR release under ADR 0052 §D1: it adds features (campaign operations, ads
conversions, email approvals, per-deployment custom-domain edges, knowledge-base
retrieval). One setting was removed (see Upgrading).

### Added

- **Campaign operations, P0 (ADRs 0921–0927).** Client accounts, an asset
  registry and a CMS page adapter (#5015); change sets with version-bound
  approval, verified execution, an operator inbox and a demo agency (#5022).
- **A rate limit shared across instances for public token surfaces (ADR 0934
  P0).** Hashed keys in a compare-and-set fixed window (#5026).
- **Email approvals and versioned templates (ADR 0905).** Immutable template
  versions with history, diff and restore (#4922); an `email-campaign-send`
  approval kind and an email approval gate (#4928).
- **Ads (ADR 0907).** Account-wide metrics with conversions, a 7-day look-back
  and backfill (#4935); TikTok and LinkedIn metric readers, off until verified
  against a sandbox (#4936); Google conversion uploads and relay match quality
  (#4937); hourly conversions delivery, off by default, with consent re-checked
  at send (#4938).
- **Knowledge base retrieval (ADR 0904).** Fair cross-collection fusion,
  calibrated relevance and a retrieval eval (#4926); query-aware embeddings on
  BYOK providers (#4976); structure-preserving DOCX/PDF parsing with page
  numbers and chunker v3 (#4978).
- **Per-deployment custom-domain edge (ADR 0906).** An edge-certificate provider
  port and adapters with ordered release (#4930); edge lifecycle,
  notifications and an HTTPS UI (#4931); an operator script for the one-time
  edge (#4921); the adapter impersonates a dedicated service account (#4985).
- **System site profiles (ADR 0931).** A per-distribution site profile and
  optional seeds (#5000).
- **Ambient work graph (ADR 0930).** Patterns belong to the person who did the
  work (#5011).
- **Just-in-time kicktodo-operator activation (ADR 0910 P1)** with use-time
  expiry and audited self-approval (#4969).
- **CMS section styles (ADR 0920).** Tones, split heads, new column layouts,
  plan and chat visuals (#4968).
- `VITE_BRAND_PRIVACY_URL` for the app's Privacy links (#5003).
- `OPENWOP_RETENTION_SWEEP_DRY_RUN` previews the retention sweep (#5002).
- A build-time legacy cache purge for a replaced service worker (ADR 0873 D13,
  #4999).
- RFC 0245: a recorded tool error replays as an error; conformance pin 2.46.18
  (ADR 0929, #4989).

### Changed

- Pack pins live in one table and resolve lazily (ADR 0919, #4971); `createApp`
  resolves a pin only for a pack it installs (#4990).
- One GCP metadata-server client (#4977); the approvals separation-of-duties
  core moved to `host/approvalSelfCheck.ts` (#4941).
- The frontend ships react-router's production build (−433 B entry gzip, #5024).
- `bump-version` writes the lockfiles' root version, and the lockstep check
  reads it (#4988).

### Fixed

- **Custom domains fail closed on lookup errors**, with one canonical host and a
  leased sweep (ADR 0906 P0, #4919).
- **Ads:** API versions un-retired, TikTok conversions fixed, relay rows erased,
  sandbox harness (ADR 0907 P0/P1, #4920).
- **Proposals apply honestly (ADR 0938).** A transition table with CAS, apply
  bound to what the reviewer saw, and authorized reads. With no installer
  registered, every apply is refused rather than reported as installed (#5019).
- **Goals:** who may act on a goal, and what the judge may read (ADR 0908,
  #4939).
- The builder's workflow menu paints above other cards and is no longer clipped
  in list view (#5034).
- **Deleting your own account cancels its Stripe subscriptions first**, revokes
  what it delegated in other workspaces (API keys, CLI logins, pairings) and
  emits `host.users.user.erased`. If the cancel fails, nothing is deleted
  (503) (#5001).
- **A superadmin can decide reviews on the reserved system site.** That org has
  no members, so its content reviews were undecidable (403). Every real org
  still needs `host:members:manage` (ADR 0027, #5042).
- Call-to-action, form, product-grid and entity section headings carry the same
  anchor id as other headings, so in-page links to them work (#5045).

### Docs

- ADRs 0906 (decisions), 0921–0928, 0933–0934, 0938, 0939, 0940, and the
  Campaign Studio program (ADRs 0941–0962).

#### Upgrading from 0.5.1

- **Required stop:** no. No schema or app migrations (sqlite 50 / postgres 48,
  app 24, as 0.5.1). Back up, deploy, check `/readiness` reports
  `version: "0.6.0"`.
- **Removed:** `OPENWOP_PROPOSALS_ACTIVATION` (ADR 0938 D2). Its
  `approval-gate` value only ever minted orphan approvals. If you set it, it now
  has no effect; remove it.
- **New optional settings**, all off or unset by default:
  - `VITE_BRAND_PRIVACY_URL` (frontend build);
  - `OPENWOP_RETENTION_SWEEP_DRY_RUN`;
  - `OPENWOP_SYSTEM_SITE_PROFILE`, `OPENWOP_SYSTEM_SITE_SEEDS_DISABLED`;
  - the custom-domain edge: `OPENWOP_CUSTOM_DOMAIN_EDGE`,
    `OPENWOP_CUSTOM_DOMAIN_EDGE_PROJECT`, `OPENWOP_CUSTOM_DOMAIN_EDGE_SA`,
    `OPENWOP_CUSTOM_DOMAIN_EDGE_HOSTNAME`, `OPENWOP_CUSTOM_DOMAIN_CERT_MAP`,
    `OPENWOP_CUSTOM_DOMAIN_LB_IP`, `OPENWOP_CUSTOM_DOMAIN_EDGE_POLL_MS`
    (see ADR 0906);
  - ads: `OPENWOP_ADS_VERIFIED_READERS`, `OPENWOP_ADS_VERIFIED_SENDERS`, and the
    `OPENWOP_ADS_SANDBOX` / `OPENWOP_SANDBOX_*` harness (ADR 0907).

## [0.5.1] — 2026-10-18

Ten PRs since v0.5.0. No migrations, rolling-safe, no required stop, no breaking
config. **Versioning note:** this release carries new features, which ADR 0052
§D1 would make a MINOR bump (0.6.0); it is labelled 0.5.1 by the maintainer's
decision. Nothing in it changes a migration or a contract.

### Added

- **White-label adoption seams (ADR 0916).** Two brand tokens with unchanged
  defaults: `--rule-control` (a text field's border) and `--ink-muted-recess`
  (muted text on the recess fill), both lifted in More-contrast mode. A frontend
  feature may ship its own nav-label translations (`navMessages`, keys under its
  own id). The Keys page recognises a key pasted under the wrong vendor's card
  and offers to move it. The deploy scripts take `OPENWOP_DEPLOY_BRANCH`
  (default `main`) for a distribution whose release branch has another name.
- **Feature-surface requirements in the node catalog (ADR 0917).** A pack node
  may declare `x-requiresFeatureSurfaces`; the per-tenant node catalog marks it
  missing while that feature is off, so the palette stops offering what a run
  would refuse.
- **A declared entry share for white-label distributions (ADR 0874
  amendment).** `distributions/<name>.json` may declare `entryShareBytes`
  (gzip, at most 1024) with an `entryShareReason`; that distribution's entry
  budget is the host's 129 kB plus the share, reported separately. The default
  build keeps 129 kB.

### Changed

- **Chain expansion ids fold nested parameter values (ADR 0917).** Two
  expansions that differ only in a nested value no longer share an id. Ids for
  flat parameters are unchanged; stored workflows and their runs keep theirs.
- **Default workspaces are rooted in membership for authority (ADR 0910 P0).**
- The frontend CI lane enters Tracegate early (ADR 0918).

### Fixed

- **An email campaign sends the content it started with (ADR 0905 P0).** A send
  now pins the template's subject and body when it starts, so editing the
  template while the campaign is sending no longer changes the rest of that send;
  a resend re-pins. Deleting a template that a campaign not yet sent still
  references is refused with `409 template_in_use` (naming the campaigns).
- **Revoked v2 chain packs no longer load (ADR 0713 A-04).** The keyring's
  revocation list now applies to v2 chain packs as it did to v1; a zero-install
  boot names the error.
- **`check-wire-claims` fails closed** when it cannot build its expected
  document, instead of passing a 1.x host with the field missing.
- A webhook delivery test no longer collides on a port (WHD-19).

### Docs

- ADRs 0904–0907: the MyndHyve port slate (RAG, email approval, custom-domain
  certificates, ads).

#### Upgrading from 0.5.0

- **Required stop:** no. No schema or app migrations (sqlite 50 / postgres 48,
  app 24, as 0.5.0). Back up, deploy, check `/readiness` reports
  `version: "0.5.1"`.
- New optional settings: `OPENWOP_DEPLOY_BRANCH` (deploy scripts), and the
  distribution manifest keys `entryShareBytes` / `entryShareReason`.

## [0.5.0] — 2026-10-18

Eight days since v0.4.0 (255 merged PRs; ADRs up to 0915). Rolling-safe, no
required stop, no breaking config.

### Added

- **Turning a bundle on is a workspace action, and buying one turns it on (ADR 0892
  Phase B).** On the feature store, a workspace owner or admin can enable an
  entitled bundle for their own workspace, or turn it off, from the bundle's card.
  Enabling also turns on what the bundle depends on. It is refused when the plan
  does not cover the bundle (the card offers the purchase) or when the host has
  switched part of it off. A verified bundle purchase now turns the bundle on for
  the buyer's workspace. Before this, a buyer received an entitlement and the
  features stayed hidden. Global toggle state stays super-admin only.
- **No hard-coded AI vendor (ADR 0903).** A run's AI provider and model come from
  the run's own choice, then the workspace's AI setting, then the catalog default,
  fixed once at run start so replay stays deterministic. Feature packs and the
  bundled chain packs no longer default to Anthropic; `core.openwop.ai` 1.5.0 makes
  `provider`/`model` optional. A sub-workflow child inherits the parent's choice
  and the host's provider policy.
- **Provider failures say what they are, and structured output is native where
  the vendor supports it (ADR 0911, ADR 0912).** A rejected key, model or request
  fails at once with its own code; a rate limit is not retried a second time; a
  5xx or timeout backs off and retries, and a run that ends on one fails with
  that code instead of "did not emit valid JSON". Gemini calls ask for JSON with
  a response schema and OpenAI calls use `json_schema`; a retry names what was
  wrong; an unescaped quote is repaired when the result then parses; an
  unparsable reply leaves a short, scrubbed excerpt on the retry event. New knob:
  `OPENWOP_PROVIDER_RETRY_BACKOFF_MS` (default 1000, 0 disables).
- **Seams for white-label features (ADRs 0913–0915).** `from-chain` takes an
  optional `subject` label, and `eraseWorkflowSubject` deletes exactly that
  subject's workflows and their runs (through the workflow index, refusing under
  a legal hold). A feature can register a document kind that is deleted, not
  anonymized, on its owner's erasure. `baseVersionId: null` makes a document's
  first save a checked one. The Markdown editor takes a content `lang`; the EPUB
  and DOCX writers take `language`/`direction`, and DOCX images carry alt text. A
  backend feature can declare public paths strictly inside its own namespace.
- **Agent evaluations (ADR 0889).** `mode:"eval"` runs, an eval-suite store,
  RFC 0244 graders (trajectory, trials, regression, efficiency, output) and an
  Agent Evals tab with capture-to-case.
- **Approval and session authority (ADRs 0894, 0896).** Approvers approve what
  they saw, with one decider per approval and a per-approval expiry; sessions bind
  to their opener and org, and one-shot approvals are verified.
- **Commerce (ADRs 0877, 0890).** Checkout tax, promotion codes and no-card
  trials. A storefront takes live money only on the operator's own account or the
  tenant's own Stripe Connect account; every other tenant is demo.
- **Support desk (ADR 0878)**, per-slide comments (ADR 0886), comment mentions and
  edit-own (ADR 0881), the team-ledger GitHub check (ADR 0855), and the offline
  service-worker engine (ADR 0873).
- **Table storage conforms to its declared schema (ADR 0909, RFC 0228 G4)**, and
  streams are bounded server-side with readers resuming (ADR 0897).

### Changed

- **CRM is an opt-in bundle (ADR 0892).** The `crm` toggle now defaults **off**,
  so a fresh white-label install no longer shows the CRM group. Analytics stays
  on and its nav item moved to the Marketing group. Enable CRM in Admin → Feature
  toggles (globally or per workspace).
- **Strategy, Priority matrix and Advisory board are opt-in too (ADR 0892,
  superseding ADR 0229).** They now default **off**. Enable them in Admin →
  Feature toggles.
- **KicktoDo surfaces bind to the run's person (ADR 0901)**, and a coach turn can
  only create work for that person.
- The display face is Bricolage Grotesque (ADR 0883).

#### Upgrading from 0.4.0

- **Required stop:** no. Rolling-safe: back up, deploy, check `/readiness`
  reports `version: "0.5.0"`.
- **Schema migrations:** Postgres 48 / SQLite 50 delete webhook subscriptions
  registered under the retired OpenWOP major 1 (and their pending deliveries).
  Those already received nothing; delivered history stays.
- **App migration 23** (`grandfather-crm-on-for-existing-users`) keeps CRM **on**
  for an install that already uses it: it writes an enabled `crm` toggle row when
  none exists and the database has CRM contacts or an enabled CRM dependent
  (commerce, csm, email, territories, job-search, …). An install with a saved
  `crm` row, or with no CRM data, is unchanged.
- **App migration 24** (`grandfather-planning-on-for-existing-users`) does the same
  per feature for `strategy`, `priority-matrix` and `advisory-board`: an install with
  data for one of them and no saved row keeps that one on.
- New optional env: `OPENWOP_PROVIDER_RETRY_BACKOFF_MS`.

## [0.4.0] — 2026-10-10

One day since v0.3.0 (2026-10-09): 80 commits and four new architecture decision
records (ADRs 0869–0872). A MINOR release: new capabilities, no schema or app
migrations, no required stop, and nothing an operator must change.

#### Upgrading from 0.3.0

- **Required stop:** no (`releases.json`).
- **Migrations:** none. Postgres schema stays **47**, SQLite **49**, app
  migrations **22**.
- **Rolling-safe:** yes. A 0.3.0 process may share the database during a rolling
  deploy. Kanban cards a 0.3.0 process writes during the overlap are stamped with
  their tenant on the next hourly tick (ADR 0872). Take a backup first as usual.
- **New optional settings (ADR 0871), all with working defaults:**
  `OPENWOP_STORAGE_GROWTH_GAUGE` (`false` turns the hourly gauge off; on by
  default), `OPENWOP_SURFACE_ROW_TRIGGER` (default `100000` rows per tenant per
  family), `OPENWOP_VECTOR_NAMESPACE_TRIGGER` (default `50000` vectors per
  namespace), `OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS` (default `30000`) and
  `OPENWOP_VECTOR_QUERY_WARN_MS` (default `200`).
- **Discovery advertises `multiAgent` only when you switch it on.** It appears
  when `OPENWOP_MULTI_AGENT_EXECUTION_MODEL` is set, and its
  `executionModel.version` is the highest phase N with every
  `…_PHASE_2`..`…_PHASE_N` flag also set; with phase 1 off the block is absent.
  The `agents` family now carries `dispatch: true`. Check these flags if a client
  relies on the `multiAgent` block.
- **Image-mode deploys build no certification bundle** (ADR 0869). `deploy.sh`
  without `OPENWOP_CERT_BUNDLE_ORIGIN` no longer refuses to ship for want of a
  stamp; it still runs the major-2 ratchet. To serve evidence, set the origin and
  run `publish-evidence.sh`.
- **After upgrading:** `GET /readiness` → `200` and its `version` reads `0.4.0`.
  Within an hour, the logs carry `surface_rows_gauge` lines; about three hours
  after the first hourly tick, `tenant_index_verified collection=kanban:card`.

### Added

- **An hourly storage-growth gauge** (ADR 0871). Once per UTC hour, across all
  instances, the host logs `surface_rows_gauge` (per durable surface family:
  tenants, the largest tenant's rows, the total, tenants over the trigger) and,
  with pgvector, `vector_rows_gauge` (namespaces, the largest, the total, the
  pgvector version). No line carries a tenant id or a namespace. A pgvector
  query of 200 ms or more logs `vector_query_slow`, and the vector pool now has
  a 30 s `statement_timeout` (it had none). `scripts/measure-storage-growth.mjs`
  reads the lines back and reports each trigger as CLEAR, TRIGGERED or
  UNMEASURED.
- **Work-Twin portfolio cards say which workflows are demos** (ADR 0870). A
  workflow built on the demo AI node shows a "Demo" chip and a one-line
  explanation, and Run now is disabled, with the reason, on a deployment that
  cannot run it (sign-in posture). New non-normative route:
  `GET /host/openwop-app/workflows/availability?ids=…`. ADR 0870 also plans
  real-AI Work-Twin workflows; those decisions are still Proposed.
- **Approved sends check Google permissions first.** An approved email or
  calendar action now checks that the approver's Google connection is present,
  current and allowed to write before it starts a run. If not, nothing runs and
  the notice gives numbered steps to reconnect with write access. A send Google
  refuses with `401`/`403` gives the same steps.

### Changed

- **Kanban card reads use a tenant index** (ADR 0872). Every card now records
  its board's tenant, and once the hourly check has verified the index, board
  views, the dashboard, "assigned to me" and card create/move read one tenant's
  cards instead of every card. Creating a card on a board that does not exist
  answers `kanban_board_not_found`. Cards whose board is gone are logged
  (`kanban_card_unstamped_orphans`), never deleted, and keep reads on the full
  scan.
- **Authorization reads use the members index** (ADR 0866 D4). Access checks
  read one tenant's members once the index is verified. A member the index lacks
  is confirmed against the full scan before any deny, self-approval exemption or
  demo-mode owner bypass, so the index can only say yes.
- **The 44 Work-Twin `tmpl.*` templates are a chain pack** (ADR 0775 P2a–c).
  They load from `vendor.openwop-app.workflows.work-twin-templates@1.0.0` under
  their original ids, byte-identical, so past runs replay unchanged. They stay
  hidden from `/builder` and the `/` picker. A host with
  `OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0` no longer has these ids.
- **`scripts/preflight-deploy.sh` refuses a deploy while a Cloud Run revision is
  tagged** (Gate 5b), and prints the `--remove-tags` command. `--allow-tagged`
  keeps a deliberate tag.
- **Image-mode `deploy.sh` builds no certification bundle** (ADR 0869); see
  Upgrading.
- **The desktop shell runs Electron 41** (was 39), closing the Electron
  advisories.

### Removed

- **The v1 discovery builder** (ADR 0812 P4). `/.well-known/openwop` serves only
  the v2 root, and the `Capabilities-Etag` header, which only the v1 response
  set, is gone. The in-tree `tmpl.*` workflow catalog is deleted (see Changed).

### Fixed

- **Attestation verification reported `discovery_drift` on every v2 host.** It
  re-digested the v1 document instead of the root actually served. The certify
  stamp also pointed at the retired `/v1` bundle path.
- v2 discovery advertises `scheduling` again (`cron`, `delayed`,
  `maxFutureHorizon: P366D`). It had been missing from the v2 root since v1
  retired, so the horizon the 0.3.0 notes announced was stated nowhere.
  `workspace` is still not advertised: it is missing a required event (ADR
  0858).
- v2 discovery advertises `multiAgent` again. `executionModel.version` is now
  the highest phase N with every phase 1..N switched on, so a gap in the phase
  flags caps the claim. v1 could claim 5 with phases 2 to 4 off. The verifier
  level (6) is not claimed. The escalation interrupt kind is `clarification`,
  which is what the host emits; v1 named an `x-host-…` kind it never sent. The
  phase-3 gate (getRunAncestry) now honours `…_PHASE_5`.
- v2 discovery advertises `agents.dispatch: true`. `core.dispatch` runs
  workers as child runs and never changes the parent's workflow graph. The v1
  fan-out descriptor has no v2 seat, so it is withheld.
- v2 discovery states `auth.subjectLinkKey` only when both the `saml` and
  `scim` lanes are advertised. A host with one lane forms no links, so it
  no longer claims a link key (spec-steward ruling 2026-10-10; matches v1).
- **Reconnecting a Google connection left a dead duplicate "Needs reconnecting"
  row.** A successful consent now retires the same person's inactive twin rows
  for that provider. An active twin is left alone.
- **A document that does not exist showed "Couldn't load" with a retry** instead
  of "not found". The page now reads the error's status.
- **In a collaborative document, one user's undo could undo another user's
  edits** (ADR 0335). The editor's own undo history is now actually off, so only
  the collaborative undo runs.
- **`npm run selftest` in `clients/desktop` hung** instead of exiting 0 or 1
  (a relative self-test directory). It now runs.

### Security

- **A refused registry pack deleted the good install it was replacing** (ADR
  0660 D3). The installer re-checked `pack.json` only after removing the old
  install and copying the new one, so a tampered tarball was refused with its
  files already on disk. The check now runs on the staged bytes first.
- **The three audit exceptions are closed, not renewed.** Knowledge-base PDF
  parsing uses the patched `pdfjs-dist` 6.2.108 instead of unpdf's vendored
  pdf.js (GHSA-hq66-cqwq-w95j). The SPA depends on `@firebase/app` and
  `@firebase/auth` directly, which drops Firestore's `@grpc/grpc-js`
  (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4). `scripts/audit-exceptions.json` is
  empty.
- **Dependency updates close 17 of 20 open backend and frontend Dependabot
  alerts** (lockfile only, every bump within its existing range): `fast-uri`,
  `markdown-it`, `moment`, `source-map-js`, `mammoth`, `brace-expansion`,
  `browserslist` and others. Three stay open: `vitest`/`@vitest/mocker`
  (dev-only) and `katex` (low; the bundled copies are pinned by `mermaid` and
  the math plugins).

## [0.3.0] — 2026-10-09

Two weeks since v0.2.0 (2026-09-27): 1,549 commits and **108 architecture decision
records (ADRs 0759–0867)**, each in `docs/adr/`. The headline: **OpenWOP v1 is
retired** — this host now speaks only the v2 protocol. `0.x` caveat applies: this
MINOR bump carries breaking changes (listed under **Upgrading**), as SemVer §4
permits before 1.0.

#### Upgrading from 0.2.0

- **Required stop:** no (`releases.json`). There is no intermediate version.
- **Migrations (replay forward on boot, no manual step):** Postgres schema
  **46 → 47**, SQLite **48 → 49** (one nullable `invocation_log.presented_key`
  column, no backfill, no table rewrite), app migrations **21 → 22** (a no-op
  marker; its cleanup runs in the background after the server listens and records
  `app_bg_job:internal-seed-retract` = `done`).
- **Rolling-safe:** the schema changes are additive, so a 0.2.0 process may share
  the upgraded database during a rolling deploy. Take a backup first as usual.
- **Breaking — OpenWOP v1 is removed (ADR 0669, ADR 0812).** Discovery advertises
  only `protocolVersions ["2.0"]`; every `/v1/*` request (WebSocket upgrades
  included) answers `410`, public read twins answer a bodiless `308` to their
  unversioned address, and a `1.x` client is refused with `426`.
  `OPENWOP_V1_RETIRED` no longer exists — there is no switch to serve v1 again.
  Move every integration (SDKs, webhook subscribers, scripts, the CDP collection
  snippet) to the unversioned v2 paths before upgrading. Stored run links and
  asset addresses keep working.
- **Breaking — chain packs must pin nodes exactly (ADR 0766).**
  - **Operator-supplied chain packs** (`OPENWOP_WORKFLOW_CHAIN_PACKS_DIR`, or a
    registry-installed chain pack) that reference nodes without an exact version now
    fail to load. Run `( cd backend/typescript && npm run chains:pin -- --write )`
    against your packs (or pin by hand as `typeId@x.y.z`), then bump each pack and
    each changed chain one patch. Watch `checks.chainPacks.refused` on `/readiness`.
  - Packs you publish to a registry for this host must be signed for the **v2
    tree** (`ed25519-canonical-json`) with `engines` admitting `<3.0.0`.
- **Trusted proxies (ADR 0851):** if a load balancer or CDN with a public address
  (other than Google's front end) sits in front of the backend, set
  `OPENWOP_TRUSTED_PROXY_CIDRS` to its ranges, or every user shares one rate-limit
  bucket.
- **SAML deployments (ADR 0815):** after the bootstrap org, only an `owner` of an
  existing org in the shared SAML tenant can create orgs — grant `owner` before
  upgrading if others need to.
- **Public-site analytics consent (ADR 0860):** with no geo header configured every
  visitor is asked before analytics counts; set `OPENWOP_GEO_COUNTRY_HEADER` behind
  an edge that overwrites it to default "on" outside regulated regions.
- **Scale-out hosts (ADR 0867):** a host running more than one instance (Cloud Run
  and similar are detected; `OPENWOP_INSTANCE_TOPOLOGY` overrides) no longer
  advertises a storage family backed by process memory, and logs
  `storage_families_withheld_process_local`. Select a shared backend
  (`OPENWOP_SURFACE_BACKEND=durable` on Postgres Storage, `OPENWOP_SURFACE_VECTOR=pgvector`,
  `OPENWOP_SURFACE_BLOB=gcs|s3`); a selected engine must pass its boot check or the
  process exits.
- **Defaults that moved:** `builder-pair` is ON (the Create-with-AI drawer is gone);
  the managed free tier is 150,000 tokens per member per day unless
  `OPENWOP_MANAGED_DAILY_TOKEN_CAP` is set; major-2 host-event webhooks use the
  `openwop-app.<feature>.<entity>-<verb>` spelling (RFC 0236 delivery stays behind
  `OPENWOP_HOST_EVENTS_V2`, default off).
- **After upgrading:** `GET /readiness` → `200`, its `version` reads `0.3.0`, and
  `checks.chainPacks.refused` / `checks.registryPacks.failed` are empty.

### Removed
- **OpenWOP major 1 (ADR 0812 P3c).** The served-v1 shim, the `/v1` route
  registrations' rewrite path, the v1 deprecation headers and the
  `OPENWOP_V1_RETIRED` switch are gone; `/v1/*` answers `410` and the ADR 0806 public
  twins `308`. The SPA reads discovery at major 2 only and no longer depends on
  `@openwop/openwop-v1`.

### Added

- **Visitors choose analytics on the public site** (ADR 0860). The front page, docs and funnel pages now ask visitors in the EEA, the UK and California, and any visitor whose region is unknown, before counting anything, with "Accept analytics" and "Reject analytics" side by side. Everywhere else analytics is on by default, and a "Privacy choices" control in the footer turns it off. The choice is recorded on the existing public consent lane. **Upgrading:** with no geo header configured, every visitor's region is unknown, so everyone is asked — including on a tenant whose consent policy says opt-out. To default to "on" outside regulated regions, put an edge that overwrites a country header in front and set `OPENWOP_GEO_COUNTRY_HEADER` (see `.env.example`).
- **The visitor key is stored only after consent** (ADR 0860). The public pages used to write `owp:vk` to the browser on every visit. The key is now written only when the visitor's choice (or their region's default) allows it, is removed when they refuse or withdraw, and is per site (`owp:vk:<orgId>`). The old key is deleted.
- **Workspace settings say that feature usage is counted** (ADR 0860). The Privacy panel now states that the product counts which features members use, in aggregate.

- **CMS prose blocks** (ADR 0813). A `richText` section now renders `### ` subheadings, `- ` and `1. ` lists, and `> ` quotes, in the app and in the crawler HTML. Plain paragraphs render as before, and there is still no raw-HTML path.
- **Blog post settings in the CMS editor** (ADR 0813). Mark a page as a blog post, set its category, and set yourself as the byline. The page routes accept `authorId: "me"`, resolved to the caller.
- **The launch blog post, as a draft** (ADR 0813). "10x Your Company = Your Team + AI Agents" is seeded on the system site with its two diagrams. It is never auto-published: finish its `[TODO]` markers and publish it from the CMS.
- **A Media library for the public site** (ADR 0817). A super admin can upload and pick images for the "Front page (public site)" scope, in the CMS editor's image picker and on the Media Library page. Before, that scope had no library, so changing a public-site image needed a code change.
- **Seeded updates after you edit** (ADR 0817). When the code that created a page has newer content but you have already edited or published the page, the update now appears in the page's History as a "Seeded update". Compare it, then Restore to use it. Your edits are never overwritten.
- Pack node entries may declare `"x-ports": "single"` (ADR 0782): the builder keeps one input port whatever the input schema's `required` says, so a schema can state its real contract without re-routing saved edges. The 17 `feature.kicktodo.nodes` input schemas get their `required` fields back (pack 1.30.3). The agent-orchestration nodes group under AI in the palette (`vendor.myndhyve.agent-orchestration` 1.0.3).
- `scripts/write-build-commit.mjs` stamps `build-meta/deployer.json` on the deploy path only (the checkout's directory name and a session slug: `OPENWOP_DEPLOY_SESSION`, else the agent's `CLAUDE_CODE_SESSION_ID`), so a production build can be traced to the session that made it. It ships in the source upload and the image, and is never served. The workflow-author model is told about single-port nodes, and `validate`/`persist` reject a `targetInput` edge into one.

- `/readiness` `checks.registryPacks` (boot-time registry install: attempted,
  installed, failed with a `code`, skipped with a reason, `bootAt`) and
  `checks.chainPacks` (chain packs loaded / refused). `scripts/verify-deploy.sh`
  fails a revision reporting either kind of failure; the named waivers are
  `--allow-registry-failures` and `--allow-chain-pack-failures`.
- A run whose definition pins a node version the host runs differently is
  stamped `metadata.nodePinMismatches` and logged `run_node_pin_mismatch`.
- A directly submitted workflow definition may pin nodes (`typeId@x.y.z`). The
  pin is kept in `metadata.nodePins`; ranges are refused.
- `scripts/check-registry-parity.sh` reports a **version collision**, a
  `name@version` already published with different content.

### Fixed

- **A form submit could attach a stranger's browsing to an existing contact** (ADR 0860). A submission whose email matched an existing contact linked the submitter's session to that contact, so anyone who typed Bob's email could add their page views to Bob's lead score. A submission now links its session only to a contact it created. A match to an existing contact adds one "Submitted the form" note to that contact's timeline per form per day. A signed email-click link still re-identifies an existing contact.

- **A new CMS section lost its selection a moment after it was added.** Its first save gives it a permanent id, and the editor now follows the section to it.
- **Publish or Submit dropped unsaved edits in the CMS.** A workflow action ran on the last saved version and then replaced the editor with it, so edits made since the last Save were lost without a warning. The editor now saves first, and stops if the save fails.
- **The CMS "Public" preview was blank in Chrome, and covered the editor.** A frame with no `src` finishes loading before React listens, so the preview never filled. Its hidden stage was also still shown on the Editor and Outline tabs, so the empty frame sat above the section editor. Both are fixed.
- **Prompt templates revalidate to `304`.** `GET /prompts/{templateId}` compared `If-None-Match` with a bare string match, so a `W/`-weakened echo from a compressing front door, or a list, answered `200`. It now uses the shared matcher the discovery and run routes use, and the `304` carries the `ETag`.

- **Blog posts are articles to crawlers** (ADR 0813). The prerendered post now has its title as `<h1>` and `Article` JSON-LD with `datePublished`. The public page read carries `kind` and `publishedAt` for posts.

- **Host events are v2-conformant on the wire** (ADR 0792). A major-2 webhook subscriber now receives `openwop-app.<feature>.<entity>-<verb>` (for example `openwop-app.crm.contact-created`) in place of `host.<feature>.<entity>.<verb>`, in the body `type`, both event-type headers and the `hostext:` run marker. Major-1 subscribers are unchanged. A subscription or host-event binding may use either spelling. The run event `host.webhook.response` now reads on major 2 as `openwop-app.webhook-response` (it returned `500`).

- **Upgrading no longer hangs at boot on the ADR 0789 seeded-workflow cleanup.**
  App migration 22 retracted stale seeded-workflow listings inside startup, and
  on a large install it outlasted the platform's startup probe, so the new
  revision never became ready. Migration 22 is now a no-op marker. The cleanup
  runs in the background once the server is listening, resumes where it stopped
  after a restart, and records `app_bg_job:internal-seed-retract` = `done` when
  it finishes. It also scans the scheduler once rather than once per row.

- **Builder: on a node with several input or output ports, each connection handle now sits beside its own port label** (it drifted up to a row away, which could wire an edge into the wrong input field). Single-port nodes are unchanged.

### Security

- **Per-IP rate limits could be bypassed by sending `X-Forwarded-For`** (ADR 0851, #4516). The limiter keyed on the leftmost entry, which the client writes, so a new header value per request got a new budget. The client address is now read from the right, skipping known proxy hops, at every place the app uses it: rate limits, SSE stream caps, break-glass login, analytics visitor hashing, and the e-signature audit record, which had recorded the front end's address instead of the signer's. **Upgrading:** if a load balancer or CDN with a public address sits in front of the backend (other than Google's front end), set `OPENWOP_TRUSTED_PROXY_CIDRS` to its ranges, or all users will share one rate-limit bucket.

- **Organizations: a sub-org is no longer a door to workspace authority, and removal takes down what the member delegated** (ADR 0815).
  - In a shared workspace, workspace-wide authority now comes from the member's workspace (root) membership only. A role in a sub-org is authority inside that sub-org.
  - Creating an org in a tenant shared by several people is owner-tier. Before this, any signed-in member could create a sub-org, become its owner, and manage the workspace.
  - Owner rows are judged per person: a group-derived owner, or an owner reached through a duplicate row, counts as an owner.
  - A member's identity can no longer be re-pointed in place.
  - Removing or demoting an admin cancels the invites they sent. Leaving a workspace pauses the schedules that ran as that person; resuming one re-owns it.
  - New host events: `host.orgs.member.added`, `host.orgs.member.roles-changed` and `host.orgs.member.removed`.

  **Operator action (SAML deployments):** every SAML user signs into ONE shared tenant (`OPENWOP_SAML_TENANT`, default `default`). The first org created there is still the bootstrap. After that, a user can create orgs only if they are an `owner` of an existing org in that tenant. Grant it from Organizations → Members ("Transfer ownership" or the `owner` role), or add the user to a group that carries `owner`.

  OIDC sign-in, the anonymous demo and personal workspaces are unaffected: each user has their own tenant there. No migration and no new env var.


### Changed
- **Pair Canvas is on by default** (ADR 0773 G-10e). The builder's AI pairing (ghost suggestions you keep or drop) replaces the Create-with-AI drawer, which is removed. Turn the `builder-pair` toggle off to hide AI pairing in the builder.
- **The managed free tier's default daily allowance is 150,000 tokens per member** (was 50,000, smaller than one Pair Canvas first draft). It is the free portion spent before plan credits and paid balance (ADR 0821), so operators who sell AI credits may want it lower. An explicit `OPENWOP_MANAGED_DAILY_TOKEN_CAP` still wins. On a login-free public demo, also set `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP`.

- **Edit sections right on the page** (ADR 0828). The CMS editor has Edit, Preview and Page tabs. On Edit, point at a section for its toolbar, click Edit to open it in place, drag its handle (or use the keyboard) to move it, and use "+" between sections to add one there. Page settings, History and experiments live on the Page tab. The side panels are gone.
- **A calmer CMS header** (ADR 0828). Publish (or Approve, for a page in review) is the one primary button, last in the row; "Check accessibility" and the assistant links move under More, and the in-place editor shows one card instead of two.
- **The CMS page editor is one screen** (ADR 0828). The section list, the live page and a settings panel sit side by side; selecting a section anywhere selects it everywhere. Drafts save themselves; a published page still saves only when you press Save. The Public, Outline and Editor views are gone.
- **Edit a page's address, search description and social image in the CMS** (ADR 0828). They sit on the editor's Page tab and save with the page. A published page's old address keeps redirecting.
- **Drag sections to reorder them, and undo** (ADR 0828). In the CMS section list, drag a section by its handle (or use the keyboard). Undo and Redo, or ⌘Z and ⇧⌘Z, step back and forward through your edits.
- **A visual section picker in the CMS** (ADR 0828). "Add section" shows every section type with a sketch of its layout and a line on what it is for. Filter by category or search; your shared sections are there too.
- **A checklist before you publish** (ADR 0828). Publish, Approve and Submit first show what still blocks the page (an empty title, a to-do left in the text), what is worth fixing (no author, description or social image, accessibility issues, untranslated sections) and what passed. "Show me" takes you to the spot.
- **Take single sections from History** (ADR 0828). Compare shows a past version, or a seeded update, beside your draft section by section; "Use this version" copies just that section into your draft, and Undo takes it back.
- **Rewrite a section with AI** (ADR 0828). On the CMS Section tab: Improve, Shorten, Expand, change the tone, fix spelling, or say what you want. You see the proposal beside the current text and apply it or discard it; links and images are never changed, and Undo takes it back.
- **Workflow-chain packs must pin every node reference exactly** (ADR 0766,
  RFC 0177 §E.1). The loader now REFUSES a chain whose node `typeId` (or
  compensation `nodeTypeId`) carries no version or a range. Every in-tree chain
  is pinned. `/readiness` reports refusals under `checks.chainPacks`.
- **Pack manifests are v2** (ADR 0767): `kind`, `engines` admitting major 2, an
  honest spec `category` with the palette group in `x-paletteCategory`, and node
  inputs as real schema files. Palette groups are unchanged except 62 nodes that
  previously fell to a default group.
- The template pre-flight and "Use template" name a node that is installed at a
  version other than the one the template pinned (`pinMismatches`), separately
  from a node that is not installed.

- **Schedules fire once, fenced in the job row, not a pruned claim** (ADR 0787).
  After winning a slot, the daemon re-reads the job and advances it by
  compare-and-swap, and only while the job is still enabled, still bound and
  still due at that exact slot. Consequences:
  - a pass that stalled past the claim prune fires nothing;
  - so does a job disabled, deleted or erased mid-pass;
  - each fire gets a deterministic run id per (tenant, job, slot), so a
    re-fired slot collapses to one run.
  Every job write is now a compare-and-swap, so a daemon write can no longer
  resurrect a deleted job or undo a disable or an erasure.
- **The scheduler door requires `workspace:write`** to create, edit, run or
  delete a schedule in a shared workspace. Viewers get `403`.
  - PATCH `metadata` merges, and can never set `actingUserId`.
  - Changing a job's `workflowId` makes it act as the person who changed it.
  - A feature-managed job cannot be retargeted there (`409`).
  - An erased job cannot be re-enabled (`409`).
- **Run now fires exactly what the schedule fires**: the job's inputs, its
  credentials and actor, and its feature gate. It never moves the next
  scheduled fire. When no run starts, the response carries `skipped: <reason>`.
- **`capabilities.scheduling.maxFutureHorizon` is now `P366D`** (was `P30D`),
  and the host honours it:
  - yearly, quarterly and 31st-of-month cadences fire;
  - an enabled schedule with an unparseable cron, an unknown time zone or no
    fire inside the horizon is refused with `400` (it used to be stored and
    never fire, or throw a `500`);
  - a cadence with no further slot records `lastSkipReason: 'no-next-fire'`.
- **Erasing a user also disables their schedules that carry their legacy
  `oidc:` principal.** This applies only in the user's home tenant, only when the
  principal comes from their own User row, and never when another User row there
  claims the same principal.
- **Schedules the old 30-day search stranded come back to life.** For example, a
  monthly `0 9 3 * *` whose next fire had been deleted. The daemon recomputes
  their next fire.
- `/readiness` for KickTodo lists `schedulerFleet`: every instance running the
  fenced daemon, with its Cloud Run revision and commit.

## [0.2.0] — 2026-09-27

The first versioned release since the inaugural `v0.1.0` (2026-06-30): three months
of work — 3,364 commits and **593 architecture decision records (ADRs 0172–0757)**,
each in `docs/adr/`. `0.x` caveat applies: this MINOR bump carries breaking changes
(listed under **Upgrading**), as SemVer §4 permits before 1.0.

### Highlights

The ADR titles, bucketed by keyword (approximate — an ADR is counted once, in the
first bucket its title matches; 161 fit no bucket):

- **OpenWOP v2 wire, RFC adoption & conformance** (~57 ADRs) — this host now speaks
  **both majors**: v2 identity (tenant-bound ids, the Subject as owner, the `ow2.`
  token scheme), the era key and codemap read path, the closed v2 snapshot, signed
  certification bundles published after every deploy, and host witnesses for
  RFCs 0199 (outbound OAuth client + credential interrupt), 0200/0201/0205/0206/
  0209/0210, 0173 (effect identity) and 0176 (persistence migration rows).
- **Workflows, chains, builder & execution** (~94) — chain packs and the builder
  gallery replace every in-tree built-in workflow; durable dispatch outbox, Layer-2
  effect ledger and atomic claim, replay/fork safety, webhook delivery isolation.
- **Agents, chat & AI exchange** (~47) — one embeddable chat, agent packs + node
  packs as the drivability pattern, standing roster, heartbeat/work loop, MCP + A2A.
- **Canvas, docs, slides & app builder** (~45) — shared canvas chassis with
  collaboration, slides, documents, drawings, app builder.
- **CRM, commerce, billing & marketing** (~97) — one content kernel, Stripe billing
  and Connect commerce, paid feature bundles, campaigns, CDP.
- **CMS, publishing & site** (~27), **Security, identity, orgs & BYOK** (~35),
  **Platform, deploy & operations** (~30).

The detailed entries below were recorded as the work landed (they cover the most
recent part of the window in depth; the ADRs are the complete record).

#### Upgrading from 0.1.0

- **Required stop:** no (`releases.json`). There is no intermediate version.
- **Migrations (replay forward on boot, no manual step):** Postgres schema
  **29 → 46**, SQLite **32 → 48**, app migrations **1 → 21**. All are forward-only;
  several are additive columns with no backfill.
- **Not rolling-safe — stop the 0.1.0 binary before starting 0.2.0.** Postgres
  migration 37 / SQLite 39 **renames** `invocation_log.provider_key` →
  `invocation_id`; a 0.1.0 process sharing the upgraded database fails on that
  table. Take a backup first; downtime is the boot-time migration window.
- **Breaking wire/config changes:**
  - **Webhook headers:** the pre-spec combined `openwop-signature: t=…,v1=…`
    encoding and the `openwop-subscription-id` header are **removed**. Verify with
    the `OpenWOP-*` (or `X-openwop-*`) family — same `${timestamp}.${rawBody}`
    recipe; the OpenWOP SDK helpers (TS 1.9.0 / Py 1.7.0 / Go v1.6.0) read both.
  - **Rate limiting split into two tiers (ADR 0640):**
    `OPENWOP_RATELIMIT_IP_REQS_PER_MIN` is now the **write** budget (default 60);
    reads use the new `OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN` (default 600, floored
    at the write budget, so an old raised value still lifts reads).
  - **Interrupt resume tokens change shape** (`ow2.hs256.<kid>.…`). Tokens issued
    by 0.1.0 keep resolving. Set **`OPENWOP_INTERRUPT_TOKEN_SECRET`** (new) — it
    falls back to a built-in value that is not a secret.
  - **`/v1` is unchanged for v1 clients.** v2 behaviour applies only to a request
    that negotiates `OpenWOP-Version: 2`.
- **After upgrading:** `GET /readiness` → `200` and its `version` reads `0.2.0`.

### Added
- **RFC 0209 — A2UI v0.9 surfaces at major 2 (ADR 0749).** The v2 root now advertises the envelope-kind catalog (`supportedEnvelopes` `["ui.a2ui-surface"]`, `schemaVersions` `{"ui.a2ui-surface": 2}`, `envelopeStrictness: warn`), printed from the same constant the new admission path enforces: the schema version selects ONE payload branch (never the union), the RFC's cross-field rules and the surface-fold guard are checked at record time, and an approval bound to a surface any untrusted envelope touched cannot be resolved (`untrusted_content_blocks_approval`). The `emitA2uiSurface` v2 seam drives it. The chat's A2UI card renders the ten-component v0.9 profile — and nothing of a surface until its fold holds `root` — beside the unchanged 0.9.1 renderer. No v2 `deltaTransport`. v1 unchanged.
- **v2 charter Phase 4 (P4-D) — v2 identity: the Subject is the owner, ids have a grammar, tokens have a scheme (ADR 0629).** Under **major 2 only**, `RunSnapshot.owner` is the closed `{ tenant, workspace?, subject }` block with `subject` REQUIRED and `principal`/`principalKind` removed (`spec/v2/core/identity.md` §1.1); `run.started` echoes the same block, projected by the same function so the two cannot disagree. A run this host recorded no principal for reads with the §1.2 legacy subject (`urn:openwop:legacy`) instead of omitting a required field, and the two v2 lanes (`session`, `anonymous`) are read back from the issuer the subject was attested under — a READ projection over the same persisted stamp, so nothing is re-minted and nothing is rewritten (migration row `openwop.migration.C3.4`).
- **RFC 0207 — the outbound trace carrier: this host's cross-host calls now continue the caller's trace.** An MCP request or A2A message this host sends carries the W3C trace context the RUN was created under, in BOTH carriers: `params._meta.traceparent` (MCP, unprefixed — the mapping `mcp-integration.md` §D names) and `Message.metadata.openwop.traceparent` (A2A), plus the HTTP `traceparent` header on each. Either carrier conforms alone; sending both satisfies the SHOULD. **The trace is read off the run row, not the ambient context** (`run.metadata.traceContext`, a new RESERVED key stamped host-side from the creating request's own header): a run is dispatched on `setImmediate` and, on the durable path, redelivered from the `dispatch_outbox` by a timer daemon with no request context at all, so an outbound call made mid-run cannot read the caller's trace any other way. Each outbound request gets a fresh CHILD span of it, so two concurrent calls stay distinguishable while joining one trace. Nothing is invented: a run started with no inbound `traceparent`, or with a malformed one, sends no carrier. **Correlation only — never read as tenant, principal or scope.** The §22 A2A and §23 MCP invoke seams thread the seam request's own `traceparent` for the same reason they drive the real clients.
- **The tenant-bound run id (`identity.md` §5, ADR 0629 Decision 1).** A major-2 caller sees `<tenantId>/<opaque>` and a `runId` whose tenant segment is not the caller's is refused with `403 id_tenant_mismatch` before the store is touched. **Run ids are NOT re-minted and no row is rewritten** — the store keeps the bare UUID and the `/v1` wire keeps returning it; the tenant-bound form is a reversible projection at the major-2 boundary (`host/v2Ids.ts`), applied by both JSON senders (`res.json` and `sendNegotiatedRunJson`, which bypasses it).
- **`Idempotency-Key` grammar (`idempotency.md` §Layer 1).** Under major 2 a key outside `^[A-Za-z0-9._~-]{22,128}$` is `400 idempotency_key_invalid`, refused before a claim is taken (the code MUST NOT be cached). The v1 wire's free-form key is untouched.
- **The `ow2.` resume-token scheme (`identity.md` §4, `interrupt.md` §Tokens).** Interrupt tokens are now minted as `ow2.hs256.<kid>.<payload>.<mac>`, with `kid` derived from `OPENWOP_INTERRUPT_TOKEN_SECRET` so a secret rotates without orphaning outstanding tokens. Under major 2 an unadvertised `alg`, an unheld `kid`, a bad MAC or a malformed token are one refusal: `401 interrupt_token_invalid`.
- **`schemaVersion` on the v2 event envelope (`events.md` §"The envelope").** Supplied at the ADR 0628 storage seat on a major-2 read (`1` — this host has never versioned an event payload, so a column would hold one constant); absent from the v1 read, which is unchanged.
- **v2 charter Phase 4 (P4-C) — the era key and the codemap read path (ADR 0628).** Every run this host creates is now stamped `eventLogSchemaVersion: 3` (`spec/v2/core/persistence.md` §"The era key"), and the v2 discovery root advertises that same one constant. The stamp lives on `Storage.insertRun`, the single interface method all **23** run-creation call sites funnel into, so persistence.md's "MUST begin stamping `3` on ALL of them in the same change" holds by construction rather than by inspection. Additive nullable column, **no backfill**: sqlite migration 44, Postgres migration 41, no `UPDATE`. A run that predates the cut keeps its absent era, reads as `2`, and its rows are never rewritten; the snapshot's REQUIRED `eventLogSchemaVersion` is synthesized as `2` for those runs at read time, because a missing stored era is not a read error.
- **The storage seat (ADR 0628 §2).** `Storage.listEvents` — the storage interface's event-list method, which every one of the backend's 35 event reads passes through (poll, SSE, fork, replay divergence, debug bundle, the analytics folds) — translates an era-`2` log through the vendored `schemas/v2/event-codemap.json` for a major-2 reader, with `sequence` preserved verbatim; an unmapped type with no vendor prefix fails the read with `500 event_type_unmapped`. Its writers `appendEvent`/`appendEventsBatch` hold each log to its era's vocabulary and refuse a v2 name an era-`2` log cannot express. The adapter is installed by decorating the Storage object in `openStorage()`, the one place a Storage is constructed, so no call site can bypass it and the two backends cannot drift.
- **RFC 0165 host leg (ADR 0625, 2026-09-02)** — root `protocolVersions: ["1.1"]` on discovery; `RunSnapshot.owner` for EVERY run with a principal (was anonymous-actor-only), now carrying the RFC 0165 `subject` record minted at creation from the caller's lane and persisted on the reserved `metadata.owner` key, with the `urn:openwop:legacy` synthesis for runs that predate it; `run.started` echoes the owner block; `:fork` copies the owner (principal + subject) verbatim while `actingUserId` keeps its ADR 0024 re-stamp; `GET /.well-known/openwop` sends a standard `ETag` and honors `If-None-Match` → `304` (`ETag` added to the CORS expose list). Suite pin `^1.152.0 → ^1.159.0` (1.157.0 and 1.159.0 fix two defects in the suite's `owner-subject-echo` leg that this leg surfaced: an async-start race and a `lastSequence=0` read that skips a 0-numbered first event); vendored schemas re-synced at `openwop-conformance/v1.159.0`.

### Changed
- **The v2 run snapshot is CLOSED (`runs.md` §Snapshot, ADR 0629 Decision 5).** Under major 2 the snapshot is filtered against the `properties` of the vendored `schemas/v2/run-snapshot.schema.json` — read from the artifact, never retyped — which drops eleven fields the v1 wire carries and v2 declares no seat for: `parentRunId`, `parentSeq`, `forkMode`, `parentNodeId`, `inputs`, `removalAt`, `pinned`, `costUsd`, `costByNode`, `childRuns`, `interrupt`. `parentRunId` and `inputs` are not host extensions in spirit and their loss is reported upstream rather than smuggled through `metadata`. **The `/v1` snapshot still carries all of them.**
- **Interrupt resume tokens change shape on BOTH wires** (43 characters/one segment → 105/five). The token is an opaque capability with no v1 grammar and every consumer treats it as opaque, but the bytes differ; tokens outstanding across the deploy keep resolving unchanged.
- **v2 charter Phase 4 (P4-A) — the corpus pin moves to the v2 line.** `schemas/CORPUS_TAG` is now `v2.0.0-rc.3` and the vendored set is re-copied from that tag (182 schemas, including `schemas/v2/` for the first time). The suite and its new peer are pinned EXACTLY — `@openwop/openwop-conformance@2.0.0-rc.3` and `@openwop/spec-artifacts@2.0.0-rc.3`, not a caret range: a host measuring itself against a moving suite is not evidence.
- **`check-vendored-schemas.mjs` learns both corpus release lines and reads the pinned tag.** The pin regex accepted only `openwop-conformance/vX.Y.Z` with a three-part version, so it could not express the v2 coordinated release (`vX.Y.Z[-rc.N]`, which publishes the suite AND `@openwop/spec-artifacts` together). It now accepts both. Separately, the drift comparison read whatever the sibling checkout happened to be on rather than the tag the pin names — so it could report agreement with a corpus nobody released. It now reads `git show <CORPUS_TAG>:<path>`, the same rule `sync-schemas.sh` already applies on the copying side, and the source label says which tag it compared against.
- **Webhook `OpenWOP-*` header family now carries the spec's values (RFC 0165 §C.1; closes ADR 0538 Phase 2).** `OpenWOP-Webhook-Id`, `OpenWOP-Event-Type`, `OpenWOP-Timestamp`, `OpenWOP-Signature: sha256=…`, `OpenWOP-Signature-Algorithm: v1` are emitted value-identical to their `X-openwop-*` twins. The pre-spec combined `openwop-signature: t=…,v1=…` encoding and the `openwop-subscription-id` header are removed. A subscriber may verify from either family with the same `${timestamp}.${rawBody}` recipe; the openwop-sdks helpers (TS 1.9.0 / Py 1.7.0 / Go v1.6.0) read both.
- **Vendored schemas are pinned to a corpus tag** (v2 charter Phase 0, 2026-09-02). `scripts/sync-schemas.sh` now requires `--tag openwop-conformance/vX.Y.Z` (or `OPENWOP_CORPUS_TAG`), refuses to copy unless the sibling corpus checkout is exactly at that tag with a clean `schemas/`, and records the tag in `schemas/CORPUS_TAG`. `scripts/check-vendored-schemas.mjs` (in `npm run ci`) fails when that tag's version differs from the installed `@openwop/openwop-conformance`. Why: the corpus is about to grow `schemas/v2/`, and an unpinned sync from whatever HEAD `../openwop` is on would ship v2 schemas into a v1 image (the H34 drift class, one major up). Suite pin `^1.151.0` → `^1.152.0`; schemas re-vendored from `openwop-conformance/v1.152.0` (only the bundle-v1 schema's deprecation note and `schemas/README.md` changed).

### Fixed
- **`GET /v1/agents/roster` is served (RFC 0086 §B, #4163).** Discovery advertised `agents.roster.supported`, but the route was never registered and `/agents/roster` fell into `/agents/:agentId` (`404 "agent 'roster' is not installed"`). It now returns the closed `agent-roster-response` projection of the tenant's standing roster, registered ahead of the id route.
- **RFC 0176 pinned-run disposition fires for every caller (#4159).** A run pinned to an unimplemented change id was cancelled only when read by the wildcard operator; a configured tenant key read it back as `running` indefinitely.
- **`sync-fixtures.sh` vendors a named corpus TAG, and the guard's remediation line now works.** The script took no tag and copied the sibling corpus clone's WORKING TREE, so with the clone ahead of the pin (found by an adopter: clone 2.36.1, pin 2.36.0) a failing `check-vendored-fixtures` printed "run `sync-fixtures.sh`" and that run vendored the wrong release — failing the same guard for the opposite reason, with a throwaway detached worktree as the only way out. It now requires `--tag` (the same contract `sync-schemas.sh` has) and `git archive`s that tag, never touching the shared clone's HEAD, index or working tree; the guard prints the tag matching the installed suite, reads the corpus AT that tag for its which-side-is-stale call, and no longer tells you to reconcile a working tree. `sync-schemas.sh` gets the same read-at-the-tag treatment: it demanded the clone already be checked out at the tag — an instruction that mutates a checkout shared with other sessions — and its three `spec/v2/*.json` copies came from the working tree, which its clean-`schemas` check never covered. `check-vendored-schemas.mjs`'s remedy no longer tells you to build a throwaway detached worktree at the tag and point `OPENWOP_CORPUS_DIR` at it — the sync reads the tag itself, so `git -C ../openwop fetch --tags` is the whole preparation. `deploy/gcp/up.sh` passes both tags (its untagged `sync-schemas.sh` call had aborted every confirmed deploy since 2026-09-02).
- **`GET /v1/runs/{id}/events/poll?lastSequence=0` dropped the first event (ADR 0625).** The route added 1 to the cursor on top of storage's already strictly-after `listEvents`; with this host's first event at sequence 1, `run.started` was never returned through the spec-canonical cursor. Caught by the RFC 0165 echo scenario; fixed 1:1.

## [0.1.0] — 2026-06-30

Inaugural versioned white-label release (ADR 0052) — replaces the rolling `whitelabel`
tag with an immutable `v0.1.0` + a moving `latest` alias. Captures the pre-1.0 app:
the OpenWOP workflow-engine backend + React SPA, the feature-package suite (CRM, CMS,
KB, Campaign Studio, publishing, notifications, RBAC/orgs, connections/BYOK), the
runtime white-label brand + generative theming (ADR 0170/0171), and the real-time
voice + ads-dispatch host arms. Fresh install — no prior version to upgrade from.

### Fixed
- **Campaign Strategist prompt — honest ad-dispatch guidance (ADR 0167).** The Strategist's
  instructions still said "there is no live ad/social posting in-app yet… nothing is posted to a
  platform" — stale after the ADR 0167 Phases 1–3 made Meta/Google/TikTok dispatch real. Corrected:
  the agent now distinguishes a **real PAUSED ad campaign** (when an ad account + platform connection
  are configured) from a **document handoff**, always tells the human which happened, and gets an
  explicit go-ahead before any real dispatch (campaigns are created PAUSED — they never auto-spend).
  Added an "Operator setup — enabling real dispatch" section to ADR 0167 (per-platform connection,
  the Google `OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN`, the test-only API-base overrides, the PAUSED-safety).

### Added
- **Customizable token-based theming (ADR 0171, extends ADR 0170).** The Appearance editor is now
  **generative**, not preset-picking: a super-admin sets a brand color (+ optional background tint,
  contrast level, corner radius, fonts) and the host deterministically generates the full **light + dark**
  design-token set — the accent kept exact for fidelity, on-colors **solved for WCAG-AA**, and the stock
  theme reproduced byte-identically so unedited installs never shift. Built on a dependency-free OKLCH
  engine (`src/brand/theme/`); the inputs persist in `Brand.identity.theme` (replay-safe) and apply at
  runtime via the ADR 0170 `:root` injection (generator lazy-loaded; pre-paint reads cached tokens → no
  flash). The rebuilt editor adds a sticky live light/dark preview (with the real logo), a **ContrastChecker**
  (WCAG ratio + APCA advisory), an **advanced per-token JSON override** tier (allowlisted tokens only,
  server-sanitized), and named seed-set starters. Host-extension — no new wire, no RFC. (#1019)
- **Runtime white-label brand identity (ADR 0170 — `brand` graduates to core).** ONE `brand` feature now
  owns both the app's own white-label identity AND tenant marketing brands (the CMS-owns-homepage pattern).
  A super-admin sets the app logo, colors, fonts, instance name, favicon, title, and default theme at
  **runtime** via an Admin **Appearance** panel — a reserved `brand:host-app` brand served pre-auth on
  `/v1/host/openwop-app/public-brand`, applied by injecting `:root` CSS vars (no rebuild). Supersedes the
  build-time `VITE_BRAND_*` baking (now the boot seed). All identity values are CSS-grammar-sanitized
  host-side; asset URLs scheme-validated. Host-extension — no new RFC. (#1016)
- **Campaign Studio: real outbound TikTok Ads dispatch (ADR 0167 Phase 3 — completes Meta/Google/TikTok).**
  A `tiktokStrategy` creates the campaign→adgroup→ad pipeline (all **DISABLE**/paused) against the hardcoded
  `business-api.tiktok.com/open_api/v1.3`, authenticating with a **raw `Access-Token` header** (not
  `Authorization: Bearer`) and the public `advertiser_id` in the request body. To support this the broker gained
  `authScheme:'raw'` + a `brokeredPost` `authHeaderName` option (the broker writes its secret under the named
  header; the `extraHeaders` strip now protects whatever that header is named — a caller can't override the
  broker's `Access-Token`). Adds a new RFC 0095 `tiktok-ads` connection pack. Fork-stable idempotent; no rollback
  (DISABLE objects don't spend). Also hardened the publish node's platform routing to an explicit allow-set (a
  bad `platform` input can no longer silently dispatch to the wrong platform). Rides Accepted RFC 0045/0046/0047/0079.
- **Campaign Studio: real outbound Google Ads dispatch (ADR 0167 Phase 2).** `host/adsAdapter.ts` is
  refactored to a `PlatformStrategy` (shared idempotency/provenance spine + Meta + a new Google strategy);
  `publish-ad-variants` gains a `platform` input (`meta` default). Google creates the budget→campaign→adGroup→ad
  `:mutate` pipeline (all **PAUSED**) against the hardcoded `googleads.googleapis.com/v18`, with the per-user
  OAuth Bearer token (broker-resolved) **and** the app-level `developer-token` — the latter as **operator host-side
  config** (`OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN`, not a Connection secret), carried by a new additive
  `brokeredPost` `extraHeaders` param that **case-insensitively strips any `authorization` override** (the broker
  stays the sole credential authority — existing slack/email/sms/Meta callers unaffected). Fork-stable idempotent
  on the `google` key; fails closed if the developer-token is unset (and the node then degrades to the ADR 0166
  document handoff). Also fixes a Phase-1 bug (a reused record reported `platform:'meta'` instead of its own).
  (Phase 3, TikTok, to follow.)
- **Campaign Studio: real outbound Meta ad dispatch (ADR 0167 Phase 1).** A new `host/adsAdapter.ts`
  (`ctx.ads.publishAd`, the slack/sms/email adapter pattern) turns an approved `ad_variants` draft into a
  real **PAUSED** Meta campaign→adset→ad through the Connections broker — composing `brokeredPost` (OAuth
  token host-resolved, never on the wire), **created-PAUSED** (no auto-spend), **hardcoded `graph.facebook.com`
  host** (never input-derived), an **adapter-owned fork-stable idempotency map** (keyed on
  `tenant:briefId:platform:adHash`, NOT runId → a `:fork` reuses the recorded platform ids, no duplicate paid
  campaign), explicit RFC 0079 `stampConnectionUse`, and best-effort PAUSED-safe cleanup on partial failure.
  `publish-ad-variants` dispatches when an `adAccountId` is targeted + a Meta connection exists; otherwise it
  falls back to the ADR 0166 document handoff. Rides the already-Accepted RFC 0045/0046/0047/0079 — **no new
  wire, no new RFC.** (Phases 2–3, Google/TikTok, to follow.)
- **Campaign Studio publish: ad / creative / social → document handoffs (ADR 0166).** Completes the
  five-channel publish path. Three `role:"action"` nodes in `feature.campaign-channels.nodes` —
  **`publish-ad-variants`**, **`publish-creative-briefs`**, **`publish-social-posts`** — map a draft to
  Markdown and write it as a **draft `documents` document** (ad-copy / creative-briefs / social-calendar)
  via a new `ctx.features.documents.createDraftDocument` (content-guarded + the deterministic
  `createDocument` short-circuit + idempotency-keyed `addVersion`, all in one owned method). These three
  channels have **no first-party platform target in-app** (a MyndHyve evaluation confirmed real outbound
  ad dispatch is a large, RFC-gated effort; organic social posting exists nowhere), so the honest target
  is a reviewable, exportable handoff packet — **nothing is dispatched to a platform**. Tenant-isolated,
  replay-idempotent (deterministic `runId:nodeId` ids), wired into the Campaign Strategist allowlist.
- **Campaign Studio publish last-mile (ADR 0162).** Generated channel drafts now become real
  entities: two `role:"action"` nodes in `feature.campaign-channels.nodes` —
  **`publish-landing-page`** (a landing_page draft → a **draft** CMS page via a new
  `ctx.features.cms.createDraftPage`) and **`publish-email-sequence`** (an email_sequence draft →
  one **draft** email template + campaign **per step** via a new `ctx.features.email.createDraftCampaign`).
  Both delegate to the existing cms/email services (single source of truth), are draft/unsent-only
  (a human gates publish/send), tenant-isolated (tenant from the run scope), and replay-idempotent
  (deterministic `runId:nodeId` ids — `createTemplate`/`createCampaign` gained optional id
  short-circuits). Wired into the Campaign Strategist tool-allowlist (ADR 0058). No new UI, no new wire.
- **Connection packs: Google Ads, Meta Ads, Oracle NetSuite (RFC 0095).** Three new
  `examples/connection-packs/` provider definitions loaded by the existing `connectionPackLoader`:
  **Google Ads** + **Meta Ads** (`marketing`) and **Oracle NetSuite** (`finance`, per-account
  `instanceUrlTemplate`) — each an OAuth2 `reach:openapi` provider carrying no secret, mirroring the
  shipped `workday`/`salesforce` packs. They fit the existing RFC 0095 manifest (no spec amendment)
  and become resolvable providers operators can connect. (ADR 0149.)
- **ADR 0149 — Real-Work Workflow Library (decision record).** Catalogs 20 real-work corporate
  workflows (exec/CoS, marketing/ads, people, finance, sales/CS, IT) and records that their correct,
  protocol-aligned home is a **workflow(-chain) pack** loaded like node/agent/connection packs
  (`schemas/workflow-chain-pack-manifest.schema.json`, RFC 0013) — a loader this host does **not** yet
  implement. An initial implementation that introduced a parallel pinned `lib.*` catalog + a bespoke
  discovery route was **reverted** as an architecture deviation (the established homes —
  `workflowTemplates.ts` and the builder registry — and a future workflow-pack loader are the right
  locations). Net code landed: the three connection packs above; the workflow-pack loader is tracked
  as the next architecture step.
- **Real-time voice host arm (ADR 0109, RFC 0106).** The reference-host arm for the OpenWOP real-time voice profile (RFC 0106, `Active`): `ctx.callTranscriber` (streaming STT — a deterministic stub + real finite-audio transcription via the managed multimodal `callAI` audio path on a host media-asset url, the `streamRef → mediaRef` finalize seam; a live `streamRef` is an honest `transcription_unsupported` because live media transport is host-internal per RFC 0106 §E), the streaming arm of `ctx.callSpeechSynthesizer({stream:true})` (emits `voice.synthesis_chunk` metadata-only run-events), and the `voice.barge_in → voice.cancelled` lifecycle (no partial leak, §F). Advertises the full `aiProviders.realtimeVoice` surface (`transcription`/`synthesis`: `"streaming"`, `turnDetection: "semantic"`, `bargeIn: "supported"`), derived from what's wired (advertise+accept-in-lockstep). **Always-on host plumbing — no toggle**; the chat's voice UX is the pre-existing `ChatInput` MediaRecorder mic (RFC 0091 implicit transcription), so no duplicate mic was built. Host work riding RFC 0106 — no new RFC. (#683, #689, #691, #693, #694)
- **Tool-output compaction (ADR 0099).** A toggle-gated platform feature (`tool-output-compaction`,
  OFF by default, tenant-bucketed) that compacts verbose JSON tool outputs at the typed tool-result
  boundary before they re-enter the model context — cutting BYOK token spend. Structure-preserving by
  default (minify + drop empty fields); opt-in per-agent lossy array-elision and per-tool exemptions
  via `agentProfile.configParameters.compaction`. The decision is frozen per-run in `run.metadata` and
  read verbatim on replay/`:fork` (deterministic); fail-open (a disabled/erroring path never breaks a
  run). Also exposes an explicit `ctx.features['tool-output-compaction'].compact` workflow surface +
  `feature.tool-output-compaction.nodes.compact` node. Savings are reported as observability telemetry
  (no parallel counter store). Host-internal — no wire change, no new RFC.
- **Strategy create-form templates (ADR 0080 Phase E).** Four presets — OKR, annual operating
  plan, portfolio bet, and working-backwards — offered as a "Start from" picker in the New Strategy
  modal. A template is a pure client preset (i18n-keyed objective/key-result/initiative scaffolds +
  horizon defaults) that **pre-fills** the existing create flow; the backend re-validates everything
  (a template is a suggestion, never an authority). No new entity, store, or schema. en +
  native-reviewed pt-BR. (Completes ADR 0080 — marked `implemented`.)
- **Strategy Analyst agent pack `feature.strategy.agents` (ADR 0080 Phase C).** A manifest agent
  (RESEARCH persona, research model class) that **audits alignment gaps** across the strategy
  portfolio (reasoning over `get-health`'s signals + `get-strategy`) and **drafts board-ready memos**
  — tool-allowlisted to the five `feature.strategy.nodes` only. Chat-drivable through the existing
  AI chat (ADR 0058 — no bespoke panel; deep-link the agent). It **recommends and drafts; the human
  authors strategy** — the agent has **no strategy-mutation tool** (its only write is a board-memo
  Document), preserving the read-only-strategy invariant, and its prompt forbids fabricating strategy
  facts. Rides RFC 0003 + ADR 0058; **no new RFC**.
- **Strategy node pack `feature.strategy.nodes` + `board-update` document kind (ADR 0080 Phase B).**
  A signed node pack over the read-only `ctx.features.strategy` surface — `list-strategies`,
  `get-strategy`, `get-context`, `get-health` (the new 4th read surface method) — plus a
  `create-board-memo` **write** node that persists an agent-authored memo as a Document of the new
  open-vocabulary `board-update` kind (`ctx.features.documents`), degrading to inline markdown when
  `documents` is OFF. The strategy surface stays **read-only**: the memo write lands in Documents,
  never in Strategy. All nodes are `role:action` (replay-safe recorded output; the memo
  `addVersion` is idempotency-keyed). Host-extension, **no new RFC** (rides RFC 0076).
- **Strategy health rollup (ADR 0080 Phase A).** A live, RBAC-bounded health signal
  (`on-track`/`at-risk`/`off-track`) rolled up per strategy from its linked execution — project
  charter health + milestone completion % + linked priority ideas — surfaced as a chip on the
  Strategy Portfolio and exposed via `GET /v1/host/openwop-app/strategy/health`. The verdict is a
  **computed projection** (never stored — same live-resolve discipline as the context packet), and
  it carries the component `signals` verbatim so the *why* is honest (no invented precision). Rides
  the existing `strategy` toggle; host-extension, **no new RFC**.
- **Strategy (Strategic Planning) — backend feature-package (ADR 0079, Phase 1).** A toggle-gated
  (`strategy`, OFF, `tenant`, "Business Tools") executive **strategy portfolio**: narrative
  rationale + OKR-compatible objectives/key-results + initiatives + planning horizon
  (quarter/half-year/annual/multi-year/custom) + owner/accountable-exec + status/confidence/risk,
  with **canonical alignment links** out to projects, Priority Matrix lists/ideas, advisory boards,
  and documents. Host-extension under `/v1/host/openwop-app/strategy/*` (CRUD · `PUT /:id/links` ·
  `GET /context`); **no new RFC**. Scope is a visibility modifier (`user`/`workspace`/`org`) over a
  mandatory owning `orgId` (ADR 0079 §Correction): fail-closed RBAC, tenant/org IDOR (uniform 404),
  cross-entity link read-gate (403 on an unreadable target; context silently omits it), soft-archive
  on delete (hard-delete only user-scoped drafts). Links are read **back** into consumer surfaces —
  no denormalized `strategyIds[]`, no `Project.charter` overload, not a reuse of `goals`.
  **Phase 2 (frontend):** a `/strategy` "Strategy" workspace page (nav-gated on the toggle) — a
  Portfolio of strategy cards (filter by scope/status/horizon; status/risk/confidence chips) + a
  per-strategy detail editor (Overview · Objectives/key-results · Initiatives · Alignment link
  picker), composing the shared `ui/` cohesion layer; en + native-reviewed pt-BR catalogs.
  **Phase 3 (Priority Matrix alignment):** a ranked idea row shows the strategies it's aligned to
  (chips) + an "Align to strategy" control, via a strategy-OWNED embeddable component the Priority
  Matrix page renders — composed entirely over the existing `GET /strategy/context` +
  `PUT /strategy/:id/links`, **no priority-matrix backend coupling** (avoids a feature import cycle,
  ADR 0079 §Correction).
  **Phase 4 (Projects alignment):** the Project Overview tab shows the strategies a project is
  aligned to (chips, via the existing context endpoint, toggle-gated), and the strategy Alignment tab
  shows each linked project's status/health — both FE-composition, no projects backend coupling.
  **Phase 5 (Board of Advisors context):** a board carries selected strategies as `contextRefs`
  (validated readable by the author, RBAC'd); a board context-preview endpoint
  (`GET /advisors/boards/:id/strategy-context`) powers a setup picker + preview. At `@@` summon, the
  board's strategy context is resolved (RBAC-filtered for the convener) and **snapshotted onto the
  boardroom conversation**, then injected into each advisor's system prompt — via a new **core
  board-context resolver seam** (`host/boardContextResolver.ts`, the ADR 0075 resolver-registry
  pattern) so core never imports a feature, and `composeAgentSystemPrompt` gains an optional
  `strategyContext` block.
  **Phase 6 (workflow surface):** a read-only `ctx.features.strategy` (`list`/`get`/`context`),
  auto-advertised at `/.well-known/openwop`. A run is tenant-trusted (no caller subject), so the
  surface exposes **shared** strategies only — `user`-scoped private drafts are excluded (no leak
  to a subjectless run). ADR 0079 marked `implemented` (Phases 1–6); node/agent packs deferred.

### Fixed
- **Accessibility & i18n polish across Strategy and Chat (`/grade-ux` — `STRAT-1..6`, `CHAT-10/11/14`).**
  Strategy: a confirm guard before the irreversible delete/archive, an `<h2>` entity heading in the
  detail view, key-result rows grouped as a labelled `role="group"`, modal headings `<h3>`→`<h2>`, the
  template-applied hint as an `aria-live` status, and static `flex` inline styles → utility classes.
  Chat: `StepList` rows announce their state to screen readers (with a dedicated `stepStatusPending`
  label distinct from the run-level "Starting…"), the `WorkflowProgressPanel` empty state uses the
  shared `<StateCard>`, and the two async streaming-error strings are i18n-keyed. Also **defines the
  previously-undefined `.sr-only`/`.visually-hidden` utility** — it was referenced by `Modal` +
  `ReviewCard` but a no-op, so those labels were painting visible (latent a11y bug, now fixed). All
  new strings en + pt-BR + fr.
- **Strategy context resolution memoizes its priority-list reads per call (ADR 0080 follow-on, perf).**
  `resolveStrategyContext` now reads + ranks each linked priority list at most once per resolve
  instead of once per priority-idea link — a portfolio-wide read like `GET /strategy/health` no longer
  re-ranks the same list repeatedly. Behaviour is identical (transparent optimization); a call-count
  regression test locks it in. Surfaced by a post-merge `/architect` review of the full Strategy feature.
- **Strategy context no longer leaks `private` projects to non-member org readers (ADR 0054).** The
  context packet's linked-project enrichment now gates on the project's own `resolveProjectAccess`
  (member-scoped visibility) instead of plain org-read, so a `private` project linked to a
  workspace-visible strategy is omitted for a read-only org member who isn't a project member.
- **Strategy link/owner identifiers are no longer secret-scrubbed.** `StrategyLink` target ids
  (card/list/project/board/document), `ownerUserId`, and `linkedProjectIds` are opaque references,
  not free text — they now validate through a non-scrubbing bounded check (`reqId`/`optId`) instead
  of `cleanString`, which would redact a uuid-shaped id (e.g. a `host.kanban` card id) to
  `[REDACTED:secret-shaped]` and silently break the link. Free-text fields (title/summary/rationale)
  keep secret-scrubbing.
- **Advisor chat — attribution, roster sidebar, and a live "thinking" indicator.** A reply
  from a named agent now carries a sender header (avatar + name, persona tagline beneath), so a
  council turn is never an unattributed blob — the identity rides the wire (`agent.agentId`),
  resolved to the `@handle` + tagline. The chat "in this conversation" rail goes from a
  radio-button list to a roster of people (avatar-anchored, name as the hero, active voice on the
  clay avatar ring). While the synchronous conversation `exchange` runs, an optimistic
  attributed "thinking" bubble shows in the feed and the addressed advisor's rail row pulses with
  a live "Thinking…" line (`thinkingAgentId`), instead of a frozen UI. Frontend-only; the
  attribution data was already on the message. A2UI is not involved (it renders agent-authored
  interactive forms, not attribution/progress).
- **Live cross-surface review-status sync (ADR 0074).** A decision on any human-review
  surface — the chat Reviews tab, the in-chat approval card, the Runs screen, or the inbox —
  now updates every other surface in real time, cross-client, instead of leaving stale
  still-approvable copies. The decision owners (`resolveAndResume`, `claimApproval`/
  `rejectApproval`) broadcast a non-persisted `review.updated` cache hint over the existing
  tenant-scoped notifications SSE stream (the emitter's new `signal()` path — never an inbox
  row, no second connection); a shared client `reviewStatusStore` (single source of truth)
  patches/evicts the affected review and drives every surface + the pending-count badge.
  Host-internal, no RFC (reuses the `interrupt.resolved` event; adds no wire surface).
- **CMS content localization — real localized delivery + Phase-3 workflow surface (ADR 0064 / RFC 0103).**
  `GET /v1/content/pages/{slug}` now negotiates over the **host-advertised** content set
  (`OPENWOP_I18N_LOCALES` / `capabilities.content`) instead of the system-site's empty per-org
  settings, so a supported locale returns an honest `Content-Language`; the seeded system-site
  home (`SEED_VERSION` 5) carries es + pt-BR overlays for real translated delivery, and a
  supported-but-unauthored locale falls back to base per-section. Adds the `ctx.features.cms`
  read surface (`listPages` + locale-resolved `getPage`), the `feature.cms.nodes` pack (`get-page`
  + `translate-section`), and the `feature.cms.agents.localizer` agent (tool-allowlisted to those
  nodes — the chat-drivable path; no separate envelope seam). Host-internal, no RFC (rides
  Accepted RFC 0103). En route this also **fixes a latent surface-gate bug** (ADR 0014
  correction): always-on features (no toggle — `cms`, `assistant`, `agent-knowledge`) had their
  `ctx.features.<id>` workflow surface refused on every call (`host_capability_disabled`), so the
  shipped `feature.{assistant,agent-knowledge}.nodes` packs were dead through the real runtime
  path. The gate now treats a feature with no toggle default as always-on substrate.
- **Priority Matrix federation — fan-out cache (ADR 0061 #3).** `GET /portfolio/federated`
  now fetches each peer through a process-local **single-flight + short-TTL (30s default,
  `OPENWOP_PM_FED_CACHE_TTL_MS`) + bounded + jittered** cache, cutting duplicate outbound peer
  calls at scale. Correctness over speed: because a peer's slice depends on the resolved
  credential (ADR 0062 per-user bearers), the cache key carries the **credential identity**
  (`resolvePeerCredential` reports `u:<userId>` / `shared` / `env` / `none`) so a per-user
  slice is never served to another caller. Only successful fetches are cached; failures stay
  fail-soft. Host-internal, no RFC.
- **Priority Matrix — weighted voters (ADR 0059).** A multi-voter list can give a stakeholder's
  vote more pull via an optional `voterWeights` map on `PriorityList` (voterId → integer 1..10;
  absent/uniform = equal weight, exactly as before). When weights differ, `aggregateVotes` uses
  the **weighted arithmetic mean** (`mean` mode) or a **lower weighted median** (`median` mode) —
  weights are never silently dropped. Config-authority-gated (list creator or `host:org:manage`),
  validated (1..10, capped), and re-ranked on a live read (no recompute / run-stamp; replay
  unaffected). FE: a per-voter weight selector in the owner/admin vote-breakdown Modal.
  Host-internal, no RFC. Follows the Limited Weighted Votes (LWV) governance pattern.
- **Priority Matrix federation — enterprise credentials + per-user authorization (ADR 0062).**
  Peer bearers move from the deploy-time env token to the **BYOK envelope** (`secretResolver`,
  KMS-sealed/rotatable), keyed per-`(peer)` and per-`(peer,user)`. `resolvePeerToken` resolves
  per-user → tenant-shared → env (deprecated). The **per-user** credential makes a peer
  authorize on the caller's own token, so its slice is filtered to their access — **closing the
  read-authorization asymmetry** (ADR 0061). `PUT /priority-matrix/peers/:id/credential` (tenant
  scope = superadmin; user scope = self) + a per-peer FE credential form. Host-internal, no RFC;
  cross-host SSO/OBO delegation (RFC 8693) is escalated to a tracked openwop RFC.

### Fixed
- **Chatting with a reasoning advisor no longer fails with `request_timeout`.** The synchronous
  conversation `exchange` generates the reply in-request, and a reasoning model legitimately
  exceeds the global 30s server backstop (especially mid-council). The interrupt-resolve routes
  now get a longer budget (`OPENWOP_LLM_REQUEST_TIMEOUT_MS`, default 120s); every other route
  keeps the tight 30s.
- **Chatting with an `@agent` no longer fails the first message with `interrupt_not_found`.**
  `POST /v1/runs` dispatches in the background and returns before the conversation gate suspends,
  so the immediate `exchange` raced the suspend; the client now waits for the gate to open
  before sending the first turn.
- **Button icons align with their labels and primary buttons drop the inverted-ink slab.** The
  shared `button` rule is now a flex container (icon centers on the text) and fills the brand
  clay (`--clay-strong`) instead of `--ink`, which rendered as a harsh near-white-on-dark /
  near-black-on-cream block.
- **Chat composer placeholder is vertically centered** in the input bar (the single-line
  textarea now matches the 36px action buttons).
- **Provider/model avatar badges use one theme color** (`--clay-strong`) instead of four
  unrelated per-brand colors (the "Try it free" / Anthropic / OpenAI / Google tiles).

### Security
- **Backend `undici` bumped 7.27.2 → 7.28.0 (Dependabot).** Closes 7 alerts (3 high, 2 moderate, 2
  low) on the default branch — `undici` is a direct backend runtime dependency for host-side
  `fetch`/`Agent` egress. Patch release within `^7` (satisfies `testcontainers`' `^7.25.0`); no API
  change. `npm ci` reports 0 vulnerabilities.
- **Priority Matrix federation — bounded peer-response reads (ADR 0061).** The peer fetch now
  sends `accept-encoding: identity` (removes the decompression-bomb vector) and reads via a
  streaming `readCapped()` hard byte cap instead of buffering `res.text()` (undici has no
  built-in max-response-size; Content-Length is untrusted) — OWASP SSRF response-size control.

### Added
- **Priority Matrix — app↔app federated portfolio (ADR 0061).** A per-tenant registry of
  peer openwop-app origins + `GET /priority-matrix/portfolio/federated` that merges the
  local portfolio with each peer's, tagging every item with its `source`. Security: peer
  config is **non-secret** (the bearer is a deploy-time env secret, never persisted),
  egress is **SSRF-guarded** (reuses the webhook egress guard — host validated at
  registration, pinned DNS at connect), peer management is **superadmin-gated**, and a
  failing peer is **fail-soft** (reported, never fatal). This is **Option A** (both ends
  run this host → the non-normative host-extension route) — host-extension, **no RFC**.
  Cross-*vendor* prioritization (Option B) stays parked behind a future RFC.
- **Priority Matrix follow-ons (ADR 0059/0060).** Three host-internal additions:
  (1) **opt-in portfolio normalization** — `?normalize=list-relative|percentile` on
  `GET /priority-matrix/portfolio` + a "Compare" selector, a labeled comparability aid
  (raw stays the default); (2) **per-voter vote breakdown** — `GET .../ideas/:cardId/votes`,
  config-authority gated (list owner / org admin), surfaced via a Modal on the Votes count;
  (3) **single→multi-voter vote seeding** — switching `votingMode` seeds the creator's vote
  from each existing shared score so priorities survive the switch. Additive; no new RFC.
- **Priority Matrix — cross-list portfolio rollup (ADR 0060).** A read-only
  workspace **Portfolio** view aggregating + ranking ideas across all the priority
  lists the caller can read (`GET /priority-matrix/portfolio`, per-org readability
  filter; `ctx.features.priority-matrix.listPortfolio`). Each row shows its source
  list, in-list rank, and scoring model — priorities aren't strictly comparable
  across lists with different criteria, so the view is explicit about it.
  Host-extension, no new RFC. (Cross-*host* federation stays parked behind a future RFC.)
- **Priority Matrix (ADR 0058).** A toggle-gated feature-package (`priority-matrix`,
  OFF, tenant-bucketed) to capture ideas/requests into named priority lists, score
  them against a configurable weighted criteria set (1–10 slider weights; a
  Weighted-Scoring engine with WSJF/RICE/ICE/Value-Effort presets), rank them, and
  run a planning session that turns a selection into a meeting agenda. An idea is a
  `host.kanban` card (statuses = columns, terminal lanes + assignment via ADR 0049 —
  no parallel board); lists are workspace-scoped, or project-scoped when a `projectId`
  is set (board `ownerSubject`, ADR 0046). The agenda composes the Documents
  `board-agenda` kind (ADR 0053) when enabled, inline markdown otherwise. Adds the
  `ctx.features.priority-matrix` workflow surface + the `feature.priority-matrix
  .{nodes,agents}` packs (a Prioritization Analyst agent drivable from the AI chat).
  Host-extension, no new RFC.
- **Priority Matrix — multi-voter scoring (ADR 0059).** A list can opt into
  `votingMode: 'multi-voter'` (default `single`) with `voteAggregation: 'mean' | 'median'`:
  each member casts an independent per-criterion `IdeaVote` and ideas rank by the
  aggregate, so one member can't overwrite another. Switching mode is config-authority
  gated; single-mode lists are unchanged (no migration). Host-extension, no new RFC.
- **Versioned app releases + built-in migrations (ADR 0052).** An app-version
  single-source-of-truth (`/VERSION` → `src/version.ts`), surfaced at `/readiness`
  (`version`, deploy-verifiable) and recorded in `__app_meta` (fresh-install vs.
  upgrade-from-prior detection). A boot-time **app-migration runner** (§D5) for
  non-schema one-shots, forward-only + idempotent, sibling to the existing
  `__schema_version` DDL runner. This changelog + the `RELEASES.md` manifest.
- **Kanban card assignment to people (ADR 0049)** — assign a card to a person or
  role; addressed inbox notification + a `/my-work` "assigned to me" live mirror;
  `terminal`-lane completion; card-scoped access.
- **Per-recipient notification targeting (ADR 0050)** — `NotificationRecord
  .recipientUserId` (addressed vs. tenant-broadcast) + per-user Web-Push.

### Changed
- **Boards and Knowledge Base moved from the workspace rail to the Admin console.**
  `/boards` now lives under Admin → **Operations** (with Mission Control + Runs) and
  `/kb` under Admin → **Access & data** (with Organizations + Keys). The admin surface
  is ungated, so every user still reaches both via the Admin entry; each keeps its own
  RBAC (and KB its `kb` toggle). Nav-placement only — no route, auth, or wire change.
- **"My Work" folded into the personal board (ADR 0049 correction #3).** The
  standalone `/my-work` page + top-level nav item are removed; the "assigned to me"
  mirror is now a collapsible **"Assigned to me"** rail rendered as the leftmost
  column of your personal board, showing your open (non-terminal) assigned cards and
  collapsing away when empty. Same derived-view records (no copies); `/my-work`
  redirects to `/boards` (query-preserving) and assignment-notification deep-links
  now target `/boards?card=`. No wire/RFC change.
- **Per-agent knowledge & memory and collaborative projects are now always-on**
  (ADR 0038 / ADR 0054 §Correction). The `agent-knowledge` and `project-collab`
  feature toggles are retired (added to `RETIRED_TOGGLE_IDS`, so any stale per-tenant
  override is cleared at boot). The Agent **Knowledge** + **Memory** tabs and the
  project **Members** + **Chat** tabs now render unconditionally. Authority is
  unchanged — per-agent knowledge still enforces IDOR + RBAC + profile policy, and
  collaborative project writes stay org-scoped (`private` projects read-gated to
  members via the `subjectAccess` seam). No wire/RFC change.
- **In-app Network inspector enabled on the deployed app** (`VITE_ENABLE_NETWORK_RECORDER=1`
  in `.env.production`). The recorder previously ran liveness-only in prod, so the
  panel showed "0 calls". Full capture now records to the tab-scoped sessionStorage
  mirror; request **and** response bodies are credential-redacted (BYOK routes dropped,
  `token`/`password`/`apikey`/`secret` fields scrubbed) and truncated.
- White-label distribution moves from the rolling `whitelabel` tag to immutable
  `vX.Y.Z` releases; `latest` (aliasing `whitelabel`) becomes a moving pointer to
  the newest stable so the `/install/` URL stays stable (ADR 0052 §D7). The
  `/publish-whitelabel` skill is renamed/reworked to **`/cut-app-release`**.

### Changed
- **Project write controls are pre-gated on the caller's write access** (ADR 0063).
  The project read now projects `canWrite` (the caller's `workspace:write` in the
  project's org, from the same `resolveProjectAccess` the gate uses), so a read-only
  member / org viewer no longer sees Delete, Edit charter, Add/Remove member, the
  visibility toggle, Open chat / Save cadence, Assign workflow, the embedded
  memory/knowledge/schedule write controls, or the projects-list **Create project**
  form when they hold no `workspace:write` — all previously 403'd on use; they see a
  "read-only access" notice instead. The shared `MemoryBrowser` /
  `SubjectKnowledgePanel` / `SubjectSchedulesPanel` gained an opt-in `readOnly` prop
  (agent + profile surfaces unchanged). UX only — `requireProject('workspace:write')`
  remains the authority on every write route. No wire change.

### Fixed
- **Kanban columns hold a firm minimum width and the board scrolls horizontally.**
  Columns are now ≥280px and no longer shrink to cram many lanes into view; the
  board scrolls within the page (`min-width:0` on the content column keeps wide
  content from forcing a page-level scrollbar), so a 20-column board is fully
  reachable. The "Assigned to me" rail stays pinned at 240px.
- **Duplicate personal board / owner on multiple auth channels** (ADR 0003 §Correction).
  The personal-workspace owner member + personal kanban board were provisioned under
  the raw request subject, which falls back to the volatile channel principal
  (`oidc:<sub>` bearer / `session:<sid>`) before the session is bound — so a single
  human accrued a second "My Board" + a duplicate owner per auth channel. Both
  provisioning choke points (`GET /me/workspaces`, `GET /kanban/boards/personal`) now
  key on the caller's one canonical durable user (`resolveCallerUser`), matching the
  read side. Backend-only; no wire change.

#### Upgrading from a rolling `whitelabel` install
- **No required stop.** DB schema migrations (`__schema_version`) and app
  migrations (`__app_meta`) apply automatically on boot, forward-only and
  idempotently — an instance on any prior schema/app version catches up in one
  start.
- **Back up your database first.** Rollback is forward-only: redeploy the prior
  image and restore the snapshot (ADR 0052 §D3 — there are no down-migrations).
- **Verify:** `GET /readiness` returns `200` with the new `version`; smoke the
  changed surface.

<!--
Released sections (newest first) are appended below this line by /cut-app-release.
Each carries: ## [X.Y.Z] — YYYY-MM-DD, the Added/Changed/Deprecated/Removed/Fixed/
Security subsections, and a #### Upgrading from <prev> block when an operator action
or a required stop applies.
-->
