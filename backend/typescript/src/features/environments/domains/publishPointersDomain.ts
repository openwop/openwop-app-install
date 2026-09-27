/**
 * `publish-pointers` config domain (ADR 0387 D2) — captures/restores a tenant's
 * FUNNEL publish pointers (which funnel is published/draft/archived). Reads and
 * re-applies through the funnels owner's public seam; environments never touches
 * the funnels store directly.
 *
 * Determinism: the payload is a NESTED MAP `{ [orgId]: { [funnelId]: status } }`
 * — order-normalized by canonical-JSON key-sort, never an array (the
 * configDomains.ts determinism contract).
 *
 * Restore drives every captured funnel to its snapshot status (funnel bodies are
 * NOT snapshotted — only the publish POINTER, ADR 0387 D3). It is fail-soft per
 * funnel: a funnel that can no longer publish (steps removed since the snapshot)
 * is skipped, and the drift detector surfaces the residual mismatch honestly
 * rather than aborting the whole apply.
 *
 * § v2 (recorded): CMS page/locale publish pointers join THIS domain once the
 * cms owner exposes a tenant page-scope enumerator and the ADR 0066 content-
 * approval interaction is designed — the seam grows without touching
 * environments. See docs/adr/0387 correction note.
 */
import type { ConfigDomain, ConfigDomainDiff } from '../../../host/configDomains.js';
import {
  listFunnelScopes,
  listFunnels,
  publishFunnel,
  unpublishFunnel,
  archiveFunnel,
  type FunnelStatus,
} from '../../funnels/funnelsService.js';

type FunnelPointers = Record<string, Record<string, FunnelStatus>>; // orgId → funnelId → status

function asPayload(raw: unknown): FunnelPointers {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: FunnelPointers = {};
  for (const [orgId, funnels] of Object.entries(raw as Record<string, unknown>)) {
    if (!funnels || typeof funnels !== 'object' || Array.isArray(funnels)) continue;
    const inner: Record<string, FunnelStatus> = {};
    for (const [funnelId, status] of Object.entries(funnels as Record<string, unknown>)) {
      if (status === 'draft' || status === 'published' || status === 'archived') inner[funnelId] = status;
    }
    out[orgId] = inner;
  }
  return out;
}

export const publishPointersDomain: ConfigDomain = {
  id: 'publish-pointers',
  label: 'Publish pointers',
  restore: 'apply-only',

  async export(tenantId) {
    const out: FunnelPointers = {};
    for (const scope of await listFunnelScopes()) {
      if (scope.tenantId !== tenantId) continue;
      const funnels = await listFunnels(tenantId, scope.orgId);
      if (funnels.length === 0) continue;
      out[scope.orgId] = Object.fromEntries(funnels.map((f) => [f.funnelId, f.status]));
    }
    return out;
  },

  async import(tenantId, payload) {
    const target = asPayload(payload);
    for (const [orgId, funnels] of Object.entries(target)) {
      const live = await listFunnels(tenantId, orgId);
      const liveById = new Map(live.map((f) => [f.funnelId, f]));
      for (const [funnelId, wantStatus] of Object.entries(funnels)) {
        const current = liveById.get(funnelId);
        if (!current || current.status === wantStatus) continue; // gone or already matching
        try {
          if (wantStatus === 'published') await publishFunnel(tenantId, orgId, funnelId);
          else if (wantStatus === 'archived') await archiveFunnel(tenantId, orgId, funnelId);
          else await unpublishFunnel(tenantId, orgId, funnelId);
        } catch {
          // Fail-soft: a funnel that can't reach the target state (e.g. steps
          // removed since the snapshot) is left as-is; drift reports it.
        }
      }
    }
  },

  diff(from, to): ConfigDomainDiff {
    const a = asPayload(from);
    const b = asPayload(to);
    const flat = (p: FunnelPointers): Map<string, FunnelStatus> => {
      const m = new Map<string, FunnelStatus>();
      for (const [orgId, funnels] of Object.entries(p)) {
        for (const [funnelId, status] of Object.entries(funnels)) m.set(`${orgId}/${funnelId}`, status);
      }
      return m;
    };
    const fa = flat(a);
    const fb = flat(b);
    let added = 0;
    let changed = 0;
    let removed = 0;
    for (const [k, v] of fb) {
      if (!fa.has(k)) added += 1;
      else if (fa.get(k) !== v) changed += 1;
    }
    for (const k of fa.keys()) {
      if (!fb.has(k)) removed += 1;
    }
    return { added, changed, removed };
  },
};
