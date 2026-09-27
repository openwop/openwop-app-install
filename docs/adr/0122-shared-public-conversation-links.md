# ADR 0122 — Shared public read-only conversation links

**Status:** implemented — **§ Status-correction (2026-07-17, code-verified audit):** both follow-up-audit gaps below SHIPPED — the public `/shared/:token` viewer handles conversations (`features/sharing/SharedSharePage.tsx`, route in `App.tsx`) and the chat Share affordance mints owner-only links (`chat/ChatHeader.tsx` `onShare` → `useConversationActions.tsx` `createLink`, gated on sharing access). Original text retained below. Previously: in-progress — **Phase 1 implemented** (2026-06-24): the `conversation` ShareResolver — ONE registry entry in the existing Sharing service (no new token recipe / public surface). `validate` (exists-in-tenant via `hostExtStorage().getChatSession`), `load` (read-only transcript snapshot via the ADR 0119 `transcriptToMarkdown` — no parallel renderer; composer-less, untrusted content inert), `card` (title + first line). Mint/resolve/revoke flow through the existing `/sharing/*` + `/shared/:token`. **Phase 2 (owner-only mint) implemented** (2026-06-24): a conversation is OWNER-scoped, so `createLink` now gates a `conversation` mint on `meta.ownerUserId === actor` — only the conversation owner may share it, not any tenant member with workspace:write (an unowned legacy conversation stays mintable). **Phase 3 (snapshot-up-to-marker) implemented** (2026-06-24): the share resolver now threads the link's mint time (`createdAt`) as a `snapshotAt` marker; the conversation `load`/`card` expose ONLY messages created at-or-before it — turns added to the live thread AFTER the link was minted stay private (the public link can't leak the conversation forward). Other resource resolvers ignore the marker (back-compat). The frontend public view (Phase 4) pending. **Date:** 2026-06-23
**Toggle:** `sharing` (rides the existing Sharing feature, ADR 0013) · default **OFF** · `bucketUnit: tenant`. No *new* toggle — a conversation share is a new **resolver type** in the existing Sharing registry, gated by the same `sharing` curtain.
**Surface:** the existing authed `/v1/host/openwop-app/sharing/*` (mint/list/revoke) + the existing public `/v1/host/openwop-app/shared/:token` (resolve) — host-extension, non-normative. **No new route prefix.**
**Depends on / composes (all implemented — this is one registry entry + one snapshot, not new infra):**
- **ADR 0013 (Sharing — resolver registry + public surface)** — the share-link store, the unguessable capability token, mint/list/revoke, the public `/shared/:token` resolver, and `PUBLIC_PATH_PREFIXES` are all owned here. This ADR adds **one `ShareResolver` map entry** (`conversation`). **No new token recipe, no new public surface, no new IDOR/404 plumbing.**
- **ADR 0102 (chat persistence) / ADR 0043 (conversations)** — `Storage.{getChatSession,listChatMessages}` + `ConversationMeta` (owner/participants) are the data the snapshot is built from.
- **ADR 0119 (conversation export render)** — the **same** transcript renderer; the public read-only projection is a snapshot of that render (no parallel renderer).
- **ADR 0027 (connected-content trust)** — rendered message bodies on a public page are **taint-marked / sanitized** so a shared conversation containing a prompt-injection cannot execute or mislead a viewer's tooling, and so untrusted external content is visibly fenced.

**RFC verdict:** **host-extension (non-normative public surface) — NO new RFC.** Conversation sharing is the ADR 0013 mechanism with one more resource type; the public `/shared/:token` surface is already non-normative and never touches the OpenWOP wire. A normative cross-host "shared conversation" advertisement would earn an RFC then — not now.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 (sharing/collaboration) / §11 (gap catalog, item B13): OpenWOP has public resource sharing (ADR 0013) but **not** for conversations — you cannot hand someone a read-only link to a chat. Competitor impl paths: **LibreChat** shared-link routes (`api/server/routes/share.js`); **Open WebUI** `models/shared_chats.py`. The boundaries audit (below) shows this is ~95% the existing Sharing seam.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a conversation-sharing service with its own token, its own public route, its own tenant-resolution and 404 discipline." Every one of those already has a single owner in ADR 0013; re-implementing any is the `no-parallel-architecture` violation (and worse — a second public surface is a second attack surface to get wrong).

