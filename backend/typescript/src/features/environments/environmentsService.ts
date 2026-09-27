/**
 * Environments service (ADR 0387) — versions a tenant's CONFIG as
 * content-hashed, immutable snapshots with promote (copy a verified snapshot up
 * the chain), rollback (promote a prior snapshot), and an append-only history
 * ledger. This is config-versioning, NOT infra-provisioning: one tenant == one
 * workspace inside one shared deployment (ADR 0015).
 *
 * Storage (KV blobs over host_ext_kv, no SQL migration — ADR 0383 precedent):
 * - `env:environment`  keyed `${tenantId}:${name}` (deterministic ⇒ structural
 *   name-uniqueness via CAS-from-null)
 * - `env:snapshot`     keyed `${tenantId}:${hash}` (TENANT-SCOPED content-address
 *   — never bare hash, or two tenants' identical configs collide; /architect §5)
 * - `env:promotion`    keyed `${tenantId}:${promotionId}` (append-only ledger)
 *
 * The config an environment snapshots is owned by feature packages and reached
 * ONLY through the `registerConfigDomain` inversion seam (ADR 0330 precedent) —
 * environments never touches a config owner's KV directly.
 */
import { createHash, randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import {
  createEnvironmentPromotionApproval,
  findPendingEnvironmentPromotion,
  type PendingApproval,
} from '../../host/approvalService.js';
import {
  listConfigDomains,
  getConfigDomain,
  diffEntries,
  type ConfigDomainDiff,
  type ConfigDomainPayload,
  type ConfigEntryDiff,
} from '../../host/configDomains.js';

export type EnvironmentProtection = 'open' | 'protected' | 'locked';

export interface EnvironmentRecord {
  environmentId: string; // `${tenantId}:${name}`
  tenantId: string;
  name: string; // dev | staging | prod | free-form slug
  order: number; // promotion chain position (promote targets order+1)
  protection: EnvironmentProtection;
  /** Content hash of the currently-deployed snapshot, or null if never promoted. */
  currentSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigSnapshotRecord {
  snapshotId: string; // `${tenantId}:${hash}`
  tenantId: string;
  hash: string; // canonical-JSON SHA-256 over `domains`
  domains: Record<string, ConfigDomainPayload>; // keyed by domain id
  sourceEnv: string | null; // the env whose live config produced it (or null)
  createdBy: string;
  createdAt: string;
}

export interface PromotionRecord {
  promotionId: string; // `${tenantId}:${id}`
  tenantId: string;
  fromEnv: string | null; // null for a rollback (snapshot came from history)
  toEnv: string;
  snapshotHash: string;
  actor: string;
  diffSummary: Record<string, ConfigDomainDiff>;
  approvalId?: string;
  /** H2 (ADR 0387) — a ledger row's terminal disposition. Absent ⇒ the pointer
   *  moved (an applied promotion — the pre-approval-gate default; every legacy
   *  row omits it). `rejected` is a promote/rollback that was gated behind an
   *  approval and DECLINED — the pointer never moved; the row parks it. */
  status?: 'applied' | 'rejected';
  createdAt: string;
}

/** H2 (ADR 0387) — per-tenant environments settings. Today just the opt-in
 *  promotion-approval gate; a struct so future knobs are additive. Stored as a
 *  single KV row per tenant (no SQL migration — the ADR 0383/0387 precedent). */
export interface EnvironmentSettings {
  tenantId: string;
  /** When ON, a promote/rollback does NOT move the pointer — it queues an
   *  approval in the SHARED host reviews inbox and the move applies only after a
   *  member with `host:members:manage` approves it (fail-closed). Default OFF. */
  requireApprovalForPromotion: boolean;
  updatedAt: string;
}

const environments = new DurableCollection<EnvironmentRecord>('env:environment', (e) => e.environmentId, undefined, (e) => e.tenantId);
const snapshots = new DurableCollection<ConfigSnapshotRecord>('env:snapshot', (s) => s.snapshotId, undefined, (s) => s.tenantId);
const promotions = new DurableCollection<PromotionRecord>('env:promotion', (p) => p.promotionId, undefined, (p) => p.tenantId);
const settingsStore = new DurableCollection<EnvironmentSettings>('env:settings', (s) => s.tenantId, undefined, (s) => s.tenantId);

export const MAX_ENVIRONMENTS_PER_TENANT = 20;

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const envKey = (tenantId: string, name: string): string => `${tenantId}:${name}`;
const snapKey = (tenantId: string, hash: string): string => `${tenantId}:${hash}`;

function normalizeEnvName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new OpenwopError('validation_error', 'Environment name must be a slug: a letter then letters/digits/`_`/`-`, max 32 chars.', 400, { field: 'name' });
  }
  return name;
}

