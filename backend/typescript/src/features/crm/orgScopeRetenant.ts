/**
 * ADR 0508 fold-in (B3) — re-tenant the CRM rows the shared-workspace defect misfiled.
 *
 * WHY THIS EXISTS, AND WHY ADR 0508 SAID IT DID NOT NEED TO.
 *
 * ADR 0508 §"Is there existing bad data" concluded "no migration", on this premise:
 * *"bad data would need a handler writing `user.tenantId` while authorized in `ws:`,
 * which the 404 prevents."* Phase 1 was inert by construction, so at the time that
 * held. **Phase 2 removed the 404** — `requireOrgScope` now authorizes against the
 * ACTIVE tenant — and CRM's 95 gate-bound handlers were still re-deriving
 * `ctx.user.tenantId` for the whole window between the two phases. That is exactly
 * the state the premise called impossible: authorized in `ws:`, writing to HOME.
 * Every create in a shared workspace filed a row tagged with the caller's personal
 * tenant while carrying an `orgId` owned by the workspace.
 *
 * Those rows are not merely invisible. After the CRM fix they are UNREACHABLE BY
 * EVERY PATH: reads go to the `ws:` partition, the home-tenant copy fails the org
 * gate, and — because every reclaim path (`ws:` teardown, the CRM retention purger,
 * the new `eraseCrmSubject`) enumerates via `listForTenantIndexed(tenantId)` — they
 * escape deletion, retention AND erasure. Undeletable CRM PII in the wrong partition
 * is a compliance problem, not a cosmetic one.
 *
 * THE MATCH IS DELIBERATELY NARROW. A row moves only when ALL of these hold:
 *
 *   1. it carries BOTH a non-empty string `tenantId` and a non-empty string `orgId`
 *      (a tenant-scoped CRM row — a contact, a segment — has no `orgId` and is never
 *      a candidate);
 *   2. its `orgId` RESOLVES to an org that actually exists (never guess at a
 *      dangling reference — an unresolvable orgId is left exactly where it is);
 *   3. that org is owned by a DIFFERENT tenant than the row claims; and
 *   4. the row's own tenant is NOT itself a `ws:` workspace tenant. A row already
 *      sitting in a shared workspace is never moved by this migration, whatever its
 *      org says — the defect only ever wrote in the HOME direction, and refusing the
 *      reverse is what makes an accidental mass-move impossible.
 *
 * A legitimately home-tenanted row whose org is owned by that same home tenant fails
 * (3) and stays put. That decoy is asserted in the test, not just described here.
 *
 * SAFETY PROPERTIES.
 *  - **Per-row CAS.** Each rewrite is a `kvCompareAndSwap` against the exact bytes
 *    read. A row a live instance changed underneath us loses the swap and is counted,
 *    never clobbered. (`runAppMigrations` has no lock and every instance in a rolling
 *    deploy runs this concurrently — see `host/appMigrations.ts`.)
 *  - **Idempotent.** After a move the row fails condition (3), so a second or
 *    concurrent execution is a no-op.
 *  - **Never fatal to boot.** Every per-row failure is caught and counted.
 *    `runAppMigrations` is unguarded and `main()` exits on a throw: a migration that
 *    turns a data problem into an outage is strictly worse than the data problem
 *    (the lesson recorded on APP_MIGRATION 16's invariant 4).
 *  - **The tenant secondary index moves with the row.** A `hostextidx:` marker is
 *    keyed by tenant, and `listForTenantIndexed` does NOT re-filter on the row's
 *    tenant — it returns whatever the marker points at. So a value-only rewrite would
 *    leave the OLD tenant still reading the row through a stale marker: the defect
 *    would survive its own repair. The marker is deleted from the old slice and
 *    written into the new one, after the CAS wins.
 *
 * WHAT THIS DOES NOT COVER, STATED RATHER THAN IMPLIED. Companies and deals moved
 * into the content kernel (APP_MIGRATIONS 10/11), where the primary key is
 * `${typeId}|${entityId}` and `typeId` EMBEDS the tenant. Re-tenanting one is a full
 * re-key across `entity:record`, `entity:type`, `entity:count`, `entity:ref-idx` and
 * `entity:term-idx` — a different, much larger migration that needs its own ADR. This
 * one COUNTS them (`kernelResidue`) and logs a warning naming the count, so the
 * residue is a number an operator can see rather than a silence. The legacy read-dark
 * `crm:company` / `crm:deal` rows ARE swept, because they are ordinary host-ext rows.
 */

