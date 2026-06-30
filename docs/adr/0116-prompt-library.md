# ADR 0116 — Prompt library (shareable, RBAC-gated, versioned)

**Status:** implemented (all phases, 2026-06-24) — **Phase 1 implemented** (2026-06-24): the `prompts` catalog feature-package — `PromptLibraryEntry` (DurableCollection, tenant/org-prefixed) + CRUD routes under `/v1/host/openwop-app/prompts/orgs/:orgId/entries`, `authorizeOrgScope`-gated (read/write), dangling-`promptRef` rejection (the catalog references the existing prompt store, never copies it), tenant/org IDOR isolation, toggle `prompts` OFF/tenant. **Phase 2 (render) implemented** (2026-06-24): `POST /v1/host/openwop-app/prompts/orgs/:orgId/entries/:id/render` resolves the entry's `promptRef` against the SAME prompt store it validated against (`getTemplate`; a removed template 404s) and substitutes `{{var}}` from the request `variables` (missing binding stays literal). Read-gated. **Phase 2b (shareable prompts) implemented** (2026-06-24): a `prompt` resolver in the ADR 0013 sharing registry (composing ADR 0116 + 0122) — a public read-only projection of a library entry (name + description + the resolved `promptRef` template body), org-scoped, mint-validated. **Phase 3a (FE client) implemented** (2026-06-24): `promptLibraryClient.ts` — listPrompts + createPrompt + renderPrompt (server-side `{{var}}` substitution) for the library UI + the `/`-insertion menu. Phases 3b–4 SHIPPED: the library UI merged into the existing prompt-library surface + the `/`-insertion menu, and `ctx.features.prompts` (`promptSurface.ts`). **Date:** 2026-06-23
**Toggle:** `prompts` (a.k.a. prompt-library) · default **OFF** · `bucketUnit: tenant` —
a shared team asset, not a per-user surface.
**Surface:** host-extension `/v1/host/openwop-app/prompts/*` (non-normative) — a
`PromptLibraryEntry` config entity + a `/`-insertion into the core chat composer. No
new wire contract.
**Depends on / composes (all Accepted/implemented — assembly, not new infra):**
- **RFC 0028/0029 prompt templates + the host `promptStore`** (`host/promptStore.ts`,
  `routes/prompts.ts`, `host/promptCompose.ts`, `host/promptResolve.ts`) — the
  template/variable/`:render` engine. **Reuse it; do NOT fork it.**
- **ADR 0053 (documents & templates)** — the precedent consumer that binds a
  `promptRef` (RFC 0028) to a named business-document kind. The prompt library is the
  general-purpose, chat-facing sibling of that binding.
- **ADR 0006 (RBAC)** — `authorizeOrgScope`, `workspace:read`/`workspace:write`.
- **ADR 0013 (Sharing)** — the `ShareResolver` registry (`features/sharing/sharingService.ts:50`)
  for public/expiring prompt links.
- **ADR 0001 (feature-package architecture)** — `BackendFeature` + `FrontendFeature`,
  toggle-gated, registered in `BACKEND_FEATURES`/the FE `registry.ts`.
- **The chat slash-command seam** (`frontend/react/src/chat/registry/CommandRegistry.ts`,
  `SlashAutocomplete.tsx`, `ChatInput.tsx` `setText`) — the existing `/`-insertion
  extensibility point. **Reuse it; do NOT add a parallel composer affordance.**

