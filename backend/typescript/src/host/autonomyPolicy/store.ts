/**
 * ADR 0942 D2 — policy and binding stores.
 *
 *  - `autonomy:policy` — immutable custom policy versions, keyed
 *    `tenant::policyId::version`, written with `putIfAbsent` (append-only). The
 *    policyId is deterministic per binding scope, so two concurrent saves race on
 *    the same `(policyId, version)` key and the loser gets a 409.
 *  - `autonomy:binding` — which policy a client (`campaignId` absent, key
 *    `tenant::orgId::*`) or a campaign uses; compare-and-swap updated.
 *
 * Presets have no rows: a binding names them as `preset:<name>` (presets.ts).
 * A binding whose custom policy row is missing resolves to the fallback preset
 * (fail closed), and says so.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { FALLBACK_PRESET, policyHash, presetFromBinding, presetPolicy, presetPolicyId } from './presets.js';
import type { ActionRule, AutonomyBinding, AutonomyPolicy, PresetId, ResolvedPolicy } from './types.js';

const policies = new DurableCollection<AutonomyPolicy>(
  'autonomy:policy',
  (p) => `${p.tenantId}::${p.policyId}::${p.version}`,
  undefined,
  (p) => p.tenantId,
);
const bindings = new DurableCollection<AutonomyBinding>(
  'autonomy:binding',
  (b) => bindingKey(b.tenantId, b.orgId, b.campaignId),
  undefined,
  (b) => b.tenantId,
);

const nowIso = (): string => new Date().toISOString();

function bindingKey(tenantId: string, orgId: string, campaignId?: string): string {
  return `${tenantId}::${orgId}::${campaignId ?? '*'}`;
}

/** One deterministic policy lineage per binding scope. */
export function policyIdFor(tenantId: string, orgId: string, campaignId?: string): string {
  return `apol_${createHash('sha256').update([tenantId, orgId, campaignId ?? '*'].join('\u0000')).digest('hex').slice(0, 24)}`;
}

export async function getBinding(tenantId: string, orgId: string, campaignId?: string): Promise<AutonomyBinding | null> {
  const b = await bindings.get(bindingKey(tenantId, orgId, campaignId));
  return b && b.tenantId === tenantId && b.orgId === orgId && (b.campaignId ?? undefined) === campaignId ? b : null;
}

/** Logical absence retained at the same key so clearing an authorized override
 * cannot delete a concurrent replacement. Custom ids are always apol_* and
 * presets are preset:*, so this host-only marker cannot name a real policy. */
export function isInheritedBinding(b: AutonomyBinding | null): boolean {
  return b?.policyId === 'inherit' && b.version === 0;
}

export async function clearCampaignBindingOverride(expected: AutonomyBinding, actor: string): Promise<boolean> {
  if (!expected.campaignId) throw new OpenwopError('validation_error', 'Only a campaign override can be cleared.', 400, { field: 'campaignId' });
  const inherited: AutonomyBinding = { ...expected, policyId: 'inherit', version: 0, updatedBy: actor, updatedAt: nowIso() };
  if (!(await bindings.compareAndSwap(expected, inherited))) {
    throw new OpenwopError('conflict', 'This autonomy policy changed since you loaded it. Reload and try again.', 409, { reason: 'binding_changed' });
  }
  return true;
}

export async function getPolicyVersion(tenantId: string, policyId: string, version: number): Promise<AutonomyPolicy | null> {
  const p = await policies.get(`${tenantId}::${policyId}::${version}`);
  return p && p.tenantId === tenantId && p.policyId === policyId && p.version === version ? p : null;
}

function toResolved(p: AutonomyPolicy): ResolvedPolicy {
  return { policyId: p.policyId, version: p.version, name: p.name, ...(p.basePreset ? { basePreset: p.basePreset } : {}), rules: p.rules, hash: p.hash };
}

/** The policy a binding names, or `null` when its custom row is missing (a dangling binding). */
export async function policyForBinding(b: AutonomyBinding): Promise<ResolvedPolicy | null> {
  const preset = presetFromBinding(b.policyId, b.version);
  if (preset) return presetPolicy(preset);
  if (b.policyId.startsWith('preset:')) return null; // an unknown preset version
  const row = await getPolicyVersion(b.tenantId, b.policyId, b.version);
  return row ? toResolved(row) : null;
}

export type PolicySource = 'campaign' | 'client' | 'default';

export interface EffectivePolicy {
  policy: ResolvedPolicy;
  source: PolicySource;
  binding: AutonomyBinding | null;
  /** True when a binding existed but named a missing policy, so the fallback applied. */
  dangling: boolean;
}

/** D2 resolution order: campaign binding → client binding → `review-everything@1`. */
export async function resolveEffectivePolicy(tenantId: string, orgId: string, campaignId?: string): Promise<EffectivePolicy> {
  let dangling = false;
  if (campaignId) {
    const b = await getBinding(tenantId, orgId, campaignId);
    if (b && !isInheritedBinding(b)) {
      const p = await policyForBinding(b);
      if (p) return { policy: p, source: 'campaign', binding: b, dangling: false };
      dangling = true;
    }
  }
  const client = await getBinding(tenantId, orgId);
  if (client && !isInheritedBinding(client)) {
    const p = await policyForBinding(client);
    if (p) return { policy: p, source: 'client', binding: client, dangling };
    dangling = true;
  }
  return { policy: presetPolicy(FALLBACK_PRESET), source: 'default', binding: null, dangling };
}

