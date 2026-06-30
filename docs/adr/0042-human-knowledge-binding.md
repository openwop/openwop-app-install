# ADR 0042 — Human knowledge binding (documents on a profile, toward a twin)

**Status:** implemented
**Date:** 2026-06-15
**Toggle:** none — rides the always-on Personal Knowledge & Memory surface (ADR 0041 §
Correction). Self-owned (a caller curates only their own knowledge).
**Capability:** none new.
**Depends on / composes:** ADR 0041 (subject memory — the seam this extends), ADR 0038
(per-agent knowledge & memory — the agent counterpart, whose composition this generalizes),
ADR 0011 (Knowledge Base / RAG — `kbService`, the single owner of collections + retrieval),
ADR 0005 (profiles — the human owner + descriptive-only boundary), ADR 0001.
**Surface:** host-internal product config under `/v1/host/openwop-app/profiles/me/knowledge/*`.
**NON-NORMATIVE — no OpenWOP RFC.** Rides **already-Accepted** RFC 0011 (KB) / 0018
(vectorStore) / 0004 (memory). No `/v1` wire contract is touched.

## Why this exists

ADR 0041 let a person train their profile with **notes** (`user:<userId>` memory). Agents get
more: they also bind **cited documents** (`agentProfile.knowledge.collectionIds`, ADR 0038),
composed into retrieval alongside notes. This ADR gives a human the same — attach documents to
their own profile — so the digital-twin corpus is documents *and* notes, not notes alone. It is
the `#1` follow-on identified in the ADR 0041 architecture review.

A boundaries audit (2026-06-15, `/architect`) found the retrieval composition is the ONLY
agent-coupled piece: `resolveAgentKnowledgeRetrieve` (`host/agentKnowledgeComposition.ts:38`)
reads `agentProfile.knowledge` then composes `kbService` (docs) + the memory port (notes). The
memory half already serves humans (ADR 0041). The doc half needs (a) a binding store for a
`user:` subject and (b) the composition to accept a binding rather than look up an agent profile.

## Decision

1. **Generalize the composition, don't fork it.** Extract the binding-driven core as
   `resolveSubjectKnowledgeRetrieve(tenantId, binding, memory, memoryScope)` — it already took
   `memory` + `memoryScope` as params; the only agent-specific lines were the profile load +
   capability gate. `resolveAgentKnowledgeRetrieve` becomes a thin wrapper (load profile, check
   the `knowledge` capability, delegate) so **every agent/advisor path is byte-identical** (the
   no-fork proof: existing knowledge/advisory tests pass unchanged). Humans call the generalized
   function with `Profile.knowledge` + the `user:<id>` memory scope.

2. **`Profile.knowledge` — a reference, never content (ADR 0005 boundary).** A mirror of
   `agentProfile.knowledge`: `{ collectionIds?: string[]; retrieval?: { topK?; sources? } }`.
   `collectionIds` are pointers into `kbService`'s collections (cited docs live there); the
   descriptive `Profile` record holds only the references, no document bytes/text.

3. **Self-service human knowledge service + routes.** `/profiles/me/knowledge/*` —
   view · create+bind / bind / unbind a collection · ingest a text document · delete a document ·
   `retrieve` (query the caller's own corpus = docs + notes through the generalized composition).
   Authority is intrinsic self-ownership (`resolveCallerUser` → the caller's own `userId`);
   org-scoped writes (create/ingest) require the caller's `workspace:write` in that org (the same
   `kbService` IDOR guard agents use). The surface is part of the always-on Personal Knowledge &
   Memory feature (stable id `profile-memory`).

## Data model

| Concept | Owner | Keying |
|---|---|---|
| Collections + cited documents + RAG | `kbService` (ADR 0011) — single owner | `tenantId` + `orgId` + `collectionId` |
| Human binding (`collectionIds`, `retrieval`) | `Profile.knowledge` (profilesService) | `userId` |
| Retrieval composition | `resolveSubjectKnowledgeRetrieve` (single owner; agent wrapper delegates) | binding + `memoryScope` |
| Notes (memory half) | subject memory (ADR 0041) | `user:<userId>` |

## Phased plan

- **Phase 1 — seam + binding.** Generalize the composition; add `Profile.knowledge` +
  `setProfileKnowledge`; human knowledge service over `kbService`; `/profiles/me/knowledge/*`
  routes incl. `retrieve`. Agent tests unchanged = no-fork proof.
- **Phase 2 — UI.** A "Knowledge" tab on My Profile (create/bind/unbind collections, ingest text,
  list/delete docs, query) using the shared `ui/` primitives.

## Alternatives weighed

- **Copy the agent-knowledge service for humans.** Rejected — two composition owners drift. The
  generalized retriever keeps one.
- **Put documents on the `Profile` record.** Rejected — violates descriptive-only (ADR 0005);
  documents live in `kbService`, referenced by `collectionId`.
- **A separate `profile-knowledge` feature.** Rejected for now — folds into the always-on Personal
  Knowledge & Memory feature (the human mirror of the single agent-knowledge feature), keeping one
  human-corpus surface.

## RFC gate

**Host-only — no new RFC.** New binding field on a host-ext record, new routes under
`/v1/host/openwop-app/*`, composition reuse. Rides Accepted RFC 0011/0018/0004. No wire change.

## Open questions

- **Who reads a human's documents?** Today: the human (via `retrieve`) — proving the corpus
  end-to-end. A twin *agent* reading them is the cross-subject-recall follow-on (#2), gated on a
  consent model — a future ADR (the 0043 number is now taken by the persistent-conversation work,
  so it lands at 0044+). This ADR deliberately stops at self-read.
- **Provider import (Google Drive) for humans** — agents have it (ADR 0038 follow-on); humans
  could reuse the same `fetchKnowledgeSource` seam. Deferred.
- **Per-profile collection cap** — reuse the agent `BINDING_CAP` (20). Revisit with usage.
- **"Personal" knowledge requires an org with `workspace:write`** — KB collections are
  org-scoped (`kbService`, ADR 0011), so creating/ingesting personal documents needs write scope
  in some org; a user with no org membership can only bind existing collections they can read
  (the UI disables the create form when the user has no orgs). Correct RBAC, but a slightly leaky
  "personal" abstraction. A per-user implicit collection (keyed on the personal tenant's default
  org) would close it later if wanted.

## Implementation status

| Phase | Status | Commit / test |
|---|---|---|
| 1 — seam + binding | implemented | `resolveSubjectKnowledgeRetrieve`, `Profile.knowledge`, profile-knowledge service + routes; `profile-knowledge-route.test.ts` (docs+notes one corpus); agent suites unchanged (no-fork) |
| 2 — UI | implemented | `ProfileKnowledgeTab` + Knowledge tab on My Profile |
