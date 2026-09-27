# ADR 0277 — Agent identity normalization + knowledge-composition reconciliation

**Status:** **implemented** — Phase 1 + Phase 2 (2026-07-05)
**Date:** 2026-07-05
**Toggle:** none — this reconciles already-shipped surfaces (voice `voice`, advisory-board, agent-knowledge); it adds no new user-facing surface.
**RFC verdict:** none — host-internal composition/authorization plumbing; no wire, capability, or event change.
**Relates to:** ADR 0031/0032 (roster), ADR 0038 (per-agent knowledge), ADR 0040/0100 (advisory board + Shared knowledge), ADR 0135 (capability firewall), ADR 0141/0199 (realtime voice + context).

## Context — the audit findings (2026-07-05 architecture review)

Every roster persona has **two projections**: a standing roster entry
(`rosterId = host:<slug>-…` — owns the `agentProfile`: knowledge bindings,
per-tool permissions, capabilities, per-agent voice, seeded memories) and a
chat-callable registry agent (`user.<tenant>.<slug>` / pack id — owns the
persona `systemPrompt` + manifest `toolAllowlist`), linked by
`RosterEntry.agentRef.agentId`. No module owned the mapping; each consumer
hand-rolled its own (or none):

- `composeChatContext` resolved the persona by the **raw** id → a
  `VoiceAgentPicker`-scoped session (which sends the rosterId) missed the
  registry and collapsed to the generic scaffold, dropping the persona, the
  boardroom context block, the owner-subject KB, **and the caller's name**
  (the identity anchor lives inside the persona scaffold). This was the
  user-visible "live conversation lost my name / system prompt" bug.
- The voice tool bridge (`agentAllowlist`) looked up manifests by the raw id →
  every roster-scoped session got an **empty allowlist** (zero tools).
- `voicePreamble` matched both id forms for the work snapshot but passed the
  raw id to the rosterId-keyed profile → agent-scoped **tabs** (registry ids)
  composed no memory/knowledge digest while the picker did — each id form lost
  a different half of the context.
- `resolveAgentVoice` read the profile by the raw id → tabs lost per-agent voice.
- Every one of these failures was a silent fail-soft (`catch → null/''`) — the
  session opened, just dumber; nothing was diagnosable.

Separately (Phase 2 scope), the **knowledge seams diverge**: the interactive
chat exchange (`conversationExchange` → `composeChatContext`) never composes
the per-agent knowledge binding (`resolveAgentKnowledgeRetrieve` — ADR 0043
Phase 5B wired it only into the workflow `chat.turn` node), so the
advisory-board "Shared knowledge" grant (ADR 0100 D2 — per-advisor
`agentProfile.knowledge.collectionIds`) is stored and displayed but **never
retrieved in the interactive text boardroom**; the `knowledge.search` tool
passes no `collectionIds` and therefore reads **tenant-wide**, ignoring the
grant in the other direction; and `updateBoard` swaps the advisor cohort
without reconciling bindings (added advisors get nothing; removed advisors
keep org strategy/priority/project KBs forever — an authorization leak).

## Decision

### D1 — one owner for the identity duality (`host/agentIdentity.ts`)

`resolveAgentIdentity(tenantId, id, { allowReverseScan? }) → { agentId, rosterId?, profileId, entry? }`.

Canonical mapping:
- **persona + manifest tool allowlist → `agentId`** (`agentRef.agentId`);
- **profile / knowledge bindings / per-agent voice / memory scope →
  `profileId`** = the rosterId when a roster entry exists (that is where the
  advisor seed writes memories, where `rosterCascade` clears them, and where
  the board Shared-knowledge bindings live), else the input id (definition-
  level profiles keep working).

Cost model: the **forward** path (`host:*` → `getRosterEntry` point-get) is one
keyed read; non-`host:` ids pay a `startsWith` check — the text hot path is
unchanged. The **reverse** path (registry id → roster entry) is a
tenant-filtered roster scan behind the explicit `allowReverseScan` opt-in, used
only at session-mint / per-speak / tool-call time, never per text turn.

### D2 — consumers adopt the resolver (Phase 1, implemented)

- `composeChatContext` normalizes internally (all callers become id-agnostic);
- voice `toolBridge.agentAllowlist` + `resolveAgentToolDecls` (now async,
  tenant-scoped) normalize before the manifest lookup;
- `voicePreamble` resolves once per mint; the memory digest + memory scope key
  off `profileId`; the local `rosterEntryFor` both-forms matcher is deleted;
- `resolveAgentVoice` normalizes to `profileId`.

### D3 — the no-persona scaffold keeps resolved context (Phase 1, implemented)

