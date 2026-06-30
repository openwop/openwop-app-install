# ADR 0041 — Subject memory: one memory primitive for agents *and* humans

**Status:** implemented
**Date:** 2026-06-15
**Toggle:** none — Personal Memory is **always-on** (§ Correction 2026-06-15: graduated off the
`profile-memory` toggle, like `profiles` itself; durability — the original gating rationale —
is satisfied). The *agent* surface keeps riding `agent-knowledge` (ADR 0038) unchanged.
**Capability:** none new — reuses the RFC 0004 memory store and the `agent-knowledge`
curation model.
**Depends on / composes:** ADR 0038 (per-agent knowledge & memory — generalized here, not
forked), ADR 0005 (user profiles — the human owner + its descriptive-only boundary), ADR
0001 (feature-package architecture), ADR 0003/0048 (opaque principals — `user:<userId>`).
Reuses the host memory adapter (`host/agentMemoryAdapter.ts` → now `host/subjectMemory.ts`,
RFC 0004) and the in-memory RFC-0004 store.
**Surface:** host-internal product config under `/v1/host/openwop-app/*`.
**NON-NORMATIVE — no OpenWOP RFC.** Rides **already-Accepted** RFC 0004 (Memory Layer),
RFC 0048 (opaque owner), RFC 0080 (memory capability dimensions). It touches no `/v1` wire
contract — the memory store keys on an opaque `memoryRef`, which already accepts any owner
string. See § "RFC gate".

## Why this exists

The request: *"per-agent memory must be 100% bulletproof and apply the same way to all
agents, with a visible tab per agent showing their memories. Human user profiles need a
memory too, so a person can train their own profile — eventually a digital twin of
themselves."*

A boundaries audit (2026-06-15, `/architect`, file:line-grounded) found:

1. **Advisor agents are already canonical — nothing to fix.** `advisoryBoardConvene.ts:126`
   and `agent-knowledge/service.ts:301` both call the *same* `resolveAgentKnowledgeRetrieve(…,
   agentMemoryScope(agentId))`. There is one per-agent memory path, not a parallel one. The
   premise's "fix the advisors" fork resolves to: **don't fix — generalize.**
2. **The store is already principal-agnostic; the *scope helper* is not.**
   `agentMemoryScope()` (`agentMemoryAdapter.ts:39-41`) hardcodes `` `agent:${id}` ``, but the
   RFC-0004 store (`inMemorySurfaces.ts` `writeMemoryEntry`/`listMemoryEntries`) keys on a
   fully opaque `memoryRef`. So a human's memory is *the same store* under `user:<userId>` —
   zero new infrastructure.
3. **Memory belongs to a standing instance, not a template.** The agent Knowledge tab is on
   `AgentWorkspacePage` (`:317`, keyed by `rosterId`); `AgentDetailPage` (templates) has no
   tabs. A template is a blueprint with no lived experience — memory accrues on the instance.
4. **`profiles` is declared descriptive-only** (`profilesService.ts:1-15`): identity →
   `users`, authority → RBAC, bytes → media-by-token. Raw memory content **must not** land in
   the `Profile` record.

## Decision

Introduce **subject memory** — one primitive, keyed by a `MemorySubject`, used identically
by agents and humans.

```ts
export type MemorySubject = { kind: 'agent'; id: string } | { kind: 'user'; id: string };
export function subjectMemoryScope(s: MemorySubject): string { return `${s.kind}:${s.id}`; }
```

- `subjectMemoryScope({kind:'agent', id})` ⇒ `agent:<id>` — **byte-identical** to the old
  `agentMemoryScope`, so every existing agent/advisor path is unchanged.
- `subjectMemoryScope({kind:'user', id})` ⇒ `user:<id>` — the human's personal memory.

**Single owner (Finding 2).** `host/subjectMemory.ts` becomes the one owner of: the scope
convention, the RFC-0004 memory **port** (`createSubjectMemoryPort`, moved verbatim from the
old adapter), and the **curated-note CRUD** (`addSubjectNote` / `listSubjectNotes` /
`removeSubjectNote` / `countSubjectNotes`). `host/agentMemoryAdapter.ts` becomes a thin
back-compat **re-export shim** (`agentMemoryScope`, `createAgentMemoryPort`,
`countAgentMemoryByTag`) so dispatch, agent-knowledge, the advisory board, and the routes keep
importing the same symbols with identical behavior.

**No `Profile` schema change (Finding 1 + 4).** Human memories live entirely in the RFC-0004
store at `user:<userId>` — they are *referenced* by the user's opaque id, never inlined into
the descriptive `Profile` record. The profile view surfaces a **derived** `memoryCount` (read
time, never persisted) to drive the "train your twin" progress affordance. (A future
`Profile.knowledge.collectionIds` reference would add bound KB documents for humans — see Open
questions; out of scope here.)

**Self-ownership authority (Finding 3).** A human curating *their own* memory needs no
`memoryWritable` opt-in (that gate exists for agents because a user curates *another* entity's
recall). The owner *is* the authority: the `/profiles/me/memory` routes resolve the caller via
`resolveCallerUser` and key the subject on the caller's own `userId` — intrinsic ownership,
exactly like the other `/me/*` routes.

**Durability before the twin claim (Finding 4 / Phase 2 — IMPLEMENTED).** The base RFC-0004
store is in-memory (sample-grade) — acceptable for an agent's transient run-recall, **dishonest
for "train your twin over months."** So a **curated note is durable**: it is written to a
`DurableCollection` (`subject-memory:note`, the SAME storage seam profiles/orgs use) as the
*source of truth* for list/count/delete, and *additionally* mirrored to the in-memory + vector
store as a best-effort recall index (so dispatch RAG recall is unchanged from ADR 0038). Both
rows share one id, so delete is consistent across durable + recency + vector. Dispatch
turn-summaries stay ephemeral (transient, regenerated each run). Net: a person's trained
memories persist exactly as durably as their profile.

