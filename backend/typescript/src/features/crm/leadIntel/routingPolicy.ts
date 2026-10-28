/**
 * ADR 0954 D5 — a client's lead routing policy: ordered rules
 * `{match, strategy, pool}`. Versions are immutable (`tenant::orgId::<version>`);
 * the insert-if-absent of version N+1 is the concurrency control, and the newest
 * version is the one routing reads. Owners are opaque subject ids; whether each
 * may receive a lead is re-checked at every assignment, never at save time.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ERASED, subjectKeyForms } from '../../../host/subjectErasureRedaction.js';
import { currentErasureRequest } from '../../../host/subjectErasure.js';
import { isErasureTombstoned, tombstoneId, tombstoneKeyForms, writeErasureTombstone } from '../../consent/consentService.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { BANDS, type Band } from './model.js';
import { LEAD_SOURCES, type LeadSource } from './leadStore.js';

export type RoutingStrategy = 'territory' | 'round-robin' | 'capacity' | 'named';
export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = ['territory', 'round-robin', 'capacity', 'named'];

export interface LeadRoutingRule {
  ruleId: string;
  match?: { bands?: Band[]; sources?: LeadSource[] };
  strategy: RoutingStrategy;
  /** round-robin / capacity: the owners to choose among. */
  pool?: string[];
  /** capacity: the most open leads one owner may hold. */
  maxOpenLeads?: number;
  /** named: the one owner. */
  named?: string;
}

export interface LeadRoutingPolicy {
  tenantId: string;
  orgId: string;
  version: number;
  rules: LeadRoutingRule[];
  createdBy: string;
  createdAt: string;
}

const MAX_RULES = 50;
const MAX_POOL = 100;
const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SUBJECT = /^[^\s]{1,200}$/;
const ALL_BANDS: readonly Band[] = [...BANDS, 'F'];

interface PolicyPublication { operation: string; subjectHashes: string[] }
type StoredPolicy = LeadRoutingPolicy & { publicationPending?: PolicyPublication; publicationDisabled?: true; requestDigest?: string };
const policies = new DurableCollection<StoredPolicy>(
  'crm:lead-routing', (p) => `${p.tenantId}::${p.orgId}::${p.version}`, undefined, (p) => p.tenantId,
);

const invalid = (field: string, message: string): OpenwopError => new OpenwopError('validation_error', message, 422, { field });

export function validateRoutingRules(input: unknown): LeadRoutingRule[] {
  if (!Array.isArray(input) || input.length > MAX_RULES) throw invalid('rules', `A routing policy has at most ${MAX_RULES} rules.`);
  const ids = new Set<string>();
  return input.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.ruleId !== 'string' || !RULE_ID.test(r.ruleId) || ids.has(r.ruleId)) throw invalid(`rules[${i}].ruleId`, 'Each rule needs a unique id (lowercase letters, digits, "-" or "_").');
    ids.add(r.ruleId);
    if (!ROUTING_STRATEGIES.includes(r.strategy as RoutingStrategy)) throw invalid(`rules[${i}].strategy`, `Strategy must be one of ${ROUTING_STRATEGIES.join(', ')}.`);
    const strategy = r.strategy as RoutingStrategy;
    const rule: LeadRoutingRule = { ruleId: r.ruleId, strategy };
    const m = (r.match ?? {}) as Record<string, unknown>;
    if (m.bands !== undefined) {
      if (!Array.isArray(m.bands) || !m.bands.every((b) => ALL_BANDS.includes(b as Band))) throw invalid(`rules[${i}].match.bands`, 'Bands are A–F.');
      rule.match = { ...rule.match, bands: [...new Set(m.bands as Band[])] };
    }
    if (m.sources !== undefined) {
      if (!Array.isArray(m.sources) || !m.sources.every((s) => (LEAD_SOURCES as readonly string[]).includes(s as string))) throw invalid(`rules[${i}].match.sources`, `Sources are ${LEAD_SOURCES.join(', ')}.`);
      rule.match = { ...rule.match, sources: [...new Set(m.sources as LeadSource[])] };
    }
    if (strategy === 'round-robin' || strategy === 'capacity') {
      if (!Array.isArray(r.pool) || r.pool.length === 0 || r.pool.length > MAX_POOL || !r.pool.every((s) => typeof s === 'string' && SUBJECT.test(s))) {
        throw invalid(`rules[${i}].pool`, `A ${strategy} rule needs 1 to ${MAX_POOL} owners.`);
      }
      rule.pool = [...new Set(r.pool as string[])];
    }
    if (strategy === 'capacity') {
      if (typeof r.maxOpenLeads !== 'number' || !Number.isInteger(r.maxOpenLeads) || r.maxOpenLeads < 1 || r.maxOpenLeads > 10_000) {
        throw invalid(`rules[${i}].maxOpenLeads`, 'A capacity rule needs maxOpenLeads from 1 to 10000.');
      }
      rule.maxOpenLeads = r.maxOpenLeads;
    }
    if (strategy === 'named') {
      if (typeof r.named !== 'string' || !SUBJECT.test(r.named)) throw invalid(`rules[${i}].named`, 'A named rule needs one owner.');
      rule.named = r.named;
    }
    return rule;
  });
}

