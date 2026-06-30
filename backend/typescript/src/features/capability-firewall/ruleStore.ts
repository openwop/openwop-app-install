/**
 * ADR 0135 Phase 3 — the per-tenant capability rule store + validation.
 *
 * Tenant-wide (the toggle is `bucketUnit:'tenant'`); one rule set per tenant.
 * `getCapabilityRuleSet` returns the stored set or the shipped default (so the loop
 * always has rules when the feature is ON). Validation is fail-closed: a malformed PUT
 * is rejected, so the store only ever holds a valid set.
 *
 * @see docs/adr/0135-capability-firewall.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { defaultCapabilityRules } from './firewallHook.js';
import type { CapabilityClass, CapabilityRule } from './types.js';

/** How the firewall treats a tool with NO classification (a 3p/MCP tool lacking
 *  `safetyTier`): `skip` (fail-open — the v1 default, for adoption) or `treat-as-risky`
 *  (fail-closed — an unclassified tool participates as a conservative write+egress class,
 *  so a security-conscious tenant closes the coverage gap). */
export type UnknownToolPolicy = 'skip' | 'treat-as-risky';

interface StoredRuleSet { tenantId: string; rules: CapabilityRule[]; unknownToolPolicy?: UnknownToolPolicy; updatedBy?: string; updatedAt: string }

const store = new DurableCollection<StoredRuleSet>('capability-firewall:rules', (r) => r.tenantId);
const MAX_RULES = 100;
const SAFETY_TIERS = new Set(['pure', 'read', 'write', 'exec']);
const EGRESS = new Set(['none', 'safe-fetch', 'host-mediated', 'host-owned']);
const VERDICTS = new Set(['deny', 'require-approval']);

function validateClass(c: unknown, where: string): CapabilityClass {
  if (!c || typeof c !== 'object') throw new OpenwopError('validation_error', `${where}: a capability class MUST be an object.`, 400);
  const o = c as Record<string, unknown>;
  if (typeof o.safetyTier === 'string' && SAFETY_TIERS.has(o.safetyTier)) return { safetyTier: o.safetyTier } as CapabilityClass;
  if (typeof o.egress === 'string' && EGRESS.has(o.egress)) return { egress: o.egress } as CapabilityClass;
  if (typeof o.scope === 'string' && o.scope) return { scope: o.scope };
  throw new OpenwopError('validation_error', `${where}: unknown capability class (need safetyTier|egress|scope).`, 400);
}

const classList = (v: unknown, where: string): CapabilityClass[] | undefined =>
  v === undefined ? undefined
  : Array.isArray(v) ? v.map((c, i) => validateClass(c, `${where}[${i}]`))
  : (() => { throw new OpenwopError('validation_error', `${where} MUST be an array.`, 400); })();

/** Validate a rules array (shape only). Throws the canonical 400 envelope on a miss. */
export function validateRules(input: unknown): CapabilityRule[] {
  if (!Array.isArray(input)) throw new OpenwopError('validation_error', 'rules MUST be an array.', 400);
  if (input.length > MAX_RULES) throw new OpenwopError('validation_error', `rules exceeds ${MAX_RULES}.`, 400);
  return input.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) throw new OpenwopError('validation_error', `rules[${i}].id is required.`, 400);
    if (typeof o.verdict !== 'string' || !VERDICTS.has(o.verdict)) throw new OpenwopError('validation_error', `rules[${i}].verdict MUST be 'deny' or 'require-approval'.`, 400);
    const when = (o.when ?? {}) as Record<string, unknown>;
    return {
      id: o.id,
      description: typeof o.description === 'string' ? o.description : '',
      when: {
        ...(classList(when.anyOf, `rules[${i}].when.anyOf`) ? { anyOf: classList(when.anyOf, `rules[${i}].when.anyOf`)! } : {}),
        ...(classList(when.with, `rules[${i}].when.with`) ? { with: classList(when.with, `rules[${i}].when.with`)! } : {}),
      },
      verdict: o.verdict as 'deny' | 'require-approval',
      reason: typeof o.reason === 'string' ? o.reason : '',
    };
  });
}

/** The tenant's rule set, or the shipped default when unset. */
export async function getCapabilityRules(tenantId: string): Promise<CapabilityRule[]> {
  return (await store.get(tenantId))?.rules ?? defaultCapabilityRules();
}

/** The tenant's unclassified-tool policy. Default `treat-as-risky` (CGOV-1, fail-CLOSED):
 *  an unclassified tool is conservatively treated as egress-capable so it participates in
 *  composition rather than silently bypassing a configured read-then-egress rule. Only
 *  affects tenants who opted into governance (the hook isn't built without rules). A
 *  tenant that explicitly prefers the looser posture can still store `'skip'`. */
export async function getUnknownToolPolicy(tenantId: string): Promise<UnknownToolPolicy> {
  return (await store.get(tenantId))?.unknownToolPolicy ?? 'treat-as-risky';
}

export async function getStoredRuleSet(tenantId: string): Promise<StoredRuleSet | null> {
  return store.get(tenantId);
}

export async function setCapabilityRules(tenantId: string, rules: CapabilityRule[], unknownToolPolicy: UnknownToolPolicy, updatedBy?: string): Promise<StoredRuleSet> {
  const next: StoredRuleSet = { tenantId, rules, unknownToolPolicy, updatedAt: new Date().toISOString(), ...(updatedBy ? { updatedBy } : {}) };
  await store.put(next);
  return next;
}