| Concern | Existing owner (file:line) | How conversation-share reuses it |
|---|---|---|
| Share-link store + unguessable token | ADR 0013 — `DurableCollection<ShareLink>('sharing:link')`, `randomBytes(32)` token (`features/sharing/`) | A conversation link is a normal `ShareLink` with `resourceType:'conversation'`, `resourceId:<sessionId>`. No new store/token. |
| Mint / list / revoke (authed) | ADR 0013 — `/v1/host/openwop-app/sharing/orgs/:orgId/links` (`features/sharing/routes.ts`) | Unchanged routes; minting a conversation link is the same `POST` with the new `resourceType`. |
| Public resolve + uniform 404 | ADR 0013 — `GET /v1/host/openwop-app/shared/:token` on `PUBLIC_PATH_PREFIXES` (`middleware/auth.ts:145-149`) | The public resolver dispatches to the `conversation` resolver's `load`; missing/expired/revoked/feature-off ⇒ uniform 404 (no enumeration). No new prefix. |
| Tenant derivation (from the resource, never the request) | ADR 0013 — the link carries `tenantId`; the public surface reads it from the link | Inherited verbatim — tenant comes from the `ShareLink`, gated on that tenant's `sharing` toggle. |
| Resolver registry (pluggable types) | ADR 0013 — `RESOLVERS: Record<ResourceType, ShareResolver>` (`cms_page`, `kb_collection`, `document`) | **One new entry: `conversation`.** Three methods (`validate`/`load`/`card`) over `getChatSession`/`listChatMessages`. |
| Transcript render | ADR 0119 — `transcriptToMarkdown`/JSON | The public `load` returns a **read-only snapshot** of that render (sanitized). No parallel renderer. |
| Untrusted-content fencing | ADR 0027 — `contentTrust`, sanitize-on-render | Public-rendered bodies are sanitized + untrusted-fenced so a shared injection can't run in a viewer's context. |

**Net new (small):** one `conversation` `ShareResolver` (validate: caller owns the conversation; load: a sanitized, read-only transcript snapshot; card: title + first-line preview), the **snapshot semantics** (point-in-time vs. live — see Decision), and a "Share this conversation" affordance in the chat chrome that calls the existing mint route. No new route, no new public surface, no new token plumbing.

---

## Decision

Register a **`conversation` resolver** in the **existing ADR 0013 Sharing registry**, so a conversation owner can mint a **revocable, read-only, unguessable public link** to a chat, resolved on the **existing public `/shared/:token`** surface. The link stores a **`(tenantId, orgId, resourceType:'conversation', resourceId:sessionId)` reference**; the resolver loads a **read-only, sanitized snapshot** of the transcript at resolve time. No new store, token, public route, tenant-resolution, or 404 path — all inherited from ADR 0013.

### Snapshot semantics — point-in-time, not live (the one real design call)

Unlike a CMS page (where live-resolve is the feature — an edit should reflect), a conversation is an append-only history that **keeps growing after sharing**. Default to **point-in-time snapshot**: minting captures `snapshotUpToMessageId` (the last message at mint time), and `load` renders **only messages up to that marker**. Rationale: the owner shares *what they have seen*, not a feed that silently leaks every future turn — including private follow-ups — to anyone holding the link. The link is still **live for revocation** (a revoked/expired link 404s immediately, ADR 0013) and the underlying conversation is never copied — `load` re-reads the persisted store and truncates at the marker, so a *redaction* (deleting a message) is reflected. An optional `live:true` mint flag (owner opt-in) shares the growing conversation for the collaborative-handoff case; default is the safe snapshot.

