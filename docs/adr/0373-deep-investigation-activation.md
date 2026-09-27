# ADR 0373 — Deep-investigation activation (host-ext capability, no RFC)

Status: implemented

## Context

ADR 0089 Phase 4 shipped a real capability: a tool-bearing agent that declares
`investigationDepth: 'deep'` and is `@mentioned` in chat dispatches its tool
loop as a **separate persisted run** (a `workflow_run` bubble) instead of an
inline turn. The branch, the synthetic `openwop-app.agent-mention` workflow, the
`agent-runner` node into the gated `runAgentDispatchLive`, and 8 tests all exist.

**It has never executed outside tests.** The 2026-07-15 grade pass found it is
unreachable, and ADR 0089 Phase 4 now carries an inline correction note:

- `packs/agentLoader.ts:209` builds `ResolvedAgentManifest` field-by-field and
  never copies `investigationDepth` off the raw manifest (`RawAgentManifest`,
  `:43`, doesn't list it); `routes/userAgents.ts` and `routes/agents.ts` never set it.
- **Zero packs declare it.**
- The only writer is a direct `registry.register()` — which is exactly what
  `test/conversation-deep-investigation.test.ts:108` does. **The tests prove the
  branch, not the feature.**

The obvious fix — teach the loader to read the field — is **not available**:
`schemas/agent-manifest.schema.json` is the SPEC schema (`$id:
https://openwop.dev/spec/v1/agent-manifest.schema.json`), vendored from
`../openwop`, re-projected onto the wire by `routes/packs.ts:38`
`projectAgentManifest`, and `additionalProperties: false` **without**
`investigationDepth`. A pack declaring it would violate the spec schema.
Manifest-declaring it is a **wire change ⇒ RFC gate** (CLAUDE.md). That road is
open, but it is an OpenWOP RFC, not host work.

The guardrail is already in place: ADR 0089's burst risk was ruled on as
`XCH-GRP-3` (2026-07-15, PR #1868) — a per-room, per-window deep-run budget over
the durable `run_budget` counter, degrading to the inline turn with an honest
notice rather than failing the turn. **The path is safe the moment it
activates.** Activation is the only remaining work, and this ADR is it.

### Why this is worth activating at all

The XCH-GRP-3 research (PR #1865) established the industry position with primary
sources. Anthropic gates multi-agent architectures on economics, not
prohibition — *"multi-agent systems require tasks where the value of the task is
high enough to pay for the increased performance"*, measured at *"about 15×
more tokens than chats"* — and names the sweet spot as *"heavy parallelization,
information that exceeds single context windows, and **interfacing with numerous
complex tools**"*. An explicit `@mention` of a deep agent satisfies that
economic gate **by construction: a human electing the cost IS the value signal.**
The same source refutes the shape we already disabled (`#1831`): *"domains that
require all agents to share the same context … are not a good fit"* — a shared
advisory-board cadence. Deep investigation is the endorsed shape; the cadence
fan-out was not.

## Decision

**Activate deep investigation as a per-agent HOST-EXTENSION capability on the
existing `agentProfile` seam. No new store, no new admin surface, no RFC.**

1. **Mechanism — `AgentProfile.capabilities`.** Add `'deep-investigation'` to
   the `AgentCapabilityId` union (`types.ts:394`, a **host-internal** type — not
   the spec schema). Activation rides the existing idempotent
   `activateAgentCapability` (`agentProfileService.ts:213-231`), whose own docstring
   states the contract: *"The runtime gates capability behavior on
   `profile.capabilities`, so this is how a capability is turned on per named
   agent — never via `roleKey`."*

   This maps **exactly** to the documented seam — `ARCHITECTURE.md:127`:
   > | Agent config + capability activation | `agentProfile` host-ext (`/v1/host/openwop-app/agents/:id/profile`) + `AgentProfile.capabilities` (ADR 0031) |

   and to the standing rule *"capabilities at core, activated via agentProfile"*
   (ADR 0031 / the agent-capability doctrine): the capability lives at core (the
   dispatch branch in `conversationExchange`), activated per named agent.

2. **`investigationDepth` on the manifest becomes vestigial, not load-bearing.**
   The registry field stays (a future RFC could make it real, and a
   directly-registered agent may still set it), but the host reads the
   **profile** as the activation source of truth. Effective rule:

   ```
   deep ⇔ profile.capabilities includes 'deep-investigation'
          OR manifest.investigationDepth === 'deep'   (vestigial; test-only today)
   ```

   The OR keeps ADR 0089's 8 existing tests meaningful and green rather than
   rewriting history, and costs nothing: no shipped agent can set the manifest
   field.

3. **Keying — `resolveAgentIdentity(...).profileId`, which is already correct
   for both worlds.** Roster-seated agents key by `rosterId`; a bare pack agent
   keys by its `agentId` — `AgentProfile.profileId` is typed exactly that way
   (`types.ts:397-398`: *"the owning agent's id — `rosterId` (preferred, for
   standing agents) or the definition-level `agentId`"*), and `getAgentProfile`
   (`:129-133`) has **no** `host:`-only guard. (The `host:`-only guard at `:147` is
   `resolveAgentToolPermissions`' own choice, not a property of profiles — a
   correction found during this review, which had been recorded as a blocker
   against this option.) `activateAgentCapability` creates a minimal profile when
   none exists, so a pack agent needs no roster seat to be granted the
   capability.

> **Phase-1 review corrections (2026-07-15)** — two design details below were
> refined when the concrete code was reviewed, recorded here rather than silently
> changed: (a) §1's predicate stays **sync + pure** with a `deepActivated`
> param — the profile read lives at the single call site next to the XCH-GRP-3
> budget read, so both I/O steps of the deep decision are visible together
> instead of one hiding inside a predicate; (b) §2's OR is evaluated
> **profile-first, manifest-second** (the draft had it reversed to short-circuit
> I/O on the test-only path) — otherwise a manifest-deep agent could never be
> DEACTIVATED via the profile, a governance hole the moment a future RFC makes
> the manifest field real. Also confirmed: the capability read fails **CLOSED**
> while the budget read fails **OPEN** — deliberately asymmetric, both serving
> one principle (on uncertainty, prefer the cheaper outcome that still answers
> the user); the code says so at both sites.

4. **Authz — TENANT-OWNER**, i.e. `agentProfile`'s existing `requireOwnedAgent`
   gate (`routes/agentProfile.ts:50`). Deliberately **not** ADR 0104's
   superadmin gate: 0104 is superadmin because *granting an agent new tools* is a
   platform-trust decision, and **deep investigation grants no new tools** — the
   agent already has them; only the DISPATCH SHAPE changes (a nested persisted
   run vs an inline turn). What it actually changes is cost (~15× tokens, **on
   the tenant's own BYOK key**) and UX (a run bubble). Spend on your own key,
   already bounded by the XCH-GRP-3 per-room budget, is a tenant decision.

5. **Default OFF, per (tenant, named agent). No platform-global row.** A 15×
   path must be electively adopted. `profile.capabilities` has no global row *by
   construction*, so this ADR **sidesteps ADR 0104's unresolved open question**
   (per-tenant vs a `tenantId:'*'` platform default) rather than inheriting it.

6. **Read the identity the exchange ALREADY resolves — do not add a scan.**
   `composeChatContext` resolves the agent identity internally
   (`chatContext.ts:136` — `resolveAgentIdentity(…, { allowReverseScan: true })`)
   and **discards it** (`ComposedChatContext`, `:70-85`, returns
   `{systemPrompt, agent, tenantOk, meta, degraded}`). Surface `identity` on
   `ComposedChatContext` and read `profileId` at the seam. This **removes** a
   redundant resolution rather than adding one, and honors
   `agentIdentity.ts:26-29` (*"callers on per-turn hot paths must not request"* a
   reverse scan) — the path already pays for it exactly once.

7. **Fix the latent `exchangeModelOverride` bug in the same phase that makes it
   reachable.** `conversationDeepInvestigationEligible` (`:110-112`) judges
   eligibility via `conversationToolTurnEligible(run, agent)` **without** the
   per-exchange override, while the inline `toolAgent` resolution passes it
   (`:260`) and the dispatch reads provider/model **raw from `run.inputs`**
   (`:300`) — so eligibility can be decided against a different provider than
   the run dispatches on. Unreachable today; live the moment this ADR lands.
   Shipping activation without this fix would ship a known defect into a newly
   live path.

## Alternatives weighed

| Option | Verdict |
|---|---|
| **A — a new `(tenant, agentId)` override store** (ADR 0104-shaped: own `DurableCollection`, superadmin routes, own audit) | **Rejected — boundary violation.** A second store for the identical concept ("activate a capability on this agent") standing beside a *documented* seam (`ARCHITECTURE.md:127`). "Same pattern, legitimately reused" is the argument every parallel system makes. |
| **A′ — extend ADR 0104's existing `agent-toolallowlist-override` record** with an `investigationDepth?` field | **Rejected.** Conflates "which tools" (a set, full-replace) with "dispatch shape" (a flag), and imports `upsertAgentProfile`'s preserve-list trap that Option B does *not* have (`activateAgentCapability` merges field-preserving). |
| **C — hybrid** (profile for roster agents, an override store for pack agents) | **Rejected.** Two mechanisms for one concept ⇒ guaranteed drift. Moot anyway: the pack-agent gap it existed to patch is not real (§3). |
| **RFC — add `investigationDepth` to the spec agent-manifest** | **Not now.** Legitimate and possibly right long-term (a pack shipping a research agent that is deep *by default* is a real want), but it is an OpenWOP RFC reaching `Accepted` first, not host work. This ADR does not foreclose it — §2's OR keeps the manifest road open. |
| **A feature toggle** | **Rejected — wrong granularity.** `ToggleSubject` is `{tenantId, userId}` (`featureToggles/types.ts:77-80`); there is no agent dimension. A per-agent flag would need one toggle id per agent, i.e. exactly the per-agent KV that `agentProfile` already is, through a system that cannot validate the key. A toggle would only fit a *tenant-wide kill-switch*, which the per-room budget already covers better. |

## Consequences

- **Deep investigation becomes reachable for the first time** — but only where a
  tenant explicitly activates it on a named agent. Nothing changes for anyone
  who doesn't.
- **`AgentCapabilityId` gains its 5th member.** The union is host-internal;
  consumers that switch on it exhaustively are a compile-time find.
- **ADR 0089 Phase 4 can drop its "unreachable" correction note** once this
  lands — the ADR's claim becomes true for the first time.
- **The `deep-research` core pack agent is the obvious first consumer**, and
  needs no pack change: a tenant activates the capability on it directly.
  **Correction (2026-07-15, Phase 1b — this claim was FALSE as written):** there
  was NO surface to activate ANY capability. The profile PUT deliberately does
  not own `capabilities` (they belong to capability activation — see
  `upsertAgentProfile`'s preserve list), and the only writer was
  `ensureAssistantAgent`, a feature-internal bootstrap. So Phase 1a alone would
  have shipped the EXACT "implemented but unreachable" defect this ADR exists to
  cure. Phase 1b builds the missing surface (below). Second correction: the
  election route is roster-gated (`requireOwnedAgent` → `getRosterEntry`), so a
  pack agent is activated **via its roster seat** (`profileId` = `rosterId`) —
  seating it as a named coworker is how a tenant adopts it anyway. An UNSEATED
  pack agent has no election surface; that is a deliberate consequence, not an
  oversight.
- **Residual risk (stated, not eliminated):** a tenant can activate deep
  investigation on an agent and spend 15× tokens per `@mention`. That is the
  point — bounded by the per-room budget (default 5/hour, degrade-to-inline) and
  their own BYOK cap (ADR 0178). We are not adding a second spend gate.

## Phases

| Phase | Work | Gate |
|---|---|---|
| **1 — activation** | ✅ **implemented 2026-07-15** — `'deep-investigation'` in `AgentCapabilityId`; `identity` surfaced on `ComposedChatContext` (reusing the resolution `composeChatContext` already did, so NO second reverse scan); `conversationDeepInvestigationEligible` kept **sync + pure** with a `deepActivated` param (the profile read sits at the ONE call site beside the budget read); dispatch resolves the nested run's model via `resolveConversationModelTarget`. | `conversation-deep-investigation.test.ts` 19 green (was 8): the ADR 0089 truth table re-pinned with `deepActivated:false` (proving the vestigial path), 4 new capability cases, activation round-trip via the REAL `activateAgentCapability`, tenant-scoping, and the override pinned at the dispatch boundary. Sabotage-verified: disabling the capability read fails 2 tests. |
| **1b — the election surface** (found by the Phase-1 `/ux-review`) | ✅ **implemented 2026-07-15** — `PUT/DELETE /v1/host/openwop-app/agents/:id/capabilities/:capabilityId` on the agentProfile host-ext (a SEPARATE surface from the profile PUT, so the governance editor still doesn't own capabilities), gated by the sibling `requireOwnedAgent` (tenant-owner, 404 fail-closed). Closed-world via a new **`TENANT_ELECTABLE_CAPABILITIES`** allowlist (`['deep-investigation']`) — everything else stays FEATURE-owned, because a tenant hand-activating `'assistant'` would give `findAssistantAgent` a second holder and break `ensureAssistantAgent`'s invariant. New `deactivateAgentCapability`: a grant that cannot be revoked is a governance defect (ADR 0104's own "additive could not revoke" reasoning). | `agent-profile.test.ts` 19 green — round-trip elect/idempotent/revoke, **`'assistant'` refused** (sabotage-verified: widening the allowlist fails it), unknown capability 404 (never 403 — a 403 would confirm the name), cross-tenant elect+revoke 404, unknown agent 404. |
| **2 — honesty sweep** | ✅ **implemented 2026-07-15** — ADR 0089 Phase 4's "unreachable" note corrected forward (not deleted — the reasoning trail is the point); `XCH-GRP-3b` closed in `docs/steward/LLM-EXCHANGE-AUDIT.md`. FEATURES.md: no row — the capability has no toggle and no UI surface (Phase 3). | Docs only. |
| **3 — deferred, NOT in scope** | ADR 0089's FE "Run as investigation" per-turn toggle (a *different, larger* concept: a per-turn override, not a per-agent capability). A platform-global default. A spec RFC for manifest-declared deep agents. | — |

## Open questions

1. **Should activation also require the agent to be roster-seated?** Not
   proposed (a bare pack agent can hold a profile), but a tenant granting a
   capability to a *global pack agent id* creates a per-tenant profile row for a
   non-standing agent — slightly novel. Believed fine; flagged for the reviewer.
2. ~~**Does any consumer switch exhaustively on `AgentCapabilityId`?**~~
   **Answered during review: no.** Every consumer is a membership check
   (`features/assistant/capability.ts:55,98` — `profile?.capabilities?.includes(...)`);
   there is no `switch` on the union anywhere in `backend/typescript/src`. Adding
   a 5th member cannot fail open.
3. **Should the vestigial manifest OR (§2) be removed once an RFC lands?** Yes,
   if the field ever becomes spec-real — noted so the OR doesn't calcify.

## RFC gate

**No RFC required.** Everything here is host-extension: a host-internal type
member, a host-internal profile field already served by
`/v1/host/openwop-app/agents/:id/profile` (non-normative), two new
**non-normative** host-ext routes (`PUT`/`DELETE
/v1/host/openwop-app/agents/:id/capabilities/:capabilityId` — Phase 1b), and a
host-internal dispatch decision. `projectAgentManifest` (`routes/packs.ts:38`) continues to
advertise exactly the pack-declared manifest — **the wire is untouched, and the
spec schema stays authoritative over what a manifest may contain.** The
alternative that *would* need an RFC (manifest-declared `investigationDepth`) is
explicitly out of scope above.

## See also

- ADR 0089 §Phase 4 + its 2026-07-15 correction note — the dispatch branch
- ADR 0031 — `agentProfile` / `AgentProfile.capabilities` (the seam)
- ADR 0104 — the superadmin tool-allowlist override (the precedent **not**
  followed here, and why)
- ADR 0315 — the default-on tool baseline; ADR 0178 — the BYOK spend cap
- `docs/steward/LLM-EXCHANGE-AUDIT.md` — `XCH-GRP-3` (the shipped guardrail, PR #1868) and
  `XCH-GRP-3b` (this ADR); PR #1865 — the industry research behind the ruling