/**
 * Canonical JSON: recursively sort object KEYS so equal configs serialize
 * identically. Arrays are emitted in place — a domain payload MUST NOT rely on
 * array order (the determinism contract in configDomains.ts); this function
 * does not (cannot) sort array elements.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function hashDomains(domains: Record<string, ConfigDomainPayload>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(domains))).digest('hex').slice(0, 32);
}

/** Capture the tenant's CURRENT live config across all registered domains. */
export async function captureLiveConfig(tenantId: string): Promise<Record<string, ConfigDomainPayload>> {
  const out: Record<string, ConfigDomainPayload> = {};
  for (const domain of listConfigDomains()) {
    out[domain.id] = await domain.export(tenantId);
  }
  return out;
}

/** Compute the live config hash on demand (NOT on every env read — /architect
 *  HIGH: drift must be lazy, never a per-render O(config) fan-out). */
export async function liveConfigHash(tenantId: string): Promise<string> {
  return hashDomains(await captureLiveConfig(tenantId));
}

/** Persist a snapshot of the tenant's current live config (content-addressed;
 *  dedupes on hash — re-snapshotting identical config is a no-op returning the
 *  existing row). */
export async function snapshotLiveConfig(input: {
  tenantId: string;
  sourceEnv: string | null;
  createdBy: string;
}): Promise<ConfigSnapshotRecord> {
  const domains = await captureLiveConfig(input.tenantId);
  const hash = hashDomains(domains);
  const existing = await snapshots.get(snapKey(input.tenantId, hash));
  if (existing) return existing;
  const rec: ConfigSnapshotRecord = {
    snapshotId: snapKey(input.tenantId, hash),
    tenantId: input.tenantId,
    hash,
    domains,
    sourceEnv: input.sourceEnv,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  // CAS-from-null: concurrent identical snapshots converge on the same row.
  const won = await snapshots.compareAndSwap(null, rec);
  if (!won) {
    const raced = await snapshots.get(rec.snapshotId);
    if (raced) return raced;
  }
  return rec;
}

export async function getSnapshot(tenantId: string, hash: string): Promise<ConfigSnapshotRecord | null> {
  const rec = await snapshots.get(snapKey(tenantId, hash));
  return rec && rec.tenantId === tenantId ? rec : null;
}

export async function listSnapshots(tenantId: string): Promise<ConfigSnapshotRecord[]> {
  const all = await snapshots.listForTenantIndexed(tenantId);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Environments ───────────────────────────────────────────────────────────

export async function createEnvironment(input: {
  tenantId: string;
  name: string;
  order?: number;
  protection?: EnvironmentProtection;
}): Promise<EnvironmentRecord> {
  const name = normalizeEnvName(input.name);
  const existing = await environments.listForTenantIndexed(input.tenantId);
  if (existing.length >= MAX_ENVIRONMENTS_PER_TENANT) {
    throw new OpenwopError('conflict', `Environment cap reached (${MAX_ENVIRONMENTS_PER_TENANT} per workspace).`, 409, {});
  }
  const protection: EnvironmentProtection =
    input.protection ?? (name === 'prod' ? 'protected' : 'open');
  if (!['open', 'protected', 'locked'].includes(protection)) {
    throw new OpenwopError('validation_error', 'protection must be open | protected | locked.', 400, { field: 'protection' });
  }
  const order = input.order ?? existing.length;
  const now = new Date().toISOString();
  const rec: EnvironmentRecord = {
    environmentId: envKey(input.tenantId, name),
    tenantId: input.tenantId,
    name,
    order,
    protection,
    currentSnapshot: null,
    createdAt: now,
    updatedAt: now,
  };
  const won = await environments.compareAndSwap(null, rec);
  if (!won) throw new OpenwopError('conflict', `An environment named \`${name}\` already exists.`, 409, { name });
  return rec;
}

/** Seed the conventional dev→staging→prod chain if the tenant has none. */
export async function ensureDefaultChain(tenantId: string): Promise<EnvironmentRecord[]> {
  const existing = await environments.listForTenantIndexed(tenantId);
  if (existing.length > 0) return existing.sort((a, b) => a.order - b.order);
  const created: EnvironmentRecord[] = [];
  const chain: Array<{ name: string; protection: EnvironmentProtection }> = [
    { name: 'dev', protection: 'open' },
    { name: 'staging', protection: 'open' },
    { name: 'prod', protection: 'protected' },
  ];
  for (let i = 0; i < chain.length; i += 1) {
    const c = chain[i];
    if (!c) continue;
    created.push(await createEnvironment({ tenantId, name: c.name, order: i, protection: c.protection }));
  }
  return created;
}

export async function getEnvironment(tenantId: string, name: string): Promise<EnvironmentRecord | null> {
  const rec = await environments.get(envKey(tenantId, name));
  return rec && rec.tenantId === tenantId ? rec : null;
}

export async function listEnvironments(tenantId: string): Promise<EnvironmentRecord[]> {
  const all = await environments.listForTenantIndexed(tenantId);
  return all.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export interface EnvironmentView extends EnvironmentRecord {
  /** Whether the live config drifted from the pinned snapshot — computed ONLY
   *  when explicitly requested (never on plain list). */
  drift?: { drifted: boolean; liveHash: string };
}

/** Environment view WITH drift computed on demand (the /architect fix: not on
 *  every list — the caller opts in). Live hash is computed once and compared to
 *  each env's pinned snapshot. */
export async function listEnvironmentsWithDrift(tenantId: string): Promise<EnvironmentView[]> {
  const envs = await listEnvironments(tenantId);
  const liveHash = await liveConfigHash(tenantId);
  return envs.map((e) => ({
    ...e,
    drift: { drifted: e.currentSnapshot !== null && e.currentSnapshot !== liveHash, liveHash },
  }));
}

export async function setProtection(input: {
  tenantId: string;
  name: string;
  protection: EnvironmentProtection;
}): Promise<EnvironmentRecord | null> {
  if (!['open', 'protected', 'locked'].includes(input.protection)) {
    throw new OpenwopError('validation_error', 'protection must be open | protected | locked.', 400, { field: 'protection' });
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await environments.get(envKey(input.tenantId, input.name));
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const next = { ...existing, protection: input.protection, updatedAt: new Date().toISOString() };
    if (await environments.compareAndSwap(existing, next)) return next;
  }
  throw new OpenwopError('conflict', 'Concurrent environment update — retry.', 409, { name: input.name });
}

// ── Settings (H2 promotion-approval gate) ────────────────────────────────────

/** Read the tenant's environments settings, defaulting every knob OFF so an
 *  un-configured tenant keeps the exact pre-H2 behavior (zero drift). */
export async function getEnvironmentSettings(tenantId: string): Promise<{ requireApprovalForPromotion: boolean }> {
  const rec = await settingsStore.get(tenantId);
  return { requireApprovalForPromotion: rec?.requireApprovalForPromotion ?? false };
}

/** Patch the tenant's environments settings (CAS; only supplied fields change). */
export async function setEnvironmentSettings(
  tenantId: string,
  patch: { requireApprovalForPromotion?: boolean },
): Promise<{ requireApprovalForPromotion: boolean }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await settingsStore.get(tenantId);
    const next: EnvironmentSettings = {
      tenantId,
      requireApprovalForPromotion:
        patch.requireApprovalForPromotion ?? existing?.requireApprovalForPromotion ?? false,
      updatedAt: new Date().toISOString(),
    };
    const won = existing
      ? await settingsStore.compareAndSwap(existing, next)
      : await settingsStore.compareAndSwap(null, next);
    if (won) return { requireApprovalForPromotion: next.requireApprovalForPromotion };
  }
  throw new OpenwopError('conflict', 'Concurrent settings update — retry.', 409, {});
}

// ── Diff ───────────────────────────────────────────────────────────────────

export function diffSnapshots(
  from: ConfigSnapshotRecord | null,
  to: ConfigSnapshotRecord,
): Record<string, ConfigDomainDiff> {
  return diffDomainPayloads(from?.domains ?? null, to.domains);
}

/**
 * The payload-level form of `diffSnapshots`. Extracted (ENV2-M1) so the
 * apply-to-live gate can diff a snapshot against the tenant's CURRENT LIVE
 * config, which is a payload map and not a stored snapshot record — rather than
 * casting a synthetic record to fit the old signature.
 */
export function diffDomainPayloads(
  from: Record<string, ConfigDomainPayload> | null,
  to: Record<string, ConfigDomainPayload>,
): Record<string, ConfigDomainDiff> {
  const out: Record<string, ConfigDomainDiff> = {};
  for (const [domainId, toPayload] of Object.entries(to)) {
    const domain = getConfigDomain(domainId);
    if (!domain) continue;
    out[domainId] = domain.diff(from?.[domainId], toPayload);
  }
  return out;
}

/**
 * ENV2-M1 — a one-line, human-readable account of WHAT a promotion changes, for
 * the approval a reviewer actually reads.
 *
 * The gate's proposal used to be `Deploy snapshot <12 hex chars>… to "prod"`.
 * That reaches the reviewer verbatim (`reviewProjection.ts` falls back
 * `summary ?? proposal`, and `ReviewCard` renders it), so the person holding
 * `host:members:manage` decided a LIVE config change knowing the destination and
 * a truncated hash — and nothing about the substance. The gate exists precisely
 * so a human reviews the change; a hash is not reviewable.
 *
 * Built from `diffSnapshots`, which this module already computes for the preview
 * path, so the review and the preview cannot disagree — and the counts stay each
 * domain's own `diff()` rather than a second opinion invented here.
 */
export function describeSnapshotChange(diff: Record<string, ConfigDomainDiff>): string {
  const parts: string[] = [];
  for (const domainId of Object.keys(diff).sort()) {
    const d = diff[domainId];
    if (!d) continue;
    const bits: string[] = [];
    if (d.added) bits.push(`+${d.added}`);
    if (d.changed) bits.push(`~${d.changed}`);
    if (d.removed) bits.push(`-${d.removed}`);
    if (bits.length) parts.push(`${domainId} ${bits.join(' ')}`);
  }
  // "no config entries change" is a REAL and useful answer here — a promotion
  // can move a pointer to a snapshot that differs only in metadata. Saying so
  // is not the same as saying nothing, which is what the hash alone did.
  return parts.length ? parts.join(', ') : 'no config entries change';
}

/**
 * The value-level companion to `diffSnapshots`. Only domains with at least one
 * entry change appear, so the payload stays proportional to what actually moved.
 */
export function entryDiffSnapshots(
  from: ConfigSnapshotRecord | null,
  to: ConfigSnapshotRecord,
): Record<string, ConfigEntryDiff> {
  const out: Record<string, ConfigEntryDiff> = {};
  for (const [domainId, toPayload] of Object.entries(to.domains)) {
    if (!getConfigDomain(domainId)) continue;
    const d = diffEntries(from?.domains[domainId], toPayload);
    if (d.changes.length > 0 || d.truncated > 0) out[domainId] = d;
  }
  return out;
}

// ── Promotion / rollback / apply ─────────────────────────────────────────────

export async function listPromotions(tenantId: string): Promise<PromotionRecord[]> {
  const all = await promotions.listForTenantIndexed(tenantId);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Bound the append-only ledger (grade-data D5): keep the newest
 *  `PROMOTION_LEDGER_CAP` rows per tenant; prune the oldest past it. */
export const PROMOTION_LEDGER_CAP = 200;

async function prunePromotions(tenantId: string): Promise<void> {
  const all = await promotions.listForTenantIndexed(tenantId);
  if (all.length <= PROMOTION_LEDGER_CAP) return;
  const oldestFirst = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const row of oldestFirst.slice(0, all.length - PROMOTION_LEDGER_CAP)) {
    await promotions.delete(row.promotionId);
  }
}

/** Preview the diff a promote/rollback WOULD apply (no side effects) — feeds the
 *  wizard before commit. `toEnv`'s current snapshot is the "from" baseline. */
export async function previewPromotion(input: {
  tenantId: string;
  toEnvName: string;
  snapshotHash: string;
}): Promise<{
  diffSummary: Record<string, ConfigDomainDiff>;
  /** ADR 0387 § value-level preview — the entries behind the counts, per domain.
   *  The counts remain each domain's own `diff()`; this is the detail. */
  entryDiff: Record<string, ConfigEntryDiff>;
  snapshot: ConfigSnapshotRecord;
  toEnv: EnvironmentRecord;
}> {
  const toEnv = await getEnvironment(input.tenantId, input.toEnvName);
  if (!toEnv) throw new OpenwopError('not_found', 'Environment not found.', 404, { name: input.toEnvName });
  const snapshot = await getSnapshot(input.tenantId, input.snapshotHash);
  if (!snapshot) throw new OpenwopError('not_found', 'Snapshot not found.', 404, { hash: input.snapshotHash });
  const from = toEnv.currentSnapshot ? await getSnapshot(input.tenantId, toEnv.currentSnapshot) : null;
  return {
    diffSummary: diffSnapshots(from, snapshot),
    entryDiff: entryDiffSnapshots(from, snapshot),
    snapshot,
    toEnv,
  };
}

/**
 * Move an environment's pinned pointer to `snapshotHash` (a promote or a
 * rollback) and append the ledger row. IDEMPOTENT by hash: pinning a hash an
 * env already points at is a no-op (the ledger still records the attempt).
 * `locked` environments reject all pointer moves. The pointer move is a CAS on
 * the Environment row (/architect §4: a concurrent drift-write is detected, not
 * silently overwritten). Authorization is the ROUTE's concern (protected →
 * admin/approval); this service method assumes it was gated.
 */
export async function movePointer(input: {
  tenantId: string;
  fromEnvName: string | null; // null ⇒ rollback (from history)
  toEnvName: string;
  snapshotHash: string;
  actor: string;
  approvalId?: string;
}): Promise<{ promotion: PromotionRecord; environment: EnvironmentRecord; noop: boolean }> {
  const snapshot = await getSnapshot(input.tenantId, input.snapshotHash);
  if (!snapshot) throw new OpenwopError('not_found', 'Snapshot not found.', 404, { hash: input.snapshotHash });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const toEnv = await getEnvironment(input.tenantId, input.toEnvName);
    if (!toEnv) throw new OpenwopError('not_found', 'Environment not found.', 404, { name: input.toEnvName });
    if (toEnv.protection === 'locked') {
      throw new OpenwopError('conflict', 'Environment is locked (change-freeze).', 409, { name: toEnv.name });
    }
    const from = toEnv.currentSnapshot ? await getSnapshot(input.tenantId, toEnv.currentSnapshot) : null;
    const diffSummary = diffSnapshots(from, snapshot);
    const noop = toEnv.currentSnapshot === snapshot.hash;

    const promotion: PromotionRecord = {
      promotionId: `${input.tenantId}:${randomUUID()}`,
      tenantId: input.tenantId,
      fromEnv: input.fromEnvName,
      toEnv: toEnv.name,
      snapshotHash: snapshot.hash,
      actor: input.actor,
      diffSummary,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      createdAt: new Date().toISOString(),
    };

    if (noop) {
      await promotions.put(promotion); // ledger records the no-op; pointer unchanged
      await prunePromotions(input.tenantId);
      emitPromoted(input.tenantId, toEnv.name, snapshot.hash, true);
      return { promotion, environment: toEnv, noop: true };
    }

    const nextEnv = { ...toEnv, currentSnapshot: snapshot.hash, updatedAt: new Date().toISOString() };
    if (await environments.compareAndSwap(toEnv, nextEnv)) {
      await promotions.put(promotion);
      await prunePromotions(input.tenantId);
      emitPromoted(input.tenantId, toEnv.name, snapshot.hash, false);
      return { promotion, environment: nextEnv, noop: false };
    }
    // CAS miss — the env row changed under us (a drift-write); re-read + re-diff.
  }
  throw new OpenwopError('conflict', 'Concurrent environment update — retry.', 409, { name: input.toEnvName });
}

