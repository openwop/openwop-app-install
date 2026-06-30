# ADR 0120 — Auto-extraction of durable memory from chat

**Status:** implemented (all phases, 2026-06-24) — **Phase 1 implemented** (2026-06-24): the opt-in consent gate (NO extraction yet). `features/memory-auto-extract/` — a FAIL-CLOSED `MemoryExtractionGrant` store (`isExtractionGranted` false unless an explicit grant exists), self-service routes `GET/PUT/DELETE /v1/host/openwop-app/profiles/me/memory-extraction` (the subject IS the caller via `callerSubject`; anon fails closed 403), toggle `memory-auto-extract` OFF/user, tenant+subject isolation, grantor audit attribution. **Phase 2 (extraction op) implemented** (2026-06-24): `features/memory-auto-extract/extractionOp.ts` — `runMemoryExtraction` is FAIL-CLOSED: no grant ⇒ no LLM call + no write; with a grant it extracts durable facts (injected LLM) and writes each via an injected `addNote` (the caller binds `addSubjectNote` untrusted/`auto-extracted`), capped at 10. Deps injected for testability. **Phase 2b (binding) implemented** (2026-06-24): `extractionBinding.extractConversationMemory` wires the Phase-2 op to the REAL services — the fail-closed `isExtractionGranted` consent gate + `addSubjectNote` to the chat user's `user:<id>` subject (notes prefixed `[auto-extracted]`); the LLM summarizer is injected. End-to-end fail-closed is covered (no grant ⇒ no LLM call, no note). **Phase 2c (extractor) implemented** (2026-06-24): `memoryExtractor` — `llmExtractFacts` (managed-provider dispatch, host-side key, capped input, best-effort → [] on error) over a PURE `parseFactLines` (strips bullets/numbering, drops the NONE sentinel + too-short/long lines, dedupes case-insensitively, caps at 10). **Phase 2d (call site) implemented** (2026-06-24) — the extraction PIPELINE is now complete (grant → op → binding → extractor → call site): `conversationExchange` fires `extractConversationMemory(tenantId, actingUserId, transcript, llmExtractFacts)` on conversation CLOSE (once, over the full transcript) — fire-and-forget + FAIL-CLOSED in the op (no grant ⇒ no LLM call, no write), so it never blocks the close and is a no-op unless the user granted extraction. Phase 3 review UI SHIPPED: the consent toggle + the auto-extracted facts reviewable/deletable in the MemoryBrowser (ProfileMemoryTab).
**Date:** 2026-06-23
**Toggle:** `memory-auto-extract` · default **OFF** · `bucketUnit: user` — a
cross-content-into-personal-memory write path; opt-in per user, fenced like a consent
grant (ADR 0044).
**Surface:** host-internal under `/v1/host/openwop-app/*` — an opt-in extraction op
(a recorded workflow step OR a post-turn async op) writing to the existing
`user:`/`agent:` subject-memory namespace. No new external routes beyond the
consent/opt-in config + a "review extracted memories" view. No new wire contract.
**Depends on / composes (all Accepted/implemented — extension, not new infra):**
- **ADR 0041 (subject memory) + `host/subjectMemory.ts`** — the `user:<id>`/`agent:<id>`
  curated-note CRUD (`addSubjectNote`/`listSubjectNotes`/`removeSubjectNote`) + the
  durable `subject-memory:note` `DurableCollection` (source of truth) + the
  RFC-0004 recall index. **Reuse the store; do NOT fork it.**
- **ADR 0044 (twin cross-subject recall)** — the **consent-grant + fence + audit**
  pattern this borrows for an extraction *write*: opt-in, fail-closed, a versioned
  audit row per write, untrusted-by-default.
- **ADR 0077 (data classification, PII masking & retention)** — the PII caution: an
  extraction pass over chat MUST run its candidate facts through the same
  classification/masking discipline before persisting (`byok/textRedaction.ts`,
  retention sweep).
- **ADR 0020 (consent)** — the opt-in/opt-out grant record + erasure fan-out
  (`host/subjectErasure.ts`).
- **`host/agentDispatch.ts:570`** — dispatch *already* writes a turn-summary to memory
  (`deps.memory.write(deps.memoryScope, { content: summarizeForMemory(...) })`, a
  heuristic non-LLM summary). The extraction op **replaces/augments that exact seam**
  with an LLM extraction pass — it is not a new write path.