### The resolver (one registry entry, ADR 0013 shape)

```
conversation: ShareResolver {
  validate(tenantId, orgId, sessionId):   // mint-time: caller owns/participates? in-tenant? (uniform 404 else)
  load(tenantId, orgId, sessionId):       // read-only sanitized snapshot ≤ snapshotUpToMessageId (untrusted-fenced)
  card(tenantId, orgId, sessionId):       // {title, description:<first user line>, imageUrl?} for the social preview
}
```

`load` composes `getChatSession` + `listChatMessages` (truncated at the marker) → the ADR 0119 markdown render → an HTML/markdown read-only projection with **rendered message bodies sanitized + untrusted-fenced** (ADR 0027): no executable content, external instruction surfaces visibly marked, no live composer, no run controls.

### RBAC & isolation
**Only the owner can mint or revoke.** Mint reuses ADR 0013's `workspace:write` + the resolver's `validate`, which additionally asserts the caller is the conversation's **owner** (or participant per policy — v1: owner-only mint) via `ConversationMeta`/`callerSubject`; a cross-tenant/non-owned `sessionId` fails closed (uniform 404). Revoke is the existing `DELETE …/:token` (owner/`workspace:write`, IDOR-guarded). The public resolve is **unauthenticated by design** — the 32-byte token IS the credential; tenant is derived from the link (never the request); the surface is gated on the link-tenant's `sharing` toggle; missing/expired/revoked/feature-off all 404 uniformly. Rate-limited via the existing per-IP read budget on the public prefix.

### Replay / fork safety
A share link is config, not a run — replay-irrelevant. The public render performs **no LLM call** and runs **no tools** (it is a static, sanitized snapshot), so a prompt-injection inside a shared conversation has no execution surface on the public page (the ADR 0027 `prompt-injection-no-llm-approval` posture). Revocation is immediate and authoritative (the ADR 0013 soft-revoke → uniform 404).

---

## Evaluation matrix

| # | Criterion | Verdict |
|---|---|---|
| 1 | Feature-package architecture | **No new package** — one `ShareResolver` entry in `features/sharing/` (the registry is the extension point, ADR 0013). |
| 2 | Toggle + admin/UI | Rides the existing `sharing` toggle (OFF, `bucketUnit: tenant`); "Share conversation" affordance in chat chrome → existing mint route. |
| 3 | Reuse-not-recreate | Store, token, public surface, tenant-resolution, 404, renderer all composed (ADR 0013 + 0119); net-new is one resolver + snapshot semantics. |
| 4 | Workflow + node packs | None — public resolve is a static read; no run. |
| 5 | AI-chat envelopes + agent packs | N/A — a sharing surface, not a chat-drivable capability. |
| 6 | Public surface discipline | **Inherited from ADR 0013:** `PUBLIC_PATH_PREFIXES` already has `/shared`; tenant from the link/resource (never the request); uniform 404; per-IP rate-limit; token is the credential. No NEW public route. |
| 7 | RBAC fail-closed | Owner-only mint/revoke (`validate` asserts ownership); cross-tenant/non-owned `sessionId` → uniform 404. |
| 8 | Replay/fork safety | Config, not a run; public render does no LLM call / no tools; revoke is immediate. |
| 9 | Caps / rate-limit / payload | Existing per-IP read budget on `/shared`; snapshot truncated at marker bounds payload; per-link expiry available. |
| 10 | RFC gate | **Host-extension — NO RFC.** Non-normative `/shared/:token` resolver; the conversation projection is host-local, not a wire type. |

---

## Phased plan

