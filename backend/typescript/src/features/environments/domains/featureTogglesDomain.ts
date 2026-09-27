/**
 * `feature-toggles` config domain (ADR 0387 D2) — captures/restores a tenant's
 * per-tenant toggle OVERRIDE set. Reads/writes through the toggle owner's public
 * seam (`listTenantOverrides` / `setTenantOverrideStatus`); environments never
 * touches the toggle store directly.
 *
 * Determinism: the payload is a MAP `{ [toggleId]: status }` (order-normalized
 * by canonical-JSON key-sort at hash time) — never an array.
 *
 * Restore is EXACT-MATCH (/architect §3): apply every override in the payload
 * AND clear any live tenant override the payload omits, so `import(export(state))`
 * leaves zero drift. The store-shadows-default gotcha is honored — we restore by
 * WRITING overrides, never by assuming compiled defaults.
 */
import type { ConfigDomain, ConfigDomainDiff } from '../../../host/configDomains.js';
import {
  listTenantOverrides,
  setTenantOverrideStatus,
} from '../../../host/featureToggles/service.js';
import type { FeatureToggleStatus } from '../../../host/featureToggles/types.js';

type TogglePayload = Record<string, FeatureToggleStatus>;

const RESTORE_ACTOR = 'environments:restore';

function asPayload(raw: unknown): TogglePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: TogglePayload = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === 'on' || v === 'off' || v === 'beta') out[k] = v;
  }
  return out;
}

export const featureTogglesDomain: ConfigDomain = {
  id: 'feature-toggles',
  label: 'Feature toggles',
  restore: 'exact-match',

  async export(tenantId) {
    return listTenantOverrides(tenantId);
  },

  async import(tenantId, payload) {
    const target = asPayload(payload);
    const live = await listTenantOverrides(tenantId);
    // Apply every override in the snapshot.
    for (const [toggleId, status] of Object.entries(target)) {
      await setTenantOverrideStatus(toggleId, tenantId, status, RESTORE_ACTOR);
    }
    // EXACT-MATCH: clear live overrides the snapshot does not contain.
    for (const toggleId of Object.keys(live)) {
      if (!(toggleId in target)) {
        await setTenantOverrideStatus(toggleId, tenantId, null, RESTORE_ACTOR);
      }
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
