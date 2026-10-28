# ADR 0993 — Prompt library: owner-only private lanes, tenant-owned templates, and insert-for-review

Status: implemented (D5 merged #5324 `1fdbf5532`; D1–D4, D6–D9 merged #5329 `5bc6ba89b`; live on rev `01068-ppm` at `e0354a2c8`, 2026-10-28). Accepted 2026-10-27 after the adversarial `/architect` pass (2 Blockers, 5 High folded into D1–D7).

Post-deploy (2026-10-28, read-only, team lead): PASS. The new strings ship from a lazy chunk and the entry chunk is clean. Anonymous `GET /prompts` lists host templates only. The prompt-library entries routes answer 401 to an anonymous caller. 0 ERROR on the new revision. Global-template cache headers are unchanged. Caveat: the Firebase `/api` door rewrites `Cache-Control` to `no-store`, so the tenant template's `private, no-store` and the global templates' `public` headers have to be verified on the `run.app` origin, not through `app.openwop.dev/api`.

Phase record: **D5 shipped first, on its own**, as #5324 (`1fdbf5532`, team-lead direction 2026-10-27). It closed a live tenant-isolation hole in `/v1/prompts`. D1–D4 and D6–D9 follow in the main row-61 PR.

Feature loop round 2, row 61 (Prompt library: `prompts`, `core:prompts`). Amends ADR 0116 (prompt
library), ADR 0694 (visibility is the ACL) and ADR 0972 D4 (the tenant-installed template layer).
It is host-only: there is no wire change and no new RFC. The RFC 0028 `/v1/prompts*` contract is
unchanged. What changes is which tenant a user-source template belongs to, which RFC 0028 leaves to
the host.

## Context

The round-1 grade was B+ / — / — (workflows only). Re-measured on `a52087693`: **WF B / UX D /
CODE C.**

**Prod, read-only, 2026-10-27:** 0 `prompts:entry` rows, 0 prompt share links and 0
`proposal-installed-prompts` rows. The query was checked against namespaces that do have rows
(sharing 75, chat 216). Nobody has used the library, so every decision below is correctness before
adoption, and no row is migrated.

Thirteen probes, all red on `a52087693`:
- `backend/typescript/test/adr0993-prompt-library-probes.test.ts`: nine probes;
- `frontend/react/src/chat/__tests__/promptCommands.adr0993.test.ts`: four probes.

1. **`PL2-1` — the user layer of `/v1/prompts` was one process-global map**
   (`host/promptStore.ts:98`).
   - **Cross-tenant access.** Tenant B could `GET`, `:render`, `PUT` a new version of and `DELETE`
     tenant A's template.
   - **Entries could bind it.** A library entry in tenant B could bind A's template.
   - **It did not survive.** The map was in memory, so a restart or a second Cloud Run instance
     lost it, and an entry that referenced it dangled.
   - **It never rendered.** `:render` composed only fixture templates (`routes/prompts.ts:369`), so
     a tenant's own user template answered 404 `template_not_found`.

   ADR 0972 D4 had already moved *proposal-installed* templates into a durable, tenant-keyed
   collection for exactly these reasons, and had left the `POST /v1/prompts` layer where it was.
2. **`PL2-2` — a private entry was private only to reads.** `updateEntry` and `deleteEntry` read
   unfiltered on purpose (ADR 0694 leg 4: "org-scoped write authority over ordinary fields is
   UNCHANGED"). So a `workspace:write` member who could not read a co-member's private entry could
   still:
   - `PATCH` it, and the 200 handed back its name, description and `promptRef`;
   - repoint it to a template of their choosing;
   - delete it.
3. **`PL2-3` — `/p-<slug>` sent the prompt unseen** (`chat/promptCommands.ts:33`). The handler
   rendered the entry and called `ctx.send`. The invoking member never saw the text, but it went out
   as their turn, with their tools and their key. Any org writer authors that text, and with `PL2-2`
   could rewrite a private one. ADR 0116 Phase 3 promised insertion into the composer for editing,
   which the ADR 0565 live-seed lane (`chat/composerSeed.ts`) now supports.
4. **`PL2-4` — no concurrency control.** `updateEntry` was a blind read-modify-write.
5. **`PL2-5` — no DSAR eraser.** `prompts:entry` sat in `ACTOR_ATTRIBUTED_DEBT` as "org content".
   A *private* entry is not org content; it is the subject's own data.
6. **`PL2-6` (`CPC-16` for prompts) — the portability export handed any exporter every member's
   private entries**, plus the entries of orgs they are not a member of.
7. **`PL2-7` — the library had no UI.**
   - `/prompts` is a localStorage template editor that never calls the library routes.
     `promptLibraryClient.createPrompt` has no callers, so no screen can create, edit, set the
     visibility of, or delete a library entry.
   - The chat picker registered commands for `listOrgs()[0]` only, once per page life. It never
     refreshed or removed them, and the multi-tab deck never registered any.
   - A slug collision silently overwrote a command.
   - An entry whose template had gone was still offered.
8. **False claims.**
   - ADR 0116 said "implemented (all phases)", with page CRUD and visibility, insertion via
     `setText`, and rendering through `composePromptTemplate`. None of those was true.
   - `routes.ts:45` said "untrusted bindings are fenced by the composer". `renderEntry` is a regex.
   - The node pack's description said "role:action (recorded)". The nodes are `role:read` and are
     not recorded (ADR 0694 D2).
   - The header of `promptCommands.test.ts` claimed a test for org-switch removal. No such test
     existed.

## Decision

### D1 — A library prompt is inserted for review, never sent

`/p-<slug>` renders the entry and inserts the text into the composer the command was typed in. It
never calls `ctx.send`.

> **REVISED (H5).** The first draft used the global `seedLiveComposer` lane. That lane gives the
> text to the first registered sink, and every sink accepts. The multi-tab deck keeps every tab's
> composer mounted, and an embedded Pair panel adds another, so `/p-x` typed in tab 3 would land in
> tab 1. `CommandContext` gains `insert(text)`, and the invoking `ChatInput` binds it.
The member reads the text, edits it, and sends it, or doesn't.

- **Every org.** Registration covers every org of the active workspace (`listOrgs()`), not just the
  first one.
- **One refresh rule.** Registration is owned by `ChatTab`, which both chat shells mount under, and
  it lazy-imports `promptCommands` (the module leaves the entry chunk). It re-reads:
  - on mount;
  - when the document becomes visible and the last read is more than 60 s old;
  - when the `/prompts` page calls `invalidatePromptCommands()` after a write.
- **No stale commands.** A re-read first removes every command it registered (`unregisterCommand`,
  added to `CommandRegistry`).
- **No late commands** (M6). A generation token drops a slow response from an older read, so
  workspace A's commands cannot register after a switch to B. A workspace switch also reloads the
  SPA (`chrome/WorkspaceSwitcher.tsx` `reloadInto`).
- **Colliding slugs.** They get `-2`, `-3`, … in list order.
- **Unusable entries.** An entry with `available: false` (D4) is not offered.

### D2 — A private entry is its owner's on every lane

Read already was. Now update, delete and the share mint are too:

- A non-owner gets the same uniform 404 a read gets. They cannot read the entry, so a 403 would
  confirm that it exists.
- `org` and `shared` entries stay writable by any `workspace:write` member. They are the org's
  content.
- **The share mint answers 404 too** (M1). The share `entitlement` answered 403 "Only the owner may
  share a private prompt", which confirmed the entry exists.
- **No admin lane** (M8, residue). Not even a workspace admin can delete another member's private
  entry. A departed member's private entries go through DSAR (D6).
- This **overturns ADR 0694 leg 4**, with a correction note there.

The reason leg 4 cannot stand is `PL2-3`: an edit that repoints someone's private prompt decides
what that person sends. ADR 0694 D1 already treated a visibility change as a grant. A body change is
the same grant, made a different way.

### D3 — Entries carry a revision, and every write is a compare-and-swap

`PromptLibraryEntry.revision` starts at 1 and is incremented by every write.

- **The write.** `updateEntry` writes with `DurableCollection.compareAndSwap(read, next)`. A lost
  race is `409 conflict`, never a silent overwrite.
- **Stale edits.** A `PATCH` may carry `expectedRevision` (or `If-Match: "<revision>"`). A stale
  value is `409 conflict` with `{ currentRevision }`. The page always sends it.
- **Old rows.** A row without `revision` reads as revision 1.
- **CAS mechanics (M3).** `compareAndSwap` compares bytes (`JSON.stringify(expected)` against the
  stored value). The write therefore clones the row as read and passes that clone, untouched, as
  `expected`. The revision default is applied only to the copy it computes the next row from.

### D4 — A library body is the library's; a bound template is the tenant's

> **REVISED after the `/architect` pass (B1, B2, H1, H2, M1, M2).** The first draft minted a
> published body into the D5 tenant layer as `library.<entryId>` and reserved that namespace with a
> 403 on `PUT`/`DELETE`. That reservation held on two of the five write lanes and none of the read
> lanes: `GET`/list/`:render`, dispatch, `POST`, the ADR 0972 installer, and another entry binding
> `library.<victim>` all reached a private body. A body whose ACL is the entry's must live where only
> the entry's lanes reach it, so it does not go in the RFC 0028 store at all.

An entry has exactly one source:

- **`body`: a published prompt.** Its versions live in `prompts:entry-version`, a collection the
  library owns. Rows are keyed `tenant:org:entryId:version` and hold a `PromptTemplate`-shaped
  `{ kind, text, variables? }`.
  - **Pinned.** The entry pins `bodyVersion`.
  - **Editing.** `PATCH` with `text` follows H1's order. It first writes the next version with
    `compareAndSwap(null)`, then CAS-swaps the entry's pin and revision. A losing CAS leaves only an
    unreferenced version, which nothing serves and the delete cascade removes.
  - **The only readers** are the entry's own lanes: the routes, `ctx.prompts`, and the share `load`.
    `/v1/prompts`, dispatch and every other entry cannot name it.
- **`promptRef`: a binding.** The entry binds a template in the prompt store, either the tenant's
  own (D5) or a global one, through ONE resolver, `resolveTenantTemplate(tenantId, ref)`.
  - **The template is not private.** It is tenant content under RFC 0028 posture, readable by every
    member with `prompts:read`. A private entry that binds one keeps its name, description and tags
    private, not the template.
  - **Refused refs.** `chainmint-*` is refused (H2): those are per-workflow artifacts whose presence
    varies by instance.

Every reader moves to the library's ONE resolver, `resolveEntryBody(entry)`:

- `assertPromptRef`;
- `renderEntry`;
- the share `load` (M1: it used to read only the global layers, so a published entry shared as
  `body: ''`);
- the `available` flag;
- import.

**Behaviour:**

- **Create and update** refuse a `promptRef` that does not resolve for the entry's tenant (400).
- **List and get** carry `available: boolean`, computed with one tenant-layer `listByPrefix` per
  request (L2), and the `{kind, text, variables}` of a readable entry so the page can edit it.
- **Render** answers 404 for an unavailable entry.

**Every delete cascades** (M2): share links, then body versions, then the entry
(`compareAndDelete`). A partial failure can then be retried, and a private body never outlives its
entry.

### D5 — User-source templates belong to one tenant and live in storage

The in-memory `userTemplates` map in `host/promptStore.ts` is deleted.

**One tenant layer.** User templates live in ONE tenant-keyed durable layer,
`host/tenantPromptTemplates.ts`.

- **Namespace.** It owns the existing `proposal-installed-prompts` namespace. The name is kept on
  purpose: prod has 0 rows, but local databases may have some, and renaming would orphan them.
- **Two writers.** The ADR 0972 installer and `POST`/`PUT /v1/prompts` both write it, so there is
  one tenant layer, not two.
- **Versions.** A version row is created with `compareAndSwap(null)`, so it is immutable and a
  concurrent duplicate is a 409. Rows are stamped `meta.source: 'user'`.

**Resolution order: global first, then tenant** (H2). Host and pack templates already win a
collision at create time, so lookup agrees with that. The tenant writer also refuses the
`chainmint-` prefix regardless of what this instance has registered. Without both, a member could
plant `chainmint-<predictable id>@1.0.0` on a cold instance and every from-chain run in the tenant
would compose it.

**The doors change:**

- **REST.** `routes/prompts.ts` reads and writes `tenantOf(req)` only. Another tenant's template is
  404 on every verb.
- **Caching** (H3). A tenant-layer `GET` answers `Cache-Control: private, no-store`. `public` stays
  for host and pack templates only. The Firebase `/api` door caches public responses, which would
  serve one tenant's pinned template to another at the same URL.
- **Render.** `:render` passes the resolved template to `composePromptTemplate`, so a tenant's own
  template renders.
- **Dispatch.** The two `getTemplate` call sites in `bootstrap/nodes.ts` resolve through
  `resolveTenantTemplate(ctx.tenantId, …)`. A run sees its own tenant's templates and no one
  else's.
- **Global lookup.** `getTemplate` stays synchronous for the global layers only.

ADR 0972 D4's installed templates were readable over REST but not at dispatch. With this they are
also usable at dispatch, which is what installing one is for (amends ADR 0972 D4).

**Replay and fork (M9).** An unpinned tenant ref at dispatch resolves to latest on a re-executed
dispatch. That was already true of the global map. It is recorded only as the `prompt.composed`
hash, and async resolution runs after `agent.promptResolved` is emitted (`nodes.ts:1410`), so event
order does not change. Library bodies are pinned (D4), so they are deterministic per revision.
Unpinned `/v1/prompts` refs are residue.

### D6 — DSAR: delete what is the subject's own, anonymize what is the org's

`eraseSubjectPromptEntries` is registered from `feature.ts` and added to the
`EXPECTED_SUBJECT_ERASERS` manifest. It matches `subjectKeyForms(key).forms`, which includes the
doubled `user:user:` spelling (DSAR-DBL). For each entry in the tenant (read through the tenant
index; the collection gains a `tenantOf` extractor):

- **A private entry the subject created is deleted** through the D4 cascade: links, then body
  versions, then the entry.
- **On every other entry, `createdBy` / `updatedBy` matching the subject become `[erased]`.**

`eraseSubject` asserts the tenant's retention hold before any eraser runs, so a held tenant keeps
everything.

**Classification.**

- `prompts:entry` moves out of `ACTOR_ATTRIBUTED_DEBT`, and the ceiling drops by one.
- `prompts:entry-version` is erased through its entry: private bodies are deleted with the entry,
  and org bodies are org content.
- The tenant template layer stamps no subject, and no library body lives there, so it is exempt for
  that reason.

### D7 — Export carries only what the exporter may read, and carries bodies

> **Found while implementing:** import used to write an entry into whatever
> `payload.orgId` named. That included an org the target tenant does not have,
> since org ids are global and a bundle carries the source tenant's. No route
> could ever reach such a row. With the `workspace:write` check, that item is now
> reported as `skipped` ("needs write access to org …"). A cross-tenant move has
> to point the bundle at the destination's org (`prompt-visibility-authority`
> leg 6d does this).

**Export.**

- **No caller, empty export.** The `prompt-template` export returns `[]` when there is no caller.
  That check runs before `runOrgScopeFilter`, which lets every org through for an undefined actor
  (M4).
- **Two identity spaces.**
  - Membership is checked with the raw caller id through `runOrgScopeFilter(…, 'workspace:read')`.
  - Ownership is checked with `canonicalPromptActor` through `readableBy`.
- **Bodies travel** (H4). A `body` entry exports its pinned `{kind, text, variables}`.

**Import.**

- **Bodies republish.** A `body` item is republished through D4.
- **Write scope.** Import requires `workspace:write` on the target org.
- **Dedupe.** It stays by (org, name), and looks only at entries the importer may read, so a
  co-member's private name is no longer an existence oracle.

### D8 — The `/prompts` page gets a Team library

The page keeps "My prompts" (local, unchanged) and adds a **Team library** tab on the same lazy
route, so the entry chunk is untouched. The tab:

- **Lists.** It lists the entries of ONE org at a time, with an org picker when the workspace has
  more than one. Each entry shows a visibility chip, an "unavailable" chip, and whether the caller
  owns it. (Corrected after code review P61CR-11: the first text said "across the workspace's orgs".
  The `/p-` commands are what cover every org.)
- **Publishes.** It publishes a prompt from My prompts, or a new one, as the library's own text
  (D4). It always copies the text: My prompts also lists demo-host samples that exist only in the
  SPA bundle, which the server cannot bind (grade-ux P61UX-7). Binding a template by reference
  stays an API path.
- **Default visibility is Team** (code review P61CR-10). The tab exists to share, and the field
  says who will see the prompt before anything is published. The API default stays `private`.
- **Edits.** It edits name, description, text and visibility with `expectedRevision`.
- **Deletes.** It deletes entries.
- **Uses in chat.** "Use in chat" stages the rendered text and navigates to `/chat` (M7: `/` is the dashboard redirect).

All copy ships in four locales.

### D9 — Doc truth

> Implementation note: the pack-description fix bumped `feature.prompts.nodes` from
> 1.1.1 to 1.1.2 (pin and steward digest included). No node changed.

- ADR 0116's status line gets a correction note that names what was not true.
- `routes.ts:45` and the pack description are corrected.
- The false header in `promptCommands.test.ts` is fixed.

## Alternatives weighed

- **Keep the global map, add a `tenantId` field.** This closes the cross-tenant read but leaves the
  template non-durable. A library entry pointing at it would still dangle after every deploy.
  Rejected.
- **Store the body on the entry.** Simplest for the library, but it creates the parallel prompt
  store ADR 0116 was written to avoid, and loses RFC 0028 versioning and dispatch reuse. Rejected.
- **A second tenant layer beside the ADR 0972 one.** Two tenant layers can disagree about what
  `getPromptTemplate` returns. Rejected for one layer with two writers.
- **Keep sending on `/p-*` and add a confirmation dialog.** This makes the user read in a modal what
  they could read in the composer, which is the one place they can also edit it. Rejected.

## `/architect` pass (adversarial, before code, 2026-10-27)

The pass found 2 Blockers, 5 High, 9 Medium and 4 Low findings. Every Blocker and High is folded in
above:

| Severity | Findings | Where it was folded in |
| --- | --- | --- |
| Blocker | B1, B2 | D4 rewritten: a body is library-owned and has no `library.` namespace |
| High | H1 | D4: pinned bodies, version-then-entry order |
| High | H2 | D5: global first, plus the `chainmint-` refusal |
| High | H3 | D5: tenant `GET` is `private, no-store` |
| High | H4 | D7: bodies travel, import needs `workspace:write` |
| High | H5 | D1: `CommandContext.insert` |
| Medium | M1–M9 | Folded in, except M5 and M8, which are residue below |

L1–L4 are noted. L1 (concurrent `PUT`s of two greater versions both land) is inside RFC 0028
semantics, since each version is still immutable.

## Review passes after implementation (2026-10-27)

`/grade-code` (CODE B, 14 findings), `/grade-ux` (UX C+, 15) and `/code-review` (3 Blockers,
2 High, 6 Medium, 4 Low) ran over the branch. Closed in the branch:

| Finding | Fix |
| --- | --- |
| P61CD-1 / P61CR-3 (High/Blocker, probe-reproduced) | A lost entry CAS left its new body version behind, and every later text edit recomputed that version and 409'd forever. Now: next version = max stored + 1 minor, and the loser deletes the version it wrote. |
| P61CD-2 / P61CR-6 | `cascadeDelete` removes the row first (compare-and-delete), then links and bodies. |
| P61CD-3 | List resolves with one body prefix read per org and one resolve per distinct ref. |
| P61CD-4 | Tenant writer validates the RFC 0028 id grammar and semver. The pinned read checks the row's own id and version (`::` in an id could alias a key). |
| P61CD-5 / P61CR-7 | Import claim is per importer for private items; the skip message no longer names a concurrent import. |
| P61CD-6 | Visibility is the owner's in both directions. A co-member narrowing an org entry took it from the whole org. `prompt-visibility-authority` leg 3 now pins this. |
| P61CD-7 | A body whose pinned row is gone can be repaired (`kind` accepted on update; the form shows it). |
| P61CD-8 / P61UX-3 | A `/p-` render failure puts the command back in the composer and says why. It never sends. The submitting-composer mark is cleared on unmount. |
| P61CD-9 | Non-integer `expectedRevision` is a 400; malformed `If-Match` is a 400. |
| P61CD-10 | A share of an entry whose text is gone answers not-found, never an empty body. |
| P61CD-11 | DSAR retries a lost CAS (bounded) and logs `prompt_erasure_cas_lost`. |
| P61CD-12 / P61CR-5 | The new `as unknown as` cast and the two existing ones in `nodes.ts` are removed; the types already agree. |
| P61CD-13, -14 | Doc comments corrected; test-only export removed. |
| P61CR-1, -2 | `useInChat` renamed (rules-of-hooks); `retry: retryOrgs` (org-selection ratchet). |
| P61UX-1 / P61CR-4 | Duplicate "Share with team" button on cards. |
| P61UX-2 | The English lede had not been updated (my locale script's guard could not fail). |
| P61UX-4 | A stale edit keeps the form and its text, and offers the reload. |
| P61UX-5 | Reload after a write is a background refresh, so focus returns to its trigger. |
| P61UX-6 | 403 says "you can use but not change"; the visibility field is disabled for a non-owner. |
| P61UX-7 / P61CR-9 | Share always copies the text (see D8). |
| P61UX-9 | Command descriptions read "Insert: …". |
| P61UX-10 | The tab is bound to `?tab=` (`useUrlTab`). |
| P61UX-11 | New Spanish strings use usted. |
| P61UX-12 | A disabled "Use in chat" is described by its chip; save shows a loading label. |
| P61UX-15 | "Use in chat" on a deleted entry says so and reloads. |
| P61CR-13 | Slug suffixes are assigned oldest-first. |

## Residue (recorded, not closed here)

- **P61UX-8 — `/p-` in a channel conversation.** It posts the literal text, as every slash command
  does there today. The channel branch runs before `runCoreSubmit`, so this is the command
  registry's behaviour, not this feature's.
- **P61UX-13 — two delete patterns on one page.** The Team library uses `ui/confirm`; My prompts
  uses its own modal.
- **P61UX-14 — the org is not mirrored to `?org=`.** The `/p-` command description does not name
  the org when two orgs' prompts collide into `-2`/`-3` suffixes.
- **P61UX-5, partly — focus after Share.** "Share with team" switches tabs, so its trigger
  unmounts and focus returns to the page.
- **P61CR-15 — dispatch wiring is pinned by a source read.** Both call sites passing
  `ctx.tenantId` are checked by reading the source. The resolver's behaviour is executed, but no
  node dispatch is.
- **P61CD-9, partly — a stale `If-Match` answers 409 `conflict`, not RFC 9110's 412.** One
  status for both spellings of the precondition.
- **The `/v1/prompts` list paginates by offset over a durable layer.** It can skip or repeat a
  row across pages when templates are written in between.
- **The `k:*` operator env-key lane shares the `default` tenant layer.** A `*` env key leaves
  `req.tenantId` unset (`middleware/auth.ts:1233`), so `tenantOf` answers `default`. Plain `k`
  env keys (tenant `default`) write the same bucket. Both are host-env operator credentials, and no
  user or anonymous caller reaches that lane. Follow-up: refuse `/prompts` writes from the `k:*`
  lane. Raised by the release manager on #5324.
- **M5: DSAR misses tenant-salted spellings.** An owner stamped `userIdFor(tenantId, raw)` (an
  import by a non-cookie caller, or the `ctx.prompts` lane in a shared workspace) is a
  tenant-salted hash, and `subjectKeyForms` does not produce it. A DSAR keyed by the home `userId`
  misses those rows.
- **M8: no admin lane** for a departed member's private entries, short of DSAR.
- **Org membership is not per template.** `/v1/prompts` writes are authorized by tenant
  co-residency plus the key-lane `prompts:write` scope (the RFC 0028 host posture). An entry that
  binds a tenant template inherits that posture.
- **Shared workspaces and non-cookie callers.** In a shared workspace, the `ctx.prompts`
  canonicalization (`canonicalPromptActor(runTenant, raw)`) differs from the route's home `userId`
  for a caller that is not a cookie user (API key, bearer). Such an owner cannot read their own
  private entry from a workflow there. Prod has no entries.

## Phased plan

Single PR. Each phase is a commit:

1. D5 + D4: the tenant layer, the resolver and the library body store.
2. D2 + D3: owner lanes and CAS.
3. D6 + D7: erasure and export.
4. D1: the picker.
5. D8: the page.
6. D9: doc truth.