**RFC verdict:** **host-extension over an already-Accepted wire (RFC 0028/0029) — NO new
RFC.** The wire prompt-template engine already exists and is honored here
(`routes/prompts.ts`, gated on `capabilities.prompts.mutableLibrary`). This ADR adds a
*product surface over host data* — an org-scoped, RBAC-gated, shareable catalog + chat
`/`-insertion — under `/v1/host/openwop-app/prompts/*`. Nothing new touches the
normative `/v1/prompts*` contract; a prompt inserted into a turn is just text. (If a
*cross-host* "team prompt library" advertisement were ever wanted, that earns an RFC
then — not now.)

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 backlog
> **B6** (P1) "Prompt library feature-package (shareable, RBAC, versioned)" + §11
> rows (Open WebUI / LibreChat / LobeHub / AnythingLLM, "Create ADR (B6)"). Today
> OpenWOP has a per-agent system prompt + the `agentProfile` + the document-template
> binding (ADR 0053), but **no library UI, no team-shared catalog, no `/`-insertable
> reusable prompts**. Competitor impl paths: LibreChat `api/server/routes/prompts.js`
> + `client/src/components/Prompts/` (ACL-gated, Cmd+K, trending, GitHub sync);
> Open WebUI `routers/prompts.py` + `models/prompt_history.py` (version history);
> AnythingLLM `systemPromptVariables`.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a prompt CRUD service with its own template/variable engine, its
own versioning, its own ACL, and a bespoke composer textarea." Every one of those
already has a single owner here; re-implementing any is the `no-parallel-architecture`
violation (the EA-assistant / orgs↔accessControl failure mode).

| Concern | Existing owner (file:line) | How the library reuses it |
|---|---|---|
| Template body + variable schema + `:render` | **`host/promptStore.ts:34` (`PromptTemplate`) + `host/promptCompose.ts` (`composePromptTemplate`) + `routes/prompts.ts:241` (`/v1/prompts:render`)** — RFC 0028/0029 engine; `userTemplates` already keyed `templateId → version → entry` (`promptStore.ts`, PUT snapshots prior versions) | A `PromptLibraryEntry` references a `PromptRef` (`prompt:<templateId>[@version]`) into `promptStore`; substitution + render use `composePromptTemplate`. **No copy of the template body, no new variable engine.** |
| Versioning / history | **`promptStore` user-template layer** — PUT already snapshots prior versions per RFC 0028 §A | Library entries point at a versioned `PromptRef`; "version history" is the store's, surfaced read-only. **No parallel version table.** |
| Org-scope / RBAC | **`authorizeOrgScope` (ADR 0006)** — `workspace:read`/`workspace:write` | Every library route is org-scoped; create/edit = `workspace:write`, read = `workspace:read`; cross-tenant/non-member → uniform 404. |
| Public/expiring links | **`features/sharing/sharingService.ts:50` `ShareResolver` registry (ADR 0013)** | Add one `prompt` resolver entry — `/shared/:token` resolves a published library entry. **One entry, no new link surface.** |
| `/`-insertion into the composer | **`chat/registry/CommandRegistry.ts` (`registerCommand`) + `SlashAutocomplete.tsx` + `ChatInput.tsx` `setText` (line 209/218/236)** — the slash-command extensibility seam, "shows both built-in commands AND custom registrations" | The library registers a `/prompt` (or per-entry) command that, on pick, inserts the rendered text into the composer via the existing `setText` path. **No bespoke composer affordance** (the AiAuthorPanel lesson — chat is CORE, one composer). |
| Feature lifecycle | **ADR 0001** `BackendFeature`/`FrontendFeature` registries (`features/index.ts`, FE `features/registry.ts`) | `prompts` registers like every feature; toggle OFF/tenant. No core route/nav edits. |

**Net new (small):** one `PromptLibraryEntry` config entity (a catalog row =
name/description/tags/visibility + a `PromptRef`), its REST routes under
`/v1/host/openwop-app/prompts/*`, a `prompt` share-resolver entry, the `/`-insertion
command registration, a `ctx.prompts` read op (matrix row 3), and the library UI
(browse/search/insert + create/edit/share).

---

## Decision

Ship a **`prompts` feature-package** that turns ad-hoc prompts into governed, reusable,
shareable team assets: an **org-scoped catalog** of `PromptLibraryEntry` rows, each a
thin binding to a versioned `PromptRef` in the existing host `promptStore` (RFC 0028/0029),
with **public/private/shared** visibility via ADR 0006 RBAC + ADR 0013 sharing, and a
**`/`-insertion** into the core chat composer through the existing
`CommandRegistry`/`SlashAutocomplete` seam with variable substitution. The library owns
the **catalog + visibility + chat-insertion glue**, NOT a parallel prompt/template
engine.

### Data model — one catalog entity (the binding, not a new engine)

