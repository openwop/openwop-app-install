# ADR 0028 — Admin governance for connectors & assistant actions

**Status:** Accepted — **implemented + tested** (`governance.test.ts`; ADR 0023 §12 T7): `host/governanceService.ts` policy store; allowlist enforced with one predicate at the connect routes AND the node-exec resolver; per-kind action policy at the assistant enqueue + dispatch seams; `storage.listAudit` read view + `/v1/host/openwop-app/governance/*` routes (superadmin gate extracted to `host/superadmin.ts`, shared with feature-toggles); Connections-page admin panel. Group-access narrowing and the retention sweep remain follow-on (retention config is stored).

> **Correction (2026-06-11, implementation).** The §"Decision" table sketched
> `draft-only` defaults for the send/invite/reschedule kinds. Implemented
> default is **`approval-required` for every kind**: under a draft-only
> default the Approve button silently does nothing — a UX trap. The
> restrictive postures exist for admins to opt INTO; the human approval claim
> is the default gate (T6).
**Date:** 2026-06-11
**Depends on:** ADR 0024 (Connections + Phase-C RBAC scopes
`host:connections:manage` / `connections:use`), ADR 0006 (RBAC), ADR 0023
(action kinds), ADR 0015 (workspace = tenant).
**Rides (Accepted, no new RFC):** RFC 0064 (tool-invocation hooks — the
enforcement point), RFC 0049 (scopes + `authorization-fail-closed`), RFC 0079
(provenance), RFC 0009/0010 pattern via `storage.appendAudit`.
**Surface:** `/v1/host/openwop-app/governance/*` (admin-gated) — host-extension,
**NON-NORMATIVE — no RFC**.
**Toggle:** rides the existing `connections` + `assistant` toggles; the policy
store is host infrastructure, not a separately bucketed feature.

> **One-line thesis.** Admin policy **configures the enforcement points that
> already exist**; it never becomes a second evaluator. The 2026-06-11 architect
> review's finding: a standalone policy store that node execution doesn't
> consult is advisory — so every rule here lowers into either `toolHooks`
> (RFC 0064, wraps every MCP/HTTP/native invocation, fail-closed) or the
> Connections resolver (ADR 0024 D2), and every observable rides
> `storage.appendAudit` + `agent.toolCalled/toolReturned` + 
> `run.metadata.connectionUse[]` — **no new audit store**.

---

## Decision

One new store, `GovernancePolicy` (a `DurableCollection`, one row per tenant),
edited from an admin page, **compiled into the existing enforcement seams**:

```
GovernancePolicy {
  tenantId,
  providerAllowlist?: string[],        // absent = all registry providers
  actionPolicy: {                      // per ADR 0023 PendingAction kind
    [kind]: 'disabled' | 'draft-only' | 'approval-required'
  },                                   // default: 'approval-required' for nudge,
                                       //   'draft-only' for send/invite/reschedule
  groupAccess?: { [provider]: orgId[] }, // narrows connections:use grants
  retention?: { assistantGraphDays?, sourceDerivedDays? },
  updatedAt, updatedByUserId }
```

### How each rule is enforced (the load-bearing table)

| Rule | Enforced at | Mechanism |
|---|---|---|
| Provider allowlist | **Connections resolver** (`resolveConnectionCredential`) + connect routes | non-allowlisted provider: create/authorize 403s; resolve fails closed — both seams share one predicate so they cannot drift (the `webhookEgressGuard` discipline) |
| Per-action-kind policy | **`toolHooks`** (RFC 0064 pre-hook) | each ADR 0023 action kind maps to its executing tool + a required scope (`assistant:action:<kind>`); `disabled` ⇒ the scope is grantable to no one; `draft-only` ⇒ scope withheld from the dispatch path so execution (T6) refuses pre-resolve; `approval-required` ⇒ scope granted only to the claim-dispatched run |
| Group access | **resolver** (`actingUserHasOrgUse`) | narrows existing `connections:use` evaluation; never widens |
| Write-scope consent separation | **already shipped** (ADR 0024 Phase C `includeWrite`) | the admin page surfaces read-vs-write per connection; no new flow |
| Retention | a daemon sweep (the `refreshDaemon` pattern) | prunes graph entities / source-derived rows past the window; tombstones, never silent cascade to the principal's board cards (ADR 0023 loop-3 rule) |

### Audit surface (read view, not a store)

`GET /v1/host/openwop-app/governance/audit` composes, tenant-scoped + admin-gated:
`appendAudit` rows (`assistant.loop.*`, approval decisions, policy edits — every
policy write itself audited), `agent.toolCalled/toolReturned` events (RFC 0064 —
content-free: `argsHash` is SR-1-redacted-then-hashed), and
`run.metadata.connectionUse[]` (which human used which credential, for what
run). Pagination + time-window filters; no secret material by construction.

## Boundaries audit

| Concept | Single owner |
|---|---|
| Authorization evaluation | **`toolHooks`** (RFC 0064) + **`accessControlService`** (RFC 0049) — configured, not duplicated |
| Credential scoping | **Connections resolver** (ADR 0024 D2) — narrowed, not bypassed |
| Audit persistence | **`storage.appendAudit`** — reused |
| Policy document + admin UI + audit read-view | **NEW — `governance` (this ADR)** — the only new owner |

Route check: no prior registrant on `/v1/host/openwop-app/governance`.

## RFC gate

**Host work — no new RFC.** Policy, RBAC narrowing, and audit views are
host-local under non-normative surfaces; enforcement rides Accepted RFC 0064 /
0049 / 0079 semantics unchanged. Tripwire: advertising a normative
`capabilities.governance` block would need an RFC — deliberately not done.

## Testing (lands with T7)

Route-level (`createApp` + cookie-jar): non-admin policy write → 403; member vs
admin reading audit; allowlist enforcement at BOTH create and resolve seams;
`disabled` action kind refused at the pre-hook (forbidden-before-resolve, ADR
0024 Phase D §1); policy edit appears in its own audit trail.

## Open questions

1. **(Medium) Policy versioning** — keep history rows for "what was policy when
   this action ran"? *v1: the audit row snapshots the decided policy values.*
2. **(Low) Per-group (not per-org) granularity** — wait for a real tenant need.
