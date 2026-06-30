# ADR 0044 — Digital twin: cross-subject recall (an agent reads its owner's memory)

**Status:** implemented (Phases 1–3 — link + grant + RBAC + audit, fenced recall, UI; see the phase table. Status line corrected 2026-06-22: the body already recorded all phases implemented.)
**Date:** 2026-06-15
**Toggle:** `twin-recall` (proposed; default OFF, `bucketUnit: tenant`) — this is a
new cross-principal access path and MUST be opt-in per tenant, not always-on.
**Capability:** none new on the wire (see RFC gate).
**Depends on / composes:** ADR 0041 (subject memory — the `user:<id>` scope this reads),
ADR 0042 (human knowledge binding — the docs side of the corpus), ADR 0038 (per-agent
knowledge + the §C untrusted fence this reuses), ADR 0031 (`agentProfile` — where the twin
link lives), ADR 0006 (RBAC), ADR 0036 (`agentProfile` policy). Adjacent (not dependent):
ADR 0043 (persistent conversations — a twin may act in one).
**Surface:** host-internal under `/v1/host/openwop-app/*`.
**NON-NORMATIVE — no OpenWOP RFC** *(with one caveat — see RFC gate)*.

> **This is the architecture review's #2.** It is deliberately a separate ADR from ADR
> 0041/0042 because it is the **first intra-tenant cross-principal read** in the app: an
> `agent:<id>` run reading a `user:<id>` memory scope. That is an authorization decision, not
> a memory change — so it gets its own consent model + security review before any code.

## Why this exists

ADR 0041/0042 let a person train a durable corpus (notes + documents). But nothing *acts* on
it: a human's `user:<id>` memory is written and self-read only. The payoff of "digital twin"
is an **agent acting on your behalf that recalls what you know** — drafting as you would,
remembering your preferences. That requires an agent run to read a *different principal's*
memory, which today is impossible and, done naively, is a data-leak waiting to happen.

A grounded audit (ADR 0041/0042 work) established the constraints:
- Dispatch reads exactly ONE memory scope (`agentDispatch.ts` `deps.memoryScope`); there is no
  multi-scope recall.
- There is **no user↔agent link** anywhere (`RosterEntry`/`agentProfile` have no user anchor) —
  so "whose twin is this agent" must be established first.
- The retrieval composition is already subject-agnostic (`resolveSubjectKnowledgeRetrieve`,
  ADR 0042) — it can compose a second subject's corpus *if* authorized.
- CTI-1 (tenant isolation) remains necessary but is **no longer sufficient**: agent and user are
  different principals *within the same tenant*, so a new consent boundary appears.

## Forces

1. **Consent is the user's to give, not the operator's to assume.** Only the linked human may
   authorize an agent to read their memory. Fail-closed: no active grant ⇒ no cross read.