import type { Storage } from '../../storage/storage.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.crm.orgScopeRetenant');

/**
 * The CRM host-ext namespaces this migration sweeps: every collection whose PRIMARY
 * KEY is a plain entity id with no tenant component, so a re-tenant is a value
 * rewrite plus a marker move and never a re-key.
 *
 * Deliberately EXCLUDED because their key embeds the tenant (a move would be a
 * re-key, and none of them is org-scoped anyway): `crm:gmailsync`
 * (`${tenantId}:${syncId}`), `crm:suppression` (`${tenantId}::${email}`),
 * `crm:suppression-count`, `cdp:contact-ident`, and `crm:contactkeyclaim`
 * (`${tenantId}::email::<address>` — ADR 0627 D6; it is tenant-scoped like the
 * contact it guards, so it has no org to re-tenant by).
 *
 * Namespaces that turn out to hold no `orgId` (contacts, segments) are harmless to
 * list: every row fails condition (1) and is counted as `skippedNoOrg`. Listing them
 * is the safer error — a missing namespace is a silent orphan, a spurious one is a
 * counter.
 */
const CRM_NAMESPACES: readonly string[] = [
  'crm:pipeline',
  'crm:company',
  'crm:deal',
  'crm:stagehistory',
  'crm:task',
  'crm:activity',
  'crm:fielddef',
  'crm:snapshot',
  'crm:booking-link',
  'crm:booking-link-slug',
  'crm:booking',
  'crm:sign-request',
  'crm:signature-record',
  'crm:companykeyclaim',
  'crm:dealkeyclaim',
  'crm:company-merge-event',
  'crm:merge-event',
  'crm:segment',
  'crm:contact',
];

export interface CrmRetenantResult {
  /** Rows read across every swept namespace. */
  examined: number;
  /** Rows whose `tenantId` was rewritten to their org's owning tenant. */
  rewritten: number;
  /** Not org-scoped (no string `orgId`) — a contact, a segment, a tenant-scoped row. */
  skippedNoOrg: number;
  /** `orgId` names an org this host cannot find — never guessed at. */
  skippedOrgMissing: number;
  /** Already correct: the row's tenant owns its org. */
  skippedCorrect: number;
  /** The row already sits in a `ws:` workspace tenant — never moved (condition 4). */
  skippedWorkspaceTenant: number;
  /** A concurrent writer won the CAS; the row is left to the next deploy's sweep. */
  casLost: number;
  /** A per-row error (unparseable JSON, a storage failure). Never fatal. */
  failed: number;
  /** Content-kernel company/deal rows that ARE misfiled but are out of scope here. */
  kernelResidue: number;
  /** Per-namespace rewrite counts, for the operator log. */
  byNamespace: Record<string, number>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** `orgId → owning tenantId`, read from `access-orgs` (the authoritative store —
 *  `Organization.tenantId` is the owning tenant). Built once for the whole sweep. */
async function orgOwners(storage: Storage): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { value } of await storage.kvList('hostext:access-orgs:')) {
    try {
      const org = JSON.parse(value) as unknown;
      if (!isRecord(org)) continue;
      const orgId = str(org.orgId);
      const tenantId = str(org.tenantId);
      if (orgId && tenantId) out.set(orgId, tenantId);
    } catch { /* an unparseable org row cannot authorize a move — skip it */ }
  }
  return out;
}

/** Count (never move) the kernel-backed company/deal rows carrying the same defect,
 *  so the uncovered residue is an operator-visible number. Read-only. */