- **ADR 0001 (feature-package architecture)** — toggle-gated; `core` never imports the
  feature, the feature fills a host seam (the `twinRecallSurface` precedent).

**RFC verdict:** **host-extension — rides already-Accepted RFC 0004 (Memory Layer) /
RFC 0048 (opaque owner) — NO new RFC.** The store keys on an opaque `memoryRef`
(`user:<id>`/`agent:<id>`) that already accepts any owner string; extraction is a
host-internal op (a recorded run step or a post-turn async op) under
`/v1/host/openwop-app/*`. Nothing touches the `/v1` wire (no run-event field, capability
flag, event type, or normative MUST). (Same gate as ADR 0041/0044.)

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 backlog
> **B10** (P2/Quarter 3) "Memory auto-extraction from chat" + §11 rows
> (LibreChat / LobeHub / AnythingLLM, "Create ADR (B10)"; §5: OpenWOP has
> subjectMemory ✓ but extraction ✗). Today `subjectMemory` (RFC 0004 / ADR 0041) is
> **curated manually** — a person/admin adds notes by hand; dispatch only writes a
> heuristic turn-summary (`agentDispatch.ts:577 summarizeForMemory`). Competitors run
> an **LLM memory pass that extracts durable facts** and writes set/delete ops:
> LibreChat `packages/api/src/agents/memory.ts` (a memory agent emits set/delete);
> LobeHub `packages/memory-user-memory/`; AnythingLLM `utils/memories/`.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a memory-extraction service with its own LLM call, its own memory
store, its own opt-in flag, and its own write/dedupe logic." Every one of those already
has a single owner; re-implementing any is the `no-parallel-architecture` violation. The
single biggest trap: writing to a *second* memory store instead of `subjectMemory`.