/** The applied-pointer-move result (the pre-H2 shape). */
export interface AppliedPromotion {
  promotion: PromotionRecord;
  environment: EnvironmentRecord;
  noop: boolean;
}
/** H2 — a promote/rollback that the approval gate intercepted: nothing moved;
 *  a review is pending. Route returns a typed 202, NOT a success mutation. */
export interface PendingPromotionApproval {
  pendingApproval: PendingApproval;
}
export type PromotionOutcome = AppliedPromotion | PendingPromotionApproval;

/** Narrowing guard for the promote/rollback union (route + tests). */
export function isPendingApproval(o: PromotionOutcome): o is PendingPromotionApproval {
  return 'pendingApproval' in o;
}

/**
 * H2 gate (ADR 0387) — when the tenant opted into `requireApprovalForPromotion`,
 * a pointer move is intercepted: instead of applying, queue an
 * `environment-promotion` approval in the SHARED reviews inbox and return it.
 * Returns null when the gate is OFF, or when the move would be a NO-OP (the
 * pointer already at this hash — nothing to approve; let the caller record the
 * idempotent no-op unchanged). Idempotent: an identical pending gate
 * (same toEnv + snapshotHash) is REUSED, never duplicated. `locked` is a hard
 * change-freeze that rejects even the request (fail-closed, before any queue).
 */