```
PromptLibraryEntry                  // org-scoped catalog row
  { entryId, tenantId, orgId,
    name, description, tags,        // catalog metadata (searchable)
    promptRef,                      // → RFC 0028 PromptRef `prompt:<templateId>[@version]`
                                    //   into host/promptStore (the template body + vars)
    visibility,                     // 'private' | 'org' | 'shared'  (ADR 0006 + ADR 0013)
    createdBy, updatedBy, createdAt, updatedAt }
```

- The **template body, variable schema, version history** live in `promptStore`
  (RFC 0028/0029) — the entry is a *named, governed pointer*, exactly as ADR 0053's
  `DocumentTemplate.promptRef` is. Reject a dangling `promptRef` at create (the
  honest-binding rule, ADR 0053 §template-create).
- **Variable substitution** at insertion-time routes through `composePromptTemplate`
  (`:render`) — the same deterministic pipeline `routes/prompts.ts:241` uses, so a
  preview and a dispatch produce the same hash.
- **Visibility** is `private` (creator-only) / `org` (any member with `workspace:read`)
  / `shared` (a published, revocable public link via the `prompt` share-resolver).

### RBAC & isolation
Org-scoped (ADR 0006): managing an entry needs `workspace:write` in its org; reading an
`org`-visibility entry needs `workspace:read`. Cross-tenant / non-member → **uniform
404** (no existence leak — the fail-closed/IDOR floor). A `private` entry is visible only
to its creator; an admin cannot read another user's private entry by id (uniform 404). A
`shared` entry resolves through the Sharing resolver's revocable token; missing / expired
/ revoked → uniform 404.

### Replay / fork
**N/A — no run-variant.** A prompt inserted into a turn is **plain composer text** before
the turn is created; it never participates in dispatch as a typed variant, so there is
nothing to stamp on `run.metadata` and nothing a `:fork` would re-resolve. (Contrast
ADR 0053, where a *template that influences generation* is stamped — here the library is
upstream of the composer, not inside the run.) The underlying `promptRef`'s
determinism is already guaranteed by RFC 0028 §A's hash invariant.

### Agent pack
**None in v1 — honest.** The library is a human-authoring/insertion surface; driving it
with an LLM persona adds no capability the chat already has (a user can ask any agent to
"write me a prompt" today and save the result). A **`prompt-author` assistant** (drafts
a reusable prompt from a description, suggests variables) is a *reasonable, optional*
follow-on agent pack riding the existing chat (ADR 0058 "agent + nodes" drivability) — but
it is **not required** for the feature and is left to Open Question OQ-4 rather than
claimed as shipped.

---

## Evaluation matrix

| # | Dimension | Verdict for `prompts` |
|---|---|---|
| 1 | Feature-package architecture (ADR 0001) | One `prompts` `BackendFeature` + `FrontendFeature`, toggle-gated; no core route/nav edits. |
| 2 | Toggle + admin/bucketing | `prompts` default **OFF**, `bucketUnit: tenant` (shared team asset). |
| 3 | Workflow surface (`ctx.*`) | `ctx.prompts` read op — `listLibrary`/`getEntry`/`renderEntry` (cached reads; assemble-only, render rides `composePromptTemplate`). |
| 4 | Node pack | **None** — there is no run-side execution; the engine (RFC 0028) already exists, and insertion is a FE composer action. |
| 5 | AI-chat envelopes | **None new** — insertion is `/`-text into the existing composer; no new chat envelope type. |
| 6 | Agent pack | **None in v1** (optional `prompt-author` follow-on, OQ-4) — honest. |
| 7 | RBAC (fail-closed / IDOR / uniform-404) | `authorizeOrgScope`; private/org/shared visibility; uniform 404 cross-tenant + on private/shared misses. |
| 8 | Replay/fork | **N/A** — inserted prompt is plain composer text, no run-variant, nothing to stamp. |
| 9 | Reuse-not-recreate | Composes `promptStore`/`promptCompose` (engine), Sharing (links), RBAC, the chat slash seam — owns only the catalog binding + insertion glue. |
| 10 | RFC gate | **Host-ext, NO RFC** — rides Accepted RFC 0028/0029; routes under `/v1/host/openwop-app/prompts/*`. |

