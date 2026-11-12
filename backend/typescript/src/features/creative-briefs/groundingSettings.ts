/**
 * ADR 0945 Q1 (decided 2026-10-20 by team-lead; David can override) — edit mode
 * is OFF per client org by default and needs that client's explicit opt-in.
 * Edit mode repaints the pixels around the client's real product, so the
 * client whose brand it is must say yes; composite mode (the product's pixels
 * copied, only scaled) needs no opt-in. The tenant sub-toggle
 * `creative-briefs.product-grounded` stays the master switch.
 *
 * One small row per (tenant, client org). Only an org admin may change it.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { casRewrite } from './creativeBriefsService.js';

export interface GroundingSettings {
  tenantId: string;
  orgId: string;
  /** Edit mode (masked inpaint around the product) — OFF unless the client opts in. */
  editModeEnabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

const settings = new DurableCollection<GroundingSettings>(
  'creative-briefs:grounding-settings',
  (s) => `${s.tenantId}::${s.orgId}`,
  undefined,
  (s) => s.tenantId,
);

export async function getGroundingSettings(tenantId: string, orgId: string): Promise<{ editModeEnabled: boolean }> {
  const s = await settings.get(`${tenantId}::${orgId}`);
  return { editModeEnabled: !!s && s.tenantId === tenantId && s.orgId === orgId && s.editModeEnabled === true };
}

export async function setGroundingSettings(tenantId: string, orgId: string, actor: string, patch: { editModeEnabled: boolean }): Promise<{ editModeEnabled: boolean }> {
  await settings.put({ tenantId, orgId, editModeEnabled: patch.editModeEnabled === true, updatedBy: actor, updatedAt: new Date().toISOString() });
  return getGroundingSettings(tenantId, orgId);
}

/** ADR 1039 D7 — tombstone the subject as the last editor of a client org's
 *  grounding settings. The setting is the client's and is kept. */
export async function tombstoneGroundingActors(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const s of await settings.listByPrefix(`${tenantId}::`)) {
    if (s.tenantId !== tenantId || !forms.has(s.updatedBy)) continue;
    if (await casRewrite(settings, `${s.tenantId}::${s.orgId}`, (row) => (forms.has(row.updatedBy) ? { ...row, updatedBy: tombstone } : null))) n += 1;
  }
  return n;
}

/** Refuse edit mode for a client org that has not opted in (fail closed). */
export async function assertEditModeEnabled(tenantId: string, orgId: string): Promise<void> {
  const s = await getGroundingSettings(tenantId, orgId).catch(() => ({ editModeEnabled: false }));
  if (!s.editModeEnabled) {
    throw new OpenwopError('edit_mode_not_enabled', 'Edit mode is off for this client. An admin of the client can turn it on; composite product shots work without it.', 403, { orgId });
  }
}