async function maybeGatePromotion(input: {
  tenantId: string;
  fromEnvName: string | null;
  toEnvName: string;
  snapshotHash: string;
  actor: string;
}): Promise<PendingApproval | null> {
  const { requireApprovalForPromotion } = await getEnvironmentSettings(input.tenantId);
  if (!requireApprovalForPromotion) return null;
  const toEnv = await getEnvironment(input.tenantId, input.toEnvName);
  if (!toEnv) throw new OpenwopError('not_found', 'Environment not found.', 404, { name: input.toEnvName });
  if (toEnv.protection === 'locked') {
    throw new OpenwopError('conflict', 'Environment is locked (change-freeze).', 409, { name: toEnv.name });
  }
  if (toEnv.currentSnapshot === input.snapshotHash) return null; // no-op — nothing to gate
  const snapshot = await getSnapshot(input.tenantId, input.snapshotHash);
  if (!snapshot) throw new OpenwopError('not_found', 'Snapshot not found.', 404, { hash: input.snapshotHash });
  // Idempotent: a pending gate for the SAME target+hash is the deterministic
  // key — re-submitting the same promote returns the existing review, never a
  // second one.
  const existing = await findPendingEnvironmentPromotion(input.tenantId, input.toEnvName, input.snapshotHash);
  if (existing) return existing;
  // ENV2-M1 — the target's CURRENT snapshot is the baseline the reviewer is
  // implicitly being asked about ("what changes if I approve this?").
  const current = toEnv.currentSnapshot ? await getSnapshot(input.tenantId, toEnv.currentSnapshot) : null;
  const change = describeSnapshotChange(diffSnapshots(current, snapshot));
  return createEnvironmentPromotionApproval({
    tenantId: input.tenantId,
    toEnv: input.toEnvName,
    fromEnv: input.fromEnvName,
    snapshotHash: input.snapshotHash,
    requestedBy: input.actor, // ADR 0732 D1 — the proposer, previously dropped here
    proposal: `Deploy snapshot ${input.snapshotHash.slice(0, 12)}… to "${input.toEnvName}" — ${change}`,
  });
}