const keyOf = (row: LeadRoutingPolicy): string => `${row.tenantId}::${row.orgId}::${row.version}`;
const subjectsOf = (rules: LeadRoutingRule[], actor?: string): string[] => [...new Set([
  ...(actor ? [actor] : []), ...rules.flatMap((rule) => [...(rule.pool ?? []), ...(rule.named ? [rule.named] : [])]),
])].filter((subject) => subject !== ERASED);
function publicPolicy({ publicationPending: _pending, publicationDisabled: _disabled, requestDigest: _digest, ...row }: StoredPolicy): LeadRoutingPolicy { return row; }
async function latestStored(tenantId: string, orgId: string): Promise<StoredPolicy | null> {
  const rows = (await policies.listByPrefix(`${tenantId}::${orgId}::`)).filter((row) => row.tenantId === tenantId && row.orgId === orgId);
  return rows.sort((a, b) => b.version - a.version)[0] ?? null;
}

export async function latestRoutingPolicy(tenantId: string, orgId: string): Promise<LeadRoutingPolicy | null> {
  const row = await latestStored(tenantId, orgId);
  if (row?.publicationPending || row?.publicationDisabled) {
    throw new OpenwopError('conflict', 'The routing policy is incomplete. Save it again or retry.', 409, { reason: 'routing_policy_pending', latestVersion: row.version });
  }
  return row ? publicPolicy(row) : null;
}

export async function saveRoutingPolicy(input: { tenantId: string; orgId: string; expectedVersion: number; rules: unknown; actor: string }): Promise<LeadRoutingPolicy> {
  const rules = validateRoutingRules(input.rules);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw invalid('expectedVersion', 'Expected version must be a non-negative integer.');
  const subjects = subjectsOf(rules, input.actor);
  const digest = createHash('sha256').update(JSON.stringify({ rules, actor: tombstoneId(input.tenantId, input.actor) })).digest('hex');
  const latest = await latestStored(input.tenantId, input.orgId);
  let pending: StoredPolicy;
  if (latest?.version === input.expectedVersion + 1 && latest.requestDigest === digest && !latest.publicationDisabled) {
    pending = latest; // Retry the same version after an uncertain insert/publish.
  } else {
    if ((latest?.version ?? 0) !== input.expectedVersion) throw new OpenwopError('conflict', 'This routing policy changed since you opened it.', 409, { reason: 'routing_policy_conflict', latestVersion: latest?.version ?? 0 });
    pending = {
      tenantId: input.tenantId, orgId: input.orgId, version: input.expectedVersion + 1,
      rules: [], createdBy: ERASED, createdAt: new Date().toISOString(), requestDigest: digest,
      publicationPending: { operation: randomUUID(), subjectHashes: [...new Set(subjects.flatMap((subject) => tombstoneKeyForms(subject).map((form) => tombstoneId(input.tenantId, form))))] },
    };
    if (!(await policies.compareAndSwap(null, pending))) throw new OpenwopError('conflict', 'This routing policy changed since you opened it.', 409, { reason: 'routing_policy_conflict' });
  }
  // The receipt is already visible on the same primary before raw subject ids.
  // Erasure either changes that exact row or leaves a barrier this read sees.
  for (const subject of subjects) for (const form of tombstoneKeyForms(subject)) {
    if (await isErasureTombstoned(input.tenantId, form)) throw new OpenwopError('conflict', 'A routing policy participant was erased. Refresh the owners and retry.', 409, { reason: 'routing_policy_subject_erased', latestVersion: pending.version });
  }
  if (!pending.publicationPending) return publicPolicy(pending);
  const { publicationPending: _receipt, ...rest } = pending;
  const published: StoredPolicy = { ...rest, rules, createdBy: input.actor };
  if (!(await policies.compareAndSwap(pending, published))) throw new OpenwopError('conflict', 'This routing policy changed while it was being saved. Retry.', 409, { reason: 'routing_policy_conflict', latestVersion: pending.version });
  return publicPolicy(published);
}

/** PII redaction is the explicit exception to immutable policy versions.
 * Remove erased recipients from authored rules; never route a delayed save to
 * an erased member. A staged publication is sealed without publishing its ids. */
export async function eraseRoutingPolicySubjects(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const forms = [...new Set([...subjectKeyForms(subjectKey).forms].flatMap(tombstoneKeyForms))];
  const hashes = new Set(forms.map((form) => tombstoneId(tenantId, form)));
  const request = currentErasureRequest();
  const dsarHash = tombstoneId(tenantId, request?.tenantId === tenantId ? request.requestedKey : subjectKey);
  for (const form of forms) await writeErasureTombstone(tenantId, form, dsarHash);
  const matches = (subject: string): boolean => tombstoneKeyForms(subject).some((form) => forms.includes(form));
  for (const candidate of await policies.listByPrefix(`${tenantId}::`)) {
    if (candidate.tenantId !== tenantId) continue;
    let done = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await policies.get(keyOf(candidate));
      if (!row) { done = true; break; }
      const pending = row.publicationPending?.subjectHashes.some((hash) => hashes.has(hash));
      if (!pending && !subjectsOf(row.rules, row.createdBy).some(matches)) { done = true; break; }
      const next: StoredPolicy = {
        ...row, createdBy: matches(row.createdBy) ? ERASED : row.createdBy,
        rules: row.rules.flatMap((rule) => {
          if (rule.named && matches(rule.named)) return [];
          if (!rule.pool) return [rule];
          const pool = rule.pool.filter((subject) => !matches(subject));
          return pool.length ? [{ ...rule, pool }] : [];
        }),
      };
      if (pending) { delete next.publicationPending; next.publicationDisabled = true; }
      if (await policies.compareAndSwap(row, next)) { done = true; break; }
    }
    if (!done) throw new Error('lead_routing_policy_erasure_conflict');
  }
}