1. **`conversation` resolver.** Add the registry entry in `features/sharing/`: `validate` (owner + in-tenant), `load` (sanitized snapshot ≤ marker via ADR 0119 render + ADR 0027 fencing), `card` (title + first-line). Persist `snapshotUpToMessageId` (+ optional `live`) on the `ShareLink` for this type. +resolver tests.
2. **Mint/revoke wiring.** No route change — verify a `resourceType:'conversation'` mint flows through the existing `POST …/sharing/orgs/:orgId/links` with the ownership check; revoke via existing `DELETE`. +route tests (owner-only mint, IDOR-404, cross-tenant fail-closed).
3. **Public resolve hardening.** Confirm `/shared/:token` dispatches to `conversation.load`; assert uniform 404 on missing/expired/revoked/feature-off; assert the rendered page is sanitized + untrusted-fenced + composer-less. +a hostile-injection share fixture (a shared conversation containing an injection renders inert, no executable content).
4. **Frontend.** "Share this conversation" in the chat chrome (mint with optional expiry + copy public URL + revoke), a read-only public conversation view route, and the share list. `npm run build` gate green; `ui/` cohesion + a11y.
5. **Tests + docs.** Snapshot-not-live semantics (a turn appended after mint does NOT appear unless `live`), revoke→404, owner-only mint, sanitization, social card.

## Alternatives weighed

1. **A new `conversation-sharing` feature-package with its own public route + token.** Rejected — duplicates the entire ADR 0013 security surface (token recipe, `PUBLIC_PATH_PREFIXES`, tenant-from-resource, uniform 404); the registry exists precisely so a new shareable type is one map entry (the ADR 0013 §"pluggable, not special-cased" thesis).
2. **Live-resolve only (CMS-style), no snapshot.** Rejected as the default — a conversation grows after sharing; live-resolve silently leaks every future turn to anyone holding the link. Point-in-time snapshot is the safe default; `live` is an explicit owner opt-in.
3. **Copy the transcript into the link (immutable share record).** Rejected — `load` re-reads the live store and truncates at the marker, so a redaction reflects and there's no second copy to GC (the ADR 0013 alt-2 "snapshot share needs a versioned copy + GC" caveat; the marker gives point-in-time without a copy).
4. **Participant-mintable (any participant can share).** Deferred — v1 is owner-only mint (the conservative confidentiality posture); a participant-share policy is a follow-on (it needs a per-conversation share policy).

## Open questions

1. **OQ-1 — Snapshot vs. live default.** v1 defaults to point-in-time snapshot + an opt-in `live`. Is the collaborative handoff common enough to flip the default? (Lean: no — confidentiality first.)
2. **OQ-2 — Comment/fork on a shared link.** LibreChat allows "continue from a shared chat." v1 is read-only; "import this shared conversation into my own" is the ADR 0119 import path (a viewer with an account), not a public-write surface.
3. **OQ-3 — Per-link access controls.** Password / view-count caps / view audit — the same open question ADR 0013 carries; inherited, not solved here.
4. **OQ-4 — Card richness.** Server-rendered OG image for a conversation preview depends on the ADR 0013 image surface (still open there).

> **Phase 4 (admin label sync) implemented** (2026-06-24):** the FE sharing `ResourceType` union was 3 types behind the backend (`cms_page | kb_collection` only), so a `conversation`/`document`/`prompt` share link rendered a broken `t(undefined)` label in the admin list. Synced the FE union to the backend's authoritative `RESOURCE_TYPES` + completed `TYPE_LABEL_KEY` (5 entries) + added the labels in 4 locales — so conversation (ADR 0122) / document (ADR 0053) / prompt (ADR 0116 2b) share links now display correctly. /architect (inline boundary check — single source = the backend union; no new system), /code-review + /ux-review clean. The public conversation-view page + the mint-picker options for the new types (need `listResources`) pending.

> **Phase 5 (mint-picker for all types) implemented** (2026-06-24):** the SharingPage mint-picker now lists + mints all 5 resource types. The backend already resolves `document`/`conversation`/`prompt` (RESOURCE_TYPES); the gap was FE-only — `listResources` handled only cms_page/kb_collection. Extended it to fetch each new type via its OWNING feature's list endpoint (`/documents/orgs/:orgId/documents`, `/prompts/orgs/:orgId/entries`, `/chat/sessions` (tenant-scoped)) + added the 3 picker options (reusing the Phase-4 `typeDocument`/`typeConversation`/`typePrompt` labels — now referenced, not orphaned). Best-effort ([] if the source feature is off). /architect (inline — composes each feature's existing list endpoint; no new backend), /code-review + /ux-review clean (select labeled via the wrapping `<label>`; i18n×4; no hex). 4 listResources tests (document/prompt/conversation mapping + feature-off → []). ADR 0122 is now complete (mint + resolve for all share types).