| Concern | Existing owner (file:line) | How extraction reuses it |
|---|---|---|
| The durable memory store + note CRUD | **`host/subjectMemory.ts` (`addSubjectNote`/`listSubjectNotes`/`removeSubjectNote`, `subject-memory:note` `DurableCollection`, `NOTE_CAP`/`MAX_NOTE_LEN`)** | Extracted facts are written as **ordinary subject notes** under `user:<id>`/`agent:<id>` — same store, same caps, same recall index. **No new memory store, no new collection.** |
| The existing post-turn write seam | **`host/agentDispatch.ts:570` `deps.memory.write(deps.memoryScope, …)` + `summarizeForMemory` (`:577`)** | The LLM extraction op **is the upgrade of this seam** — it produces structured durable facts instead of (or alongside) the heuristic summary, behind the toggle. **Not a parallel write path.** |
| Opt-in / opt-out / consent | **ADR 0044 grant model (`host/twinService.ts` grant/revoke + audit) + ADR 0020 consent** | A user-owned, revocable extraction grant (the same intrinsic-self-ownership authority as `/profiles/me/*`); fail-closed (no grant ⇒ no extraction). **No new consent engine.** |
| Audit of every write | **ADR 0044 audit pattern (`twinService.ts:52 audit(...)` → `storage.listAudit`)** | Every extraction write emits a versioned audit row `{runId, subject, extractedFrom, version}` — the user can see what was learned and when. |
| LLM call authority (run-scope) | **dispatch's `AdapterScope` / `ctx.callAI` (ADR 0011 §Correction)** — provider calls need a per-run `runId/nodeId/secretResolver` | The extraction LLM call happens **where `ctx.callAI`/`AdapterScope` exist** — a recorded workflow step OR the dispatch post-turn op — **never** from synchronous route code (the run-scoped-honesty rule). |
| PII / redaction / retention | **ADR 0077 (`byok/textRedaction.ts`, classification, retention sweep)** | Candidate facts pass through classification + masking before persisting; extracted notes inherit the retention/erasure sweep. |
| The untrusted fence | **ADR 0044 §3 structural fence + ADR 0038 §C untrusted marking** | Extracted facts are **`contentTrust:'untrusted'`** by default (they originate from chat content, not the agent's own truth) — never followed as instructions on recall. |

**Net new (small):** one **opt-in extraction grant** (user/agent-scoped), the **LLM
extraction op** (a recorded run step or a post-turn dispatch op, behind the toggle) with
a **valid-key/limit guard**, the per-write **audit row**, and a **"review extracted
memories"** affordance (extracted notes are tagged + user-deletable). The memory store,
consent model, audit, redaction, and write seam all already exist.

---

## Decision

Extend **subject memory** (ADR 0041) with an **opt-in LLM extraction pass** that distills
durable facts from chat turns and writes them to the **existing** `user:`/`agent:` memory
namespace as ordinary curated notes — **consent-gated and fenced exactly like ADR 0044
twin-recall**: opt-in per subject, fail-closed without a grant, untrusted-by-default,
audited per write, PII-masked (ADR 0077). The extraction op runs **where the LLM
authority exists** — a recorded workflow step or the dispatch post-turn op — never from
synchronous route code. It **reuses the memory store**; it does not fork it.

### Data model — a grant + tagged notes (no new memory store)

```
MemoryExtractionGrant               // subject-owned opt-in, revocable (ADR 0044/0020 shape)
  { subject,                        // { kind:'user'|'agent', id }  (the memory owner)
    grantedBy,                      // the owner (intrinsic self-ownership) or admin for an agent
    status,                         // 'active' | 'revoked'
    grantedAt, revokedAt?, version, // versioned (audited)
    limits }                        // per-window extraction cap + max facts/turn (the guard)
```

Extracted facts are **`SubjectNote` rows** (`host/subjectMemory.ts`) under the subject's
scope, written via `addSubjectNote`, with:
- `tags` including a reserved `auto-extracted` tag (so the review UI lists them apart
  from hand-curated notes and the user can prune them) + a provenance ref
  `{runId, turnId}`;
- `contentTrust: 'untrusted'` (the fence) — recall neutralizes them, never follows them
  as instructions;
- the same `NOTE_CAP` / `MAX_NOTE_LEN` caps as manual notes (no separate budget).

The extraction op is a **set/delete diff** (the LibreChat memory-agent shape): it may
add a new fact, or supersede/delete a stale one — both expressed as `addSubjectNote` /
`removeSubjectNote` against the same store, never a parallel "extracted-memory" table.

### The extraction op (run-scoped — NOT a route)

A toggle-gated op (a recorded `memory.extract` workflow node OR the dispatch post-turn
op at `agentDispatch.ts:570`):
1. **gate** — resolve a live `MemoryExtractionGrant` for the subject; absent/revoked ⇒
   **no-op** (fail-closed). Check the per-window limit guard + a valid managed/BYOK key
   (no key ⇒ skip, never error the turn).
2. **extract** — `ctx.callAI` (run-scope) over the recent turn(s) → a structured list of
   candidate durable facts (set) + supersede/delete ops, with a confidence floor.
3. **classify + mask** — each candidate through ADR 0077 classification + masking; drop
   facts above the confidential-PII threshold unless explicitly permitted.
4. **write** — `addSubjectNote(tenantId, subject, fact)` (untrusted, `auto-extracted`
   tag, provenance) for sets; `removeSubjectNote` for deletes. Idempotency-keyed on
   `{runId, turnId, factHash}` so a retried/replayed run does not duplicate.
5. **audit** — one audit row per write `{runId, subject, extractedFrom, grantVersion}`.

### RBAC & isolation
A `user`-subject grant is **intrinsic self-ownership** (`resolveCallerUser` → the
caller's own `userId`, the `/profiles/me/*` model) — only the owner grants/revokes their
own extraction. An `agent`-subject grant is an operational act (`workspace:write` + the
ADR 0036 policy), like the twin *link*. Cross-tenant / non-member → uniform 404. The
review/delete view is self-scoped (a user sees only their own extracted notes).

### Replay / fork
**Extraction is a separately-recorded op** (a node step or the post-turn op), so its
LLM call + writes are normal recorded-run state. **Memory writes are
versioned/audited (the ADR 0044 audit pattern)** and **idempotency-keyed on
`{runId,turnId,factHash}`** — a replayed/retried/forked run reproduces the same note rows
(no duplicates), and a **revoked grant is re-checked live at extraction time** (the ADR
0044 §4 privacy-first re-check): a fork of an old turn whose grant was since revoked
extracts nothing. Privacy-first is the do-nothing-special path; an audit annotation is
permitted for provenance only, never read for authorization.

### Agent pack
**Optional `memory-extractor` persona — honest.** The extraction logic is a
*core capability* (it lives at the dispatch/node seam, driven by `ctx.callAI`), **not**
something unique to a named agent (David's law — capabilities are core, activated per
named agent via `agentProfile`). A `memory-extractor` *persona* is merely the prompt that
frames the extraction call; it is a thin, optional pack, and the capability stays core.
v1 may ship extraction as the dispatch post-turn op with an internal extraction prompt
and **no separate agent pack** — the persona is an optional refinement (OQ-4), not a
claimed deliverable.

---

## Evaluation matrix

| # | Dimension | Verdict for `memory-auto-extract` |
|---|---|---|
| 1 | Feature-package architecture (ADR 0001) | `memory-auto-extract` feature fills a host seam (the `twinRecallSurface`/dispatch-write precedent); `core` never imports it. |
| 2 | Toggle + admin/bucketing | default **OFF**, `bucketUnit: user` — opt-in per user; agent extraction admin-gated. |
| 3 | Workflow surface (`ctx.*`) | `ctx.subjectMemory` write (existing) reused; extraction reads the grant + writes notes — no new surface owner. |
| 4 | Node pack | a `memory.extract` recorded node (run-scoped `ctx.callAI`), OR the dispatch post-turn op — replaces the heuristic `summarizeForMemory`. |
| 5 | AI-chat envelopes | **None new** — extraction is a post-turn/recorded op, not a user-visible chat envelope. |
| 6 | Agent pack | **Optional** `memory-extractor` persona (OQ-4); capability stays core (David's law) — honest. |
| 7 | RBAC (fail-closed / IDOR / uniform-404) | self-owned `user` grant; admin-gated `agent` grant; fail-closed without a grant; uniform 404 cross-tenant; self-scoped review. |
| 8 | Replay/fork | separately-recorded op; idempotency-keyed writes; versioned+audited; revoked grant re-checked live on fork (ADR 0044 §4). |
| 9 | Reuse-not-recreate | reuses `subjectMemory` store + note CRUD + caps, the ADR 0044 consent/fence/audit, ADR 0077 PII, the dispatch write seam — owns only the grant + extraction op. |
| 10 | RFC gate | **Host-ext, NO RFC** — rides Accepted RFC 0004/0048; `/v1/host/openwop-app/*`. |

---

## Phased plan

1. **Opt-in grant + RBAC.** `features/memory-auto-extract/`: `MemoryExtractionGrant`
   store + `/profiles/me/memory-extraction` (user self-grant/revoke) +
   agent-grant route (`workspace:write`); the limit guard; audit rows (ADR 0044 shape).
   Toggle OFF/user. Tests: only-owner-grants, fail-closed, IDOR uniform-404. **No
   extraction yet.**
2. **The extraction op (run-scoped).** A `memory.extract` node OR the dispatch post-turn
   op: gate → `ctx.callAI` extract → ADR 0077 classify/mask → `addSubjectNote`
   (untrusted, `auto-extracted` tag, provenance) / `removeSubjectNote`, idempotency-keyed;
   valid-key/limit guard (no key ⇒ skip). Tests: no grant ⇒ no write; revoke ⇒ fork
   extracts nothing; idempotent re-run (no dup); untrusted fence on recall; PII-masked.
3. **Review UI.** A "Memory learned from chat" section on the Profile Memory tab
   (ADR 0041 §Phase 3 `MemoryBrowser`, subject-parameterized) listing `auto-extracted`
   notes with provenance + per-note delete + a global opt-out; reuses the trusted/untrusted
   chips. `ui/` cohesion + a11y; `frontend/react && npm run build` gate green.
4. **Tests + docs.** Extraction correctness (set/supersede/delete), consent fail-closed,
   revoke-on-fork, idempotency, untrusted-marking, PII masking, audit attribution;
   `FEATURES.md` entry.

---

## Alternatives weighed

1. **A second "auto-memory" store separate from `subjectMemory`.** Rejected outright
   (no-parallel-architecture; David's law; the ConversationMeta key-mismatch lesson) —
   extracted facts ARE subject memory; they belong in the `subject-memory:note` store
   under the same scope, tagged, not in a shadow table that recall would miss.
2. **Always-on extraction (no consent grant).** Rejected — silently mining a person's
   chat into durable memory is exactly the privacy surprise ADR 0044 forbids. Extraction
   MUST be opt-in, fail-closed, revocable (ADR 0020/0044).
3. **Synchronous extraction in a route handler.** Rejected — a provider LLM call needs a
   per-run `AdapterScope`/`ctx.callAI` (ADR 0011 §Correction); extraction is a recorded
   node or the dispatch post-turn op, never synchronous route code.
4. **Trust extracted facts (let the agent act on them directly).** Rejected — extracted
   facts originate from chat content (second-party), so they are `untrusted`-fenced by
   default (ADR 0044 §4 floor); promoting to trusted is a deliberate, separate decision
   (OQ-3), not the default.
5. **Stamp a frozen extraction snapshot for fork fidelity.** Rejected for the *grant
   check* — privacy-first re-checks the live grant on fork (ADR 0044 §4); only the written
   note rows (idempotency-keyed) are reproduced.

## Open questions

- **OQ-1 — Extraction cadence.** Every turn (the dispatch post-turn op) vs. a periodic
  batch over the conversation (cheaper, less duplicative)? Propose: post-turn behind a
  per-window rate cap (the limit guard) v1; a batch consolidation pass as a follow-on.
- **OQ-2 — Dedupe / supersede.** How aggressively should extraction supersede an existing
  note (the set/delete diff)? Propose: confidence-floored adds + explicit supersede only
  when the new fact contradicts a tagged prior `auto-extracted` note; never auto-delete a
  hand-curated note.
- **OQ-3 — Trusted opt-in.** Should a user ever mark extracted facts `trusted` (so a twin
  acts on them directly), or is untrusted-fenced-always the floor? Default: always fenced
  (ADR 0044 parity); revisit with usage.
- **OQ-4 — `memory-extractor` agent pack.** Ship the extraction prompt as a named persona
  pack, or keep it an internal core extraction prompt? Propose: internal v1 (capability is
  core, David's law); a persona is an optional refinement, not a claimed deliverable.
- **OQ-5 — PII threshold tuning.** ADR 0077 classifies Public/Internal/Confidential-PII.
  Where is the auto-persist cut-off for extracted facts? Propose: drop Confidential-PII by
  default; an opt-in "allow sensitive facts" per grant (still masked in logs).

## RFC verdict (Step 5)
**Host-extension — rides Accepted RFC 0004 (memory) / RFC 0048 (opaque owner) — NO new
RFC.** Extraction keys the existing opaque `memoryRef` on `user:<id>`/`agent:<id>` and
runs as a host-internal op (recorded node or dispatch post-turn) under
`/v1/host/openwop-app/*`. No run-event field, capability flag, event type, or normative
MUST is touched — the identical gate as ADR 0041/0044. (If extraction were ever made a
capability a *remote* OpenWOP client negotiates, that flips to needs-an-RFC — flag then.)

---

## Follow-up action — surfacing audit (2026-06-24)

**Audit verdict:** 🟡 full backend pipeline (`features/memory-auto-extract/`, grant routes,
post-turn call in `host/conversationExchange.ts`), but the feature is **fail-closed on a
consent grant that has NO UI** — settable only via a raw `PUT
/v1/host/openwop-app/profiles/me/memory-extraction`. So no user can enable it. The ADR's
"only review UI (Phase 3) pending" undersells it: there is no enable control at all.

**Nuance (single-source-of-truth holds):** the extractor persists each fact via
`addSubjectNote(... "[auto-extracted] " + fact)` — the **same subject-note store** as the
ADR 0041 manual notes. So extracted memories **already surface** (and are deletable) in the
existing `features/profile-memory/ProfileMemoryTab.tsx`; a separate "review list" is mostly
redundant. The **genuine** gap is just the consent toggle.

**Seam-correct action (pure FE, backend done):** add a **consent toggle** to the existing
`ProfileMemoryTab` — a small client over `/profiles/me/memory-extraction` (GET/PUT/DELETE),
**default OFF**, with a one-line consent explainer; optionally filter/label the
`[auto-extracted]` notes already in the list for clarity.

**Boundary check:** reuse the profile-memory tab + subject-note store — do NOT stand up a
second memory surface or store. Consent stays opt-in / fail-closed (deny when ungranted).