2. **Link ≠ grant.** *Configuring* which agent is whose twin (operational) is distinct from
   *authorizing* memory access (the user's call). Two steps, two owners.
3. **Replay/fork determinism vs. revocation.** What a run recalled must be reproducible on
   `:fork`; but a user who revokes must be protected. These pull in opposite directions — the
   ADR must pick an explicit semantics (see Decision §4).
4. **Borrowed content is not the agent's own truth.** A user's memory entering an agent turn is
   second-party content; it must be fenced (untrusted-by-default) so it's never followed as
   instructions.
5. **Auditability.** Every cross-subject recall must be attributable to a specific grant.

## Decision (proposed)

### 1. The twin link — `agentProfile.twin`
A new optional block on the agent's host profile (ADR 0031):
```
twin?: { userId: string; linkedBy: string; linkedAt: string }
```
Establishes "agent X is a twin of user Y." Set by an **admin/owner** (`workspace:write` +
ADR 0036 policy), since attaching an agent to a person is an operational/governance act. The
link alone grants **no** memory access.

### 2. The consent grant — issued by the user, revocable
A separate, user-owned grant record (NOT the GDPR-style `consent` feature, which models
marketing categories — a different concept):
```
TwinGrant { agentId, grantedByUserId, grantedAt, scopes: ('memory'|'knowledge')[],
            status: 'active'|'revoked', revokedAt?, version: number }
```
- **Only `grantedByUserId == the linked twin.userId` may create/revoke it** (intrinsic
  self-ownership — the same authority model as `/profiles/me/*`). An admin can sever the *link*
  but cannot *grant on the user's behalf*.
- Surface: `/v1/host/openwop-app/profiles/me/twin-grants` (list / grant / revoke). The user sees
  exactly which agents may recall their memory and can revoke any, any time.
- Fail-closed: absent or `revoked` ⇒ the agent reads only its own `agent:<id>` scope (today's
  behavior, unchanged).

### 3. Dispatch composition — additive, STRUCTURALLY fenced (implemented)
When a twin agent runs AND an active grant exists, dispatch composes a SECOND retriever over the
owner's corpus via the existing seam:
`resolveSubjectKnowledgeRetrieve(tenantId, ownerBinding, ownerMemoryPort, subjectMemoryScope({kind:'user', id: twin.userId}))`
where `ownerBinding` is synthesized from the grant's `scopes` (`memory` → owner notes; `knowledge`
→ owner `Profile.knowledge.collectionIds`).

**The fence is STRUCTURAL, not a marking convention (Phase-2 `/architect` finding 2).** Dispatch
takes a dedicated `borrowedRetrieve` input and funnels **every** chunk it returns into the UNTRUSTED
block (neutralized) — there is **no trusted path** for borrowed content, regardless of a chunk's own
`contentTrust`. So a future edit cannot accidentally promote a user's memory to trusted. (Marking
owner chunks `untrusted` on the *agent's* `knowledgeRetrieve` was rejected — `agentDispatch.ts:456`
drops `kind:'memory'` chunks, which would silently lose owner notes.)

**Boundary:** core dispatch never imports the twin feature. The feature fills a host seam
(`twinRecallSurface.setBorrowedRecallResolver`, mirroring `setKnowledgeBackend`); core dispatch reads
it via `getBorrowedRecallResolver`. The resolver reads the owner's `Profile.knowledge` from the
profiles feature (a feature→feature read, the same pattern `agent-knowledge` uses for `kb`).

### 4. Replay/fork semantics (the hard call — proposed, needs sign-off)

> **Correction (2026-06-15, Phase-2 `/architect`): NO run-stamp is needed.** The proposal below
> (stamp `run.metadata.twinGrant`, re-check on fork) was over-built. Implementation found the
> recall happens in `runAgentDispatchLive` — an **ad-hoc, non-persisted dispatch** (`routes/agents.ts`,
> `runId: agent-dispatch:…`) — and memory recall is a **live read** never written to an event log.
> So there is nothing to stamp and nothing a fork could replay: the grant is checked **live** on
> every dispatch (`twinRecallSurface` → `resolveBorrowedRecall`), and a revocation takes effect
> immediately everywhere — chat, runs, and forks alike. Privacy-first is the *do-nothing-special*
> path; a `run.metadata.twinGrantUsed` annotation is permitted for **audit provenance only**, never
> read for authorization. The original proposal is kept below for the reasoning trail.

Stamp the **resolved grant** on the run at creation: `run.metadata.twinGrant = { agentId,
userId, scopes, version }` (the ADR 0001 variant-stamp pattern). On `:fork`, read the stamp
verbatim — the fork recalls what the original was authorized to.

