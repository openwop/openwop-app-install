# ADR 1161 — Org-deleted hooks: a feature's per-org rows go with the org

Status: Accepted (2026-11-25). Implemented in the PR that carries this ADR.

`deleteOrg` runs registered `onOrgDeleted` hooks after it deletes the org, so a
feature's per-org rows that carry no `orgId` field are removed with it. A failed
hook is logged and audited, never blocks the delete, and is retried by the
default-window sweep. Host-extension only: no RFC.

## Context

`deleteOrg` (`host/accessControlService.ts`) refuses while the org still holds
business rows (grade-data RI-7 / DG-INT-5). It counts them with
`countOrgHostExtRows`, which sees only rows that carry an `orgId`. Then it
deletes the access-control scaffolding: teams, members, groups, roles, and the
org.

A store keyed per org WITHOUT that field is invisible to both. CasaVoga's
dashboards keep a working calendar keyed by a hash of tenant and org (CasaVoga
data gap 12). That row survives the org's deletion as an orphan nothing can
reach or clean. Tenant teardown has `purgeTenantHostExt`; org deletion had no
hook. ADR 0815 D4's `onMemberAuthorityLost` is the precedent for a host seam
features register a cascade on.

## Decision

### D1 — `onOrgDeleted(id, hook)`

A registry keyed by id: a repeated boot registration is ignored. A hook receives
`{ tenantId, orgId }` and returns how many rows it removed (logged when more
than zero).

- **Contract:** idempotent (it may run again for the same org), per-org only.
- **Scope:** a hook is for a feature's OWN derived or configuration rows.
  Business content carries `orgId`, so the guard keeps refusing to delete an org
  that still holds it. A hook is not a way around that refusal.

### D2 — ordering: the org first, then the hooks

The hooks run after `orgs.delete(orgId)`. A hook that fails then leaves
unreachable rows, which D4 retries. The other order would leave a live org with
half its data gone, and nothing could later tell that state from a deliberate
one. A refused delete (D1's guard) runs no hook.

### D3 — a hook failure is logged and audited, and never blocks

Each hook runs in its own try:
- **On failure:** `org_deleted_hook_failed` is logged with the error, and a
  `governance.decision` audit row records `org.deleted.hook-failed` with ids only
  (`orgId`, `hook`, `attempts`). The error text stays out: the audit chain is
  DSAR-exempt.
- **Never blocking:** a throw stops neither the next hook nor the delete, and it
  never reverses the delete.

### D4 — the retention sweep retries what a hook missed

A failure is kept as a retry row (`access-org-deleted-retry`; ids and counts
only, tenant-indexed, so tenant teardown removes it). The retention daemon's
default-on tick (`registerDefaultWindowSweep`, ADR 0951 D3) re-runs only the
failed hook for that org:
- **on success**, it deletes the row;
- **after `ORG_DELETED_HOOK_MAX_ATTEMPTS` (10)**, it marks the row `gaveUp` and
  audits `org.deleted.hook-gave-up`, and the operator reads it from the log and
  the chain.

The sweep skips a tenant under legal hold, a hook no longer registered, and an
org id that exists again.

This is the answer to "should the retention sweep catch rows a hook misses": yes,
and through the hook that owns them. A generic sweep cannot know a feature's
keying. That keying is exactly why this seam exists.

## Alternatives weighed

1. **Require every per-org row to carry `orgId`.** This is right for business
   content (D1 keeps that rule), but a derived row keyed by a hash has no reason
   to carry it, and a migration of every adopter store is not the host's to
   force.
2. **Hooks before the delete, and a failure blocks it.** A transient store error
   would then make an org undeletable, and the user would have no lever.
3. **A count callback that joins the guard.** This would turn configuration rows
   into "business rows" that block deletion. That is wrong for a calendar the
   user never sees as content.

## Tests

`src/host/__tests__/orgDeletedHooks.test.ts` covers:
- the hooks run after the org is gone;
- a throwing hook stops neither the next hook nor the delete, and is audited
  without its error text;
- the sweep re-runs only the failed hook, clears it on success, and gives up at
  the cap;
- one id registered twice runs once;
- a refused delete runs no hook.

## Open questions

- None for the host. CasaVoga registers its working-calendar hook at its next
  sync.