export type PolicyInput =
  | { kind: 'preset'; preset: PresetId }
  | { kind: 'custom'; name: string; basePreset?: PresetId; rules: ActionRule[] };

/** The policy an input would resolve to, before it is stored (for the strictness comparison). */
export function previewPolicy(input: PolicyInput): Pick<ResolvedPolicy, 'rules' | 'basePreset' | 'hash'> {
  if (input.kind === 'preset') return presetPolicy(input.preset);
  return { rules: input.rules, ...(input.basePreset ? { basePreset: input.basePreset } : {}), hash: policyHash(input.basePreset, input.rules) };
}

/**
 * Save a policy for a scope and CAS the binding onto it. `expected` is the binding
 * the caller read (null ⇒ none); a binding that moved in between is a 409, so a
 * concurrent save never silently overwrites another.
 */
export async function savePolicy(args: {
  tenantId: string; orgId: string; campaignId?: string;
  input: PolicyInput; actor: string; expected: AutonomyBinding | null;
}): Promise<{ binding: AutonomyBinding; policy: ResolvedPolicy }> {
  const { tenantId, orgId, campaignId, input, actor } = args;
  const at = nowIso();
  let policy: ResolvedPolicy;
  let ref: { policyId: string; version: number };
  if (input.kind === 'preset') {
    policy = presetPolicy(input.preset);
    ref = presetPolicyId(input.preset);
  } else {
    const policyId = policyIdFor(tenantId, orgId, campaignId);
    const existing = await policies.listByPrefix(`${tenantId}::${policyId}::`);
    const version = existing.filter((p) => p.tenantId === tenantId && p.policyId === policyId).reduce((m, p) => Math.max(m, p.version), 0) + 1;
    const row: AutonomyPolicy = {
      tenantId, policyId, version, name: input.name,
      ...(input.basePreset ? { basePreset: input.basePreset } : {}),
      rules: input.rules, hash: policyHash(input.basePreset, input.rules),
      createdBy: actor, createdAt: at,
    };
    if (!(await policies.putIfAbsent(row))) {
      throw new OpenwopError('conflict', 'Someone else saved this policy at the same time. Reload and try again.', 409, { reason: 'policy_version_taken' });
    }
    policy = toResolved(row);
    ref = { policyId, version };
  }
  const binding: AutonomyBinding = {
    tenantId, orgId, ...(campaignId ? { campaignId } : {}),
    policyId: ref.policyId, version: ref.version, updatedBy: actor, updatedAt: at,
  };
  // An unreferenced version row left by a lost CAS is harmless: nothing resolves it.
  if (!(await bindings.compareAndSwap(args.expected, binding))) {
    throw new OpenwopError('conflict', 'This autonomy policy changed since you loaded it. Reload and try again.', 409, { reason: 'binding_changed' });
  }
  return { binding, policy };
}

/** Bind a new client to a preset if it has no binding yet. Never overwrites. */
export async function bindClientPresetIfAbsent(tenantId: string, orgId: string, preset: PresetId, actor: string): Promise<boolean> {
  const ref = presetPolicyId(preset);
  return bindings.putIfAbsent({ tenantId, orgId, policyId: ref.policyId, version: ref.version, updatedBy: actor, updatedAt: nowIso() });
}

/** Campaign delete cascade. Policy versions are history and stay (tenant teardown reaps them). */
export async function deleteCampaignBinding(tenantId: string, orgId: string, campaignId: string): Promise<boolean> {
  return bindings.delete(bindingKey(tenantId, orgId, campaignId));
}

/**
 * Client delete cascade: every binding of the org (its default and any campaign
 * overrides). An org with rows left cannot be deleted (`deleteOrg` refuses while
 * populated), so a client delete must not strand its bindings.
 */
export async function deleteBindingsForOrg(tenantId: string, orgId: string): Promise<number> {
  let n = 0;
  for (const b of await bindings.listByPrefix(`${tenantId}::${orgId}::`)) {
    if (b.tenantId === tenantId && b.orgId === orgId && (await bindings.delete(bindingKey(tenantId, orgId, b.campaignId)))) n++;
  }
  return n;
}

/** Subject erasure (ADR 0464): the rows are the org's configuration and stay; the person in them goes. */
export async function eraseAutonomyActors(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const initial of await bindings.listForTenantIndexed(tenantId)) {
    if (initial.tenantId !== tenantId || !forms.has(initial.updatedBy)) continue;
    let current: AutonomyBinding | null = initial;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!current || current.tenantId !== tenantId || !forms.has(current.updatedBy)) break;
      if (await bindings.compareAndSwap(current, { ...current, updatedBy: tombstone })) { n++; break; }
      if (attempt === 4) throw new OpenwopError('conflict', 'Autonomy subject erasure must be retried.', 409, { reason: 'subject_erasure_conflict' });
      current = await getBinding(tenantId, initial.orgId, initial.campaignId);
    }
  }
  for (const initial of await policies.listForTenantIndexed(tenantId)) {
    if (initial.tenantId !== tenantId || !forms.has(initial.createdBy)) continue;
    let current: AutonomyPolicy | null = initial;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!current || current.tenantId !== tenantId || !forms.has(current.createdBy)) break;
      if (await policies.compareAndSwap(current, { ...current, createdBy: tombstone })) { n++; break; }
      if (attempt === 4) throw new OpenwopError('conflict', 'Autonomy subject erasure must be retried.', 409, { reason: 'subject_erasure_conflict' });
      current = await getPolicyVersion(tenantId, initial.policyId, initial.version);
    }
  }
  return n;
}