/**
 * Record a REJECTED promotion into the ledger (H2) — a gated promote/rollback a
 * reviewer declined. The pointer never moved; the row parks the decision (with
 * its `approvalId`) so the promotions history is honest about the attempt.
 */
export async function recordRejectedPromotion(input: {
  tenantId: string;
  fromEnvName: string | null;
  toEnvName: string;
  snapshotHash: string;
  actor: string;
  approvalId: string;
}): Promise<PromotionRecord> {
  const snapshot = await getSnapshot(input.tenantId, input.snapshotHash);
  const toEnv = await getEnvironment(input.tenantId, input.toEnvName);
  const from = toEnv?.currentSnapshot ? await getSnapshot(input.tenantId, toEnv.currentSnapshot) : null;
  const rec: PromotionRecord = {
    promotionId: `${input.tenantId}:${randomUUID()}`,
    tenantId: input.tenantId,
    fromEnv: input.fromEnvName,
    toEnv: input.toEnvName,
    snapshotHash: input.snapshotHash,
    actor: input.actor,
    diffSummary: snapshot ? diffSnapshots(from, snapshot) : {},
    approvalId: input.approvalId,
    status: 'rejected',
    createdAt: new Date().toISOString(),
  };
  await promotions.put(rec);
  await prunePromotions(input.tenantId);
  return rec;
}