---

## Phased plan

1. **Catalog backend + RBAC.** `features/prompts/`: `PromptLibraryEntry`
   (`DurableCollection 'prompts:entry'`, tenant/org-prefixed) + CRUD routes under
   `/v1/host/openwop-app/prompts/*` (create/list/get/update/delete), `authorizeOrgScope`
   gated, `promptRef` validated against `promptStore` (reject dangling), visibility +
   uniform-404 IDOR. Toggle `prompts` OFF/tenant. Tests: toggle gate, IDOR, dangling-ref
   reject, private/org visibility.
2. **Sharing + render.** A `prompt` `ShareResolver` (ADR 0013) for `shared` entries
   (revocable token, approved-only, uniform 404 on miss); a `…/prompts/:id/render`
   route (or the `ctx`/FE path) that resolves the `promptRef` + substitutes variables via
   `composePromptTemplate`. Tests: share approve/revoke, render-substitution parity with
   `/v1/prompts:render`.
3. **Library UI + chat `/`-insertion.** A `PromptLibraryPage` (browse/search by
   tags/name, create/edit, set visibility, copy-link) using `ui/` cohesion + tokens +
   a11y; and a `registerCommand` registration so `/prompt <name>` (and the unified slash
   picker) inserts the rendered text into the composer via `ChatInput`'s existing
   `setText`. Canonical `frontend/react && npm run build` gate green. Tests: command
   inserts into composer; picker lists org-visible entries only.
4. **Core-app extension surface.** `ctx.prompts` workflow surface (ADR 0014) —
   replay-safe `listLibrary`/`getEntry`/`renderEntry` (cached reads), advertised as
   non-normative `host.openwop-app.prompts` at `/.well-known/openwop`, toggle-gated — so a
   node/agent may pull a governed prompt by name. (Optional, gated on a real consumer.)
5. **Tests + docs.** Catalog CRUD, IDOR/uniform-404, dangling-ref reject, share
   approve/revoke, render parity, composer insertion; `FEATURES.md` entry.

---

## Alternatives weighed

