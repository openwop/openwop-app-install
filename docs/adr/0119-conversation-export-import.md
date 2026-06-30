# ADR 0119 — Conversation export + import (markdown / JSON)

**Status:** implemented (all phases, 2026-06-24) — **Phase 1 implemented** (2026-06-24): the pure renderer (`features/chat-export/transcriptRenderer.ts`) — `transcriptToMarkdown` (title + per-message sections, structured cards as fenced JSON, order-preserving) + `transcriptToJson` (the round-trippable `openwop-v1` shape, authorship preserved). Deterministic + I/O-free. **Phase 2 implemented** (2026-06-24): the export route. `GET /v1/host/openwop-app/chat-export/:sessionId?format=md|json` renders the caller's OWN-or-participant transcript via the Phase-1 renderer; toggle `chat-export` OFF/tenant; owner/participant visibility (shared ADR 0043 predicate) → uniform 404. **Phase 4a (import parsers) implemented** (2026-06-24): `features/chat-export/importParser.ts` — pure `parseOpenwopExport` (the round-trippable openwop-v1 shape) + `parseChatGptExport` (the OpenAI mapping-tree → linear chronological path via `current_node`, cycle-guarded, best-effort). Normalize to `{title, turns}`; a hostile import is stamped untrusted at the WRITE step (Phase 4b), not here. **Phase 4b (import write) implemented** (2026-06-24): `importConversation(tenantId, ownerUserId, parsed)` creates a NEW owned conversation (chat session + meta) from the Phase-4a parsers' `{title, turns}` and appends each turn — SECURITY: every imported message is stamped `contentTrust:'untrusted'` + `source:'import'` in its meta, so a hostile import (prompt-injection) is fenced, never silently trusted. Turn/content caps applied. Phase 3 (as-Document, `asDocumentService.ts`) + the FE export/import (`useConversationActions` + ChatHeader, PR #925) SHIPPED. **Date:** 2026-06-23
**Toggle:** `chat-export` · default **OFF** · `bucketUnit: tenant` (a per-tenant data-portability surface; the *capability* is feature-gated, an individual export still requires owner/participant authority on the conversation).
**Surface:** host-extension `/v1/host/openwop-app/chat-export/*` (non-normative) — read-only transcript rendering + an import-via-`conversations/open` path. No new wire contract.
**Depends on / composes (all implemented — this is assembly, not new infra):**
- **ADR 0102 (chat history persistence + authorship)** — `Storage.{getChatSession,listChatMessages}` + `author_subject`; the persisted transcript is the source of truth this ADR renders. **No new transcript store.**
- **ADR 0043 (persistent conversations)** — the conversation model (`ConversationMeta`, participants, `type`) + the **`POST …/chat/conversations/open`** idempotent open-or-resume path import rides to materialize conversations. **No new conversation builder.**
- **ADR 0053 (Documents & Templates)** — optional "export as a Document" projects the rendered markdown into `documents:doc` (org-scoped, versioned). **No new document store.**
- **ADR 0007 (Media Library) / RFC 0055** — optional rendered-bytes (a `.md`/`.json` blob served by capability token) ride Media; never re-store bytes.
- **ADR 0006 (RBAC) / ADR 0102 authorship gate** — owner/participant authority (`callerSubject`, `requireManageAsync`) reused verbatim.

**RFC verdict:** **host-extension — NO new RFC.** Rendering a persisted transcript to markdown/JSON and rebuilding conversations through the existing `conversations/open` path are host-internal operations under `/v1/host/openwop-app/*`; nothing touches the OpenWOP wire. (A *normative* cross-host "conversation portability" envelope would earn an RFC then — not now.)

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 (data portability) / §11 (gap catalog, item B9): OpenWOP can neither export a transcript nor import one. Competitor impl paths: **Open WebUI** NDJSON chat export/import (`backend/open_webui/routers/chats.py`); **LibreChat** import adapters for OpenAI/ChatGPT/LibreChat exports (`api/server/utils/import/`). The boundaries audit (below) shows this is ~95% existing seams.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a chat-export service with its own transcript store, its own conversation-creation code, and its own blob writer." Every one of those already has a single owner here; re-implementing any is the `no-parallel-architecture` violation.

| Concern | Existing owner (file:line) | How export/import reuses it |
|---|---|---|
| Persisted transcript (messages, roles, authorship, timestamps) | ADR 0102 — `Storage.getChatSession` (`backend/typescript/src/storage/storage.ts:389`), `listChatMessages` (`:413`), `appendChatMessage` (`:416`), `author_subject` | Export READS `getChatSession` + `listChatMessages` and renders; it stores nothing. |
| Conversation model + authorship gate | ADR 0043/0102 — `host/conversationStore.ts`, `callerSubject`/`requireManageAsync` (`routes/chatSessions.ts:646-650`) | Export authz reuses the exact owner/participant check the message-edit route uses. |
| Materialize a conversation (idempotent) | ADR 0043 — `POST /v1/host/openwop-app/chat/conversations/open` (`routes/chatSessions.ts:665`) + `createChatSession`/`ensureConversationMeta` | Import creates the target conversation through this path, then appends parsed turns via `appendChatMessage`. NO new conversation builder. |
| Document projection | ADR 0053 — `documents:doc`/`documents:version` (`features/documents/`) | "Export as Document" calls the documents service; the rendered markdown becomes a versioned `documents:doc`. |
| Rendered bytes (a downloadable `.md`/`.json`) | ADR 0007 / RFC 0055 — Media capability-token blob | Optional download serves a Media token; never an inline blob store. |
| Untrusted-content discipline on imported text | ADR 0027 — `contentTrust:'untrusted'` | Imported message bodies are external content → stamped `untrusted` so a re-run can't treat them as instructions (see RBAC/replay). |

**Net new (small):** a transcript→markdown and transcript→JSON renderer (pure, deterministic), the two export routes + an optional "as Document" projection, a parser for the supported import formats (OpenWOP-JSON v1 + an OpenAI/ChatGPT export adapter) that drives `conversations/open`, and a thin "Export / Import" affordance in the conversation chrome. Toggle `chat-export` OFF/tenant.

---

## Decision

Ship a **`chat-export` feature-package** that (a) **renders** a persisted conversation transcript (ADR 0102) to **markdown** or **JSON** — optionally projecting the markdown into a **Document** (ADR 0053) and/or a downloadable **Media** blob (ADR 0007) — and (b) **imports** a conversation from a supported export file by materializing it through the existing **`conversations/open`** path (ADR 0043) and appending parsed turns. It owns **no transcript store, no conversation builder, and no blob writer** — those are composed.

**Why a feature-package, not a core-chat route (the call, justified).** Export/import is an *optional product surface* with its own toggle/lifecycle, an import parser that grows per competitor-format (OpenAI today, others later), and an optional dependency on the (also-optional) `documents` feature. A core-chat route would (1) couple always-on chat to an off-by-default capability, (2) drag format-adapter churn into `routes/chatSessions.ts`, and (3) violate the feature-package contract (ADR 0001: core must not import features; `documents` is a feature). It is the ADR 0013-style thin surface: a feature that READS core stores and composes other features. (One justified shared edit: `PUBLIC_PATH_PREFIXES` is **not** touched — export/import is authed; see RBAC.)

### Data model — none new (the point)

Export is **stateless**: a pure render of `(ChatSessionRecord, ChatMessageRecord[])` → bytes. Import **writes only** to the existing conversation/message stores via `conversations/open` + `appendChatMessage`. The only persisted artifacts are the *optional* `documents:doc` projection (ADR 0053's store) and the *optional* Media token (ADR 0007's store) — both owned elsewhere.

**Export shapes:**
- **markdown** — a human-readable transcript: a title header, then per-turn `**<role/author>** · <ts>` + the message body (interrupt/A2UI cards rendered as fenced blocks).
- **JSON (OpenWOP-conversation v1)** — `{ version:1, conversation:{id,title,type,participants,createdAt}, messages:[{role, authorSubject?, content, createdAt, meta?}] }`. A flat, self-describing, host-local schema (NOT a wire type — see RFC verdict).

**Import formats (v1):** OpenWOP-conversation v1 (round-trips our own export) + an **OpenAI/ChatGPT export** adapter (`conversations.json`) → normalized to the same intermediate before `conversations/open`. Each adapter is one parser module (the LibreChat `utils/import/` shape); a new source is a new adapter, no route change.

### REST surface (non-normative, authed)

```
GET  /v1/host/openwop-app/chat-export/:sessionId?format=markdown|json   # render (owner/participant)
POST /v1/host/openwop-app/chat-export/:sessionId/as-document            # project markdown → documents:doc (requires `documents` on)
POST /v1/host/openwop-app/chat-export/import                            # body: {format, payload} → new conversation(s)
```

### RBAC & isolation
**Fail-closed, owner/participant-only.** Export reads a conversation only if the caller is its **owner or a participant** — the exact `callerSubject`/`requireManageAsync` gate the ADR 0102 message-edit route uses (`routes/chatSessions.ts:646-650`); a non-participant gets a **uniform 404** (no existence leak). Import creates conversations **owned by the caller** in the caller's tenant (`conversations/open` derives owner from `actingUserOf(req)`); it cannot inject into someone else's conversation. Tenant is derived from `req.tenantId`, never the body. Caps: per-export message/byte ceiling, per-import payload size + message-count cap, per-tenant import rate-limit (the rate-limit middleware budget) — a 10k-turn paste cannot blow memory.

### Replay / fork safety
Export is a read; it records nothing on any run and is replay-irrelevant. Imported message bodies are **external content** → stamped `contentTrust:'untrusted'` (ADR 0027) so a subsequent agentic run over an imported conversation wraps them in `<UNTRUSTED>` markers (`promptInjectionGuard`) and cannot treat a pasted "ignore previous instructions" as authority. Import is **idempotent on a client-supplied import key** (re-running the same import resolves to the same conversation via `conversations/open`'s dmKey/idempotency, never a duplicate).

---

## Evaluation matrix

| # | Criterion | Verdict |
|---|---|---|
| 1 | Feature-package architecture | **Feature-package** `src/features/chat-export/` (ADR 0001); core untouched; reads core stores, composes `documents`/`media` features. |
| 2 | Toggle + admin/UI | `chat-export` default OFF, `bucketUnit: tenant`; Export/Import affordance in the conversation chrome, self-hiding on a 404 when off. |
| 3 | Reuse-not-recreate | No transcript store, no conversation builder, no blob writer — all composed (ADR 0102/0043/0053/0007). |
| 4 | Workflow + node packs | None needed (render is pure + synchronous; no provider call). A future `chat.exportToDocument` node is additive, not required. |
| 5 | AI-chat envelopes + agent packs | N/A — this is a data-portability surface, not a chat-drivable capability. |
| 6 | Public surface discipline | None — export/import is **authed**; `PUBLIC_PATH_PREFIXES` untouched (contrast ADR 0122). |
| 7 | RBAC fail-closed | Owner/participant only (the ADR 0102 gate); import writes only caller-owned conversations; uniform 404. |
| 8 | Replay/fork safety | Export is a pure read; imported bodies stamped `untrusted` (ADR 0027); import idempotent on an import key. |
| 9 | Caps / rate-limit / payload | Per-export byte ceiling; per-import payload + message-count cap; per-tenant import rate-limit. |
| 10 | RFC gate | **Host-extension — NO RFC.** Non-normative `/v1/host/openwop-app/chat-export/*`; the JSON schema is host-local, not a wire type. |

---

## Phased plan

1. **Renderer (pure).** `transcriptToMarkdown` + `transcriptToJson` over `(ChatSessionRecord, ChatMessageRecord[])` — deterministic, interrupt/A2UI cards as fenced blocks. Unit-tested standalone (no I/O).
2. **Export routes.** `features/chat-export/{routes,feature}.ts`: `GET …/:sessionId?format=` (owner/participant gate + caps), toggle-gated, uniform-404 IDOR. +route tests.
3. **As-Document + Media projection.** `POST …/:sessionId/as-document` → `documents` service (guarded on the `documents` toggle; honest 409/404 when off); optional Media-token download. +tests.
4. **Import.** The OpenWOP-v1 parser + the OpenAI/ChatGPT adapter → normalized turns → `conversations/open` + `appendChatMessage` (untrusted-stamped); import key idempotency; payload caps. +parser + route tests (incl. a hostile-injection import fixture asserting `untrusted` stamping).
5. **Frontend.** Export/Import controls in the conversation chrome (`chat/`): download `.md`/`.json`, "Save as Document", an import dropzone. `chatExportClient.ts`; `npm run build` gate green; `ui/` cohesion + a11y.
6. **Tests + docs.** Round-trip (export→import→export is stable), authorship preservation, owner/participant IDOR-404, caps, untrusted-on-import, the OpenAI-adapter fixture.

## Alternatives weighed

1. **A core-chat route in `routes/chatSessions.ts`.** Rejected — couples always-on chat to an off-by-default capability, drags per-format parser churn into core, and a core route cannot import the `documents` feature (ADR 0001 import direction). The thin feature-package is the ADR 0013 precedent.
2. **Copy a frozen transcript snapshot into the export record.** Rejected — export is a stateless render of the live transcript; a stored snapshot is a second source of truth to GC (the ADR 0013 "compose, don't copy" lesson).
3. **A bespoke import-only conversation builder.** Rejected — `conversations/open` already materializes conversations idempotently; a parallel builder shadows it (`no-parallel-architecture`).
4. **Treat imported text as trusted (faster).** Rejected outright — imported bodies are external instruction surfaces; not stamping `untrusted` is exactly how a pasted injection reaches an LLM unwrapped (ADR 0027 thesis).

## Open questions

1. **OQ-1 — Import format breadth.** v1 ships OpenWOP-v1 + OpenAI/ChatGPT. LibreChat-native and Open WebUI NDJSON are follow-on adapters (each one parser module).
2. **OQ-2 — Attachment/media round-trip.** v1 exports message *text* + card payloads; re-hosting referenced Media/files on import is deferred (needs a Media import path).
3. **OQ-3 — Bulk export.** v1 is per-conversation. An org-wide "export all my conversations" (the GDPR-portability shape) is a follow-on that fans out the per-conversation renderer behind the same caps.
4. **OQ-4 — Run/interrupt fidelity.** How much of an interrupt/HITL card's structured payload survives the round-trip vs. flattening to a fenced block? v1 flattens; structured round-trip is deferred.

> **Phase 3 (as-Document) implemented** (2026-06-24):** `exportConversationAsDocument` composes the Phase-1 `transcriptToMarkdown` renderer + the ADR 0053 Documents service (`createDocument` + `addVersion` — the single owner of documents) + `hostExtStorage` (chat source): a conversation exports as an org-scoped `conversation-transcript` document with one version carrying the rendered transcript. No new store; one-shot (no replay obligation). /architect GO (pure composition of existing owners), /code-review clean (backend — no UI). 2 tests (doc + version content, 404). The as-Media projection + the FE export menu (Phases 5+) pending.

> **Phase 5 (FE export menu) implemented** (2026-06-24):** an **Export** button in ChatHeader (beside Branch/Compare) downloads the conversation transcript as Markdown via the Phase-2 export route (`GET /chat-export/:sessionId?format=md`). `chatExportClient.exportConversation(sessionId, format)` fetches the route + triggers a browser download (Blob → anchor, with URL.revokeObjectURL cleanup). Toggle-gated: the button renders only when `useFeatureAccess('chat-export')` is enabled (mirroring the server-side 404-when-off). /architect (inline — surfaces the existing export route; no new backend), /code-review + /ux-review clean (button aria-labelled + titled; i18n×4; entry 162.6 kB). 2 tests (route URL+format+download; throws on non-OK). The FE import dropzone (a follow-on) reuses the existing Phase-4a/4b parsers/write.

> **Import (route + FE dropzone) implemented** (2026-06-24):** `POST /v1/host/openwop-app/chat-export/import {format, data}` parses a supported export (Phase-4a `parseOpenwopExport`/`parseChatGptExport`) and materializes a NEW owned conversation (Phase-4b `importConversation` — imported bodies stamped `contentTrust:'untrusted'`, so a hostile import is fenced). Toggle-gated (`chat-export` 404-when-off). FE: an Import file-input button in ChatHeader (gated by the same feature) → `chatExportClient.importConversation` + `detectImportFormat` (openwop-v1 vs OpenAI tree) → opens the new conversation via the existing `selectConversation` flow (no new router path). /architect (inline — composes the existing parsers + import write + the conversation-open flow; no new store), /code-review + /ux-review clean (file input hidden + aria-labelled, i18n×4, entry 162.8 kB). Backend round-trip test (export→import→re-export) + toggle-off 404 + FE client tests (detect/post/throw). **ADR 0119 is now COMPLETE** (export + as-Document + import, both reachable from chat).