---

## Follow-up action — surfacing audit (2026-06-24)

**Audit verdict:** 🟠 mint + resolve are complete, but the **headline UX — "hand someone a
link to a chat" — is not deliverable.** Two gaps remain (the ADR's "now complete" claim is
about mint/resolve plumbing, not the user-facing flow):
1. **No public viewer page.** The public `GET /v1/host/openwop-app/shared/:token` returns
   raw JSON; there is no `/shared/:token` React route, so a recipient sees JSON, not a
   rendered read-only conversation.
2. **No share affordance in chat.** The conversation owner can only mint from the admin
   `SharingPage`; there is no "Share" control in the chat chrome.

**Seam-correct action (reuse `features/sharing`):**
1. Add an **unauthenticated `/shared/:token` viewer page** (App.tsx public route, following
   the CMS/Media public-route pattern) that renders the share card + read-only transcript
   the public endpoint already returns. Point-in-time snapshot + owner-only mint are already
   enforced server-side, so no new authz.
2. Add a **"Share" item to `ChatHeader`** that mints a `conversation` link via the existing
   sharingService (owner-only — already gated `meta.ownerUserId === actor`) and copies the
   URL.

**Boundary check:** single owner stays `features/sharing` (no second share system); the
viewer is read-only + unauthenticated; the chat button is owner-only. (Closes OQ-2's
read-only stance without a public-write surface.)

---

## Correction note — share-viewer discretion + snapshot honesty (2026-07-24, `docs/steward/UX_UPGRADE-sharing.md`)

The public viewer had already been through a polish pass and graded well on
looks, states and a11y. The gap this benchmark found was **discretion** — the one
dimension a link-sharing surface cannot be casual about. Details in
`docs/steward/UX_UPGRADE-sharing.md`.

**SH-G3 — capability-token pages are now `noindex,nofollow`.** `robots.txt`
serves `Allow: /` with no disallow for token surfaces, and the SPA set no robots
meta, so a `/shared/:token` URL that leaked into a referrer header, a pasted
forum post or a screenshot was indexable. The token being unguessable is exactly
why an index entry would BE the breach. A new shared helper
(`features/site/siteSeo.ts` → `applyUnlistedHead`) sets the meta and a real
document title while the page is mounted and **undoes both on unmount** — a naive
version would leave the entire SPA marked noindex for the rest of the session
once a visitor followed one share link and navigated on. That undo is
test-asserted.

**SH-G1/SH-G2 — the viewer now says it is reading a SNAPSHOT.** `resolveShared`
already loads the resource with `{ snapshotAt: link.createdAt }` and then threw
that instant away, so a recipient reasonably assumed they were looking at
something live. It now returns `snapshotAt` (and `expiresAt` when the owner set
one) — data the token-holder is already authorized to see — and the viewer says
"Snapshot from <date>" beside the read-only chip. When the server sends no
instant, the page claims nothing rather than defaulting a date.

**SH-G4 — one `ShareFrame` for all four resource types.** The conversation, quote,
app-design and slide-deck branches each carried their own copy of the header and
footer. That duplication is precisely why adding the snapshot line was risky: it
would have landed in three of four by accident. Fixing it first made SH-G2 a
one-line change, and the test parameterises across all four types.

Follow-on, deliberately not done here: `/sign/:token` and the booking-manage URL
are the SAME capability-token shape and still carry no `noindex`. The helper they
need now exists; adopting it belongs in the `crm` feature's own pass with its own
ADR note (ADR 0402), not as a drive-by edit from this one.
