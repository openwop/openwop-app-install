/**
 * ADR 0956 D5 — UTM governance for a client org: the policy the linter checks
 * outbound links against, and the alias table that maps an unmatched
 * `utm_campaign` to a campaign at read time.
 *
 * - The policy is per client org. With no saved row the default applies
 *   (`DEFAULT_UTM_POLICY`, GA4 channel-grouping mediums). Edits are
 *   closed-world and CAS-guarded on `version`.
 * - An alias is a human decision (no agent tool writes one). It never rewrites
 *   an event; the attribution join reads it. It may not name a value that is
 *   already a campaign's join key (that would attribute twice), and its target
 *   must be one of the org's campaigns.
 *
 * @see docs/adr/0956-attribution-and-incrementality.md
 */
import { OpenwopError } from '../../types.js';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import { DEFAULT_UTM_POLICY, UTM_PARAMS, lintTrackedUrl, type UtmParam, type UtmPolicy, type UtmViolation } from '../../host/trackedUrl.js';
import { getCampaign, listCampaigns } from '../campaign-orchestration/campaignService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('campaign-intel.utm');

export interface UtmPolicyRow {
  tenantId: string;
  orgId: string;
  policy: UtmPolicy;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface UtmAlias {
  tenantId: string;
  orgId: string;
  /** The raw `utm_campaign` value seen on conversions. */
  utmCampaign: string;
  /** The campaign it is attributed to. */
  campaignId: string;
  createdBy: string;
  createdAt: string;
}

const policies = new DurableCollection<UtmPolicyRow>('campaign-intel:utm-policy', (r) => `${r.tenantId}::${r.orgId}`, undefined, (r) => r.tenantId);
const aliases = new DurableCollection<UtmAlias>('campaign-intel:utm-alias', (r) => `${r.tenantId}::${r.orgId}::${r.utmCampaign}`, undefined, (r) => r.tenantId);

/** A campaign's attribution join key (C8): its `utm.campaign`, else its brief
 *  id. The ONE definition — the attribution join and the alias guard share it. */
export const campaignJoinKey = (c: { utm?: { campaign?: string }; briefId: string }): string => c.utm?.campaign ?? c.briefId;

const MAX_VOCAB = 64;
const VALUE_RE = /^[\w .+-]{1,64}$/;

function invalid(message: string, field: string): OpenwopError {
  return new OpenwopError('validation_error', message, 400, { reason: 'utm_policy_invalid', field });
}

function vocab(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_VOCAB || !raw.every((v) => typeof v === 'string' && VALUE_RE.test(v))) {
    throw invalid(`${field} must be a list of up to ${MAX_VOCAB} short values.`, field);
  }
  return [...new Set(raw as string[])];
}

/** Closed-world parse of a policy body. */
export function parseUtmPolicy(body: unknown): UtmPolicy {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Body must be an object.', 'policy');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['sources', 'mediums', 'required', 'case', 'expectedVersion'].includes(k)) throw invalid(`Unknown field "${k}".`, k);
  const required = b.required === undefined ? DEFAULT_UTM_POLICY.required : b.required;
  if (!Array.isArray(required) || !required.every((p) => (UTM_PARAMS as readonly unknown[]).includes(p))) {
    throw invalid(`required must list parameters from: ${UTM_PARAMS.join(', ')}.`, 'required');
  }
  const caseRule = b.case === undefined ? DEFAULT_UTM_POLICY.case : b.case;
  if (caseRule !== 'lower' && caseRule !== 'any') throw invalid('case must be "lower" or "any".', 'case');
  const lower = (vs: string[]): string[] => (caseRule === 'lower' ? vs.map((v) => v.toLowerCase()) : vs);
  return {
    sources: lower(vocab(b.sources, 'sources')),
    mediums: lower(b.mediums === undefined ? DEFAULT_UTM_POLICY.mediums : vocab(b.mediums, 'mediums')),
    required: [...new Set(required as UtmParam[])],
    case: caseRule,
  };
}

/** The org's policy, or the default (version 0) when none is saved. */
export async function getUtmPolicy(tenantId: string, orgId: string): Promise<{ policy: UtmPolicy; version: number; isDefault: boolean }> {
  const row = await policies.get(`${tenantId}::${orgId}`);
  if (row && row.tenantId === tenantId && row.orgId === orgId) return { policy: row.policy, version: row.version, isDefault: false };
  return { policy: DEFAULT_UTM_POLICY, version: 0, isDefault: true };
}