/**
 * Promote a source env's blessed snapshot to the next env in the chain
 * (order+1), or to an explicit `toEnvName`. The source MUST have a pinned
 * snapshot. Skipping the chain (a non-adjacent hop) is allowed only when the
 * caller passes an explicit target (the route gates this on admin authority).
 *
 * H2: when the tenant opted into the approval gate, the pointer does NOT move —
 * a review is queued and the pending approval is returned (`isPendingApproval`).
 */
export async function promote(input: {
  tenantId: string;
  fromEnvName: string;
  toEnvName?: string;
  actor: string;
  approvalId?: string;
}): Promise<PromotionOutcome> {
  const fromEnv = await getEnvironment(input.tenantId, input.fromEnvName);
  if (!fromEnv) throw new OpenwopError('not_found', 'Environment not found.', 404, { name: input.fromEnvName });
  if (!fromEnv.currentSnapshot) {
    throw new OpenwopError('conflict', 'Source environment has no snapshot to promote.', 409, { name: fromEnv.name });
  }
  let toEnvName = input.toEnvName;
  if (!toEnvName) {
    const envs = await listEnvironments(input.tenantId);
    const next = envs.find((e) => e.order === fromEnv.order + 1);
    if (!next) throw new OpenwopError('conflict', 'No next environment in the chain to promote to.', 409, { fromEnv: fromEnv.name });
    toEnvName = next.name;
  }
  // H2 gate: an approval-gated promotion never moves the pointer here.
  if (!input.approvalId) {
    const gated = await maybeGatePromotion({
      tenantId: input.tenantId,
      fromEnvName: fromEnv.name,
      toEnvName,
      snapshotHash: fromEnv.currentSnapshot,
      actor: input.actor,
    });
    if (gated) return { pendingApproval: gated };
  }
  return movePointer({
    tenantId: input.tenantId,
    fromEnvName: fromEnv.name,
    toEnvName,
    snapshotHash: fromEnv.currentSnapshot,
    actor: input.actor,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
  });
}

