# AI Chat Interface — Competitive & Technical Analysis

**Date:** 2026-06-23
**Subject:** Deep-dive technical analysis of the top 5 open-source AI chat interface repos vs. our app (`app.openwop.dev`)
**Repos analyzed:** Open WebUI · LobeChat/LobeHub · LibreChat · AnythingLLM · Jan
**Output mode:** Research + gap analysis + **ranked ADR backlog** (no ADR files authored this round — greenlight items from §8 to convert to `/feature-refinement` ADRs)

> Method: each repo was shallow-cloned and inspected at the **source-tree** level (frontend components, backend services, API routes, provider integrations, RAG, auth, plugin/MCP/agent architecture), not just the README. Every feature below cites the exact in-repo implementation path so our team can clone/adapt/rebuild locally. Our own baseline was mapped from `FEATURES.md`, `frontend/react/src/chat/`, the chat ADRs, and the backend run/provider/RAG/RBAC surface.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [OpenWOP current capability map (baseline)](#2-openwop-current-capability-map-baseline)
3. [Open WebUI](#3-open-webui)
4. [LobeChat / LobeHub](#4-lobechat--lobehub)
5. [LibreChat](#5-librechat)
6. [AnythingLLM](#6-anythingllm)
7. [Jan](#7-jan)
8. [Cross-repo capability matrix + gap analysis](#8-cross-repo-capability-matrix--gap-analysis)
9. [Ranked ADR backlog (recommendations)](#9-ranked-adr-backlog-recommendations)
10. [Appendix — licensing caveats & clone locations](#10-appendix--licensing-caveats--clone-locations)

---

## 1. Executive summary

**Where OpenWOP is already strong (peer or better than the field):** the conversation primitive (one reusable model across agent/group/workspace chats), streaming, BYOK + managed-provider parity, replay/fork safety, agent packs + node packs, MCP (inbound + outbound), A2UI agent-authored surfaces, RBAC + consent-gated digital-twin recall, feature toggles with variant testing, and a coherent design system. Several of these (replay-safe runs, A2UI, twin-recall consent) are **ahead** of every repo analyzed.

**Where the field is clearly ahead of us** — the high-value gaps that seed the backlog:

| Gap | Who does it well | OpenWOP status |
|---|---|---|
| **Full-text conversation/message search** | LibreChat (Meilisearch), Open WebUI, LobeHub | ABSENT (only KB semantic + conversation-list filter) |
| **Web search tool with inline citations** | Open WebUI (25+ providers), LibreChat, LobeHub | ABSENT in chat |
| **Code interpreter / sandboxed execution** | LibreChat (multi-lang sandbox), Open WebUI (Jupyter+Pyodide), LobeHub (Pyodide+cloud sandbox) | ABSENT |
| **Image generation in chat** | Open WebUI (4 backends), LobeHub, LibreChat (DALL·E/Flux) | ABSENT (workflows can call APIs, no first-class output) |
| **Conversation forking/branching + multi-model compare** | LibreChat (4 fork strategies), Open WebUI (tree+graph), LobeHub | ABSENT |
| **Prompt library UI (shareable, RBAC, versioned)** | LibreChat, Open WebUI, AnythingLLM | PARTIAL (per-agent prompt only; no library) |
| **Reranking + hybrid (BM25+dense) retrieval** | Open WebUI, AnythingLLM, LobeHub | ABSENT (single-stage cosine) |
| **Broad document loaders / OCR ingestion** | AnythingLLM (collector), Open WebUI (8 OCR engines) | PARTIAL (text/PDF only) |
| **Conversation export (md/JSON) + import** | All five | ABSENT |
| **Local model support (Ollama/compat endpoint)** | All five | ABSENT (cloud only) |
| **Bidirectional voice / live call** | Open WebUI, LobeHub | PARTIAL (one-way audio in / TTS out) |
| **LLM observability (OTel + trace/eval)** | LibreChat (OTel+Langfuse), Open WebUI (OTel), LobeHub | PARTIAL (feedback logged, no tracing) |
| **RLHF / model-eval leaderboard** | Open WebUI (Elo arena), LobeHub (eval framework) | ABSENT (feedback captured, unused) |

**Strategic read:** The single biggest theme across all five is **chat-as-an-extensible-agentic-platform**: web search, code execution, image gen, and rich tool ecosystems delivered *inside the chat turn* with citations and artifacts. OpenWOP already has the right substrate for this (node packs + agent packs + artifact projection + A2UI), so most of these are **host work that rides existing seams** rather than greenfield builds. The few that touch the wire (local-model capability honesty, any new run-event/artifact-type) need an `openwop` RFC first.

**Recommended P0/P1 focus** (full ranking in §9): conversation full-text search, a web-search node + citation rendering, a sandboxed code-execution node + artifact projection, an image-generation node, KB reranking/hybrid retrieval, and a prompt-library feature-package. These six close the most visible capability gaps while reusing our architecture.

---

## 2. OpenWOP current capability map (baseline)

### Architecture summary

OpenWOP's chat is a **single reusable conversation primitive** (ADR 0043), type-discriminated (agent / person / group / workspace / project) with a `ConversationParticipant` membership join. Four pillars:

1. **One conversation model** — replaces separate transcript/history/active-agent surfaces.
2. **Conversation-run transport (ADR 0067)** — every AI turn is an OpenWOP `chat.turn` run; a suspended RFC 0005 conversation-gate holds the long-lived exchange; replays reconstruct from event logs.
3. **Streaming by default (ADR 0079)** — token-deltas via `ai.message.chunk` to the direct `*.run.app` SSE path (bypassing the Firebase `/api` CDN 60s ceiling); final turn persisted authoritatively.
4. **Embeddable, feature-scoped (ADR 0073)** — `EmbeddedChatPanel` + `ConversationView` separate chrome from content so any feature drops a scoped agent-chat without reimplementing BYOK/streaming/persistence.

**Reuse, not recreate:** RAG is the `kb` feature (ADR 0011); memory is `subjectMemory` (RFC 0004, `user:`/`agent:`/`project:` namespaces); agents are roster agents with `agentProfile` (ADR 0031) + capabilities. No parallel chat runtime or shadow store.

### Capability inventory (HAVE / PARTIAL / ABSENT)

- **Chat UX** — HAVE. `frontend/react/src/chat/` — ConversationView, ChatInput (auto-resize, send/stop, audio record + live transcription, attachments, agent/board `@`-mentions, `/` slash), MessageFeed (streaming bubbles, workflow-progress cards, inline interrupts), feedback, regenerate.
- **Conversation management** — HAVE (ADR 0043/0067). Typed sidebar (Agents/Groups/Workspace), unread badges, participants (server-authoritative), read state, cursor pagination, Board of Advisors group convening (ADR 0040).
- **Message actions** — HAVE. Regenerate, feedback (rating+reason, ADR 0071), resolve interrupt (approval/clarification/refinement), A2UI declarative surfaces (ADR 0051 / RFC 0102).
- **Prompting / templates** — PARTIAL. Per-agent system prompt + `agentProfile`; per-turn composition (ADR 0043 P5B); prompt-templates bound to document kinds (ADR 0053). **ABSENT:** prompt library UI, versioning, A/B prompt splitting.
- **Model/provider management** — HAVE. Anthropic/Google/OpenAI managed + BYOK (ADR 0067); MiniMax TTS; capability probing (`modelCapabilityGate.ts`); per-agent `modelClass`. **PARTIAL:** no in-chat model-switch UI; no cross-provider fallback.
- **Local model support** — ABSENT. Cloud providers only.
- **Multi-modal** — HAVE (in). Image (vision), PDF (Anthropic/Google), audio in (Gemini transcribe). **ABSENT:** image output / generation.
- **File upload & document handling** — HAVE. ChatInput attachments → Media token; KB ingest chunks/embeds/cites. **PARTIAL:** no direct composer→KB ingest.
- **RAG / knowledge base** — HAVE (ADR 0011). Collections (RBAC-gated), deterministic local-hash embedder, top-k cosine retrieval + augmented prompt, per-agent/human knowledge binding (ADR 0038/0042), planning KB (ADR 0100). **PARTIAL:** no rerank, no hybrid BM25, no knowledge-graph UI, no nested collections.
- **Tools / MCP / agents** — HAVE. Roster agents (ADR 0025), node packs (`core.openwop.ai|mcp|http|hitl|integration|a2a|rag`), per-agent tool allowlist (ADR 0031/0104), MCP inbound (`routes/mcp.ts`) + outbound (`host/agentToolProvider.ts`), 10-agent work-twin suite. **PARTIAL:** no tool marketplace UI; tool-call execution not streamed.
- **Auth / RBAC** — HAVE (ADR 0006). Users + agents as principals, org/workspace roles, conversation visibility (owner-or-participant, 404 non-members), agent permission policy (ADR 0036), consent-gated twin recall (ADR 0044). Enterprise SSO/SCIM via RFC 0050 (ADR 0002).
- **Admin settings** — HAVE. Feature toggles + variant splitting (ADR 0001), Connections credential broker (ADR 0024), tool-allowlist editor (ADR 0104), consent/GDPR. **ABSENT:** per-workspace model defaults, conversation archival policy.
- **Workspace / team** — HAVE (workspace = tenant). **ABSENT:** topic channels, presence/typing, human↔human 1:1 UI.
- **Data persistence** — HAVE. Conversation/participant/readstate/message stores, run-replay reconstruction, idempotency (exchangeKey CAS).
- **Search** — PARTIAL. KB semantic + conversation-list filter. **ABSENT:** full-text message search.
- **Memory / personalization** — HAVE (RFC 0004 / ADR 0041/0042/0044). Structured + unstructured, twin recall, Memory/Knowledge UI. **ABSENT:** auto-extraction from chat; learning from feedback.
- **Artifacts / canvas / code interpreter** — PARTIAL. Documents + artifact workbench (ADR 0069), chat artifact preview/diff. **ABSENT:** code interpreter / live execution, interactive canvas.
- **Voice / TTS / STT** — PARTIAL. Audio in (Gemini), podcast TTS (ADR 0086), notebook ingest (ADR 0085). **ABSENT:** live bidirectional voice.
- **Theming / UI** — HAVE. `ui/` design system, light/dark, Lucide icons, responsive.
- **Observability / evals** — PARTIAL. Message feedback (ADR 0071), run telemetry, health indexing (ADR 0080). **ABSENT:** OTel/Langfuse tracing, eval/leaderboard.
- **Security / privacy** — HAVE. BYOK gate, secret stripping, replay safety, consent grants, content-trust taint. **PARTIAL:** no PII/DLP scan (ADR 0077 Proposed).
- **Import / export** — PARTIAL. Document/media export. **ABSENT:** conversation transcript export/import.
- **API surface** — HAVE. `/v1/host/openwop-app/*` (chat/agents/runs/artifacts), `/.well-known/openwop` capability advertisement, SSE.
- **i18n / a11y** — HAVE. EN + pt-BR (ADR 0065), CMS content localization (ADR 0064), ARIA/keyboard. **ABSENT:** RTL.

### Notable gaps (seeds for §8/§9)

Local models · bidirectional voice · code interpreter · image generation · full-text conversation search · topic channels · in-chat model switch · conversation archival · presence/typing · conversation templates · tool-call streaming · prompt versioning/A-B · learning from feedback · conversation export · web search · reranking/hybrid retrieval · broad document loaders · LLM tracing · eval leaderboard.

**Key chat ADRs:** 0043 (conversations), 0067 (conversation-run), 0073 (EmbeddedChatPanel), 0051 (A2UI), 0079 (streaming), 0071 (chat UI state + feedback), 0069 (artifact workbench), 0023 (assistant/CoS), 0031 (agentProfile), 0040 (Board), 0011 (KB/RAG), 0038/0042 (agent/human knowledge), 0024 (Connections).

---

## 3. Open WebUI

### 3.1 Repository overview

- **Repo / URL:** `open-webui/open-webui` — https://github.com/open-webui/open-webui (inspected v0.9.6, HEAD `02dc3e6`).
- **Purpose:** Extensible, self-hosted, offline-capable "ChatGPT-style" platform fronting Ollama / OpenAI-compatible / Anthropic, with built-in RAG, document/knowledge mgmt, tools/functions, agents, image+voice, full multi-user admin.
- **Stack:** **Frontend** SvelteKit + TS + Vite + Tailwind v4, i18next, `@xyflow/svelte`, KaTeX/mermaid/highlight.js, Pyodide + Kokoro WASM workers (`src/`). **Backend** Python 3.11 FastAPI/Uvicorn, async SQLAlchemy 2.0, Alembic, Pydantic (`backend/open_webui/main.py`). **DB** SQLite default / PostgreSQL; Redis optional; storage Local/S3/GCS/Azure (`storage/provider.py`); ~14 vector DBs.
- **Deployment:** Docker-centric (multi-stage Dockerfile, 8 compose variants), K8s, `:ollama`/`:cuda` tags. Backend `:8080`.
- **License:** ⚠️ **Custom "Open WebUI License"** — BSD-3 derivative with a **branding-protection clause (§4)** prohibiting removal of "Open WebUI" branding unless ≤50 users / written permission / enterprise license. **Not OSI-permissive** — material for any white-label reuse. CLA-gated contributions.
- **Maintenance:** Very active/mature (~855KB CHANGELOG, 62 locales, tens of thousands of stars).
- **Architecture:** SvelteKit SPA + FastAPI monolith, ~30 routers under `/api/v1/*` + `/ollama`/`/openai` proxies + `/scim/v2`. Pluggable factories everywhere (vector DB, embeddings, rerankers, web-search, storage, STT/TTS, image-gen). Real-time via Socket.IO. Dynamic Python plugin loading via `exec()`.
- **Where things live:** Chat UI `src/lib/components/chat/`; providers `backend/open_webui/routers/{openai,ollama,models}.py` + `utils/anthropic.py`; settings `backend/open_webui/config.py` + `src/lib/components/admin/Settings/*`; **docs external** at docs.openwebui.com (in-repo docs thin, no `examples/`).

### 3.2 Feature inventory

**Chat UX**
- **Streaming responses** (Mature) — SSE chunked to 1–3 chars for smooth typing, OpenAI-normalized. `src/lib/apis/streaming/index.ts`; `backend/open_webui/routers/openai.py`, `utils/middleware.py`, `utils/response.py`. *Risk:* CDN/proxy buffering breaks SSE.
- **Edit / regenerate / continue** (Mature) — `src/lib/components/chat/Messages/{ResponseMessage,UserMessage,Message,OutputEditView}.svelte`; `routers/chats.py`.
- **Multi-model side-by-side + response branching/versions** (Mature) — one message → many models in parallel; sibling-version navigation; history is a tree (`childrenIds`, `branchPointMessageId`). `src/lib/components/chat/Messages/{MultiResponseMessages,ResponseMessage}.svelte`. Feeds the arena/eval leaderboard.
- **Conversation flow graph (Overview)** (Mature) — visual DAG of branches via `@xyflow/svelte`. `src/lib/components/chat/Overview/{View,Node,Flow}.svelte`.
- **Rich rendering** (Mature) — markdown + KaTeX + Mermaid + code highlight + citation cards. `src/lib/components/chat/Messages/{Markdown,CodeBlock,Citations,ContentRenderer}.svelte`.
- **Slash/command palette + input menus** (Mature) — `/` commands, prompt-template variables, integrations/tools/terminal menus, attach-webpage. `src/lib/components/chat/MessageInput.svelte`, `MessageInput/Commands/`, `InputMenu/`, `InputVariablesModal.svelte`.

**Conversation management**
- **Chats / folders / tags / pin / archive / share** (Mature) — `backend/open_webui/routers/{chats,folders}.py`; `models/{chats,folders,tags,shared_chats}.py`; sidebar in `src/lib/components/layout/`.
- **Search across chats** (Mature) — full-text over title+content, AND semantics, `tag:` filters, pagination. `routers/chats.py` (search). *Risk:* SQL `LIKE`-based, no dedicated FTS index.
- **Import/export** (Mature) — single chat or NDJSON-stream all; bulk import w/ OpenAI-export conversion; `ENABLE_ADMIN_EXPORT`. `routers/chats.py`; `src/lib/components/chat/Settings/DataControls.svelte`.

**Model / provider**
- **Multi-provider connections** (Mature; Anthropic conversion Partial) — Ollama, OpenAI-compatible, native Anthropic Messages. `routers/{openai,ollama,models}.py`, `utils/anthropic.py`; `src/lib/components/admin/Settings/Connections.svelte`.
- **Custom model definitions** (Mature) — wrap a base model w/ system prompt, params, knowledge, tools, filters, capability flags, per-group access. `models/models.py`, `utils/payload.py`; `src/lib/components/workspace/Models/`.
- **Local model lifecycle (Ollama)** (Mature) — pull/list/delete/run; CUDA/AMD images. `routers/ollama.py`; `docker-compose.{gpu,amdgpu}.yaml`.

**Multi-modal & image gen**
- **Vision input** (Mature) — `src/lib/components/chat/MessageInput/InputMenu/`; `routers/files.py`.
- **Image generation & editing (4 backends)** (Mature; editing Partial) — DALL·E/gpt-image, AUTOMATIC1111, ComfyUI (JSON node-graph), Google Imagen 3. `routers/images.py`, `utils/images/comfyui.py`; `src/lib/apis/images/`.

**Voice / real-time**
- **STT (5 engines)** (Mature) — local faster-whisper, OpenAI Whisper, Deepgram, Azure, Mistral. `routers/audio.py`; `src/lib/components/chat/MessageInput/VoiceRecording.svelte`.
- **TTS (5 engines + Kokoro WASM)** (Mature) — OpenAI, ElevenLabs, Azure SSML, HF SpeechT5, Mistral; in-browser Kokoro worker. `routers/audio.py`; `src/lib/workers/kokoro.worker.ts`.
- **Live voice call mode** (Experimental) — mic→STT→LLM→TTS overlay w/ RMS monitoring/wake-lock. `src/lib/components/chat/MessageInput/CallOverlay.svelte`.

**Files / RAG**
- **Document loaders / OCR (multi-engine)** (Mature; some OCR Experimental) — LangChain loaders + Mistral OCR, MinerU, Datalab Marker, PaddleOCR-VL, Azure Doc Intelligence, Tika, Docling, YouTube transcript. `backend/open_webui/retrieval/loaders/*.py`; `routers/retrieval.py`.
- **Vector DB (~14 backends)** (Mature) — Chroma, Milvus(+MT), Qdrant(+MT), Pinecone, pgvector, Elasticsearch, OpenSearch, Weaviate, Oracle 23ai, MariaDB, OpenGauss, Valkey, S3Vector. `retrieval/vector/factory.py` + `dbs/*.py`.
- **Embeddings + hybrid BM25 + reranking** (Mature) — dense (SentenceTransformers/OpenAI/Ollama/Azure) + BM25 weighted hybrid; rerankers (CrossEncoder, ColBERT jina-colbert-v2, external HTTP). `retrieval/utils.py`, `utils/embeddings.py`, `retrieval/models/{colbert,external,base_reranker}.py`.
- **Knowledge bases (collections + directories + ACL)** (Mature) — hierarchical dirs (cycle-detected), file↔KB M2M, per-KB/file access grants, attachable to models. `models/knowledge.py`; `routers/knowledge.py`; `src/lib/components/workspace/Knowledge/`.
- **Web search (25+ providers)** (Mature) — SearXNG, Google PSE, Bing, Brave, DuckDuckGo, Kagi, Tavily, Exa, Perplexity, Jina, Firecrawl, etc. `backend/open_webui/retrieval/web/*.py`.
- **Storage backends** (Mature) — Local/S3/GCS/Azure, workload-identity, SHA-256 dedup. `storage/provider.py`.

**Tools / functions / MCP / agents**
- **User-defined Python tools** (Mature) — `exec()`-loaded modules, type-hints→OpenAPI, frontmatter `requirements:` auto-pip, admin+user Valves. `models/tools.py`, `routers/tools.py`, `utils/{tools,plugin}.py`. *Risk:* `exec()` of user Python = major sandboxing surface.
- **Functions — filters / pipes / actions** (Mature) — inlet/outlet/stream hooks, custom model providers, user-triggered actions; priority-sorted. `backend/open_webui/functions.py`, `utils/{filter,actions}.py`.
- **Pipelines server (external middleware)** (Mature) — offload filters/pipes to external HTTP server. `routers/pipelines.py`.
- **MCP client + OpenAPI tool servers** (MCP Experimental / OpenAPI Mature) — `streamablehttp_client`, OAuth2, remote spec → OpenAI tool format. `utils/mcp/client.py`, `utils/tools.py`. *Note:* HTTP-only MCP (no stdio).
- **Built-in tool catalog (30+)** (Mature) — KB search, memory CRUD, web search, fetch URL, image gen, code exec, notes, channel search, task/automation/calendar/skills. `backend/open_webui/tools/builtin.py`.
- **Skills (reusable prompt modules)** (Mature) — versioned/shareable, loaded on-demand. `models/skills.py`; `src/lib/components/workspace/Skills/`.
- **Automations (scheduled chat runs)** (Mature) — RRULE timezone-aware scheduler, atomic claim (`FOR UPDATE SKIP LOCKED`), execution history. `models/automations.py`, `utils/automations.py`; `src/lib/components/automations/`.
- **Tasks (background gen jobs)** (Mature) — Redis-tracked async title/tags/emoji/followup/query gen, cancellable. `backend/open_webui/tasks.py`.
- **Terminals (remote shell proxy)** (Mature) — HTTP+WS reverse-proxy to ttyd-style servers, path-traversal protection, exposed as model tools. `routers/terminals.py`. *Risk:* remote shell = high security surface.

**Artifacts / code**
- **Code interpreter (Jupyter + Pyodide)** (Jupyter Mature / Pyodide Partial) — remote Jupyter (WS, token/XSRF) or in-browser Pyodide WASM; FileNav for produced files. `utils/code_interpreter.py`, `src/lib/pyodide/`, `src/lib/components/chat/Messages/CodeExecution*.svelte`.
- **Artifacts / code canvas** (Mature) — sandboxed iframe HTML/SVG/code w/ CSP. `src/lib/components/chat/Artifacts.svelte`.
- **Playground** (Mature) — raw prompt/completions testing. `src/lib/components/playground/`.

**Users / auth / RBAC**
- **Auth methods** (Mature) — local (bcrypt/argon2), JWT (Redis revocation, OIDC back-channel logout), API keys, OAuth/OIDC (Google/MS/GitHub/generic, role+group sync), LDAP/AD, trusted-header, no-auth debug. `routers/auths.py`, `utils/{auth,oauth}.py`.
- **SCIM 2.0 provisioning** (Experimental) — `/scim/v2/Users`+`/Groups`. `routers/scim.py`.
- **Roles / groups / granular ACL** (Mature) — admin/user/pending, hierarchical dot-notation group perms, per-resource `AccessGrant` across KBs/models/prompts/tools/notes/channels/files. `models/{groups,access_grants}.py`, `utils/access_control/`.

**Workspace / team / real-time**
- **Channels (real-time team messaging)** (Mature) — group/private/direct, roles/mute/pin/read-state, webhook ingestion, searchable by models. `models/channels.py`, `socket/`; `src/lib/components/channel/`.
- **Notes** (Mature) — markdown, pin, FTS, ACL, model read/write. `routers/notes.py`.
- **Calendar** (Mature) — iCal RRULE events, attendees/RSVP, virtual "Scheduled Tasks" calendar. `routers/calendar.py`.
- **Prompts library (with history)** (Mature) — reusable templates + variables + version history, `/`-insertable. `routers/prompts.py`, `models/{prompts,prompt_history}.py`.

**Memory** — **Long-term memory** (Mature) — per-user `user-memory-{id}` vector collection, semantic recall threshold, full CRUD. `routers/memories.py`.

**Admin / observability**
- **Admin settings console** (Mature) — Connections/Models/Documents/WebSearch/Images/Audio/CodeExecution/Pipelines/Evaluations w/ config locking. `src/lib/components/admin/Settings/*`.
- **Usage analytics dashboard** (Mature) — messages by model/user, token usage, time-series. `routers/analytics.py`.
- **RLHF evaluations / arena leaderboard** (Mature) — feedback + chat snapshots, **Elo (K=32) leaderboard** w/ optional query-aware semantic re-rank. `routers/evaluations.py`, `models/feedbacks.py`; `src/lib/components/admin/Evaluations/`.
- **Audit logging** (Mature) — ASGI middleware, levels NONE→REQUEST_RESPONSE, password redaction. `utils/audit.py`.
- **OpenTelemetry** (Mature) — OTLP traces+metrics, auto-instrumentation, Prometheus. `utils/telemetry/`; `docker-compose.otel.yaml`.

**Security / theming / i18n** — Redis rate limiter, security headers, sanitization (`utils/{rate_limit,security_headers,sanitize}.py`); themes incl. OLED-dark (`src/app.css`); **62 locales** w/ RTL (`src/lib/i18n/`); PWA Partial (empty manifest in-repo).

**Cleanly-extractable subsystems:** web-search providers (`retrieval/web/`), vector-DB factory (`retrieval/vector/`), document loaders/OCR (`retrieval/loaders/`), STT/TTS (`routers/audio.py`), image-gen (`routers/images.py`), storage (`storage/provider.py`), access-control (`utils/access_control/`). **Highest-risk to copy:** `exec()` plugin loader (`utils/plugin.py`), terminal proxy (`routers/terminals.py`), branching tree-history.

---

## 4. LobeChat / LobeHub

### 4.1 Repository overview

- **Repo / URL:** `lobehub/lobe-chat` (pkg `@lobehub/lobehub` v2.2.7) — https://github.com/lobehub/lobe-chat (inspected HEAD `b39e8aed`). **Rebranded LobeChat → LobeHub** in 2.x.
- **Purpose:** Originally a multi-provider chat UI; 2.x repositions as a **"Chief Agent Operator"** — hire/schedule/run/report on a *team* of AI agents 7×24, unattended/background operation, multi-agent "Fleet", deploy agents into Discord/Slack/Telegram/WeChat. Chat is now one surface of an agent-ops product.
- **Stack:** TS end-to-end; **React 19**; **Next.js (App Router) + Vite** (web/mobile/auth SPA variants); Zustand; **Drizzle ORM**; **tRPC**; **Hono** server handlers; pnpm workspaces; Bun build.
- **DB:** PostgreSQL (+pgvector) via Drizzle; **PGlite** client-side browser DB; Redis optional; S3 object storage; 119 migrations.
- **Deployment:** Vercel (primary), Docker (distroless), compose (Postgres/Redis/RustFS/Searxng), Netlify; **Electron desktop app** + a `lh` CLI.
- **License:** ⚠️ **LobeHub Community License** (Apache-2.0 base + commercial restriction on derivative distribution). `package.json` says `"MIT"` but the LICENSE file is authoritative and more restrictive — **port concepts, not copied code**.
- **Maintenance:** Very active (~76K-line CHANGELOG, ~1997 test files).
- **Architecture:** Feature-first monorepo, ~88 `packages/` (agent-runtime, model-runtime/bank, 31 builtin tools, context-engine, etc.) + `src/` + `apps/{cli,desktop,server}`.
- **Where things live:** Chat UI `src/features/Conversation/` + `ChatInput/` + `Portal/`; providers `packages/model-runtime/src/providers/` (83) + `packages/model-bank/`; settings `src/features/{WorkspaceSetting,AgentSetting}/`.

### 4.2 Feature inventory

**Chat UX**
- **Conversation UI + streaming** (Mature) — markdown/code/images/reasoning/tool-call cards, SSE w/ token+cost display, per-conversation isolated Zustand store. `src/features/Conversation/`; `packages/conversation-flow/` (message-tree/branch/council/compressed-group); `packages/fetch-sse/`.
- **Message actions** (Mature) — regenerate, edit, copy, delete, delete-and-regenerate, continue, **branch, translate, TTS**, collapse, share. `src/features/Conversation/Messages/components/MessageActionBar/actions/`.
- **Topic / thread management** (Mature) — topics under sessions; **threads = branched paths** (continuation/standalone/isolation/eval); **message groups** for parallel multi-model w/ compression. `src/store/chat/slices/{topic,thread}/`; `packages/database/src/schemas/{topic,message}.ts`.
- **In-app search + command menu** (Mature) — FTS over conversations/messages/agents/tasks. `src/features/CommandMenu/`, `packages/database/src/repositories/search/`.

**Prompting / personalization**
- **Prompt templates + input transforms** (Mature) — slash commands, variable substitution, prompt-transform, suggested follow-ups. `src/features/{PromptTransform,SuggestQuestions}/`; `packages/context-engine/src/processors/`.
- **User memory / personalization** (Mature backend / Experimental extraction) — persistent cross-conversation memory w/ structured schemas (identity/context/activity/experience/gatekeeper), **server-side extraction workflow**, in-chat memory inspector/intervention. `packages/memory-user-memory/` (incl. LOCOMO benchmarks), `packages/builtin-tool-memory/`, `src/server/workflows-hono/memory-user-memory/`, `packages/context-engine/src/providers/UserMemoryInjector.ts`.

**Model / provider**
- **Multi-provider runtime (83 providers)** (Mature) — unified abstraction + capability flags (functionCall/reasoning/search/structuredOutput/vision/imageOutput/audio/video/files; types chat/embedding/tts/asr/image/video/realtime) + pricing/cost. `packages/model-runtime/src/providers/` (83), `packages/model-bank/`; `src/features/{ModelSelect,ModelSwitchPanel}/`.
- **Local model support** (Mature) — Ollama (+in-app downloader+guide), LM Studio, vLLM, Xinference. `packages/model-runtime/src/providers/{ollama,lmstudio}/`; `src/features/{OllamaModelDownloader,OllamaSetupGuide}/`.

**Multi-modal / generation**
- **Vision input** (Mature) — gated by `vision: true`.
- **Image generation** (Mature) — batch tracking + per-topic history (DALL-E/Imagen/Flux/Kolors/Qwen-Image/ComfyUI). `src/store/image/`, `src/app/(backend)/webapi/create-image/`.
- **Video generation** (Mature) — text/image→video w/ webhook async. `src/store/video/`, `src/app/(backend)/api/webhooks/video/`.
- **Voice TTS/ASR/realtime** (TTS Mature / realtime Partial) — OpenAI/Microsoft/Edge TTS. `src/store/chat/slices/tts/`, `src/app/(backend)/webapi/tts/`.

**Files / RAG**
- **File upload + parsing** (Mature) — PDF/DOCX/XLSX/PPTX/text w/ page+metadata. `packages/file-loaders/src/loaders/`; `src/features/{FileViewer,FileTree,AttachmentInput}/`.
- **Knowledge base / RAG** (Mature) — chunk-level pgvector + **BM25 hybrid**, status tracked. `packages/builtin-tool-knowledge-base/`, `src/services/rag.ts`; `packages/context-engine/src/providers/KnowledgeInjector.ts`.
- **Web crawling + browsing** (Mature) — Firecrawl/Browserless/Jina/Exa/Tavily/Search1API + cheerio fallback. `packages/web-crawler/src/crawImpl/`, `packages/builtin-tool-web-browsing/`.

**Agents / tools / MCP (the 2.x heart)**
- **Agent runtime (plan-execute loop)** (Mature) — instruction set (call_llm/call_tool/finish/human_approve/prompt/select/resolve_blocked_tools), max-step, usage tracking, graph + general-chat agents. `packages/agent-runtime/src/core/runtime.ts`, `.../agents/`; `src/store/chat/slices/agentRun/`.
- **31 built-in tools** (Mature) — calculator, web-browsing, knowledge-base, memory, task, local-system, remote-device, cloud-sandbox, notebook, claude-code, agent-builder, group-agent-builder, agent/group-management, skills/skill-store, self-iteration, page-agent, user-interaction, etc. `packages/builtin-tool-*/`, `packages/tool-runtime/`. *Risk:* local-system/remote-device/claude-code/cloud-sandbox carry real security surface.
- **MCP support** (Mature) — stdio + streamable HTTP, connector manifests, permission patching, OAuth; install-progress + dev manifest editor. `src/libs/mcp/`, `src/services/mcp.ts`, `src/features/MCP/`; `packages/heterogeneous-agents/`.
- **Legacy plugins + skill marketplace** (Mature / marketplace Partial) — OpenAPI/OpenRPC plugins, per-agent binding, URL-protocol install; skill store synced from LobeHub. `src/services/plugin/`, `src/features/SkillStore/`.
- **Multi-agent groups + "Fleet" 24/7** (Mature) — supervisor-executor orchestration, agent-council debate, heterogeneous coordination over MCP, agent gateway for remote exec, **Fleet dashboard** (multi-column monitoring), scheduled/cron + heartbeat. `packages/agent-runtime/src/groupOrchestration/`, `packages/{heterogeneous-agents,agent-gateway-client}/`; `src/features/Fleet/`, `src/store/{agentGroup,task}/`; `src/server/agent-hono/handlers/`. *Risk:* highest-complexity area; significant cost/security exposure unattended.
- **Agent builder + self-iteration** (Mature / templates Partial) — UI+tools for agents to build other agents; nightly review workflows. `src/features/{AgentBuilder,AgentSetting}/`, `packages/builtin-tool-{agent-builder,self-iteration}/`.
- **Messenger / chat-platform deployment** (Mature) — deploy agents into Discord/Slack/Telegram/WeChat/Line/Feishu/iMessage/QQ via OAuth+webhooks. `src/features/Messenger/`, `packages/chat-adapter-*/`, `src/server/agent-hono/handlers/messenger*`.
- **Context engine** (Mature) — ~20-injector pipeline assembling each turn (system/RAG/memory/tools/topic-refs/tasks/agent-group/history-summary) w/ token accounting. `packages/context-engine/src/providers/`.

**Artifacts / code**
- **Pages / editor canvas / artifacts** (Mature) — inline + full-page editor, topic-scoped canvas, edit-lock. `src/features/{EditorCanvas,PageEditor,TopicCanvas}/`, `packages/editor-runtime/`.
- **Code interpreter** (Python/notebook Mature / cloud-sandbox Partial) — Pyodide Web Worker, Jupyter-like notebook tool, remote cloud sandbox, local-system shell. `packages/python-interpreter/`, `packages/builtin-tool-{notebook,cloud-sandbox,local-system}/`.

**Auth / RBAC / multi-tenancy**
- **Authentication (better-auth v2)** (Mature) — email/pw, magic link, OTP, passkey/WebAuthn, OAuth/SSO (Google/GitHub/Discord/MS/Authentik/Auth0/Authelia), OIDC provider endpoints. `src/libs/better-auth/`, `src/app/(backend)/oidc/`.
- **RBAC + workspaces + multi-tenancy** (Mature) — roles (admin/editor/viewer), workspace isolation, audit logs, API keys, **billing/subscription/credits/usage**. `packages/database/src/schemas/{rbac,workspace}.ts`, `packages/business-server/src/`. *Note:* `business`/`business-server` = hosted commercial edition.

**Other** — Settings/theming/feature-flags (`src/features/{Setting,DevFeatureFlagPanel}/`); mobile SPA + **Electron desktop** (local FS, tray, hotkeys, screen-capture, auto-update) + `lh` CLI; dual Postgres/PGlite persistence; import/export (S3-staged for large); REST+tRPC+OpenAPI; **OTel + agent-tracing CLI + eval framework** (rubric matchers, dataset parser) — `packages/{observability-otel,agent-tracing,eval-rubric,eval-dataset-parser}/`; **18 locales** w/ RTL; ~1997 Vitest + Playwright/Cucumber BDD; SSRF-safe fetch + encrypted vaults.

**Highest-value/highest-risk to study:** agent-runtime instruction set + transports, context-engine injectors, heterogeneous-agents/MCP coordination, Fleet + scheduler/cron unattended-operation model.

---

## 5. LibreChat

### 5.1 Repository overview

- **Repo / URL:** LibreChat — https://github.com/danny-avila/LibreChat (v0.8.7-rc1; HEAD `2026-06-23`, "Harden User-Provided Endpoint URL Protection #13919"). MIT.
- **Purpose:** Free self-hostable ChatGPT-style platform fronting many providers (Anthropic/OpenAI/Azure/Google-Vertex/Bedrock/Responses API + any OpenAI-compatible/local) with agents, tools, MCP, RAG, code interpreter, multi-user auth/RBAC, enterprise SSO.
- **Stack:** Monorepo (npm workspaces + Turborepo). **Frontend** React+TS+Vite+Tailwind, React Query, Ariakit/Radix, i18next (`client/`). **Backend** Node + Express, Passport.js (`api/`). Shared: `packages/{data-provider,data-schemas,api,client}`.
- **DB:** **MongoDB** primary (Mongoose); **Meilisearch** for FTS; **pgvector + external RAG API**; storage Local/S3/CloudFront/Azure/Firebase/OpenAI; Redis optional.
- **Deployment:** Docker/Compose first (app + Mongo + Meili + pgvector + RAG API + ClickHouse admin panel), Helm, one-click templates.
- **Maintenance:** Extremely active (RC release, same-day commits, ~14K PRs).
- **Where things live:** Chat UI `client/src/components/Chat/`; providers `api/app/clients/` + `api/server/services/Endpoints/`; config `librechat.example.yaml` (887 lines) + `packages/data-provider/src/config.ts`; docs external (docs.librechat.ai).

### 5.2 Feature inventory

**Chat UX & conversation**
- **Streaming (SSE)** (Mature) — normalized across all providers, live tool-call/citation/artifact handling. `api/app/clients/TextStream.js`; `client/src/hooks/Chat/useAdaptiveSSE.ts`.
- **Conversation forking/branching** (Mature) — **4 strategies** (DIRECT_PATH/INCLUDE_BRANCHES/TARGET_LEVEL/DEFAULT) w/ parent-child remap. `client/src/components/Chat/Messages/Fork.tsx`; `api/server/utils/import/fork.js`.
- **Multi-conversation compare mode** (Mature) — two side-by-side convos, different endpoint/model/params each. `client/src/components/Chat/AddMultiConvo.tsx`.
- **Temporary (ephemeral) chat** (Mature) — non-persisted, retention expiry (720h default). `client/src/components/Chat/TemporaryChat.tsx`.
- **Message actions (edit/regenerate/continue/copy/feedback)** (Mature) — feedback w/ tag taxonomy (helpful/creative vs incorrect/harmful/misleading). `client/src/components/Chat/Messages/{HoverButtons,Feedback}.tsx`; `packages/data-provider/src/feedback.ts`.
- **Presets** (Mature) — save/load endpoint+model+param bundles. `api/server/routes/presets.js`.
- **Auto title generation** (Mature) — per-endpoint title model, cached. `api/server/routes/convos.js`.
- **Landing / conversation starters** (Mature) — `{{user.name}}` substitution, branded model-spec tiles. `client/src/components/Chat/Landing.tsx`.
- **Bookmarks & tags** (Mature) — `client/src/components/Bookmarks/`; `api/server/routes/tags.js`.
- **Projects (workspace org)** (Mature) — group convos into projects. `api/server/routes/projects.js`; `packages/api/src/projects`.

**Prompting** — **Prompt templates/library** (Mature) — CRUD, categorize, Cmd+K search, public/private/shared visibility, usage/trending, optional GitHub sync, **ACL-gated per role**. `api/server/routes/prompts.js`; `client/src/components/Prompts/` (12 subdirs); `packages/api/src/prompts`.

**Model / provider**
- **Multi-provider switching** (Mature) — dynamic model discovery per provider + fallback/aliases. `api/server/controllers/EndpointController.js`; `client/src/hooks/Endpoint/useAvailableModels.ts`.
- **Custom OpenAI-compatible endpoints** (Mature) — arbitrary baseURL+key via YAML, `dropParams`, header placeholder substitution (`{{LIBRECHAT_USER_EMAIL}}`). `api/server/services/Config/getEndpointsConfig.js`. *Note:* recent SSRF hardening (#13919).
- **Model Specs (branded presets)** (Mature) — curated endpoint+model+instructions bundles w/ icons, hard/soft defaults, pinned skills/subagents. `packages/api/src/modelSpecs`.
- **Parameter tuning UI** (Mature) — dynamic per-endpoint panel; invalid params never sent. `client/src/components/SidePanel/Parameters/`.
- **Local (Ollama)** (Mature) — auto-discovery, vision, SSRF-validated. `api/app/clients/OllamaClient.js` (others ride custom-endpoint path).

**Multi-modal / files**
- **Vision input** (Mature) — per-provider encoding, Sharp resize. `api/server/services/Files/images/encode.js`; `api/app/clients/prompts/createVisionPrompt.js`.
- **File upload + pluggable storage** (Mature) — Local/S3/CloudFront/Azure/Firebase/OpenAI/VectorDB/OCR via strategy factory. `api/server/services/Files/{process,strategies}.js`.
- **File permissions + ACL** (Mature) — agent-based inheritance, VIEW vs EDIT. `api/server/services/Files/permissions.js`.
- **File retention/lifecycle** (Partial) — `expiredAt` expiry sweep. `api/server/services/Files/retention.js`.
- **File preview** (Mature) — thumbnails, Office HTML extraction, code preview. `client/src/components/Files/FileList/FilePreview.tsx`.

**RAG**
- **RAG (external RAG API + pgvector)** (Mature) — semantic (k=4) or full-doc context, JWT-authed. `api/app/clients/prompts/createContextHandlers.js`; `packages/api/src/files/rag.ts`; `rag.yml`. *Dep:* requires external `RAG_API_URL` + pgvector.
- **Citations / source tracking** (Mature) — relevance filtering (`minRelevanceScore` ~0.45), per-file/message caps, permission-gated. `api/server/services/Files/Citations/index.js`.

**Tools / MCP / agents**
- **Agents framework + builder** (Mature) — user-owned shareable tool-calling agents, no-code builder, ephemeral inline agents, recursion control, **multi-agent/subagents** (`discoverConnectedAgents`) across providers, agent marketplace. `api/server/controllers/agents/`, `packages/api/src/agents/`; `client/src/components/Agents/Marketplace.tsx`.
- **MCP servers + client** (Partial→Mature) — stdio/SSE/WS/HTTP, runtime add/remove, OAuth2 + OBO/Graph token flows, SSRF allowlists, per-user pooling + circuit breaker, tool pagination caps. `api/server/services/MCP.js`; `packages/api/src/mcp/`; `client/src/components/SidePanel/MCPBuilder/`.
- **MCP UI Resources** (Experimental) — renders server-defined UI inline. `client/src/components/MCPUIResource/`.
- **Unified tools/plugins + built-in catalog** (Mature) — DALL·E 3, Stable Diffusion, Flux, Gemini Image, Google/Tavily/Azure AI Search, Wolfram, OpenWeather, Calculator. `api/server/services/{ToolService,PluginService}.js`; `api/app/clients/tools/structured/`.
- **Custom Actions (OpenAPI → tools)** (Mature) — any OpenAPI spec → agent tools, OAuth2. `api/server/services/ActionService.js`; `packages/api/src/actions/`.
- **Skills (custom code tools + GitHub sync)** (Partial→Mature) — JS/Python code units, marketplace, GitHub sync scheduler. `api/server/routes/skills.js`; `packages/api/src/skills/`.
- **OpenAI/Azure Assistants API** (Mature) — assistant CRUD, threads, retrieval, code interpreter. `api/server/controllers/assistants/`.
- **Web search (with citations)** (Mature) — Tavily/Serper/SearXNG/Google + Firecrawl scrapers + Jina/Cohere rerankers, inline citation markers + hover cards. `packages/api/src/web/web.ts`; `client/src/components/Web/`.

**Artifacts / code**
- **Artifacts / canvas** (Mature) — React (Tailwind+shadcn+recharts+lucide), single-file HTML/CSS/JS, Mermaid, w/ version history, iframe-sandboxed. `api/app/clients/prompts/artifacts.js`; `client/src/components/Artifacts/`.
- **Code Interpreter (sandboxed, multi-language)** (Mature core / Experimental preview) — Python/Node/Go/C/C++/Java/PHP/Rust/Fortran in isolated external Code API; file upload/process/download; per-conversation/agent session identity. `api/server/services/Files/Code/`; `packages/api/src/agents/codeFilesSession.ts`. *Dep:* external Code API.

**Memory** — **Memory/personalization** (Mature) — user K-V memories w/ token limits + valid-key whitelist, LLM "memory agent" extracts set/delete ops, permission-gated (`MEMORIES` USE/READ/CREATE/UPDATE/OPT_OUT). `api/server/routes/memories.js`; `packages/api/src/agents/memory.ts`.

**Search** — **Conversation/message search (Meilisearch)** (Mature) — FTS over convos/messages/prompts, `_meiliIndex` sync, regex fallback. `api/server/routes/search.js`; `client/src/components/Nav/Search.tsx`.

**Auth / RBAC**
- **Email/pw + social/OAuth + reset** (Mature) — Google/GitHub(Enterprise)/Facebook/Discord/Apple, domain allowlists. `api/strategies/*Strategy.js`.
- **Enterprise SSO — OIDC / SAML / LDAP** (OIDC Mature / SAML+LDAP Partial) — full OIDC (PKCE, nonce, refresh, IdP→role sync), SAML 2.0, LDAP/AD. `api/strategies/{openidStrategy,samlStrategy,ldapStrategy}.js`.
- **JWT sessions + refresh rotation** (Mature) — `api/strategies/jwtStrategy.js`.
- **2FA (TOTP + backup codes)** (Mature) — `api/server/services/twoFactorService.js`.
- **Roles / RBAC + granular ACL + groups** (Mature) — system+custom roles, ~16 permission types, principal ACL (USER/GROUP/PUBLIC/ROLE × VIEWER/EDITOR/OWNER), grant/revoke/make-public, Entra ID principal search. `packages/api/src/acl/accessControlService.ts`; `api/server/services/PermissionService.js`.
- **On-Behalf-Of tokens + MS Graph** (Mature) — OBO exchange w/ caching/coalescing. `api/server/services/{OboTokenService,GraphApiService}.js`.

**Admin / governance** — capability-based admin grants + audit (`api/server/routes/admin/grants.js`); user-mgmt CLI (`config/*-user.js`); banner; **shared links / public chat** (snapshot, read-only, expiry, revoke — `api/server/routes/share.js`); **balance/billing** (token accounting + auto-refill — `api/server/routes/balance.js`).

**Voice** — **TTS/STT/Streaming TTS** (TTS+STT Mature / streaming Partial) — browser + OpenAI TTS, mic→external transcription. `client/src/components/Audio/`, `client/src/hooks/Audio/`.

**Other** — themes/dark (`packages/client/src/theme/`); **~41 locales** + RTL + Locize sync; **a11y** w/ live-region announcer (`client/src/a11y/`) + dedicated Playwright a11y config; responsive (no native app); **observability — OpenTelemetry + Langfuse + RUM proxy** (`packages/api/src/{telemetry,langfuse,rum}/`); security (rate limit, SSRF hardening, PII/credential message filtering — `packages/api/src/crypto`); import/export (JSON/CSV — `api/server/utils/import/`); broad REST API + SSE; Jest + Playwright (multi-config) tests; **context projection** (long-conversation compression — `api/server/controllers/ContextProjectionController.js`).

> **Cross-cutting:** authorization enforced consistently via `PermissionService` + ACL across agents/prompts/files/memories/MCP. Headline features lean on **required external services** (RAG API + pgvector, Code API sandbox, Meilisearch) → a "full" deploy is multi-container. A `tenantId` multi-tenancy framework exists but is only partially activated.

---

## 6. AnythingLLM

### 6.1 Repository overview

- **Repo / URL:** `Mintplex-Labs/anything-llm` — https://github.com/Mintplex-Labs/anything-llm (v1.14.2, HEAD `2026-06-22`). **MIT**.
- **Purpose:** Full-stack self-hostable "all-in-one" app turning private documents/URLs/data into a contextual RAG chatbot with agentic capabilities.
- **Stack:** JS/Node ESM monorepo. **Frontend** React+Vite+Tailwind, i18next (29 locales), markdown-it+highlight.js+KaTeX, recharts/tremor (`frontend/`). **Backend** Node≥18 Express + Prisma, **two services**: `server/` (API+agents+RAG) + `collector/` (document ingestion, signed inter-service comms).
- **DB:** Prisma + **SQLite default** (PostgreSQL supported); **10 pluggable vector DBs** (default LanceDB local); docs as JSON on disk.
- **Deployment:** Self-hosted Docker/bare-metal + IaC (AWS CFN, GCP, DO Terraform, K8s, OpenShift, Helm, HF Spaces); separate **desktop app** (external) + mobile app (separate repo; server has pairing endpoints).
- **Maintenance:** Very active (v1.14.2, daily commits).
- **Where things live:** Chat UI `frontend/src/components/WorkspaceChat/`; providers `server/utils/AiProviders/` + `EmbeddingEngines/` + `vectorDbProviders/` + `SpeechToText/`+`TextToSpeech/`; agents `server/utils/agents/aibitat/`; settings `server/models/systemSettings.js` + `frontend/src/pages/{Admin,GeneralSettings}/`.

### 6.2 Feature inventory

**Chat & conversation**
- **Workspace chat UI** (Mature) — streaming, markdown, code (copy/lang labels), KaTeX, DOMPurify, **inline data-viz charts (10 types)**. `frontend/src/components/WorkspaceChat/ChatContainer/`; `frontend/src/utils/chat/markdown.js`; `.../Chartable/`.
- **Message actions (copy/edit/regenerate/delete/feedback/fork)** (Mature) — thumbs-up scored feedback persisted; **fork thread** from a message. `.../HistoricalMessage/Actions/`; `server/models/workspaceChats.js`.
- **Multi-thread per workspace** (Mature) — named/slugged threads sharing the same KB; user-scoped or shared. `server/models/workspaceThread.js`; `.../ThreadContainer/`.
- **Prompt input — attachments/@-mentions/-commands/undo-redo/STT** (Mature) — drag-drop, `@agent`, `/` tools menu, Ctrl+Z stack, mic STT. `.../PromptInput/`.

**Prompting**
- **System prompt + history + variables** (Mature) — per-workspace prompt w/ version history, admin default, `{variable}` substitution. `server/models/{promptHistory,systemPromptVariables}.js`; `frontend/src/pages/Admin/`.
- **Slash commands & presets** (Mature) — custom presets, publishable to Community Hub. `server/models/slashCommandsPresets.js`.
- **Suggested messages** (Mature) — up to 4 on empty chat. `server/models/workspacesSuggestedMessages.js`.

**Model / provider**
- **LLM providers (~36)** (Mature) — base-class + sync/stream + token-map + vision detection; per-workspace `chatProvider`/`agentProvider` override. `server/utils/AiProviders/` (~30 dirs); `server/utils/helpers/index.js`.
- **Local / self-hosted** (Mature) — Ollama, LM Studio, LocalAI, KoboldCPP, Text-Gen-WebUI, NVIDIA NIM, Docker Model Runner, PrivateMode + native Transformers.js embeddings. `server/utils/AiProviders/{ollama,lmStudio,...}/`. *Note:* tool-calling emulated via prompt injection (`aibitat/providers/helpers/untooled.js`) when unsupported.
- **Model Router (rule-based)** (Partial) — routes per turn by token/message/attachment rules + cached LLM-classification, sticky cooldown + fallback. `server/utils/AiProviders/modelRouter/`, `server/models/modelRouter*.js`.
- **Multi-modal/vision** (Partial) — `image_url` content across ~30 providers; no central capability registry.

**RAG / KB**
- **Workspaces (RAG container)** (Mature) — similarity threshold (0.25), topN (4), chat/query/automatic modes, vector mode default/rerank, query-refusal response. `server/models/workspace.js`; `server/utils/chats/stream.js`.
- **Embedding engines + rerankers** (Mature / rerankers Partial) — 14 embedders + native cross-encoder reranker (ms-marco-MiniLM). `server/utils/EmbeddingEngines/`, `EmbeddingRerankers/native/`.
- **Vector DB (10 backends)** (Mature) — LanceDB/Pinecone/Chroma/Weaviate/Qdrant/Milvus/Zilliz/Astra/pgvector. `server/utils/vectorDbProviders/`.
- **Embedding pipeline + worker** (Mature) — isolated child-process worker w/ IPC progress (SSE-relayed), token-aware chunking. `server/utils/EmbeddingWorkerManager.js`, `server/jobs/embedding-worker.js`.
- **Pinned documents + two-stage upload** (Mature) — pin docs to always include (token-budgeted); parse→buffer→admin-embed. `server/utils/DocumentManager/index.js`.
- **Document sync/watching** (Mature) — periodic re-fetch + re-embed (link/youtube/confluence/github/gitlab), drop after 5 failures. `server/models/documentSyncQueue.js`; `server/jobs/sync-watched-documents.js`.

**File / document handling (Collector)**
- **Multi-format ingestion** (Mature) — PDF(+OCR fallback)/DOCX/PPTX/XLSX/ODT/EPUB/MBOX/audio-video(transcription)/images(OCR). `collector/processSingleFile/convert/`; `collector/utils/OCRLoader/`.
- **Web scraping + connectors** (Mature) — URL→Markdown, depth crawler, GitHub/GitLab/YouTube/Confluence/Obsidian/DrupalWiki/Paperless. `collector/processLink/`, `collector/utils/extensions/`.
- **Audio transcription** (Mature) — local Xenova Whisper or OpenAI Whisper + FFmpeg. `collector/utils/WhisperProviders/`.

**Agents / tools / MCP**
- **AIbitat multi-agent framework + @agent** (Mature) — tool-calling (native+emulated) over websocket w/ approval + clarifying-question flows. `server/utils/agents/aibitat/index.js`; `server/endpoints/agentWebsocket.js`.
- **Agent skills** (Mature) — built-in (memory/summarize/web-scrape) + configurable (web browse, **SQL agent** PG/MySQL/MSSQL, filesystem, file creation PDF/DOCX/XLSX/PPTX, charts) + integrations (Gmail/Outlook/Google Calendar), whitelist-controlled. `server/utils/agents/aibitat/plugins/`.
- **Agent Flows (no-code visual builder)** (Partial) — START/API_CALL/LLM_INSTRUCTION/WEB_SCRAPING/FINISH blocks w/ `${variable}` substitution → agent-callable tools. `server/utils/agentFlows/`; `frontend/src/pages/Admin/AgentBuilder/`.
- **MCP support** (Partial) — hypervisor boots/manages stdio/http/sse servers, per-tool suppression. `server/utils/MCP/hypervisor/index.js`.
- **Imported/community skills** (Partial) — third-party `plugin.json`+`handler.js`. `server/utils/agents/imported.js`. *Risk:* arbitrary handler code.
- **Scheduled jobs (cron agents)** (Partial) — cron-scheduled agent runs w/ preset prompt + tools, run history. `server/models/scheduledJob.js`.

**Users / auth / admin**
- **Multi-user mode + roles + invites + recovery** (Mature) — single (token) / multi (JWT) mode, 3 roles, daily message limits, suspension, invite codes, bcrypt recovery. `server/models/{user,invite}.js`.
- **System settings + admin console** (Mature) — 40+ settings (branding, text-splitter, agents, memory, telemetry). `server/models/systemSettings.js`; `frontend/src/pages/Admin/`.
- **Experimental features flags** (Experimental) — imported plugins, live sync. `server/endpoints/experimental/`.

**Memory** — **Memory/personalization** (Partial) — workspace + global memories w/ auto-extraction, view/add/edit/delete UI. `server/models/memory.js`; `.../MemoriesSidebar/`.

**Voice** — **TTS + STT in chat** (Mature) — per-message TTS (OpenAI/ElevenLabs/Kokoro/Piper/native), STT (Web Speech/OpenAI/Groq/Deepgram). `server/utils/{TextToSpeech,SpeechToText}/`.

**Artifacts** — **File generation + download cards + chart artifacts** (Partial) — agents generate downloadable PDF/DOCX/XLSX/PPTX; charts inline. No code-interpreter sandbox. `server/utils/agents/aibitat/plugins/create-files/`.

**Other** — theming/branding (logo/app-name/favicon — `frontend/src/ThemeContext.jsx`); **PWA + mobile device pairing (QR)** + external desktop app; **telemetry (PostHog opt-out) + event logs** (`server/models/{telemetry,eventLogs}.js`); privacy + signed inter-service comms + encryption manager (`server/utils/EncryptionManager/`); **chat export + Community Hub** publish/import (`server/endpoints/communityHub.js`); **versioned REST API + OpenAI-compatible `/v1/openai/*`** (workspaces as "models") + Swagger (`server/endpoints/api/`); **embeddable chat widget** (domain allowlist, rate limits — `server/models/embedConfig.js`, submodule `embed/`); **browser extension** (`server/endpoints/browserExtension.js`); Telegram bot + web push; multi-target IaC deployment; Jest unit tests (~2 dozen suites, Partial coverage); 29 locales.

---

## 7. Jan

### 7.1 Repository overview

- **Repo / URL:** `janhq/jan` (pkg `jan-app`) — https://github.com/janhq/jan (HEAD `ef4d219`, 2026-06-22). © Menlo Research, Apache-2.0-family.
- **Purpose:** Open-source, **local-first** desktop "ChatGPT replacement" — download and run LLMs locally (llama.cpp / Apple MLX) with full privacy, plus optional cloud providers.
- **Stack:** **Frontend** React+TS+Vite, TanStack Router, Zustand, Radix, Tailwind, i18next, Vercel `ai` SDK, Shiki/Mermaid (`web-app/`). **Desktop runtime Tauri 2 (Rust)** — *not* Electron; mobile via Tauri mobile. **Local engines** llama.cpp + Apple MLX. Native Rust plugins (`tauri-plugin-{llamacpp,mlx,hardware,rag,vector-db}`).
- **Backend/runtime:** Rust Tauri core (`src-tauri/src/core/`) exposing `invoke` commands + a **local OpenAI/Anthropic-compatible HTTP server** (hyper). MCP client via `rmcp`.
- **DB:** SQLite (threads/messages, `sqlx`) + **sqlite-vec** vector search; JSON/YAML on disk; everything local (`~/Jan/data/`).
- **Deployment:** Desktop binaries (Microsoft Store, Flathub, direct) w/ HMAC-signed auto-update + embedded local API server. No cloud backend.
- **Maintenance:** Very active (commit 2026-06-22, 17+ locales).
- **Monorepo:** `core/` (`@janhq/core` SDK: engine abstractions `OAIEngine`/`Local`/`Remote` + `EngineManager`), `web-app/` (React SPA), `extensions/` (llamacpp/mlx/assistant/conversational/download/rag/vector-db), `src-tauri/` (Rust shell + plugins + local server + MCP + updater), `mlx-server/`, `docs/`, `autoqa/` (Python computer-use E2E).
- **Where things live:** Chat UI `web-app/src/routes/threads/$threadId.tsx` + `containers/{ChatInput,MessageItem}.tsx` + `components/ai-elements/`; providers `web-app/src/constants/providers.ts` + `core/.../engines/RemoteOAIEngine.ts`; local engines `extensions/{llamacpp,mlx}-extension/` + Rust plugins; settings `web-app/src/routes/settings/*`.

### 7.2 Feature inventory

**Chat & conversation**
- **Threaded chat** (Mature) — streaming, reasoning/thinking disclosure, tool-call rendering, markdown/code/Mermaid/tables. `web-app/src/routes/threads/$threadId.tsx`; `containers/{ChatInput,MessageItem}.tsx`; `components/ai-elements/`. *Risk:* 2400+/1600-line monolith files.
- **Thread management** (Mature) — create/rename/delete, favorites+recents, SQLite persistence, **temporary (ephemeral) mode**, title gen. `containers/ThreadList.tsx`; `extensions/conversational-extension/`; `src-tauri/src/core/threads/db.rs`.
- **Message actions** (Mature) — copy, edit (incl. image parts), regenerate, **token-speed indicator**, citations. `containers/MessageItem.tsx`, `TokenSpeedIndicator.tsx`, `components/Citations.tsx`.
- **Message queue (send while busy)** (Partial) — `stores/message-queue-store.ts`.

**Prompting** — **Sampler/model parameters** (Mature) — per-thread temp/top-k/top-p/repeat-penalty + assistant defaults + presets. `containers/{SamplerPopover,SamplerDefaults}.tsx`; `routes/settings/assistant.tsx`.

**Model / provider**
- **Remote provider mgmt (BYOK)** (Mature) — OpenAI/Azure/Anthropic(native)/OpenRouter/Mistral/Groq/xAI/Gemini/MiniMax/HF/NVIDIA NIM + custom; per-provider base-URL override. `web-app/src/constants/providers.ts`; `core/.../RemoteOAIEngine.ts`.
- **Local model hub + downloads** (Mature, headline) — browse/search hub + HF GGUF/MLX, quant selection, progress, import local GGUF, capability badges. `web-app/src/routes/hub/`; `extensions/download-extension/`; `src-tauri/src/core/downloads/`.
- **llama.cpp engine** (Mature) — managed `llama-server` router (multi-model on demand), auto hardware backend (CPU AVX/CUDA/Vulkan/HIP/Metal), per-model context/GPU-layers/flash-attn/speculative-decoding/embeddings, HMAC-keyed. `extensions/llamacpp-extension/`; `src-tauri/plugins/tauri-plugin-llamacpp/`. *Risk:* highest-complexity code; hardware-matrix fragility.
- **Apple MLX engine (macOS)** (Partial) — safetensors on Apple Silicon, OpenAI-compatible. `extensions/mlx-extension/`; `mlx-server/`.
- **System/hardware monitor** (Mature) — live CPU/RAM/GPU/VRAM, model-fit. `web-app/src/routes/system-monitor.tsx`; `src-tauri/plugins/tauri-plugin-hardware`.

**Multimodal / RAG**
- **File upload + attachments** (Mature) — PDF/txt/md/CSV/Excel/PPT/Word/code + image/audio/video chips. `web-app/src/hooks/useAttachments.ts`; `src-tauri/plugins/tauri-plugin-rag/src/parser.rs`.
- **RAG** (Partial) — chunk+embed attached docs, MCP-style `retrieve`/`list_attachments`/`get_chunks`, thread+project scopes, local embeddings via llamacpp. `extensions/rag-extension/`; `web-app/src/stores/grounding-store.ts`.
- **Vector DB (sqlite-vec)** (Mature) — per-collection SQLite vec0 + linear fallback, cosine ANN. `extensions/vector-db-extension/`; `src-tauri/plugins/tauri-plugin-vector-db/src/db.rs`.

**Tools / agents / MCP / extensions**
- **MCP tool servers** (Mature) — stdio/HTTP/SSE, preconfigured (Browser MCP/exa/fetch/serper/filesystem/sequential-thinking), lockfile-tracked, exponential-backoff restart, optional **smart tool routing** (lightweight router model). `src-tauri/src/core/mcp/`; `web-app/src/routes/settings/mcp-servers.tsx`. (`rmcp` v0.8.5.)
- **Tool-approval/permission gating** (Mature) — per-thread allow-once/always/deny, persisted, modal. `web-app/src/hooks/{useToolApproval,useModelContextApproval}.ts`.
- **Agent mode** (Partial/Experimental) — per-thread autonomous multi-step tool use. `web-app/src/hooks/useAgentMode.ts`.
- **Assistants (personas)** (Mature) — named instructions+params+avatar, migration-versioned, switcher. `extensions/assistant-extension/`; `components/AssistantsMenu.tsx`.
- **Projects (grouped workspaces)** (Partial→Mature) — threads+files under a project, per-project assistant/model, scoped RAG. `web-app/src/routes/project/$projectId.tsx`.
- **Extension system** (Mature) — runtime-registered engines/conversational/assistant/RAG/vector-db. `core/src/browser/extension.ts`; `web-app/src/providers/ExtensionProvider.tsx`.

**Artifacts / dev**
- **HTML artifacts + code blocks** (Mature) — strict CSP-sandboxed iframe (scripts/network off by default), Shiki highlight, Mermaid. `web-app/src/components/HtmlArtifact.tsx`. *Risk:* CSP/sandbox load-bearing.
- **Local OpenAI/Anthropic-compatible API server** (Mature) — hyper server `/v1/chat/completions`/`/v1/embeddings`/`/v1/models` + Anthropic `/messages`, configurable host/port/key/trusted-hosts/CORS, optional server-side MCP orchestration. `src-tauri/src/core/server/`; `routes/settings/local-api-server.tsx`.
- **Claude Code integration** (Partial) — wire Jan's local server + a model to Claude Code CLI. `web-app/src/routes/settings/claude-code.tsx`.
- **CLI (`jan-cli`)** (Experimental) — `src-tauri/src/bin/jan-cli.rs`.

**Desktop / system**
- **Auto-update (custom HMAC)** (Mature) — HMAC-signed manifests + session handling. `src-tauri/src/core/updater/`.
- **Native window chrome / deep links / proxy / browser-extension bridge** (Mature) — `web-app/src/components/{WindowControls,WindowResizeGrips}.tsx`; `routes/settings/https-proxy.tsx`.
- **Mobile targets (iOS/Android)** (Experimental) — Tauri mobile builds.

**Settings / privacy** — settings hub (`routes/settings/*`); **privacy / local-first + opt-in PostHog analytics** (`routes/settings/privacy.tsx`, `providers/AnalyticProvider.tsx`). **No accounts/RBAC/teams** (single-user desktop trust model — intentional).

**Other** — theming + accent/font-size + colored-bubble (`routes/settings/interface.tsx`); **17 locales** (`web-app/src/i18n/`); keyboard shortcuts + global search dialog (`routes/settings/shortcuts.tsx`, `hooks/useSearchDialog.ts`); **no first-party voice/TTS/STT**, **no cross-thread memory** (assistants/projects only); logging + log viewer (`routes/logs.tsx`); MCP routing telemetry; data folder persistence; multi-platform Tauri/Flatpak/MS-Store packaging; **Vitest + Rust unit tests + Python `autoqa/` computer-use E2E**.

**Intentional absences** (single-user local app): no accounts/RBAC/teams, no native TTS/STT, no persistent cross-thread memory, no first-class chat-export UI (data-folder is the portability path).

---

## 8. Cross-repo capability matrix + gap analysis

Legend: ●=mature/strong · ◐=partial · ○=absent/none. "OpenWOP" = `app.openwop.dev` today.

| Capability | OpenWOP | Open WebUI | LobeHub | LibreChat | AnythingLLM | Jan |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Streaming chat | ● | ● | ● | ● | ● | ● |
| Conversation branching/forking | ○ | ● | ● | ● | ◐ (fork) | ○ |
| Multi-model side-by-side compare | ○ | ● | ● | ● | ○ | ○ |
| Full-text conversation search | ○ | ● | ● | ● | ◐ | ◐ |
| Conversation export/import | ○ | ● | ● | ● | ◐ | ◐ |
| Prompt library UI (shareable/RBAC) | ◐ | ● | ● | ● | ● | ◐ |
| Multi-provider mgmt | ● | ● | ● | ● | ● | ● |
| **Local model support** | ○ | ● | ● | ● | ● | ● |
| In-chat model switch UI | ◐ | ● | ● | ● | ● | ● |
| Image input (vision) | ● | ● | ● | ● | ◐ | ● |
| **Image generation** | ○ | ● | ● | ● | ◐ | ○ |
| Video generation | ○ | ○ | ● | ○ | ○ | ○ |
| **Web search + citations** | ○ | ● | ● | ● | ◐ | ◐(MCP) |
| RAG / knowledge base | ● | ● | ● | ● | ● | ◐ |
| **Reranking + hybrid (BM25)** | ○ | ● | ● | ● | ◐ | ○ |
| Broad doc loaders / OCR | ◐ | ● | ◐ | ● | ● | ◐ |
| Tools / MCP | ● | ● | ● | ● | ● | ● |
| Agents / multi-agent | ● | ◐ | ● | ● | ● | ◐ |
| **Code interpreter / sandbox** | ○ | ● | ● | ● | ○ | ◐(WASM) |
| Artifacts / canvas | ◐ | ● | ● | ● | ◐ | ● |
| Memory / personalization | ● | ● | ● | ● | ◐ | ○ |
| **Memory auto-extraction from chat** | ○ | ◐ | ● | ● | ● | ○ |
| Auth / SSO / SCIM | ● | ● | ● | ● | ◐ | ○ |
| RBAC / granular ACL | ● | ● | ● | ● | ◐ | ○ |
| Scheduled/recurring agent runs | ◐ | ● | ● | ○ | ◐ | ○ |
| Team channels / real-time | ○ | ● | ◐ | ○ | ○ | ○ |
| Voice in (STT) | ◐ | ● | ◐ | ● | ● | ○ |
| Voice out (TTS) | ◐ | ● | ● | ● | ● | ○ |
| **Live bidirectional voice** | ○ | ◐ | ◐ | ○ | ○ | ○ |
| **Shared links / public chat** | ◐ | ● | ● | ● | ● (widget) | ○ |
| **Embeddable public widget** | ◐ | ○ | ○ | ○ | ● | ○ |
| **LLM observability (OTel/trace)** | ◐ | ● | ● | ● | ◐ | ◐ |
| **Eval / RLHF leaderboard** | ○ | ● | ◐ | ◐ | ○ | ○ |
| Theming / dark | ● | ● | ● | ● | ● | ● |
| i18n breadth | ◐(2) | ●(62) | ●(18) | ●(41) | ●(29) | ●(17) |
| RTL support | ○ | ● | ● | ● | ◐ | ○ |
| Desktop/local app | ○ | ○ | ● | ○ | ● | ● |

### Gap themes (ranked by strategic value)

1. **Chat-native agentic capabilities** (web search, code execution, image gen) delivered inside the turn with citations/artifacts — every leader has at least two; OpenWOP has none in-chat despite owning the right substrate.
2. **Retrieval quality** — reranking + hybrid BM25 + broad ingestion are now table-stakes for RAG; OpenWOP's single-stage cosine + text/PDF-only ingestion is behind.
3. **Conversation power-UX** — full-text search, branching/forking, multi-model compare, export. Pure productivity wins, mostly host-side.
4. **Prompt library** — a shareable, RBAC-gated, versioned prompt catalog is universal; OpenWOP only has per-agent prompts.
5. **Observability & evals** — OTel tracing + an eval/feedback leaderboard. OpenWOP already captures feedback (ADR 0071) but doesn't trace or score.
6. **Local models** — universal in this set; the one true wire-honesty item (needs an `openwop` RFC for capability advertisement).
7. **Reach** — shared/public read-only chat links, embeddable public widget, live voice. Differentiators, lower urgency.

---

## 9. Ranked ADR backlog (recommendations)

> **No ADR files were authored** (per the "research doc only" decision). This is the prioritized backlog: greenlight any item to convert into a full `/feature-refinement` ADR. Each item notes **OpenWOP fit** (the existing seam it rides — reuse-not-recreate), **reference impls** to study, and the **RFC gate** (does it touch the OpenWOP wire → needs an `openwop` RFC *before/with* host work, or is it pure host work).

Priority tiers: **P0** = highest value × best fit, do first · **P1** = high value, clear path · **P2** = valuable, more scope/dependencies · **P3** = differentiator / large effort / lower urgency.

### P0 — do first (high value, rides existing seams, mostly host work)

**B1. Full-text conversation & message search**
- **Why:** the single most-requested productivity gap; universal in the field; OpenWOP has none.
- **OpenWOP fit:** new search surface over the existing conversation/message store (ADR 0043); a `feature.search` package + sidebar entry. Postgres FTS (we're already on Cloud SQL) avoids a new service; Meilisearch optional later.
- **Reference:** LibreChat `api/server/routes/search.js` + Meilisearch sync; Open WebUI `routers/chats.py` search (SQL LIKE, AND + `tag:`); LobeHub `packages/database/src/repositories/search/`.
- **RFC gate:** none — host-side query over host data.

**B2. Web-search tool node + inline citation rendering**
- **Why:** turns chat into a grounded research surface; the most common agentic tool across the field.
- **OpenWOP fit:** a `core.openwop.web` (or extend `core.openwop.ai`) **node pack** providing a `web.search` tool + a chat citation renderer; drive via agent packs (ADR 0058). Reuse A2UI/citation surface patterns. Provider keys via Connections (ADR 0024).
- **Reference:** Open WebUI `retrieval/web/*.py` (25+ providers, cleanest factory to study); LibreChat `packages/api/src/web/web.ts` + `client/src/components/Web/` (citations+hovercards); LobeHub `packages/web-crawler/src/crawImpl/`.
- **RFC gate:** none if it rides the existing tool/run surface; **RFC only if** we advertise a new normative capability flag for "web-search-grounded" runs.

**B3. KB reranking + hybrid (BM25 + dense) retrieval**
- **Why:** biggest single quality lever for our existing RAG; closes the gap to every leader.
- **OpenWOP fit:** enhancement to the `kb` feature (ADR 0011) retrieval stage — add a reranker step + BM25 channel behind the existing `resolveSubjectKnowledgeRetrieve` seam (ADR 0042); no new feature-package.
- **Reference:** Open WebUI `retrieval/utils.py` + `retrieval/models/{colbert,base_reranker}.py` (CrossEncoder/ColBERT/external); AnythingLLM `EmbeddingRerankers/native/`; LobeHub `builtin-tool-knowledge-base/` (semanticSearch + BM25).
- **RFC gate:** none — internal retrieval quality; deterministic-embedder replay invariants must be preserved.

### P1 — high value, clear path

**B4. Sandboxed code-execution node + artifact projection**
- **Why:** unlocks data analysis, file generation, and "run this" workflows; present in 3 of 5 leaders.
- **OpenWOP fit:** a `core.openwop.code` **node pack** calling an isolated sandbox; project results through the existing **artifact workbench** (ADR 0069) and stream via `ai.message.chunk` (ADR 0079). HITL gate (ADR 0051) for execution approval.
- **Reference:** LibreChat `api/server/services/Files/Code/` (external Code API, multi-language, per-session identity — the cleanest model); Open WebUI `utils/code_interpreter.py` (Jupyter+Pyodide); LobeHub `packages/python-interpreter/` (Pyodide worker).
- **RFC gate:** host work if it reuses existing run/artifact events; **RFC if** a new artifact type or execution-result event is added to the wire.

**B5. Image-generation node + chat output rendering**
- **Why:** a visible, high-demand modality OpenWOP entirely lacks in-chat.
- **OpenWOP fit:** a `core.openwop.image` **node pack** (OpenAI/Imagen/Flux providers via Connections); render output as a Media token projected into chat (ADR 0069 artifact projection); cost-governed (ADR 0106 media budget — already Proposed).
- **Reference:** Open WebUI `routers/images.py` + `utils/images/comfyui.py` (4 backends); LobeHub `src/store/image/` + `webapi/create-image/`; LibreChat built-in DALL·E/Flux tools.
- **RFC gate:** none if image output rides Media/artifact surfaces; **RFC if** a normative "image-output" capability is advertised.

**B6. Prompt library feature-package (shareable, RBAC, versioned)**
- **Why:** universal; turns ad-hoc prompts into governed, reusable team assets.
- **OpenWOP fit:** a `feature.prompts` package with toggle/admin UI + RBAC (workspace:read/write) + the existing prompt-template seam (ADR 0053 / RFC 0027); `/`-insertable in ChatInput; variable substitution. Public/private/shared visibility via existing ACL.
- **Reference:** LibreChat `api/server/routes/prompts.js` + `client/src/components/Prompts/` (ACL-gated, Cmd+K, trending, GitHub sync); Open WebUI `routers/prompts.py` + `models/prompt_history.py` (version history); AnythingLLM `systemPromptVariables`.
- **RFC gate:** none — host feature over host data.

**B7. Conversation branching/forking + multi-model compare**
- **Why:** non-destructive exploration + live model comparison; strong power-user UX present in the three web leaders.
- **OpenWOP fit:** extends the conversation primitive (ADR 0043) + conversation-run (ADR 0067, which already supports run-fork at the infra level — surface it in UI). Compare mode = two scoped `ConversationView`s (ADR 0073).
- **Reference:** LibreChat `client/src/components/Chat/Messages/Fork.tsx` + `api/server/utils/import/fork.js` (4 strategies); Open WebUI tree-history + `Overview/` graph; LobeHub `packages/conversation-flow/` + thread schema.
- **RFC gate:** host work; verify replay/fork-safety invariants hold for branched message trees (this is exactly the kind of decision an ADR must get right — flag for `/architect`).

**B8. LLM observability — OpenTelemetry + per-turn tracing**
- **Why:** production-grade visibility into cost/latency/tool-calls; we have telemetry data but no tracing.
- **OpenWOP fit:** instrument the run/dispatch path; export OTel spans; optional Langfuse sink. Complements existing run metadata + health indexing (ADR 0080).
- **Reference:** LibreChat `packages/api/src/{telemetry,langfuse}/` (OTel + Langfuse + RUM proxy — the most complete); Open WebUI `utils/telemetry/`; LobeHub `packages/{observability-otel,agent-tracing}/`.
- **RFC gate:** none — operational instrumentation.

### P2 — valuable, more scope or dependencies

**B9. Conversation export/import (markdown + JSON)** — easy win; turn transcript → Document (ADR 0053) or downloadable JSON; import from OpenAI/other exports. *Ref:* Open WebUI NDJSON `routers/chats.py`; LibreChat `api/server/utils/import/`. *RFC:* none.

**B10. Memory auto-extraction from chat** — extend `subjectMemory` (RFC 0004 / ADR 0041) with an LLM extraction pass writing durable facts; consent-gated, fenced like twin-recall (ADR 0044). *Ref:* LibreChat `packages/api/src/agents/memory.ts`; LobeHub `packages/memory-user-memory/`; AnythingLLM `utils/memories/`. *RFC:* none (host memory).

**B11. Broader document loaders / OCR ingestion for KB** — extend `kb` ingest beyond text/PDF (DOCX/PPTX/XLSX/EPUB/audio-video transcript/image OCR/URL crawl). *Ref:* AnythingLLM `collector/processSingleFile/convert/` + `utils/extensions/` (the reference "collector" service); Open WebUI `retrieval/loaders/`. *RFC:* none.

**B12. Local model support (Ollama / OpenAI-compatible BYO endpoint)** — add a local/compat provider to the provider abstraction + BYOK (ADR 0067); capability-probe (`modelCapabilityGate.ts`) for vision/tools. *Ref:* LibreChat `api/app/clients/OllamaClient.js` + custom-endpoint path; Jan `core/.../RemoteOAIEngine.ts`; AnythingLLM local providers. **RFC gate: YES** — advertising local-model support / a new provider class is a wire-honesty claim; needs an `openwop` RFC for capability advertisement before host work (`OPENWOP_REQUIRE_BEHAVIOR=true` would fail a dishonest claim).

**B13. Shared links / public read-only conversation** — snapshot a conversation to a revocable public link; reuse Sharing (ADR 0013) + content-trust taint. *Ref:* LibreChat `api/server/routes/share.js`; Open WebUI `models/shared_chats.py`. *RFC:* none.

**B14. Eval / feedback leaderboard from existing MessageFeedback** — we already persist thumbs+reason (ADR 0071); build an admin leaderboard + optional A/B model arena. *Ref:* Open WebUI `routers/evaluations.py` (Elo K=32 + semantic re-rank); LobeHub `packages/eval-rubric/`. *RFC:* none.

**B15. In-chat model-switch UI + capability-aware selector** — surface model/provider switching in ChatInput, gated by capability probe; reuses provider abstraction. *Ref:* LibreChat `useAvailableModels` + Model Specs; LobeHub `ModelSwitchPanel/`; Open WebUI `ModelSelector/`. *RFC:* none.

**B16. Recurring/scheduled agent chat runs** — extend roster schedules + nested agentic run (ADR 0089) with RRULE/cron-triggered chat turns + run history. *Ref:* Open WebUI `models/automations.py` (RRULE, `FOR UPDATE SKIP LOCKED`); LobeHub Fleet scheduler; AnythingLLM `scheduledJob.js`. *RFC:* none (host orchestration).

### P3 — differentiators / larger effort / lower urgency

**B17. Live bidirectional voice (call mode)** — mic→STT→LLM→TTS streaming overlay; large effort, latency-sensitive. *Ref:* Open WebUI `CallOverlay.svelte`; LobeHub realtime. **RFC gate: likely** (realtime/streaming-audio wire profile).

**B18. Team channels / real-time messaging** — topic-organized channels w/ presence; explicitly deferred in ADR 0043. *Ref:* Open WebUI `models/channels.py` + `socket/`. **RFC gate: possibly** (presence/delivery semantics).

**B19. Embeddable PUBLIC chat widget** — distinct from internal `EmbeddedChatPanel` (ADR 0073): a public, domain-allowlisted, rate-limited widget for external sites. *Ref:* AnythingLLM `models/embedConfig.js` + `embed/` submodule. *RFC:* none (host-ext route).

**B20. Video generation node** — niche but emerging; node pack + webhook-async like image gen. *Ref:* LobeHub `src/store/video/` + `webhooks/video/`. **RFC gate:** as for image output.

**B21. RTL + i18n breadth** — we have EN+pt-BR (ADR 0065); leaders ship 17–62 locales + RTL. Incremental. *Ref:* Open WebUI `src/lib/i18n/` (62 locales, RTL auto-direction). *RFC:* none.

**B22. Context compression for long conversations** — token-aware history summarization to cut cost on long threads. *Ref:* LibreChat `ContextProjectionController.js`; LobeHub context-engine summary injector. *RFC:* none.

### Suggested sequencing

1. **Quarter 1 (productivity + quality):** B1 (search), B3 (rerank/hybrid), B6 (prompt library), B9 (export). All host-side, no RFC, immediate user value.
2. **Quarter 2 (agentic chat):** B2 (web search), B5 (image gen), B4 (code exec). Node-pack pattern; B4 is the heaviest (sandbox + security review via `/architect`).
3. **Quarter 3 (depth):** B7 (branching/compare), B8 (observability), B10 (memory auto-extract), B11 (loaders), B14 (eval leaderboard).
4. **Wire-gated / strategic:** B12 (local models — start the `openwop` RFC early since host work is blocked on it), B17/B18 (voice/channels).

---

## 10. Appendix — licensing caveats & clone locations

**Licensing (critical for any code reuse / white-label):**
- **Open WebUI** — ⚠️ **custom "Open WebUI License"** (BSD-3 derivative + **branding-protection clause §4**): cannot remove "Open WebUI" branding above 50 users without permission/enterprise license. **Not OSI-permissive.** Study concepts; do not lift branded code into a white-label build.
- **LobeChat/LobeHub** — ⚠️ **LobeHub Community License** (Apache-2.0 base + commercial-distribution restriction). `package.json` says MIT but the LICENSE file is authoritative & more restrictive. **Port concepts, not copied code.**
- **LibreChat** — **MIT.** Cleanest to adapt.
- **AnythingLLM** — **MIT** (+ `TERMS_SELF_HOSTED.md`). Clean to adapt.
- **Jan** — **Apache-2.0-family** (© Menlo Research). Clean to adapt.

> Practical rule: prefer **LibreChat / AnythingLLM / Jan** as direct code references; treat **Open WebUI / LobeHub** as architecture/concept references only.

**Clone locations (this run, shallow `--depth 1`):** `/tmp/research-open-webui` (v0.9.6), `/tmp/research-lobe-chat`, `/tmp/research-librechat` (v0.8.7-rc1), `/tmp/research-anythingllm` (v1.14.2), `/tmp/research-jan`. Re-clone for fresh inspection — paths cited above are relative to each repo root.

**OpenWOP reuse principle reminder (CLAUDE.md):** there is ONE chat (`frontend/react/src/chat/`). Every recommendation above is framed to **ride existing seams** — node packs + agent packs (ADR 0058), `EmbeddedChatPanel`/`ConversationView` (ADR 0073), `kb` (ADR 0011), `subjectMemory` (RFC 0004), artifact workbench (ADR 0069), Connections (ADR 0024) — never a second chat system. Any item marked **RFC gate: YES** must land an Accepted `openwop` RFC before/with the host work.

---

## 11. Feature-by-feature comparison vs `app.openwop.dev`

**Verification basis (read first):** OpenWOP status is classified from the **codebase + ADRs** (the authoritative source — real files in `frontend/react/src/chat/`, `FEATURES.md`, chat ADRs, and the backend run/provider/RAG/RBAC surface were read), not from a live click-through. The deployed app is **auth + BYOK-gated**, so a logged-out browser session cannot reach gated features (RAG, agents, MCP, replay, etc.) — code is stronger evidence there. The only things a live UI pass actually resolves are a few **UI-presence** questions; those are marked **Unknown / needs verification** and collected in §11.7 for a targeted `/browser` run. Nothing below is asserted as present unless it is traceable to a file or ADR.

**Status legend:** `Already exists` · `Partially exists` · `Missing` · `Better than source` · `Not applicable` (out of scope for a cloud multi-tenant host) · `Unknown / needs verification`.
**Gap severity:** Critical · High · Medium · Low · None. **Recommendation** cites the §9 backlog IDs (B1–B22).

### 11.1 Open WebUI → OpenWOP

| Source repo | Feature | Source maturity | OpenWOP status | Gap severity | Recommendation |
|---|---|---:|---|---:|---|
| Open WebUI | Streaming responses | Mature | Better than source (replay-safe `ai.message.chunk`, ADR 0079) | None | None |
| Open WebUI | Edit / regenerate / continue | Mature | Partially exists (regenerate ✓; edit + continue ✗ confirmed) | Medium | Create ADR (message edit + continue) |
| Open WebUI | Multi-model side-by-side + branching | Mature | Missing | High | Create ADR (B7) |
| Open WebUI | Conversation flow graph (Overview) | Mature | Missing | Low | Monitor (rides B7) |
| Open WebUI | Rich rendering (md/KaTeX/Mermaid/code/citations) | Mature | Partially exists (md/code/citations ✓; KaTeX/Mermaid ✗ confirmed) | Medium | Enhance (add math + diagram rendering) |
| Open WebUI | Slash commands + input menus | Mature | Partially exists (`/` + `@` ✓; template-variable insert ◐) | Medium | Enhance (B6) |
| Open WebUI | Chats / folders / tags / pin / archive / share | Mature | Partially exists (chats ✓; folders/tags/pin/archive ✗) | Medium | Create ADR (folders/archive) |
| Open WebUI | Full-text search across chats | Mature | Missing | High | Create ADR (B1) |
| Open WebUI | Import / export | Mature | Missing | Medium | Create ADR (B9) |
| Open WebUI | Multi-provider connections | Mature | Already exists (ADR 0067) | None | None |
| Open WebUI | Custom model defs (prompt/params/tools/access) | Mature | Better than source (roster agent + `agentProfile`, replay+RBAC) | None | None |
| Open WebUI | Local model lifecycle (Ollama) | Mature | Missing | High | Create ADR (B12 — RFC gate) |
| Open WebUI | Vision input | Mature | Already exists | None | None |
| Open WebUI | Image generation (4 backends) | Mature | Missing | High | Create ADR (B5) |
| Open WebUI | STT (5 engines) | Mature | Partially exists (Gemini transcribe in) | Medium | Enhance |
| Open WebUI | TTS (5 engines + Kokoro) | Mature | Partially exists (podcast TTS ADR 0086; no per-message chat TTS) | Medium | Enhance |
| Open WebUI | Live voice call mode | Experimental | Missing | Low | Monitor (B17) |
| Open WebUI | Document loaders / OCR (multi-engine) | Mature | Partially exists (text/PDF only) | High | Create ADR (B11) |
| Open WebUI | Vector DB (~14 backends) | Mature | Partially exists (host store; pgvector-capable per ADR 0011) | Low | Monitor |
| Open WebUI | Embeddings + hybrid BM25 + reranking | Mature | Missing (rerank/BM25); embeddings ✓ | Critical | Create ADR (B3) |
| Open WebUI | Knowledge bases (collections + dirs + ACL) | Mature | Partially exists (collections+ACL ✓; no nested dirs) | Low | Enhance |
| Open WebUI | Web search (25+ providers) | Mature | Missing | High | Create ADR (B2) |
| Open WebUI | Storage backends (Local/S3/GCS/Azure) | Mature | Partially exists (host Media token + BYOK storage) | Low | Monitor |
| Open WebUI | User-defined Python tools (`exec()`) | Mature | Partially exists (node packs + MCP — safer, replay-safe; no in-app authoring) | Medium | Enhance (we deliberately avoid `exec()`) |
| Open WebUI | Functions (filters/pipes/actions) | Mature | Partially exists (workflows/node packs cover pipes) | Medium | Monitor |
| Open WebUI | Pipelines server (external middleware) | Mature | Not applicable (workflow engine is the equivalent) | None | None |
| Open WebUI | MCP client + OpenAPI tool servers | MCP Exp / OpenAPI Mature | Better than source (MCP in+out + `openapi-call` node) | None | None |
| Open WebUI | Built-in tool catalog (30+) | Mature | Partially exists (7 node packs; lacks web/image/code) | Medium | Create ADR (B2/B4/B5) |
| Open WebUI | Skills (reusable prompt modules) | Mature | Partially exists (prompt-templates ADR 0053) | Medium | Create ADR (B6) |
| Open WebUI | Automations (scheduled chat runs, RRULE) | Mature | Partially exists (roster schedules + ADR 0089) | Medium | Enhance (B16) |
| Open WebUI | Tasks (background gen jobs) | Mature | Partially exists (async runs) | Low | Monitor |
| Open WebUI | Terminals (remote shell proxy) | Mature | Missing | Low | Monitor (security-misaligned) |
| Open WebUI | Code interpreter (Jupyter + Pyodide) | Mature | Missing | High | Create ADR (B4) |
| Open WebUI | Artifacts / code canvas | Mature | Partially exists (artifact workbench ADR 0069; no live iframe canvas) | Medium | Enhance |
| Open WebUI | Playground | Mature | Missing | Low | Monitor |
| Open WebUI | Auth methods (local/JWT/OAuth/OIDC/LDAP/header) | Mature | Already exists (ADR 0006 + RFC 0050) | None | None |
| Open WebUI | SCIM 2.0 provisioning | Experimental | Better than source (RFC 0050-backed, ADR 0002) | None | None |
| Open WebUI | Roles / groups / granular ACL | Mature | Already exists (ADR 0006/0036) | None | None |
| Open WebUI | Channels (real-time team messaging) | Mature | Missing | Medium | Monitor (B18) |
| Open WebUI | Notes | Mature | Partially exists (notebooks ADR 0085 / documents) | Low | Monitor |
| Open WebUI | Calendar | Mature | Not applicable | None | None |
| Open WebUI | Prompts library (with history) | Mature | Partially exists (per-agent prompt only) | High | Create ADR (B6) |
| Open WebUI | Long-term memory | Mature | Better than source (RFC 0004 namespaced + consent twin-recall) | None | None |
| Open WebUI | Admin settings console | Mature | Better than source (toggles + variant testing, ADR 0001) | None | None |
| Open WebUI | Usage analytics dashboard | Mature | Partially exists (run telemetry; published-surface analytics) | Medium | Enhance (B8) |
| Open WebUI | RLHF evaluations / Elo arena leaderboard | Mature | Missing (feedback captured ADR 0071, unused) | Medium | Create ADR (B14) |
| Open WebUI | Audit logging | Mature | Partially exists (twin-recall audit; general audit ◐) | Medium | Enhance |
| Open WebUI | OpenTelemetry observability | Mature | Missing | High | Create ADR (B8) |
| Open WebUI | Rate limiting / security headers / sanitization | Mature | Already exists (`middleware/rateLimit.ts`; content-trust taint) | None | None |
| Open WebUI | Theming (incl. OLED dark) | Mature | Already exists (light/dark) | None | None |
| Open WebUI | i18n (62 locales) | Mature | Partially exists (EN + pt-BR) | Low | Monitor (B21) |
| Open WebUI | PWA / mobile | Partial | Partially exists (responsive; no PWA/native) | Low | Monitor |

### 11.2 LobeHub (lobe-chat) → OpenWOP

| Source repo | Feature | Source maturity | OpenWOP status | Gap severity | Recommendation |
|---|---|---:|---|---:|---|
| LobeHub | Conversation UI + streaming | Mature | Already exists | None | None |
| LobeHub | Message actions (regen/edit/branch/translate/TTS) | Mature | Partially exists (regen ✓; branch/translate/TTS ✗) | Medium | Enhance (B7) |
| LobeHub | Topic/thread mgmt (branched threads, message groups) | Mature | Partially exists (conversations ✓; branched threads/groups ✗) | High | Create ADR (B7) |
| LobeHub | In-app search + command menu | Mature | Missing | High | Create ADR (B1) |
| LobeHub | Prompt templates + input transforms | Mature | Partially exists | High | Create ADR (B6) |
| LobeHub | User memory + extraction | Mature | Partially exists (memory ✓ Better; auto-extraction ✗) | Medium | Create ADR (B10) |
| LobeHub | Multi-provider runtime (83 providers) | Mature | Partially exists (3 managed + BYOK; fewer providers) | Low | Monitor |
| LobeHub | Local model support (Ollama/LM Studio/vLLM) | Mature | Missing | High | Create ADR (B12) |
| LobeHub | Vision input | Mature | Already exists | None | None |
| LobeHub | Image generation | Mature | Missing | High | Create ADR (B5) |
| LobeHub | Video generation | Mature | Missing | Low | Monitor (B20) |
| LobeHub | Voice TTS / ASR / realtime | Mature/Partial | Partially exists | Medium | Enhance |
| LobeHub | File upload + parsing | Mature | Partially exists (text/PDF) | Medium | Create ADR (B11) |
| LobeHub | Knowledge base / RAG (BM25 hybrid) | Mature | Partially exists (no hybrid/rerank) | Critical | Create ADR (B3) |
| LobeHub | Web crawling + browsing | Mature | Missing | High | Create ADR (B2/B11) |
| LobeHub | Agent runtime (plan-execute loop) | Mature | Better than source (agents + nested run ADR 0089, replay-safe) | None | None |
| LobeHub | 31 built-in tools | Mature | Partially exists (7 node packs; fewer) | Medium | Create ADR (B2/B4/B5) |
| LobeHub | MCP support | Mature | Already exists | None | None |
| LobeHub | Legacy plugins + skill marketplace | Mature | Partially exists (no marketplace UI) | Low | Monitor |
| LobeHub | Multi-agent groups + Fleet 24/7 | Mature | Partially exists (Board ADR 0040 + schedules + nested run) | Medium | Enhance (B16) |
| LobeHub | Agent builder + self-iteration | Mature | Partially exists (workflow-author ADR 0072; no self-iteration) | Medium | Monitor |
| LobeHub | Messenger / chat-platform deploy (Discord/Slack/…) | Mature | Missing (outbound integration node only) | Low | Monitor |
| LobeHub | Context engine (injector pipeline) | Mature | Partially exists (per-turn composition ADR 0043 P5B) | Medium | Enhance (B22) |
| LobeHub | Pages / editor canvas / artifacts | Mature | Partially exists (documents + artifact workbench) | Medium | Enhance |
| LobeHub | Code interpreter (Pyodide/notebook/cloud sandbox) | Mature | Missing | High | Create ADR (B4) |
| LobeHub | Authentication (better-auth) | Mature | Already exists | None | None |
| LobeHub | RBAC + workspaces + multi-tenancy | Mature | Already exists (RBAC; workspace=tenant) | None | None |
| LobeHub | Billing / subscription / credits | Mature | Not applicable (managed-tier budgets ADR 0106 ◐) | None | None |
| LobeHub | Settings / theming / feature flags | Mature | Better than source (variant testing) | None | None |
| LobeHub | Mobile SPA + Electron desktop + CLI | Mature | Partially exists (responsive web; `openwop` CLI) | Low | Monitor |
| LobeHub | Dual Postgres/PGlite persistence | Mature | Not applicable (server-side DB) | None | None |
| LobeHub | Import / export (S3-staged) | Mature | Missing | Medium | Create ADR (B9) |
| LobeHub | API (REST + tRPC + OpenAPI) | Mature | Already exists (host-ext + `.well-known`) | None | None |
| LobeHub | Observability + tracing + evals | Mature/Partial | Partially exists | Medium | Create ADR (B8/B14) |
| LobeHub | 18 locales + RTL | Mature | Partially exists (no RTL) | Low | Monitor (B21) |
| LobeHub | Testing (~1997 vitest + BDD e2e) | Mature | Better than source (+ conformance suite) | None | None |
| LobeHub | Security (SSRF-safe fetch, encrypted vaults) | Mature | Partially exists (BYOK KMS ✓; SSRF-safe fetch needed for B2) | Medium | Bundle with B2 |

### 11.3 LibreChat → OpenWOP

| Source repo | Feature | Source maturity | OpenWOP status | Gap severity | Recommendation |
|---|---|---:|---|---:|---|
| LibreChat | Streaming (SSE) | Mature | Already exists | None | None |
| LibreChat | Conversation forking (4 strategies) | Mature | Missing | High | Create ADR (B7) |
| LibreChat | Multi-conversation compare | Mature | Missing | High | Create ADR (B7) |
| LibreChat | Temporary (ephemeral) chat | Mature | Missing | Medium | Create ADR (small; ephemeral session) |
| LibreChat | Message actions (edit/regen/continue/copy/feedback) | Mature | Partially exists (regen+feedback ✓; edit/continue ◐) | Medium | Enhance |
| LibreChat | Presets | Mature | Partially exists (`agentProfile` pins config) | Low | Monitor |
| LibreChat | Auto title generation | Mature | Missing (manual rename; defaults to "Untitled") | Low | Create ADR (small) |
| LibreChat | Landing / conversation starters | Mature | Partially exists (welcome empty-state ADR 0073) | Low | Enhance |
| LibreChat | Bookmarks & tags | Mature | Missing | Low | Monitor |
| LibreChat | Projects (workspace org) | Mature | Partially exists (projects reserved ADR 0046) | Low | Monitor |
| LibreChat | Prompt templates / library (ACL-gated) | Mature | Partially exists | High | Create ADR (B6) |
| LibreChat | Multi-provider switching (in-chat) | Mature | Partially exists (no in-chat switch UI) | Medium | Create ADR (B15) |
| LibreChat | Custom OpenAI-compatible endpoints | Mature | Missing | High | Create ADR (B12 — RFC gate) |
| LibreChat | Model Specs (branded presets) | Mature | Partially exists (`agentProfile`/model class) | Low | Monitor |
| LibreChat | Parameter tuning UI | Mature | Partially exists (model class; no slider UI) | Low | Monitor |
| LibreChat | Local (Ollama) | Mature | Missing | High | Create ADR (B12) |
| LibreChat | Vision input | Mature | Already exists | None | None |
| LibreChat | File upload + pluggable storage | Mature | Partially exists (Media token; fewer backends) | Low | Monitor |
| LibreChat | File permissions + ACL | Mature | Already exists (RBAC) | None | None |
| LibreChat | File retention / lifecycle | Partial | Already exists (Media lifecycle) | None | None |
| LibreChat | File preview | Mature | Partially exists (artifact preview) | Low | Monitor |
| LibreChat | RAG (external RAG API + pgvector) | Mature | Better than source (self-contained `kb` ADR 0011) | None | None |
| LibreChat | Citations / source tracking | Mature | Already exists (KB citations) | None | None |
| LibreChat | Agents framework + builder + subagents | Mature | Already exists (roster agents + nested run ADR 0089 + Board) | None | None |
| LibreChat | MCP servers + client (OAuth/OBO) | Partial→Mature | Already exists (MCP in+out + Connections OAuth) | None | None |
| LibreChat | MCP UI Resources | Experimental | Better than source (A2UI ADR 0051 / RFC 0102) | None | None |
| LibreChat | Unified tools + built-in catalog | Mature | Partially exists | Medium | Create ADR (B2/B5) |
| LibreChat | Custom Actions (OpenAPI → tools) | Mature | Already exists (`openapi-call` node) | None | None |
| LibreChat | Skills (custom code tools + GitHub sync) | Partial→Mature | Partially exists (node packs; no code-skill GitHub sync) | Low | Monitor |
| LibreChat | OpenAI / Azure Assistants API integration | Mature | Not applicable (provider-agnostic host) | None | None |
| LibreChat | Web search (with citations) | Mature | Missing | High | Create ADR (B2) |
| LibreChat | Artifacts / canvas (React/HTML/Mermaid) | Mature | Partially exists (workbench; no live React/HTML render) | Medium | Enhance |
| LibreChat | Code Interpreter (multi-language sandbox) | Mature | Missing | High | Create ADR (B4) |
| LibreChat | Memory / personalization (LLM memory agent) | Mature | Partially exists (subjectMemory ✓; extraction ✗) | Medium | Create ADR (B10) |
| LibreChat | Conversation/message search (Meilisearch) | Mature | Missing | High | Create ADR (B1) |
| LibreChat | Email/pw + social/OAuth + reset | Mature | Already exists | None | None |
| LibreChat | Enterprise SSO (OIDC / SAML / LDAP) | Mature/Partial | Already exists (RFC 0050) | None | None |
| LibreChat | JWT sessions + refresh rotation | Mature | Already exists | None | None |
| LibreChat | Two-factor auth (TOTP + backup codes) | Mature | Already exists (local-account TOTP MFA, Users feature) | None | None |
| LibreChat | Roles / RBAC + granular ACL + groups | Mature | Already exists | None | None |
| LibreChat | On-Behalf-Of tokens + MS Graph | Mature | Partially exists (Connections OAuth broker) | Low | Monitor |
| LibreChat | Admin grants + audit | Mature | Already exists | None | None |
| LibreChat | User-management CLI | Mature | Partially exists (`openwop` CLI) | Low | Monitor |
| LibreChat | Banner / announcements | Partial | Missing (only demo-mode `InMemoryHostBanner`; no admin announcements) | Low | Monitor |
| LibreChat | Shared links / public chat | Mature | Missing | Medium | Create ADR (B13) |
| LibreChat | Balance / billing | Mature | Not applicable (managed budgets ADR 0106 ◐) | None | None |
| LibreChat | TTS / STT / streaming TTS | Mature/Partial | Partially exists | Medium | Enhance |
| LibreChat | Theming / dark | Mature | Already exists | None | None |
| LibreChat | i18n (~41 locales) + RTL | Mature | Partially exists (no RTL) | Low | Monitor (B21) |
| LibreChat | Accessibility (live announcer, a11y e2e) | Mature | Partially exists (ARIA/keyboard) | Medium | Enhance |
| LibreChat | Mobile / responsive | Mature | Already exists | None | None |
| LibreChat | Observability (OTel + Langfuse + RUM) | Mature | Missing | High | Create ADR (B8) |
| LibreChat | Security (rate limit, SSRF, PII filter) | Mature | Partially exists (rate limit ✓; PII filter ✗ ADR 0077 Proposed) | Medium | Enhance |
| LibreChat | Import / export (JSON/CSV) | Mature | Missing | Medium | Create ADR (B9) |
| LibreChat | API surface (REST + SSE) | Mature | Already exists | None | None |
| LibreChat | Testing (Jest + Playwright multi-config) | Mature | Already exists (+ conformance) | None | None |
| LibreChat | Context projection (long-convo compression) | Mature | Missing | Low | Monitor (B22) |

### 11.4 AnythingLLM → OpenWOP

| Source repo | Feature | Source maturity | OpenWOP status | Gap severity | Recommendation |
|---|---|---:|---|---:|---|
| AnythingLLM | Workspace chat UI (inline data-viz charts) | Mature | Partially exists (chat ✓; inline charts ✗) | Medium | Enhance (chart artifacts, B4) |
| AnythingLLM | Message actions (copy/edit/regen/delete/feedback/fork) | Mature | Partially exists (fork ✗) | Medium | Create ADR (B7) |
| AnythingLLM | Multi-thread per workspace | Mature | Already exists (conversations) | None | None |
| AnythingLLM | Prompt input (attach/@/-cmds/undo-redo/STT) | Mature | Partially exists (undo-redo ◐) | Low | Enhance |
| AnythingLLM | System prompt + history + variables | Mature | Partially exists (per-agent prompt; no history/variables UI) | Medium | Create ADR (B6) |
| AnythingLLM | Slash commands & presets | Mature | Partially exists | Medium | Create ADR (B6) |
| AnythingLLM | Suggested messages | Mature | Partially exists (welcome empty-state) | Low | Enhance |
| AnythingLLM | LLM providers (~36) | Mature | Partially exists (fewer) | Low | Monitor |
| AnythingLLM | Local / self-hosted models | Mature | Missing | High | Create ADR (B12) |
| AnythingLLM | Model Router (rule-based selection) | Partial | Missing | Medium | Monitor (cost routing) |
| AnythingLLM | Multi-modal / vision | Partial | Better than source (capability-probed) | None | None |
| AnythingLLM | Workspaces (tunable RAG container) | Mature | Already exists (KB collections + per-agent binding) | None | None |
| AnythingLLM | Embedding engines + rerankers | Mature/Partial | Partially exists (embeddings ✓; rerank ✗) | Critical | Create ADR (B3) |
| AnythingLLM | Vector DB (10 backends) | Mature | Partially exists | Low | Monitor |
| AnythingLLM | Embedding pipeline + worker | Mature | Already exists (KB ingest) | None | None |
| AnythingLLM | Pinned documents + two-stage upload | Mature | Partially exists (knowledge binding; no pin-always) | Low | Monitor |
| AnythingLLM | Document sync / watching | Mature | Partially exists (Drive KB ADR 0107; periodic resync ◐) | Medium | Enhance |
| AnythingLLM | Multi-format ingestion (collector) | Mature | Partially exists (text/PDF) | High | Create ADR (B11) |
| AnythingLLM | Web scraping + connectors | Mature | Partially exists (Drive folder ADR 0107; broad connectors ✗) | Medium | Create ADR (B11/B2) |
| AnythingLLM | Audio transcription (collector) | Mature | Partially exists (notebook ingest ADR 0085) | Low | None |
| AnythingLLM | AIbitat multi-agent + @agent | Mature | Already exists (agents + Board + nested run) | None | None |
| AnythingLLM | Agent skills (SQL/filesystem/file-gen/charts/Gmail) | Mature | Partially exists (node packs; fewer skills) | Medium | Create ADR (B4/B5) |
| AnythingLLM | Agent Flows (no-code visual builder) | Partial | Better than source (replay-safe DAG builder ADR 0072) | None | None |
| AnythingLLM | MCP support (hypervisor) | Partial | Better than source (MCP in+out) | None | None |
| AnythingLLM | Imported / community skills | Partial | Partially exists (pack model) | Low | Monitor |
| AnythingLLM | Scheduled jobs (cron agents) | Partial | Partially exists (schedules + ADR 0089) | Medium | Enhance (B16) |
| AnythingLLM | Multi-user mode + roles + invites | Mature | Already exists | None | None |
| AnythingLLM | System settings + admin console | Mature | Better than source (toggles + variants) | None | None |
| AnythingLLM | Experimental feature flags | Experimental | Better than source (ADR 0001) | None | None |
| AnythingLLM | Memory / personalization (auto-extract) | Partial | Partially exists (subjectMemory ✓ Better; extraction ✗) | Medium | Create ADR (B10) |
| AnythingLLM | TTS + STT in chat | Mature | Partially exists | Medium | Enhance |
| AnythingLLM | File generation + download cards + chart artifacts | Partial | Partially exists (workbench; no chart/download cards in chat) | Medium | Enhance (B4) |
| AnythingLLM | Theming / branding (white-label) | Mature | Already exists (`/cut-app-release` white-label bundle) | None | None |
| AnythingLLM | PWA + mobile pairing + desktop | Partial | Partially exists (responsive) | Low | Monitor |
| AnythingLLM | Telemetry (PostHog) + event logs | Mature | Partially exists (run telemetry; analytics) | Medium | Enhance (B8) |
| AnythingLLM | Privacy + signed inter-service + encryption | Mature | Already exists (BYOK KMS, secret stripping) | None | None |
| AnythingLLM | Chat export + Community Hub | Partial | Missing (export) | Medium | Create ADR (B9) |
| AnythingLLM | Versioned REST API + OpenAI-compatible endpoint | Mature | Partially exists (host-ext API; no OpenAI-compat shim) | Low | Monitor |
| AnythingLLM | Embeddable chat widget (public) | Mature | Partially exists (internal `EmbeddedChatPanel`; no public widget) | Medium | Create ADR (B19) |
| AnythingLLM | Browser extension | Mature | Missing | Low | Monitor |
| AnythingLLM | Telegram bot + web push | Partial | Partially exists (notifications ADR 0050; no bot) | Low | Monitor |
| AnythingLLM | Multi-target IaC deployment | Mature | Partially exists (Cloud Run + Firebase; white-label install) | Low | Monitor |
| AnythingLLM | Testing strategy | Partial | Better than source (+ conformance) | None | None |
| AnythingLLM | i18n (29 locales) | Mature | Partially exists (EN + pt-BR) | Low | Monitor (B21) |

### 11.5 Jan → OpenWOP

> Jan is a **single-user local-first desktop app** (Tauri + llama.cpp/MLX). Much of its surface is **Not applicable** to a cloud, multi-tenant host — and several of its *intentional absences* (accounts/RBAC, memory, voice) are areas where OpenWOP is **Better than source**.

| Source repo | Feature | Source maturity | OpenWOP status | Gap severity | Recommendation |
|---|---|---:|---|---:|---|
| Jan | Threaded chat | Mature | Already exists | None | None |
| Jan | Thread mgmt (favorites / recents / temporary) | Mature | Partially exists (conversations ✓; favorites/temporary ✗) | Low | Enhance |
| Jan | Message actions (token-speed, citations) | Mature | Partially exists (citations ✓; token-speed indicator ✗) | Low | Enhance |
| Jan | Message queue (send while busy) | Partial | Missing | Low | Monitor |
| Jan | Sampler / model parameters (per-thread) | Mature | Partially exists (`agentProfile` model class; no per-thread sampler UI) | Low | Monitor |
| Jan | Remote provider mgmt (BYOK) | Mature | Already exists | None | None |
| Jan | Local model hub + downloads | Mature | Not applicable (desktop) → maps to compat endpoint | High | Create ADR (B12) |
| Jan | llama.cpp inference engine | Mature | Not applicable | None | None |
| Jan | Apple MLX engine (macOS) | Partial | Not applicable | None | None |
| Jan | System / hardware monitor | Mature | Not applicable | None | None |
| Jan | File upload + attachments | Mature | Partially exists (text/PDF) | Medium | Create ADR (B11) |
| Jan | RAG (local) | Partial | Better than source (`kb` ADR 0011) | None | None |
| Jan | Vector DB (sqlite-vec) | Mature | Not applicable (host vector store) | None | None |
| Jan | MCP tool servers (smart routing) | Mature | Partially exists (MCP ✓; smart tool-routing ✗) | Low | Monitor |
| Jan | Tool-approval / permission gating | Mature | Already exists (HITL ADR 0051) | None | None |
| Jan | Agent mode | Partial/Exp | Already exists (agents) | None | None |
| Jan | Assistants (personas) | Mature | Better than source (roster agents + `agentProfile`) | None | None |
| Jan | Projects (grouped workspaces) | Partial→Mature | Partially exists (projects reserved ADR 0046) | Low | Monitor |
| Jan | Extension system | Mature | Better than source (feature packages + node packs, replay-safe) | None | None |
| Jan | HTML artifacts + code blocks (CSP iframe) | Mature | Partially exists (workbench; no CSP iframe HTML) | Medium | Enhance |
| Jan | Local OpenAI/Anthropic-compatible API server | Mature | Not applicable (we ARE the server; host-ext API) | None | None |
| Jan | Claude Code integration | Partial | Partially exists (MCP inbound for Claude Desktop/Cursor, ADR 0087) | Low | Monitor |
| Jan | CLI (`jan-cli`) | Experimental | Already exists (`openwop` CLI) | None | None |
| Jan | Auto-update (HMAC) | Mature | Not applicable (web app) | None | None |
| Jan | Native window chrome / deep links / proxy | Mature | Not applicable | None | None |
| Jan | Mobile targets (iOS/Android) | Experimental | Partially exists (responsive web) | Low | Monitor |
| Jan | App settings hub | Mature | Already exists | None | None |
| Jan | Privacy / local-first + opt-in analytics | Mature | Partially exists (consent/GDPR; local-first N/A) | None | None |
| Jan | (No accounts / RBAC) | N/A | Better than source (full RBAC ADR 0006) | None | None |
| Jan | Theming + accent / font-size | Mature | Partially exists (theming ✓; accent/font-size ✗) | Low | Monitor |
| Jan | i18n (17 locales) | Mature | Partially exists (EN + pt-BR) | Low | Monitor (B21) |
| Jan | Keyboard shortcuts + global search dialog | Mature | Partially exists (keyboard contract ✓; global search ✗) | Medium | Create ADR (B1) |
| Jan | (No voice / TTS / STT) | N/A | Better than source (partial voice in/out) | None | None |
| Jan | (No cross-thread memory) | N/A | Better than source (subjectMemory) | None | None |
| Jan | Logging + log viewer | Mature | Partially exists (run telemetry) | Low | Monitor |
| Jan | Data folder persistence | Mature | Not applicable (cloud DB) | None | None |
| Jan | Tauri / Flatpak / MS-Store packaging | Mature | Not applicable | None | None |
| Jan | Testing (Vitest + Rust + autoqa E2E) | Mature | Better than source (+ conformance) | None | None |

### 11.6 Roll-up counts

| OpenWOP status | Approx. count (across all 5 tables) | Notes |
|---|---:|---|
| Already exists | ~33 | Provider mgmt, MCP, RBAC, SSO/SCIM, RAG core, agents/workflows, streaming, persistence |
| Better than source | ~14 | Replay-safe runs, A2UI vs MCP-UI, variant-testing toggles, namespaced memory + twin-recall, white-label, conformance testing |
| Partially exists | ~55 | Largest bucket — capability present but thinner (rerank, loaders, voice, prompt mgmt, artifacts, observability) |
| Missing | ~30 | Search, web search, code interpreter, image gen, local models, forking/compare, export, public links, leaderboard |
| Not applicable | ~16 | Local-inference / desktop / billing surfaces (mostly Jan + LobeHub commercial) |
| Unknown / needs verification | 0 | All resolved via the live + source pass — see §11.7 |

### 11.7 Live-verification results (RESOLVED 2026-06-23)

A `/browser` pass against `app.openwop.dev/chat` (reachable as an **anonymous demo session**, which gates on BYOK/sign-in before the conversation surface) plus targeted `frontend/react/src` + `backend/typescript/src` source inspection resolved all five UI-presence questions. Source was the decisive evidence (the live chat surface is BYOK-gated); the live pass corroborated the shell and the gate.

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Message **edit** + **continue-generation** | **Partially exists** — regenerate ✓, edit ✗, continue ✗ | `MessageBubble.tsx:260` wires `MessageActions` with only `onRegenerate`+`onFeedback`; no edit/continue props anywhere in `src/chat`. |
| 2 | **KaTeX math** + **Mermaid** rendering | **Missing** | Chat markdown = `react-markdown` + `remark-gfm` only (`MessageRenderer.tsx`, `ui/Markdown.tsx`); **no katex/mermaid dependency** in `package.json`. |
| 3 | Conversation **auto-title** generation | **Missing** | Titles come from an explicit `title` param or default to `chat:untitled` ("Untitled"); `rename()` is manual (`useChatSessions.ts:155,71`). No LLM title generation in FE or backend. |
| 4 | **2FA / TOTP** for local accounts | **Already exists** (gated) | `features/users/SsoPanel.tsx` + i18n: "Local accounts with **TOTP MFA** (this app, when the Users feature is on)." Present behind the Users feature toggle. |
| 5 | Conversation **folders / tags / pin / archive** | **Missing** | `ConversationsRail.tsx` supports rename + delete + remove-from-conversation only. "Pin" exists but for *agents pinned to chat* (`WelcomeCard.tsx`), not conversations. |

**Bonus (the §11.3 LibreChat "banner" Unknown):** **Missing** — the only banner is the demo-mode `InMemoryHostBanner` (`App.tsx:191`); there is no admin announcement/banner system.

**Net corrections to the tables:** item 4 (2FA) flips from Unknown → **Already exists / None** — OpenWOP already has local-account TOTP MFA. Items 1, 2, 3, 5 and the banner are confirmed **Missing/Partial** as the tables now reflect. **Zero Unknowns remain.**

> Method note: deeper RAG/agents/MCP/replay features stayed out of this pass — they're auth+BYOK-gated so a click-through can't reach them, and code/ADRs are the stronger evidence there. The five above were the only items the live UI could adjudicate, and source closed them definitively.