**The tension:** a user revokes after a run; a `:fork` of that old run would still recall
now-revoked memory (determinism preserved, but privacy surprised). **Decision (2026-06-15 — privacy-first re-check):** stamp for
determinism of *non-memory* state, but **re-check the live grant at fork time for the
cross-subject MEMORY read specifically** — a revoked grant yields no owner recall on the fork,
accepting that a forked run may recall *less* than the original. Rationale: memory *content* is
read live at recall time (it is never frozen into the run's event log), so a pure stamp only ever
froze the *authorization decision*, not the content — privacy-first therefore costs little real
replay fidelity while making revocation effective even on a fork. Revocation is a safety control
and wins over replay fidelity for borrowed personal data.

### 5. Audit
Every cross-subject recall emits an audit row (`storage.listAudit`) keyed by `{runId, agentId,
twin.userId, grantVersion}` so a user (and an admin) can see when their memory was used.

## Phased plan (proposed)

| Phase | Scope | Gate |
|---|---|---|
| 0 | This ADR accepted; the replay semantics (§4) signed off. | review |
| 1 | `agentProfile.twin` link + admin route; `TwinGrant` store + `/profiles/me/twin-grants` (list/grant/revoke); RBAC + audit. **No recall yet.** | tests: only the user can grant/revoke; fail-closed |
| 2 | Dispatch composition behind `twin-recall` (OFF): compose the owner corpus when a stamped active grant exists; untrusted fence; run-stamp. | tests: no grant ⇒ no cross read; revoke ⇒ forks stop recalling memory |
| 3 | UI: the user's "Who can recall my memory" panel (grant/revoke) + an agent "Twin of …" affordance. | build gate |

## Alternatives weighed

- **Always-on once linked (no separate grant).** Rejected — conflates operational linking with
  the user's authorization; an operator could read a user's memory by linking an agent. The grant
  MUST be the user's.
- **Reuse the `consent` feature.** Rejected — it models marketing/data-processing categories, not
  an access grant; overloading it would muddy both.
- **Pure replay stamp (fork ignores revocation).** Simpler, but lets a forked historical run
  resurrect revoked personal memory — rejected in favor of §4's live-recheck for memory reads
  (pending sign-off).
- **A shared "twin corpus" scope both read/write.** Rejected — collapses the principal boundary;
  the agent must read the user's scope under grant, not co-own it.

## RFC gate

**Host-only — no new RFC**, today: the link, grant, and composition are all host-internal;
memory reads never cross the `/v1` wire (`memoryRef` is opaque; no run-event field, capability
flag, or event type changes). **Caveat to re-test at Phase 2:** if the twin link/grant is ever
made a capability a *remote* OpenWOP client negotiates (rather than host-side config), that
flips to **needs an RFC** — flag loudly then. The cross-principal read is also exactly the class
of change that should get a `/architect` + security pass before Phase 2 code lands.

## Open questions (for sign-off)

- **§4 replay semantics** — DECIDED 2026-06-15: live-recheck for memory on fork (privacy-first).
- **Trusted opt-in** — should a grant ever mark owner memory `trusted` (so the twin can act on it
  directly), or is untrusted-fenced-always the right floor? Default: always fenced.
- **Granularity** — grant per-agent (proposed) vs. a blanket "any of my twins." Per-agent is
  safer; revisit with usage.
- **Cross-tenant twin** — a user whose twin agent lives in another tenant. Out of scope (CTI-1
  forbids); would need explicit cross-tenant federation, a separate ADR.

## Implementation status

| Phase | Status |
|---|---|
| 0 — design sign-off | Accepted (§4 = privacy-first re-check) |
| 1 — link + grant + RBAC + audit | implemented (`host/twinService.ts`, `twin` feature, `agentProfile.twin`, cascade cleanup, `twin-route.test.ts`; toggle `twin-recall` OFF) |
| 2 — fenced recall (NO stamp — §4 correction) | implemented (`borrowedRetrieve` structural fence, `twinRecallSurface` seam, `borrowedRecall` resolver + live gate + audit; `twin-recall-fence.test.ts` + gate test) |
| 3 — UI | implemented (`features/twin/{twinClient,AgentTwinPanel,ProfileTwinGrantsTab}.tsx`). The agent **"Twin of …"** affordance mounts on `AgentProfilePanel` (link/unlink + grant/revoke when the viewer is the linked person); the user's **"Who can recall my memory"** consent dashboard is a `twin-recall`-gated tab on `ProfilePage` (list active grants + immediate revoke). Both self-gate on the toggle; build gate green) |
