# ADR 0031 — Rich `agentProfile` host-extension + seed-all-properties for work-twin agents

**Status:** implemented
**Date:** 2026-06-13
**Depends on:** ADR 0001 (feature-package architecture), ADR 0023 (assistant /
Chief-of-Staff roster agent), ADR 0025 (user/agent orchestration symmetry —
roster, personal boards, schedules), ADR 0024 (Connections — `requiredConnections`
resolves against it). Reuses the existing seed path (`host/seedEverything.ts`,
`host/exampleDataSeed.ts`, `host/exampleDataSeeders.ts`) and `DurableCollection`.
**Sibling decisions:** ADR 0032 (which twins are seeded), ADR 0033 (connector
reachability / `requiredConnections` activation gating).
**Surface:** host-internal product config under `/v1/host/openwop-app/agents/:id/profile`.
**NON-NORMATIVE — no OpenWOP RFC.** This adds host-local product configuration; it
does **not** touch the RFC 0003 agent manifest wire shape or any `/v1` contract.

## Why this exists

The "Enterprise Digital Work Twin" initiative (`~/Downloads/new_agents.md`) seeds
ten governed role-based agents. Each agent's spec sheet enumerates far more
properties than the app can persist today:

- **`UserAgentRecord`** (`backend/typescript/src/types.ts` ~L290) holds only:
  `persona, label, description, modelClass, systemPrompt, toolAllowlist,
  memoryShape, confidenceThreshold`.
- **`RosterEntry`** (`backend/typescript/src/host/rosterService.ts` ~L45) adds:
  `autonomyLevel (auto|guided|review), workflows[], heartbeatIntervalMs,
  roleKey`.
- The **seed entry schema** in `host/seed-data/exampleAgents.json` carries only:
  `persona, role, roleKey, description, systemPrompt, modelClass, autonomyLevel,
  cards, schedules, department`.

None of these can hold the spec's: configuration parameters, permissions /
access controls, human-in-the-loop requirements, escalation rules, channel
preferences, admin controls, risk/compliance notes, required integrations,
analytics/success metrics, or the spec's **four-level** autonomy model. The user
requirement is explicit: "make sure that we also have the ability to seed all of
the agents' properties." Today we cannot.

The architecture review (2026-06-13) recorded this as the central data-model gap
and warned (ARCHITECTURE.md) against cramming these onto a parallel store or
forking the normative manifest.

## Decision

Introduce an **`agentProfile`** object: a host-extension, non-normative record
attached to an agent, that carries the full enterprise property set.

1. **Persistence.** A new `DurableCollection<AgentProfile>('agent-profile',
   p => p.profileId)`, tenant-scoped, keyed by the owning `rosterId` (standing
   agents) or `agentId` (definition-level). It rides the existing `Storage` /
   `DurableCollection` seam — **no new database, table family, or store**.
2. **Routes.** `GET /v1/host/openwop-app/agents/:id/profile` and
   `PUT /v1/host/openwop-app/agents/:id/profile`, backend-gated by the same
   tenant/RBAC rules the existing agent routes enforce. These are vendor-prefixed
   host-extension routes per `spec/v1/host-extensions.md`.
3. **Explicitly NOT** new fields on the RFC 0003 agent manifest. Per
   ARCHITECTURE.md "Do not fork the protocol in this app," product config that no
   OpenWOP client needs stays host-local under `/v1/host/openwop-app/*`. Therefore
   **no OpenWOP RFC is required.** `GET /v1/agents` keeps returning the normative
   manifest projection unchanged; the profile is a separate, additive read.