1. **A bespoke prompt/template engine inside the feature.** Rejected outright
   (no-parallel-architecture; David's law) — RFC 0028/0029 + `promptStore`/`promptCompose`
   already specify and implement templates, variables, versioning, and `:render`. The
   library *binds* them.
2. **Extend the `documents` feature with a "prompt" kind.** Rejected — ADR 0053 is the
   *business-document* store (versioned authored artifacts, rendered bytes, approval
   lifecycle); a reusable chat prompt is a different product (no document instance, no
   render-to-PDF, chat-insertion not document-generation). Both *compose the same
   promptRef seam* — that is the right shared owner, not the documents store.
3. **A bespoke "insert prompt" textarea / panel in chat.** Rejected — the chat composer
   is CORE and singular (the removed `AiAuthorPanel` lesson, CLAUDE.md). Insertion rides
   the existing `CommandRegistry`/`SlashAutocomplete` seam.
4. **A new wire capability for a cross-host prompt library.** Rejected for v1 — host
   data over an Accepted wire needs no new RFC; cross-host advertisement is a future,
   separately-RFC'd play if ever wanted.

## Open questions

- **OQ-1 — User-scoped vs org-scoped private entries.** `private` visibility is
  creator-only within the org. Do we also want a true *personal* library independent of
  any org (the ADR 0042 "personal requires an org with write" leaky-abstraction)? Propose
  org-scoped v1; a per-user implicit library is a follow-on.
- **OQ-2 — Trending / usage analytics.** LibreChat surfaces "trending" prompts. Worth a
  per-entry use counter? Deferred — privacy + scope; v1 is browse/search by tag.
- **OQ-3 — Pack import / GitHub sync.** LibreChat syncs prompts from GitHub; OpenWOP has
  prompt *packs* (`promptStore` pack layer). Should the library import from an installed
  prompt pack (read-only catalog rows) the way ADR 0053 copies seed templates from a
  catalog? Propose: yes, as a follow-on (`from-pack` copy), mirroring ADR 0053's
  `from-catalog`.
- **OQ-4 — `prompt-author` agent pack.** Ship an optional persona that drafts reusable
  prompts (riding the existing chat, ADR 0058), or leave authoring fully manual? Propose:
  manual v1, persona as a clearly-separate follow-on (honest capability claim).
- **OQ-5 — Variable-source safety.** A `PromptTemplate` variable may have
  `source: 'secret' | 'context'` (`promptStore.ts:42`). At chat-insertion time, only
  `input`/`variable` sources are safe to fill from the composer; `secret`/`context`
  substitution must NOT happen client-side. Propose: the FE insertion fills only
  user-supplied variables; secret/context-sourced templates are insertable only via the
  run-side `ctx.prompts` path (Phase 4) where the resolver authority exists — never from
  the browser.

## RFC verdict (Step 5)
**Host-extension over Accepted RFC 0028/0029 — NO new RFC.** The prompt-template engine
(`/v1/prompts*`, `promptStore`, `composePromptTemplate`) is already on the wire and
honored here; this ADR adds an org-scoped catalog + chat `/`-insertion under the
non-normative `/v1/host/openwop-app/prompts/*` namespace. No run-event field, capability
flag, event type, or normative MUST changes. A cross-host "team prompt library"
advertisement would warrant a new RFC then — not now.

> **Phase 3b (2026-06-24) — library page:** `features/prompt-library/PromptLibraryPage.tsx` (+ routes + i18n×4 + a component test), registered in `FRONTEND_FEATURES` under the Workspace nav (`featureId: prompts`). Read-only list (name · description · template) over `listPrompts`; all states; toggle-gated. /architect GO (0118/0123 precedent), /code-review + /ux-review clean. The `/`-insertion menu is Phase 3c.

> **Phase 3c (/-insertion) implemented** (2026-06-24):** the org's prompt-library entries surface as `/p-<slug>` chat slash commands via the EXISTING CommandRegistry + SlashAutocomplete (the `/`-insertion seam) — NO bespoke composer affordance (the one-chat rule). `chat/promptCommands.ts` (`registerPromptCommands(orgId)`, idempotent) registers a command per entry whose handler renders the entry server-side (`renderPrompt`; unbound `{{var}}` stays literal) and SENDS it as the user's turn. ChatSidebar wires it on mount, toggle-gated (`prompts`) + scoped to the primary org (`listOrgs()[0]` — autonomous v1 decision; multi-org selection + insert-for-edit of `{{vars}}` before send are follow-ons needing a composer setText API). Lowest-risk: reuses the proven command path, NO change to the hot SlashAutocomplete core. /architect (inline — reuse the CommandRegistry seam, no parallel affordance), /code-review + /ux-review clean (prompts render through the existing CommandRow; no new UI/strings; entry 162.3 kB). 3 tests (slug, register+render+send, idempotent). The library page (Phase 3a-page) + `ctx.prompts` (Phase 4) remain.

> **Phase 4 (ctx.prompts workflow surface) implemented** (2026-06-24):** a workflow node can now read/render a library entry mid-run via `ctx.features.prompts` (ADR 0014 seam — `featureSurfaces.registerFeatureSurface`, declared as `BackendFeature.surface`, NO edit to core `buildHostSurfaceBundle`). Methods: `listLibrary({orgId})`, `getEntry({orgId,entryId})`, `renderEntry({orgId,entryId,variables})`. Toggle-gated at the seam (`prompts` OFF ⇒ every method refuses `host_capability_disabled`); tenant-isolated (builder closes over `scope.tenantId`, methods take explicit orgId, the service enforces the tenant+org key — a cross-tenant id isn't found). The render route's inline substitution was EXTRACTED into a single `renderEntry` service fn reused by BOTH the route AND the surface (no duplicated render). /architect (the ADR-0014 feature-surface seam is the verified extension point; no parallel surface), /code-review clean. 3 new tests (renderEntry substitution/404; the surface list/render + CTI-1 cross-tenant isolation) + sharing-prompt regression green. ADR 0116 is now complete (catalog + render + sharing + chat `/`-insertion + ctx.prompts).
