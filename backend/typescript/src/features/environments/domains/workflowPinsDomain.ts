/**
 * `workflow-pins` config domain (ADR 0479) — captures/restores a tenant's
 * workflow PUBLISH PINS (`ownership.publishedRevision`, the ADR 0474 handle
 * read by `resolveLaunchWorkflow` at every production launch). This is the
 * v2 contributor ADR 0387 §D2 reserved ("register the domain contributor in
 * v2 once the store exposes a stable version handle").
 *
 * Determinism: the payload is a MAP `{ [workflowId]: revisionHash }` —
 * published workflows only (a transient draft or never-published workflow is
 * not pinnable state).
 *
 * Restore is APPLY-ONLY, never clear-omitted (ADR 0479 §3, the /architect
 * ruling): a workflow absent from the snapshot keeps its live pin — clearing
 * would flip its production launches back to HEAD, the exact class ADR 0474
 * closed. Drift detection is the honesty surface for the divergence. This
 * follows the `publishPointersDomain` production-pointer register, NOT the
 * `featureTogglesDomain` exact-match register (see configDomains.ts).
 *
 * Per-item failures are AGGREGATED AND NAMED, never swallowed (ADR 0479 §4):
 * a silently-unapplied pin means production runs the WRONG revision after a
 * "green" promote. Unknown/foreign workflows and pruned/unknown revisions
 * throw one error listing the failed workflowIds, surfacing through
 * `applyToLive`'s per-domain 409. Point writes are idempotent — retry-safe.
 */
import type { ConfigDomain, ConfigDomainDiff } from '../../../host/configDomains.js';
import { listOwned, getOwned, setPublishedRevision, isAuthoredByOtherTenant } from '../../../host/workflowOwnership.js';
import { getRevision } from '../../../host/workflowRevisions.js';
import { workflowRoomLive } from '../../../host/collab/workflowCollabResource.js';

type PinPayload = Record<string, string>;

const HASH_RE = /^[0-9a-f]{16,128}$/;

/** Split raw payload into valid entries + NAMED rejects (code-review M2 —
 *  silently dropping a corrupted entry would green an apply that skipped a
 *  pin; payloads only ever come from this domain's own export, so a
 *  malformed value means corruption or a format change: exactly when a
 *  silent green is most dangerous). diff() uses the valid half only. */
function splitPayload(raw: unknown): { valid: PinPayload; malformed: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: {}, malformed: [] };
  const valid: PinPayload = {};
  const malformed: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && HASH_RE.test(v)) valid[k] = v;
    else malformed.push(`${k} (malformed revision reference)`);
  }
  return { valid, malformed };
}

function asPayload(raw: unknown): PinPayload {
  return splitPayload(raw).valid;
}

export const workflowPinsDomain: ConfigDomain = {
  id: 'workflow-pins',
  label: 'Published workflow pins',
  restore: 'apply-only',

  async export(tenantId) {
    const out: PinPayload = {};
    for (const row of await listOwned(tenantId)) {
      if (row.publishedRevision) out[row.workflowId] = row.publishedRevision;
    }
    return out;
  },

  async import(tenantId, payload) {
    const { valid: target, malformed } = splitPayload(payload);
    const failed: string[] = [...malformed];
    for (const [workflowId, revisionHash] of Object.entries(target)) {
      try {
        const owned = await getOwned(tenantId, workflowId);
        if (!owned) {
          // Code-review M1 — gone-vs-foreign split: a workflow the TENANT
          // deleted since the snapshot is skipped (the publishPointers
          // lifecycle precedent — drift reports it; failing forever would
          // brick every older snapshot). A workflow another tenant owns is a
          // NAMED failure (never silently half-true).
          if (await isAuthoredByOtherTenant(tenantId, workflowId)) {
            failed.push(`${workflowId} (owned by another workspace)`);
          }
          continue;
        }
        if (owned.publishedRevision === revisionHash) continue; // already matching
        // ADR 0482 grade-fix H2 — a workflow in a LIVE collab room has the
        // room as its head's only writer (the D2 lock); the room's derive
        // calls recordOwnership, which races this pin write. Refuse the pin
        // for a roomed workflow (named, retryable after the session) rather
        // than a green apply the derive can silently clobber.
        if (await workflowRoomLive(workflowId)) {
          failed.push(`${workflowId} (in a live collaboration session — apply again after it ends)`);
          continue;
        }
        // The revision row must still exist AND belong to this tenant
        // (code-review H2 — resolveLaunchWorkflow checks tenancy and silently
        // falls back to HEAD on mismatch, so a foreign-tenant revision row
        // passing here would produce a green apply that launches head).
        const revision = await getRevision(workflowId, revisionHash);
        if (!revision || revision.tenantId !== tenantId) {
          failed.push(`${workflowId} (revision ${revisionHash.slice(0, 12)}… is not available to this workspace — take a newer snapshot)`);
          continue;
        }
        if (!(await setPublishedRevision(tenantId, workflowId, revisionHash))) {
          failed.push(`${workflowId} (concurrent edits kept winning — retry the apply)`);
        }
      } catch (err) {
        failed.push(`${workflowId} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`workflow pins not applied: ${failed.join('; ')}`);
    }
  },

  diff(from, to): ConfigDomainDiff {
    const a = asPayload(from);
    const b = asPayload(to);
    let added = 0;
    let changed = 0;
    let removed = 0;
    for (const [k, v] of Object.entries(b)) {
      if (!(k in a)) added += 1;
      else if (a[k] !== v) changed += 1;
    }
    for (const k of Object.keys(a)) {
      if (!(k in b)) removed += 1;
    }
    return { added, changed, removed };
  },
};