4. **Seed schema.** Extend the `exampleAgents.json` entry to carry an optional
   `profile` block (shape below). The existing seed path persists it; the entry
   schema stays backward-compatible (absent `profile` = today's behavior).

### `AgentProfile` shape (typed)

> **Extension (T2.C, 2026-06-13) — `capabilities`.** The profile is the
> **activation surface** for **core agent capabilities** (David's law: capabilities
> live at the core-agent level, activated per named agent — never hardcoded to a
> `roleKey`). `capabilities?: AgentCapabilityId[]` (`AgentCapabilityId = 'assistant'`
> today, an extensible union). The `assistant` capability — the operating-rhythm
> memory-graph + perception loops + action drafting/approval — is now activated by
> setting `capabilities: ['assistant']` (e.g. on Iris and Executive Operations),
> and the assistant runtime resolves the acting agent by this flag, not by
> `roleKey 'chief-of-staff'`. See the ADR 0023 correction note +
> `features/assistant/capability.ts`.


```ts
interface AgentProfile {
  profileId: string;            // = rosterId (preferred) or agentId
  tenantId: string;
  roleKey: string;              // e.g. 'finance-close'
  capabilities?: AgentCapabilityId[]; // core capabilities ACTIVATED on this agent (T2.C, 2026-06-13)
  department?: { departmentId: string; name: string; roleId?: string; roleName?: string };
  configParameters?: Record<string, unknown>;   // free-form, per-twin (thresholds, calendars, matrices)
  permissions?: { read: string[]; write: string[]; never: string[] };
  hitl?: string[];              // action types that always require approval
  escalation?: { contacts: string[]; triggers: string[] };
  channels?: { approval?: string; delivery?: string };
  adminControls?: string[];
  riskCompliance?: string[];
  requiredConnections?: string[]; // Connections provider ids; gates activation (ADR 0033)
  metrics?: string[];           // success/analytics metric keys
  autonomy: {
    level: 'auto' | 'guided' | 'review';        // the enforced roster level
    specLevel: 'draft-only' | 'recommend' | 'execute-with-approval' | 'autonomous-within-policy';
    withinPolicyActions?: string[];             // allowlist when level === 'auto'
  };
  createdAt: string;
  updatedAt: string;
}
```

`workflows[]` and `schedules[]` are **not** duplicated here — they remain owned by
`RosterEntry.workflows` and the scheduler (`schedulingService`). The profile
references roles/behavior; the roster and scheduler remain the source of truth for
portfolio and cadence (single-source-of-truth discipline).

### Autonomy mapping (four-level spec → three-level roster)

The spec uses four levels; the roster enforces three. The profile stores both —
`specLevel` for provenance/display, `level` for enforcement:

| Spec `specLevel` | Roster `level` | Enforcement |
|---|---|---|
| draft-only | `review` | every pick queues an approval; tool allowlist excludes all write/send tools |
| recommend | `review` | every pick queues an approval (may stage writes but cannot commit) |
| execute-with-approval | `guided` | routine picks run; HIGH-priority picks queue approval |
| autonomous-within-policy | `auto` | runs immediately, but only `withinPolicyActions` are permitted; anything off-list falls back to `review` |

This makes the spec's "execute autonomously within policy" honest: `auto` is
gated by an explicit allowlist, not blanket autonomy.

### Replay / determinism

`autonomy` and `requiredConnections` are read from the **persisted profile at run
creation** and stamped into run metadata; historical runs replay/fork against the
stamped values and never recompute them. This preserves ADR 0023/0025 replay
discipline.

### Seed-schema diff (`exampleAgents.json` entry)

```jsonc
// before (still valid):
{ "persona": "...", "roleKey": "...", "systemPrompt": "...", "modelClass": "chat",
  "autonomyLevel": "review", "cards": [...], "schedules": [...], "department": {...} }

// after (additive — adds optional "profile"):
{ "persona": "...", "roleKey": "...", "systemPrompt": "...", "modelClass": "chat",
  "autonomyLevel": "review", "cards": [...], "schedules": [...], "department": {...},
  "profile": {
    "configParameters": { "materialityThreshold": 5000 },
    "permissions": { "read": ["erp","docs"], "write": ["tasks","drafts"], "never": ["postJournal"] },
    "hitl": ["journalPosting","paymentInstruction"],
    "escalation": { "contacts": ["controller@"], "triggers": ["missingEvidence"] },
    "channels": { "approval": "slack:#finance-approvals", "delivery": "email" },
    "adminControls": ["sodPolicy","postingDisablement"],
    "riskCompliance": ["SoD","dualReview"],
    "requiredConnections": ["erp","docStorage"],
    "metrics": ["daysToClose","reconPrepTime"],
    "autonomy": { "specLevel": "draft-only" }   // level derived from the mapping table
  }
}
```

Seeding stays **idempotent, marker-gated (`demo:seed-claimed:{tenantId}`), and
heal-able** — the profile is written on the same single creation path
(`createSeededRosterMember` in `exampleDataSeed.ts`); `heal:true` backfills a missing
profile for an existing persona without resurrecting user-deleted agents.

## Alternatives weighed

1. **New fields on the RFC 0003 agent manifest** — rejected: forces an upstream
   OpenWOP RFC for host-local product config no wire client needs; violates
   ARCHITECTURE.md "do not fork the protocol."
2. **Stuff config into `RosterEntry.metadata` / `UserAgentRecord`** — rejected:
   overloads records with unrelated concerns, no typed surface, no clean
   read/write route, harder to test and gate.
3. **Per-feature config tables** — rejected: ten near-identical stores, drift, no
   single profile surface; contradicts single-source-of-truth.

## Extensions

- **ADR 0036** enforces this profile's `permissions.never` / `hitl` /
  `withinPolicyActions` (resolves the day-1 "advisory vs enforced" open question
  below — enforcement now lives in `host/agentPolicyResolver.ts`).
- **ADR 0038** adds an additive optional `AgentProfile.knowledge` field
  (`{ collectionIds?, memoryWritable?, retrieval? }`) and widens
  `AgentCapabilityId` with `'knowledge'` — binding per-agent KB collections + the
  RFC 0004 memory namespace to a profile, activated per agent (core-not-named).
  Pure additive host-ext; no change to the `GET/PUT …/profile` contract shape.

## Implementation plan

| Phase | Work | Gate |
|---|---|---|
| 1a | `AgentProfile` type + `DurableCollection` + service | — |
| 1b | `GET/PUT /v1/host/openwop-app/agents/:id/profile` + route-level tests (createApp + cookie-jar; authz, tenant-isolation, fail-closed) | 1a |
| 1c | Extend `exampleAgents.json` entry schema + seed path to persist `profile` (idempotent/heal) | 1a |
| 1d | FE: profile view/edit in agent workspace + admin surface | 1b |

## Implementation (landed 2026-06-13)

| Phase | PR | Key file |
|---|---|---|
| 1a/1b — `AgentProfile` type, `DurableCollection`, service + `GET/PUT …/profile` routes | [#224](https://github.com/openwop/openwop-app/pull/224) | `backend/typescript/src/host/agentProfileService.ts`, `backend/typescript/src/routes/agentProfile.ts` |
| 1c — persist `profile` on demo seed (idempotent/heal) | [#227](https://github.com/openwop/openwop-app/pull/227) | `backend/typescript/src/host/exampleDataSeed.ts` |
| 1d — FE profile view/edit + admin surface | [#225](https://github.com/openwop/openwop-app/pull/225) | `frontend/react/src/` (agent workspace) |
| T2.C — `capabilities` field; assistant capability → core, profile-activated | [#231](https://github.com/openwop/openwop-app/pull/231) | `backend/typescript/src/features/assistant/capability.ts` |

## Open questions / decisions checklist

- [ ] Should `permissions`/`hitl` be advisory metadata only (day-1) or enforced at
      the tool-policy layer? (Recommend: advisory + displayed day-1; enforcement is
      a follow-on once the tool-policy layer reads them.)
- [ ] Profile keyed by `rosterId` vs `agentId` when both exist — confirm
      `rosterId` precedence for standing agents.
- [ ] Does the FE editor expose `configParameters` as free-form JSON or a
      per-roleKey typed form? (Recommend free-form day-1, typed later.)
- [ ] Migration for tenants already seeded under ADR 0032's persona change — see
      ADR 0032.