The generic fallback previously discarded the caller's already-resolved NAME,
the boardroom `injectedContextBlock`, and the owner-subject knowledge. It now
composes them around `GENERIC_CHAT_SCAFFOLD` (blocks append only when present,
so a bare call still yields the exact legacy string).

### D4 — degraded composition is loud (Phase 1, implemented)

Every fail-soft context drop in the realtime mint logs
`context_degraded { block: 'identity'|'conversation'|'persona'|'preamble'|'whole', reason }`
— names only, never composed content (PII). Voice keeps opening; the loss is
now diagnosable.

### D5 — realtime owner-KB retrieval is seeded (Phase 1, implemented)

The realtime mint threads the same seed the preamble uses (transcript tail →
last seed turn → generic work seed) into `composeChatContext.seedText`, so the
ADR 0084 owner-subject grounding runs a seeded query like the text path
(`conversationExchange` passes the user's turn text) instead of an empty one.

### D6 — knowledge-composition reconciliation (Phase 2, implemented)

1. **Fold-in.** `composeChatContext` now composes the per-agent knowledge
   binding (`resolveAgentKnowledgeRetrieve` on `identity.profileId`, seeded
   with the turn text; skipped when there is no seed — the multimodal-only
   parity with the node path) — the interactive text exchange and voice both
   compose the Shared-knowledge grant. **Dedup:** the voice preamble's memory
   digest MOVED here (it would otherwise inject the same retrieval twice into
   one instructions payload); the preamble keeps only the work snapshot. The
   `chat.turn` workflow node and the agent-dispatch route adopted the identity
   resolver for their existing injections (profile + memory scope by
   `profileId`). The reverse (agentId → rosterId) resolution is TTL-cached
   (~30s, per tenant) so the per-turn cost is one roster scan per window.
2. **Tool scoping.** `BundleScope.agentProfileId` (optional, fail-closed
   absent) names the executing agent; `knowledge.search` + the RAG-retriever
   aliases scope retrieval to the agent's bound `collectionIds` when a binding
   exists. Absent agent / empty binding ⇒ tenant-wide (agent-less workflow
   nodes unchanged). This is a deliberate NARROWING: a bound agent's knowledge
   tools now honor the binding as a scoping contract (ADR 0038's intent).
   Threaded by: the conversation tool loop, the voice tool bridge, the channel
   agent-runner node, and the agent-dispatch route.
3. **Cohort reconcile.** `board.sharedKbKinds` (new optional field) stores the
   share INTENT — previously sharedness was derived (all-advisors-bound), which
   is the silent-OFF drift itself. The share route records intent only when the
   share bound something (a kind with zero resolvable collections — e.g. only a
   PRIVATE project — records nothing: the visibility carve-out stays
   authoritative); unshare always clears it. `updateBoard` reconciles on cohort
   change: added advisors bound, removed advisors unbound **unless another
   board still grants them that kind** (cross-board check — conservative:
   over-retain, never over-remove; the personal-bind collateral of unbinding a
   managed collection an API caller bound directly is accepted + documented,
   a provenance ledger being disproportionate). Best-effort: reconcile failure
   never fails the board update; both operations are idempotent.
4. **Priorities: RAG-only (decided).** No `kind:'priority-matrix'` contextRef —
   ADR 0100 already rejected KB-shaped contextRefs, a third static kind would
   duplicate the snapshot-staleness problem, and with (1) the interactive path
   retrieves the priority-matrix KB per turn. Verified during implementation:
   idea/list CRUD live-indexes the priority KB (`priorityMatrixService.ts`
   `indexList`/`reindexListIdeas` on create + update), so RAG freshness holds.

## Alternatives considered

- **Normalize at the frontend** (picker sends `agentRef.agentId`): rejected —
  the profile half (voice/knowledge/memory) genuinely needs the rosterId, so a
  single client-side id cannot serve both halves; and every other client
  (deep links, embeds, API callers) would need the same fix. The server owns
  identity.
- **Register roster entries into the agent registry** (make `host:*` resolve):
  rejected — duplicates the persona into a second store keyed by a second id;
  the registry is a pack/user-agent catalog, not an instance table (ADR 0031
  keeps instances in the roster).
- **A per-request cache for the reverse scan**: deferred — mint-time only
  today; measure in Phase 2 when the per-turn path adopts profile reads.

## Phase → verification table

| Phase | Shipped | Tests |
|---|---|---|
| **P1** — identity resolver + voice context (D1–D5) | `host/agentIdentity.ts`; `chatContext` normalization + generic-scaffold fix + `context_degraded`; async tenant-scoped `resolveAgentToolDecls`; `voicePreamble` profileId keying; `resolveAgentVoice` normalization; realtime `seedText`; `EmbeddedConversation` threads `voiceConversationId` | `voice-realtime.test.ts` "ADR 0277" block: roster-scoped session composes persona; tool decls equal across both id forms; per-agent voice resolves from both forms; no-persona scaffold keeps the name (and the bare call stays byte-identical) |
| **P2** — knowledge reconciliation (D6) | `composeChatContext` knowledge fold-in + voice-preamble dedup; `BundleScope.agentProfileId` + scoped knowledge tools; `board.sharedKbKinds` stored intent + cohort reconcile w/ cross-board protection; `chat.turn` node + agent-dispatch route identity adoption; reverse-index TTL cache | `advisory-board-knowledge.test.ts` "ADR 0277 P2" block: cohort reconcile (adds bound, removes unbound, toggle stays ON); cross-board protection; `knowledge.search` bound⇒scoped / agent-less⇒tenant-wide; `composeChatContext` composes the bound-KB block for BOTH id forms (the GAP-B pin) |

## Hardening corrections (2026-07-05 `/grade-code` adversarial audit)

- **GRADE-1 (voice/data-integrity):** a live realtime session was not pinned to
  its conversation — the singleton chat surface keeps the hook mounted across
  rail switches, so transcripts spoken about conversation A were rendered AND
  durably persisted into whatever conversation the user switched to. The
  session now ends on conversation change (`useRealtimeVoice`
  `boundConversationRef`).
- **GRADE-2/-3 (voice/races):** `loadSessionFromBackend` gained a load-epoch
  staleness guard (a slower, older load can no longer clobber a newer switch),
  and `useVoiceTranscriptStream`'s catch-up reload fires only on the
  active→false transition (it previously fired on conversation change, racing
  the new conversation's load).
- **GRADE-4 (authz/UX):** the FE probed the superadmin-gated `GET /config` to
  learn whether realtime is configured — non-superadmin members silently got
  the walkie fallback and no transcript stream. New non-privileged
  `GET …/voice/realtime/capability` (provider id only, never the credentialRef);
  all three probes ride it.
- **GRADE-11/-12 (knowledge reconcile):** removals now run BEFORE binds with
  per-call fault isolation (a bind throw — collection cap, vanished collection —
  previously aborted removals permanently, since the cohort was already
  persisted: the exact leak D6.3 set out to close). Legacy derived-shared
  boards now reconcile their own cohort edits (effective kinds = stored ∪
  derived-from-the-pre-edit-cohort).
- **Perf/observability:** the two independent per-turn knowledge retrievals
  (owner-subject + agent binding) run concurrently (2-way only — pool-safe);
  the identity reverse-cache is bounded (TTL sweep + 200-tenant cap) and caches
  slim entries (no base64 avatars); the per-turn persona-miss warn is deduped
  per (agent, conversation) per 10-min window; a sideband socket failure now
  logs loudly (it previously degraded the call to no-persona/no-tools/no-audit
  in total silence); the `messages/stream` success path is test-pinned
  (frame delivery end-to-end).
- **Recorded, not fixed:** `persistTranscript`'s `messageCount` read-modify-write
  can undercount under concurrent writes — within the field's documented
  contract ("cached count; sample-grade", `storage.ts`); voice-first sessions
  are created titled "New chat" (cosmetic; title is only set at create); the
  walkie path shares the conversation-switch exposure in a milder form
  (tap-to-talk turns are short) — follow ADR 0277 OQ-1 telemetry.

## Open questions

- **OQ-1 — RESOLVED (2026-07-05, deferred-closure batch):** the realtime mint
  responses (`POST /session`, `POST /openai/connect` — non-normative host-ext)
  carry an optional `degraded: string[]` of block NAMES that failed to compose
  (`identity` · `persona` · `agent_knowledge` · `owner_knowledge` · `preamble` ·
  `whole`); the composer's live pill shows a quiet localized "Reduced context"
  chip (block labels in the title), and a `whole` collapse additionally raises a
  one-time error toast. **Security ruling:** the `conversation` visibility-shed
  block stays LOG-ONLY — surfacing it would be an existence oracle (an invisible
  conversation would flag while a nonexistent one would not). An ANONYMOUS
  caller (`sign_in_required`) is not "degraded" — only unexpected identity
  resolution failures report. Scope: realtime-only — the walkie path rides the
  per-turn text compose, and text chat has no per-turn signal either, so a
  walkie-only signal would be arbitrary (recorded, not an oversight).

## Correction pointers

- **ADR 0199** ("`composeChatContext` = the ONE owner of what an agent knows"):
  accurate for persona/board/owner-KB, but the per-agent knowledge binding
  (ADR 0043 Phase 5B) lived only in the workflow `chat.turn` node until this
  ADR's Phase 2 folds it in.
- **ADR 0100 D2** ("RAG rides each advisor's per-turn query"): true on the
  workflow node path; the interactive boardroom exchange did not retrieve the
  binding until this ADR's Phase 2.
