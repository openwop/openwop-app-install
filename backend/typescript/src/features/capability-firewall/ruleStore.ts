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
import { parseExpression } from './expressionEvaluator.js';
import type { CapabilityClass, CapabilityRule, CountAtLeast, FirewallMode } from './types.js';

/** How the firewall treats a tool with NO classification (a 3p/MCP tool lacking
 *  `safetyTier`): `skip` (fail-open — the v1 default, for adoption) or `treat-as-risky`
 *  (fail-closed — an unclassified tool participates as a conservative write+egress class,
 *  so a security-conscious tenant closes the coverage gap). */
export type UnknownToolPolicy = 'skip' | 'treat-as-risky';

interface StoredRuleSet { tenantId: string; rules: CapabilityRule[]; unknownToolPolicy?: UnknownToolPolicy; mode?: FirewallMode; defaultDenyVerdict?: 'deny' | 'require-approval'; updatedBy?: string; updatedAt: string }

const store = new DurableCollection<StoredRuleSet>('capability-firewall:rules', (r) => r.tenantId);
const MAX_RULES = 100;
const SAFETY_TIERS = new Set(['pure', 'read', 'write', 'exec']);
const EGRESS = new Set(['none', 'safe-fetch', 'host-mediated', 'host-owned']);
// ADR 0397 — `'allow'` (explicit allow-list rule) joins the save-time verdict grammar.
const VERDICTS = new Set(['deny', 'require-approval', 'allow']);
const MODES = new Set<FirewallMode>(['default-allow', 'shadow', 'enforce']);
const DEFAULT_DENY_VERDICTS = new Set(['deny', 'require-approval']);

function validateClass(c: unknown, where: string): CapabilityClass {
  if (!c || typeof c !== 'object') throw new OpenwopError('validation_error', `${where}: a capability class MUST be an object.`, 400);
  const o = c as Record<string, unknown>;
  if (typeof o.safetyTier === 'string' && SAFETY_TIERS.has(o.safetyTier)) return { safetyTier: o.safetyTier } as CapabilityClass;
  if (typeof o.egress === 'string' && EGRESS.has(o.egress)) return { egress: o.egress } as CapabilityClass;
  if (typeof o.scope === 'string' && o.scope) return { scope: o.scope };
  if (o.kind === 'fan-out') return { kind: 'fan-out' };
  throw new OpenwopError('validation_error', `${where}: unknown capability class (need safetyTier|egress|scope|kind).`, 400);
}

const classList = (v: unknown, where: string): CapabilityClass[] | undefined =>
  v === undefined ? undefined
  : Array.isArray(v) ? v.map((c, i) => validateClass(c, `${where}[${i}]`))
  : (() => { throw new OpenwopError('validation_error', `${where} MUST be an array.`, 400); })();

/** Validate a `countAtLeast` predicate (ADR 0135 Phase 5). */
function validateCountAtLeast(v: unknown, where: string): CountAtLeast {
  if (!v || typeof v !== 'object') throw new OpenwopError('validation_error', `${where} MUST be an object.`, 400);
  const o = v as Record<string, unknown>;
  const cls = validateClass(o.class, `${where}.class`);
  if (typeof o.threshold !== 'number' || !Number.isInteger(o.threshold) || o.threshold < 1) {
    throw new OpenwopError('validation_error', `${where}.threshold MUST be a positive integer.`, 400);
  }
  if (o.window !== 'turn') throw new OpenwopError('validation_error', `${where}.window MUST be 'turn'.`, 400);
  return { class: cls, threshold: o.threshold, window: 'turn' };
}

/** Validate a rules array (shape only). Throws the canonical 400 envelope on a miss.
 *  Each rule MUST use exactly one predicate kind (presence `anyOf`/`with`, `countAtLeast`,
 *  or `expression`); an invalid expression fails CLOSED at save time (ADR 0135 Phase 6). */