function audit(action: string, tenantId: string, orgId: string, actor: string, extra: Record<string, unknown>): void {
  const at = new Date().toISOString();
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `campaign-intel.utm.${action}`, resource: orgId, outcome: 'success', payload: { tenantId, orgId, ...extra } })
      .catch((err) => log.warn('utm audit append failed', { action, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
}

/** Save the org's policy; `expectedVersion` must be the version the editor read. */
export async function setUtmPolicy(tenantId: string, orgId: string, policy: UtmPolicy, expectedVersion: number, actor: string): Promise<UtmPolicyRow> {
  const key = `${tenantId}::${orgId}`;
  const current = await policies.get(key);
  const currentVersion = current && current.tenantId === tenantId ? current.version : 0;
  if (expectedVersion !== currentVersion) {
    throw new OpenwopError('conflict', 'The UTM policy changed since you opened it. Reload and reapply your edit.', 409, { reason: 'utm_policy_stale', version: currentVersion });
  }
  const next: UtmPolicyRow = { tenantId, orgId, policy, version: currentVersion + 1, updatedBy: actor, updatedAt: new Date().toISOString() };
  if (!(await policies.compareAndSwap(current && current.tenantId === tenantId ? current : null, next))) {
    throw new OpenwopError('conflict', 'The UTM policy changed since you opened it. Reload and reapply your edit.', 409, { reason: 'utm_policy_stale' });
  }
  audit('policy-updated', tenantId, orgId, actor, { version: next.version });
  return next;
}

/** Lint each URL against the org's policy. */
export async function lintUrls(tenantId: string, orgId: string, urls: string[]): Promise<{ policyVersion: number; results: Array<{ url: string; violations: UtmViolation[] }> }> {
  const { policy, version } = await getUtmPolicy(tenantId, orgId);
  return { policyVersion: version, results: urls.map((url) => ({ url, violations: lintTrackedUrl(url, policy) })) };
}

export async function listAliases(tenantId: string, orgId: string): Promise<UtmAlias[]> {
  return (await aliases.listByPrefix(`${tenantId}::${orgId}::`)).filter((a) => a.tenantId === tenantId && a.orgId === orgId).sort((a, b) => a.utmCampaign.localeCompare(b.utmCampaign));
}

/** Map an unmatched `utm_campaign` to one of the org's campaigns. */
export async function setAlias(tenantId: string, orgId: string, utmCampaignRaw: unknown, campaignIdRaw: unknown, actor: string): Promise<UtmAlias> {
  const utmCampaign = typeof utmCampaignRaw === 'string' ? cleanString(utmCampaignRaw, 200) : '';
  if (!utmCampaign || utmCampaign.includes('::')) throw new OpenwopError('validation_error', 'utmCampaign must be the raw utm_campaign value.', 400, { reason: 'utm_alias_invalid', field: 'utmCampaign' });
  const campaignId = typeof campaignIdRaw === 'string' ? campaignIdRaw : '';
  const campaign = campaignId ? await getCampaign(tenantId, campaignId) : null;
  if (!campaign || campaign.orgId !== orgId) throw new OpenwopError('validation_error', 'campaignId must be one of this client\'s campaigns.', 400, { reason: 'utm_alias_invalid', field: 'campaignId' });
  const taken = (await listCampaigns(tenantId, orgId)).some((c) => campaignJoinKey(c) === utmCampaign);
  if (taken) {
    throw new OpenwopError('conflict', `"${utmCampaign}" is already a campaign's join key; an alias would attribute it twice.`, 409, { reason: 'utm_alias_conflicts_join_key' });
  }
  const row: UtmAlias = { tenantId, orgId, utmCampaign, campaignId, createdBy: actor, createdAt: new Date().toISOString() };
  await aliases.put(row);
  audit('alias-set', tenantId, orgId, actor, { utmCampaign, campaignId });
  return row;
}

export async function deleteAlias(tenantId: string, orgId: string, utmCampaign: string, actor: string): Promise<boolean> {
  const deleted = await aliases.delete(`${tenantId}::${orgId}::${utmCampaign}`);
  if (deleted) audit('alias-deleted', tenantId, orgId, actor, { utmCampaign });
  return deleted;
}

/** Subject erasure: policies and aliases are the org's configuration and are
 *  kept; the person's `updatedBy` / `createdBy` is tombstoned. */
export async function eraseUtmGovernanceActors(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const p of await policies.listForTenantIndexed(tenantId)) {
    if (p.tenantId === tenantId && forms.has(p.updatedBy)) { await policies.put({ ...p, updatedBy: tombstone }); n += 1; }
  }
  for (const a of await aliases.listForTenantIndexed(tenantId)) {
    if (a.tenantId === tenantId && forms.has(a.createdBy)) { await aliases.put({ ...a, createdBy: tombstone }); n += 1; }
  }
  return n;
}