async function countKernelResidue(storage: Storage, owners: ReadonlyMap<string, string>): Promise<number> {
  let residue = 0;
  for (const { value } of await storage.kvList('hostext:entity:record:')) {
    try {
      const row = JSON.parse(value) as unknown;
      if (!isRecord(row)) continue;
      const tenantId = str(row.tenantId);
      if (!tenantId || tenantId.startsWith('ws:')) continue;
      const values = isRecord(row.values) ? row.values : null;
      const orgId = values ? str(values.org_id) : null;
      if (!orgId) continue;
      const owner = owners.get(orgId);
      if (owner && owner !== tenantId) residue += 1;
    } catch { /* unparseable — not countable either way */ }
  }
  return residue;
}

/**
 * Sweep the CRM namespaces and re-tenant every row that matches all four conditions
 * in the file header. Returns the full accounting; never throws.
 */
export async function retenantMisfiledCrmRows(storage: Storage): Promise<CrmRetenantResult> {
  const r: CrmRetenantResult = {
    examined: 0, rewritten: 0, skippedNoOrg: 0, skippedOrgMissing: 0, skippedCorrect: 0,
    skippedWorkspaceTenant: 0, casLost: 0, failed: 0, kernelResidue: 0, byNamespace: {},
  };
  const owners = await orgOwners(storage);
  if (owners.size === 0) return r; // no orgs ⇒ nothing can be adjudicated (a fresh install)

  for (const ns of CRM_NAMESPACES) {
    const prefix = `hostext:${ns}:`;
    let rows: ReadonlyArray<{ key: string; value: string }>;
    try {
      rows = await storage.kvList(prefix);
    } catch (err) {
      r.failed += 1;
      log.warn('crm_retenant_namespace_unreadable', { ns, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const { key, value } of rows) {
      r.examined += 1;
      try {
        // Bounded CAS retry. A losing swap means a live instance rewrote the row
        // between our read and our write; re-read and RE-ADJUDICATE (the new bytes
        // may no longer match at all). This migration is ONE-SHOT, so a row it gives
        // up on stays misfiled until someone ships a follow-up sweep — which is why
        // it retries rather than counting the first loss and moving on.
        let raw: string | null = value;
        let outcome: 'moved' | 'noOrg' | 'orgMissing' | 'correct' | 'wsTenant' | 'casLost' = 'casLost';
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (raw === null) { outcome = 'casLost'; break; } // deleted underneath us
          const row = JSON.parse(raw) as unknown;
          if (!isRecord(row)) throw new Error('row is not a JSON object');
          const tenantId = str(row.tenantId);
          const orgId = str(row.orgId);
          if (!tenantId || !orgId) { outcome = 'noOrg'; break; }
          if (tenantId.startsWith('ws:')) { outcome = 'wsTenant'; break; }
          const owner = owners.get(orgId);
          if (!owner) { outcome = 'orgMissing'; break; }
          if (owner === tenantId) { outcome = 'correct'; break; }

          const swap = await storage.kvCompareAndSwap(key, raw, JSON.stringify({ ...row, tenantId: owner }));
          if (!swap.swapped) { raw = swap.actual; continue; }

          // Move the tenant secondary-index marker with the row.
          // `listForTenantIndexed` trusts the marker slice and does NOT re-filter on
          // the row's tenant, so a surviving marker in the OLD slice would keep the
          // old tenant reading a row it no longer owns — the defect surviving its
          // own repair.
          const id = key.slice(prefix.length);
          await storage.kvDelete(`hostextidx:${ns}:${tenantId}:${id}`).catch(() => false);
          await storage.kvSet(`hostextidx:${ns}:${owner}:${id}`, id).catch(() => undefined);
          outcome = 'moved';
          break;
        }
        if (outcome === 'moved') { r.rewritten += 1; r.byNamespace[ns] = (r.byNamespace[ns] ?? 0) + 1; }
        else if (outcome === 'noOrg') r.skippedNoOrg += 1;
        else if (outcome === 'orgMissing') r.skippedOrgMissing += 1;
        else if (outcome === 'correct') r.skippedCorrect += 1;
        else if (outcome === 'wsTenant') r.skippedWorkspaceTenant += 1;
        else r.casLost += 1;
      } catch (err) {
        r.failed += 1;
        log.warn('crm_retenant_row_failed', { ns, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  try {
    r.kernelResidue = await countKernelResidue(storage, owners);
  } catch { /* observability only — never fail the migration for a count */ }
  return r;
}