export function validateRules(input: unknown): CapabilityRule[] {
  if (!Array.isArray(input)) throw new OpenwopError('validation_error', 'rules MUST be an array.', 400);
  if (input.length > MAX_RULES) throw new OpenwopError('validation_error', `rules exceeds ${MAX_RULES}.`, 400);
  return input.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) throw new OpenwopError('validation_error', `rules[${i}].id is required.`, 400);
    if (typeof o.verdict !== 'string' || !VERDICTS.has(o.verdict)) throw new OpenwopError('validation_error', `rules[${i}].verdict MUST be 'deny', 'require-approval', or 'allow'.`, 400);
    const when = (o.when ?? {}) as Record<string, unknown>;
    const anyOf = classList(when.anyOf, `rules[${i}].when.anyOf`);
    const withList = classList(when.with, `rules[${i}].when.with`);
    const hasPresence = anyOf !== undefined || withList !== undefined;
    const countAtLeast = when.countAtLeast !== undefined
      ? validateCountAtLeast(when.countAtLeast, `rules[${i}].when.countAtLeast`)
      : undefined;
    let expression: string | undefined;
    if (when.expression !== undefined) {
      if (typeof when.expression !== 'string') throw new OpenwopError('validation_error', `rules[${i}].when.expression MUST be a string.`, 400);
      const parsed = parseExpression(when.expression);
      if (!parsed.ok) throw new OpenwopError('validation_error', `rules[${i}].when.expression is invalid: ${parsed.error}`, 400);
      expression = when.expression;
    }
    const predicateKinds = (hasPresence ? 1 : 0) + (countAtLeast ? 1 : 0) + (expression !== undefined ? 1 : 0);
    if (predicateKinds > 1) {
      throw new OpenwopError('validation_error', `rules[${i}].when MUST use exactly one predicate kind (anyOf/with, countAtLeast, or expression).`, 400);
    }
    return {
      id: o.id,
      description: typeof o.description === 'string' ? o.description : '',
      when: {
        ...(anyOf ? { anyOf } : {}),
        ...(withList ? { with: withList } : {}),
        ...(countAtLeast ? { countAtLeast } : {}),
        ...(expression !== undefined ? { expression } : {}),
      },
      verdict: o.verdict as 'deny' | 'require-approval' | 'allow',
      reason: typeof o.reason === 'string' ? o.reason : '',
    };
  });
}

/** Validate the enforcement posture (ADR 0397). Absent ⇒ preserve today's `default-allow`
 *  / `deny` defaults (never silently escalate to a deny mode). */
export function validateMode(v: unknown): FirewallMode {
  if (v === undefined) return 'default-allow';
  if (typeof v !== 'string' || !MODES.has(v as FirewallMode)) {
    throw new OpenwopError('validation_error', "mode MUST be 'default-allow', 'shadow', or 'enforce'.", 400);
  }
  return v as FirewallMode;
}

export function validateDefaultDenyVerdict(v: unknown): 'deny' | 'require-approval' {
  if (v === undefined) return 'deny';
  if (typeof v !== 'string' || !DEFAULT_DENY_VERDICTS.has(v)) {
    throw new OpenwopError('validation_error', "defaultDenyVerdict MUST be 'deny' or 'require-approval'.", 400);
  }
  return v as 'deny' | 'require-approval';
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

/** The tenant's enforcement posture (ADR 0397). Default `default-allow` when unset — a
 *  tenant that never touched governance stays exactly on today's behavior. */
export async function getFirewallMode(tenantId: string): Promise<FirewallMode> {
  return (await store.get(tenantId))?.mode ?? 'default-allow';
}

/** The tenant's default posture for an UNMATCHED action under deny modes. Default `deny`. */
export async function getDefaultDenyVerdict(tenantId: string): Promise<'deny' | 'require-approval'> {
  return (await store.get(tenantId))?.defaultDenyVerdict ?? 'deny';
}

export async function getStoredRuleSet(tenantId: string): Promise<StoredRuleSet | null> {
  return store.get(tenantId);
}

export async function setCapabilityRules(
  tenantId: string,
  rules: CapabilityRule[],
  unknownToolPolicy: UnknownToolPolicy,
  updatedBy?: string,
  posture: { mode?: FirewallMode; defaultDenyVerdict?: 'deny' | 'require-approval' } = {},
): Promise<StoredRuleSet> {
  const next: StoredRuleSet = {
    tenantId, rules, unknownToolPolicy,
    mode: posture.mode ?? 'default-allow',
    defaultDenyVerdict: posture.defaultDenyVerdict ?? 'deny',
    updatedAt: new Date().toISOString(),
    ...(updatedBy ? { updatedBy } : {}),
  };
  await store.put(next);
  return next;
}

// ADR 0397 Phase 5 — the superadmin PLATFORM-BASELINE rule set. A single global set that
// ANDs *under* every tenant's rules (most-restrictive-wins): a tenant cannot weaken a
// platform deny. Only `deny` / `require-approval` are meaningful here (a platform baseline
// tightens; it never allow-lists). Stored as a singleton in its own collection.
interface PlatformRuleSet { id: 'platform'; rules: CapabilityRule[]; updatedBy?: string; updatedAt: string }
const platformStore = new DurableCollection<PlatformRuleSet>('capability-firewall:platform-rules', () => 'platform');

/** The platform-baseline rules (empty when unset ⇒ no floor). */
export async function getPlatformRules(): Promise<CapabilityRule[]> {
  return (await platformStore.get('platform'))?.rules ?? [];
}

export async function setPlatformRules(rules: CapabilityRule[], updatedBy?: string): Promise<CapabilityRule[]> {
  // A platform baseline only tightens — reject an `allow` rule (it would be a no-op floor
  // that misleads operators into thinking it grants something).
  for (const r of rules) {
    if (r.verdict === 'allow') throw new OpenwopError('validation_error', 'platform-baseline rules must be deny or require-approval (a baseline tightens; it never allow-lists).', 400);
  }
  const next: PlatformRuleSet = { id: 'platform', rules, updatedAt: new Date().toISOString(), ...(updatedBy ? { updatedBy } : {}) };
  await platformStore.put(next);
  return next.rules;
}