/** Rollback = pin a PRIOR snapshot hash onto an environment (from history).
 *  Subject to the same H2 approval gate as promote. */
export async function rollback(input: {
  tenantId: string;
  envName: string;
  snapshotHash: string;
  actor: string;
  approvalId?: string;
}): Promise<PromotionOutcome> {
  if (!input.approvalId) {
    const gated = await maybeGatePromotion({
      tenantId: input.tenantId,
      fromEnvName: null,
      toEnvName: input.envName,
      snapshotHash: input.snapshotHash,
      actor: input.actor,
    });
    if (gated) return { pendingApproval: gated };
  }
  return movePointer({
    tenantId: input.tenantId,
    fromEnvName: null,
    toEnvName: input.envName,
    snapshotHash: input.snapshotHash,
    actor: input.actor,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
  });
}

/**
 * Materialize a snapshot as the tenant's LIVE config — restore each domain's
 * payload through its `import` (EXACT-MATCH: applies the payload AND clears live
 * config the payload omits, so a subsequent capture hashes back to this
 * snapshot — /architect §3). This is the only path that mutates live config; it
 * is gated by the route (admin authority). Returns the applied hash.
 */
/** Sentinel target for a direct apply-to-live gate row (no pointer move). */
export const LIVE_APPLY_TARGET = '__live__';

