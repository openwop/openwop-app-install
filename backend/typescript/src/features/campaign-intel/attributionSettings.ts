/**
 * ADR 0956 D1/D2 — a client org's attribution settings: the touch lookback
 * window, the time-decay half-life, and the model its reports open on. One row
 * per org; absent ⇒ the defaults (version 0). Closed-world, CAS on `version`,
 * the UTM-policy shape (`utmGovernance.ts`).
 */
import { OpenwopError } from '../../types.js';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { ATTRIBUTION_MODELS, isAttributionModel, type AttributionModel } from './attributionModels.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('campaign-intel.attribution-settings');

/** ADR 0956 D2 — the sub-toggle that turns on the multi-touch model report
 *  (default OFF). The session-last-click column (D1) rides the base toggle. */
export const MULTI_TOUCH_TOGGLE = 'campaign-intel.multi-touch';

export interface AttributionSettings {
  /** Touches older than this before a conversion are not on its path (1–90). */
  lookbackDays: number;
  /** time_decay half-life in days (1–90). */
  halfLifeDays: number;
  /** The model the org's reports open on; every report says which it is. */
  defaultModel: AttributionModel;
}

export const DEFAULT_ATTRIBUTION_SETTINGS: AttributionSettings = { lookbackDays: 30, halfLifeDays: 7, defaultModel: 'last_click' };

interface SettingsRow {
  tenantId: string;
  orgId: string;
  settings: AttributionSettings;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

const rows = new DurableCollection<SettingsRow>('campaign-intel:attribution-settings', (r) => `${r.tenantId}::${r.orgId}`, undefined, (r) => r.tenantId);

function invalid(message: string, field: string): OpenwopError {
  return new OpenwopError('validation_error', message, 400, { reason: 'attribution_settings_invalid', field });
}

const days = (v: unknown, field: string, fallback: number): number => {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 90) throw invalid(`${field} must be a whole number of days from 1 to 90.`, field);
  return v;
};

/** Closed-world parse of a settings body (`expectedVersion` rides alongside). */
export function parseAttributionSettings(body: unknown): AttributionSettings {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Body must be an object.', 'settings');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['lookbackDays', 'halfLifeDays', 'defaultModel', 'expectedVersion'].includes(k)) throw invalid(`Unknown field "${k}".`, k);
  const model = b.defaultModel === undefined ? DEFAULT_ATTRIBUTION_SETTINGS.defaultModel : b.defaultModel;
  if (!isAttributionModel(model)) throw invalid(`defaultModel must be one of: ${ATTRIBUTION_MODELS.join(', ')}.`, 'defaultModel');
  return {
    lookbackDays: days(b.lookbackDays, 'lookbackDays', DEFAULT_ATTRIBUTION_SETTINGS.lookbackDays),
    halfLifeDays: days(b.halfLifeDays, 'halfLifeDays', DEFAULT_ATTRIBUTION_SETTINGS.halfLifeDays),
    defaultModel: model,
  };
}

export async function getAttributionSettings(tenantId: string, orgId: string): Promise<{ settings: AttributionSettings; version: number; isDefault: boolean }> {
  const row = await rows.get(`${tenantId}::${orgId}`);
  if (row && row.tenantId === tenantId && row.orgId === orgId) return { settings: row.settings, version: row.version, isDefault: false };
  return { settings: DEFAULT_ATTRIBUTION_SETTINGS, version: 0, isDefault: true };
}

export async function setAttributionSettings(tenantId: string, orgId: string, settings: AttributionSettings, expectedVersion: number, actor: string): Promise<{ settings: AttributionSettings; version: number }> {
  const current = await rows.get(`${tenantId}::${orgId}`);
  const mine = current && current.tenantId === tenantId ? current : null;
  const currentVersion = mine ? mine.version : 0;
  const stale = (): OpenwopError => new OpenwopError('conflict', 'The attribution settings changed since you opened them. Reload and reapply your edit.', 409, { reason: 'attribution_settings_stale', version: currentVersion });
  if (expectedVersion !== currentVersion) throw stale();
  const next: SettingsRow = { tenantId, orgId, settings, version: currentVersion + 1, updatedBy: actor, updatedAt: new Date().toISOString() };
  if (!(await rows.compareAndSwap(mine, next))) throw stale();
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: next.updatedAt, principalId: actor, action: 'campaign-intel.attribution-settings.updated', resource: orgId, outcome: 'success', payload: { tenantId, orgId, version: next.version } })
      .catch((err) => log.warn('attribution settings audit append failed', { error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  return { settings: next.settings, version: next.version };
}

/** Subject erasure: the org's settings are kept; the editor is tombstoned. */
export async function eraseAttributionSettingsActors(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const r of await rows.listForTenantIndexed(tenantId)) {
    if (r.tenantId === tenantId && forms.has(r.updatedBy)) { await rows.put({ ...r, updatedBy: tombstone }); n += 1; }
  }
  return n;
}

/**
 * ADR 0956 D6 — the model a reconciliation / AdMap read uses. ONE rule for the
 * route and the workflow surface: last click unless the multi-touch sub-toggle
 * is on; a misspelt model, or a non-last-click model while it is off, is a
 * typed `validation_error`, never a silent fall-back. `undefined` = the org's
 * default model.
 */
export async function resolveReadModel(tenantId: string, userId: string | undefined, raw: unknown): Promise<AttributionModel | undefined> {
  if (raw !== undefined && !isAttributionModel(raw)) {
    throw new OpenwopError('validation_error', `model must be one of: ${ATTRIBUTION_MODELS.join(', ')}.`, 400, { field: 'model' });
  }
  const multi = (await resolveOne(MULTI_TOUCH_TOGGLE, { tenantId, ...(userId ? { userId } : {}) }))?.enabled === true;
  if (!multi) {
    if (raw !== undefined && raw !== 'last_click') {
      throw new OpenwopError('validation_error', 'Only last_click is available until multi-touch attribution is turned on.', 400, { field: 'model', toggle: MULTI_TOUCH_TOGGLE });
    }
    return 'last_click';
  }
  return isAttributionModel(raw) ? raw : undefined;
}