## Data model

| Concept | Owner | Keying |
|---|---|---|
| Memory entries (notes + turn summaries) | RFC-0004 store (`inMemorySurfaces.ts`) | `tenantId` + `memoryRef` (`agent:<id>` \| `user:<id>`) |
| Scope convention + note CRUD + port | `host/subjectMemory.ts` (single owner) | `MemorySubject` |
| Agent binding (`collectionIds`, `memoryWritable`) | `agentProfile.knowledge` (ADR 0038) | `agentId` |
| Human memory binding | *none needed* — notes key on `user:<userId>` | `userId` |
| Human `memoryCount` (derived) | `profilesService.viewProfile` | computed, never stored |

## Phased plan

- **Phase 1 — backend seam.** `subjectMemory.ts` (scope + port + note CRUD); `agentMemoryAdapter.ts`
  → re-export shim; `agent-knowledge/service.ts` `addNote`/note-count delegate to the seam +
  new `listAgentNotes`/`removeAgentNote`; new `GET/DELETE {BASE}/notes[/:id]` agent routes; new
  `GET/POST/DELETE /v1/host/openwop-app/profiles/me/memory[/:id]` human routes (toggle +
  self-ownership). **Acceptance: every existing agent/advisor memory test passes unchanged**
  (the no-fork proof).
- **Phase 2 — durable curated notes.** Persist curated notes to a `DurableCollection` (source
  of truth) with the in-memory + vector store as a best-effort recall index under the same id;
  notes survive restart. Turn-summaries stay ephemeral.
- **Phase 3 — shared UI.** One subject-parameterized memory-browser component; a Memory tab on
  `AgentWorkspacePage` (instance) and on `ProfilePage`; trusted/untrusted chips reused.
- **Phase 4 — twin framing.** "Train your twin" copy on the profile Memory tab. Originally
  shipped behind a `profile-memory` toggle (OFF); **graduated to always-on 2026-06-15** — a
  person's own profile should not carry an admin-gated tab they can't enable themselves, and
  durability (the gating rationale) is met. The surface is self-owned (caller curates only
  their own memory), so always-on is safe.

## Alternatives weighed

- **Fork a second human-memory service.** Rejected — two systems for one concept (the
  `orgs`↔`accessControl` failure mode); drifts immediately. The seam + shim gives one path.
- **Put memory content on the `Profile` record.** Rejected — violates the descriptive-only
  boundary (`profilesService.ts:1-15`) and bloats every directory read. Memory is referenced
  by `userId`, owned by the RFC-0004 store.
- **Gate human memory on a `memoryWritable` opt-in (agent parity).** Rejected — friction with
  no security benefit; a human owns their own memory by definition.
- **Build template-level (blueprint) memory.** Rejected for now — a template has no lived
  experience and sharing one pool across tenants leaks. Left as a distinct future feature
  (factory seed knowledge).

## RFC gate

**Host-only — no new RFC.** The change keys the existing opaque `memoryRef` on `user:<userId>`
(an already-Accepted RFC 0048 owner) and adds non-normative routes under
`/v1/host/openwop-app/*`. No run-event field, capability flag, event type, or normative MUST
is touched. (If human KB-document binding is added later it likewise rides the Accepted RFC
0011/0018 KB+vector surfaces — still host work.)

## Open questions

- **Cross-subject read (twin reads its human).** Eventually a digital-twin agent may read its
  owner's `user:<userId>` memory. That is a cross-principal access decision (consent + RBAC),
  **deliberately not built here.** Keying on the opaque `user:<userId>` makes it possible later
  with no migration.
- **Human KB-document binding.** `Profile.knowledge.collectionIds` (mirror of
  `agentProfile.knowledge`) would let a human bind cited documents, not just notes. Deferred —
  notes are the "train your twin" MVP.
- **Per-subject memory caps for humans.** The shared `NOTE_CAP` (200) applies to both; revisit
  once durable + real usage exists.

## Implementation status

| Phase | Status | Commit / test |
|---|---|---|
| 1 — backend seam | implemented | `subjectMemory.ts`, shim, profile/agent note routes; `profile-memory-route.test.ts` |
| 2 — durable curated notes | implemented | `DurableCollection('subject-memory:note')`; `subject-memory.test.ts` (survives in-memory wipe) |
| 3 — shared UI | implemented | `memory/MemoryBrowser.tsx`, agent + profile Memory tabs |
| 4 — twin framing | implemented | twin copy honest (notes durable); **always-on** (toggle retired 2026-06-15, like `profiles`) |


## § Follow-on — Temporal Agent Memory (innovation strategy, 2026-06-24)

The innovation strategy proposes memory that **decays**: confidence, provenance,
last-confirmed date, half-life, scope, contradiction set, and a refresh policy; inject a
memory only when effective confidence passes a threshold, and flag contradictions. This
**extends THIS ADR + ADR 0120 (auto-extract)**: subject memory already carries
provenance + untrusted tagging; temporal memory adds decay/confidence/contradiction as
additive fields on a `SubjectNote` + an injection-decision filter in the retrieval
composition (`resolveSubjectKnowledgeRetrieve`). No new store; needs GDPR/deletion
parity (ADR 0028). Host-extension, no new RFC.