export async function applyToLive(input: { tenantId: string; snapshotHash: string; actor: string; approvalId?: string }): Promise<{
  hash: string;
  domains: Array<{ id: string; ok: boolean; error?: string }>;
  pendingApproval?: PendingApproval;
}> {
  const snapshot = await getSnapshot(input.tenantId, input.snapshotHash);
  if (!snapshot) throw new OpenwopError('not_found', 'Snapshot not found.', 404, { hash: input.snapshotHash });
  // Phase-3 review MEDIUM-1: /apply is an equal-or-greater effect than a
  // pointer move, so the opt-in promotion gate MUST cover it too — otherwise a
  // tenant that gated promotions still has an ungated path into live config.
  if (!input.approvalId) {
    const { requireApprovalForPromotion } = await getEnvironmentSettings(input.tenantId);
    if (requireApprovalForPromotion) {
      const existing = await findPendingEnvironmentPromotion(input.tenantId, LIVE_APPLY_TARGET, input.snapshotHash);
      const gated = existing ?? await createEnvironmentPromotionApproval({
        tenantId: input.tenantId,
        toEnv: LIVE_APPLY_TARGET,
        fromEnv: null,
        snapshotHash: input.snapshotHash,
        requestedBy: input.actor, // ADR 0732 D1 — the proposer (apply-to-live lane)
        // ENV2-M1 — the baseline for an apply-to-live is the tenant's CURRENT
        // live config, not another snapshot. `captureLiveConfig` is a full
        // O(domains) fan-out and the module warns that drift must stay lazy —
        // this is fine HERE because it runs once per GATED promotion (rare,
        // human-initiated), not per render. Do not lift it somewhere hot.
        proposal: `Apply snapshot ${input.snapshotHash.slice(0, 12)}… directly to LIVE config — ${
          describeSnapshotChange(diffDomainPayloads(await captureLiveConfig(input.tenantId), snapshot.domains))
        }`,
      });
      return { hash: input.snapshotHash, domains: [], pendingApproval: gated };
    }
  }
  // Per-domain isolation (grade-code #2): one domain's failure never silently
  // half-applies the whole restore — every domain is attempted, each outcome is
  // REPORTED, and a partial apply surfaces as a 409 naming the failed domains
  // (the caller can retry; imports are exact-match idempotent).
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const domain of listConfigDomains()) {
    const payload = snapshot.domains[domain.id];
    if (payload === undefined) continue; // a domain registered after the snapshot — skip
    try {
      await domain.import(input.tenantId, payload);
      results.push({ id: domain.id, ok: true });
    } catch (err) {
      results.push({ id: domain.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new OpenwopError(
      'conflict',
      `Apply partially failed — domains: ${failed.map((f) => f.id).join(', ')}. Transient failures are retry-safe; entries naming missing content need a newer snapshot.`,
      409,
      { hash: snapshot.hash, domains: results },
    );
  }
  emitApplied(input.tenantId, snapshot.hash);
  return { hash: snapshot.hash, domains: results };
}

function emitPromoted(tenantId: string, toEnv: string, hash: string, noop: boolean): void {
  void emitHostEvent({ type: 'host.environments.promoted', tenantId, payload: { toEnv, snapshotHash: hash, noop } });
}
function emitApplied(tenantId: string, hash: string): void {
  void emitHostEvent({ type: 'host.environments.applied', tenantId, payload: { snapshotHash: hash } });
}
