/**
 * ADR 0954 D1 — the per-client scoring model store.
 *
 * Version CONTENT is immutable; attribution follows DSAR. Rows are keyed
 * `tenant::orgId::modelId::<version>`; the
 * insert-if-absent of version N+1 IS the concurrency control (two writers who
 * both read version N race for one row and exactly one wins; the loser gets a
 * 409). A save names the version it was editing (`expectedVersion`, 0 for a new
 * model), so a stale editor can never overwrite a newer one (the ADR 0905 D1
 * shape). Which version scores a client's leads is a separate pointer row per
 * client (`tenant::orgId`), moved by compare-and-swap. No pointer ⇒ v0.
 *
 * Every row carries `tenantId` and `orgId`, so `deleteOrg` sees a client's models.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { randomUUID } from 'node:crypto';
import { ERASED, subjectKeyForms } from '../../../host/subjectErasureRedaction.js';
import { currentErasureRequest } from '../../../host/subjectErasure.js';
import { isErasureTombstoned, tombstoneId, tombstoneKeyForms, writeErasureTombstone } from '../../consent/consentService.js';
import {
  contentHashOf, validateModelContent, V0_CONTENT, V0_MODEL_ID,
  type LeadScoringModel, type LeadScoringModelContent,
} from './model.js';

const MODEL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_VERSIONS_LISTED = 200;

/** Publication starts without raw attribution. The receipt is part of the SAME
 * primary CAS row, so erasure sees it before a delayed writer can publish a name.
 * No expiry: an uncertain publication keeps only these tenant-salted hashes. */
interface AttributionReceipt { operation: string; subjectHashes: string[] }
interface PendingAttribution { tenantId: string; attributionPending?: AttributionReceipt }
type StoredModel = LeadScoringModel & PendingAttribution;
type StoredPointer = ActiveModelPointer & PendingAttribution;

const versions = new DurableCollection<StoredModel>(
  'crm:lead-model',
  (m) => `${m.tenantId}::${m.orgId}::${m.modelId}::${m.version}`,
  undefined,
  (m) => m.tenantId,
);

export interface ActiveModelPointer { tenantId: string; orgId: string; modelId: string; version: number; activatedBy: string; activatedAt: string }
const active = new DurableCollection<StoredPointer>('crm:lead-model-active', (p) => `${p.tenantId}::${p.orgId}`, undefined, (p) => p.tenantId);

const nowIso = (): string => new Date().toISOString();

// Direction matters: a user's DSAR may reach legacy raw `alice`, but expanding
// the stored `agent:alice` too would erase a different scoped principal.
const subjectForms = (key: string): string[] => [...new Set([...subjectKeyForms(key).forms].flatMap(tombstoneKeyForms))];
const actorForms = (actor: string): string[] => tombstoneKeyForms(actor);
const receipt = (tenantId: string, actor: string): AttributionReceipt => ({ operation: randomUUID(), subjectHashes: actorForms(actor).map((form) => tombstoneId(tenantId, form)) });
function publicRow<T extends PendingAttribution>(row: T): Omit<T, 'attributionPending'> {
  const { attributionPending: _pending, ...out } = row;
  return out;
}

/** The logical save/activation already committed. A lost attribution CAS or an
 * unreadable barrier must not pretend it failed and invite a second activation.
 * Return its safe, unattributed receipt; never overwrite a newer activation. */
async function publishAttribution<T extends PendingAttribution>(
  store: DurableCollection<T>, pending: T, actor: string, field: 'createdBy' | 'activatedBy',
): Promise<T> {
  try {
    for (const form of actorForms(actor)) {
      if (await isErasureTombstoned(pending.tenantId, form)) return pending;
    }
    const next: T = { ...pending, [field]: actor };
    delete next.attributionPending;
    if (await store.compareAndSwap(pending, next)) return next;
  } catch {
    // No raw identity was published before the barrier. Retain the hashed
    // receipt for erasure/restart; a provider/store error is not permission.
  }
  return pending;
}

export async function listModelVersions(tenantId: string, orgId: string, modelId: string): Promise<LeadScoringModel[]> {
  const rows = await versions.listByPrefix(`${tenantId}::${orgId}::${modelId}::`);
  return rows
    .filter((m) => m.tenantId === tenantId && m.orgId === orgId && m.modelId === modelId)
    .sort((a, b) => b.version - a.version)
    .slice(0, MAX_VERSIONS_LISTED).map(publicRow);
}

export async function getModelVersion(tenantId: string, orgId: string, modelId: string, version: number): Promise<LeadScoringModel | null> {
  const m = await versions.get(`${tenantId}::${orgId}::${modelId}::${version}`);
  return m && m.tenantId === tenantId && m.orgId === orgId ? publicRow(m) : null;
}

/** Save a new version of `modelId`. `expectedVersion` is the version the editor
 *  started from (0 for a brand-new model). */
export async function saveModelVersion(input: {
  tenantId: string; orgId: string; modelId: string; expectedVersion: number; content: unknown; actor: string;
}): Promise<LeadScoringModel> {
  const { tenantId, orgId, modelId, expectedVersion, actor } = input;
  if (!MODEL_ID.test(modelId) || modelId === V0_MODEL_ID) {
    throw new OpenwopError('validation_error', 'A model id is 1–40 lowercase letters, digits or "-", and "v0" is reserved.', 422, { field: 'modelId' });
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new OpenwopError('validation_error', '`expectedVersion` must be a non-negative integer.', 422, { field: 'expectedVersion' });
  }
  const content = validateModelContent(input.content);
  const latest = (await listModelVersions(tenantId, orgId, modelId))[0]?.version ?? 0;
  if (latest !== expectedVersion) {
    throw new OpenwopError('conflict', 'This model changed since you opened it.', 409, { reason: 'model_version_conflict', latestVersion: latest });
  }
  const row: StoredModel = {
    tenantId, orgId, modelId, version: expectedVersion + 1, ...content,
    contentHash: contentHashOf(content), createdBy: ERASED, createdAt: nowIso(),
    attributionPending: receipt(tenantId, actor),
  };
  if (!(await versions.compareAndSwap(null, row))) {
    throw new OpenwopError('conflict', 'This model changed since you opened it.', 409, { reason: 'model_version_conflict' });
  }
  return publicRow(await publishAttribution(versions, row, actor, 'createdBy'));
}

/** Point the client's scoring at one saved version. `expected` is the pointer
 *  the caller saw (`null` when none), so two admins cannot silently race. */
export async function activateModel(input: {
  tenantId: string; orgId: string; modelId: string; version: number; actor: string;
  expected: { modelId: string; version: number } | null;
}): Promise<ActiveModelPointer> {
  const { tenantId, orgId, modelId, version, actor } = input;
  if (!(await getModelVersion(tenantId, orgId, modelId, version))) {
    throw new OpenwopError('not_found', 'Model version not found.', 404, { modelId, version });
  }
  const current = await active.get(`${tenantId}::${orgId}`);
  const sameAsExpected = input.expected === null
    ? current === null
    : current !== null && current.modelId === input.expected.modelId && current.version === input.expected.version;
  if (!sameAsExpected) {
    throw new OpenwopError('conflict', 'The active model changed since you opened it.', 409, { reason: 'active_model_conflict' });
  }
  const next: StoredPointer = { tenantId, orgId, modelId, version, activatedBy: ERASED, activatedAt: nowIso(), attributionPending: receipt(tenantId, actor) };
  if (!(await active.compareAndSwap(current, next))) {
    throw new OpenwopError('conflict', 'The active model changed since you opened it.', 409, { reason: 'active_model_conflict' });
  }
  return publicRow(await publishAttribution(active, next, actor, 'activatedBy'));
}

/** Attribution erasure is independent of the display's 200-version cap and of
 * secondary markers. Retry against fresh primary rows; never restore selection
 * or content from the enumeration snapshot. Contention is a partial failure. */
export async function eraseModelAttribution(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const forms = subjectForms(subjectKey);
  const hashes = new Set(forms.map((form) => tombstoneId(tenantId, form)));
  const request = currentErasureRequest();
  const dsarHash = tombstoneId(tenantId, request?.tenantId === tenantId ? request.requestedKey : subjectKey);
  for (const form of forms) await writeErasureTombstone(tenantId, form, dsarHash);
  async function redact<T extends PendingAttribution>(store: DurableCollection<T>, field: 'createdBy' | 'activatedBy', key: (row: T) => string): Promise<void> {
    for (const observed of await store.listByPrefix(`${tenantId}::`)) {
      if (observed.tenantId !== tenantId) continue;
      let settled = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const fresh = await store.get(key(observed));
        if (!fresh || fresh.tenantId !== tenantId) { settled = true; break; }
        const rawActor = (fresh as T & { createdBy?: string; activatedBy?: string })[field];
        if (!(typeof rawActor === 'string' && actorForms(rawActor).some((form) => forms.includes(form)))
          && !fresh.attributionPending?.subjectHashes.some((hash) => hashes.has(hash))) { settled = true; break; }
        const next: T = { ...fresh, [field]: ERASED };
        delete next.attributionPending;
        if (await store.compareAndSwap(fresh, next)) { settled = true; break; }
      }
      if (!settled) throw new OpenwopError('conflict', 'Model attribution erasure needs a retry.', 409, { reason: 'model_attribution_contended' });
    }
  }
  await redact(versions, 'createdBy', (m) => `${m.tenantId}::${m.orgId}::${m.modelId}::${m.version}`);
  await redact(active, 'activatedBy', (p) => `${p.tenantId}::${p.orgId}`);
}

/** The model that scores a client's leads: its active version, else v0. */
export async function resolveActiveModel(tenantId: string, orgId: string | undefined): Promise<{ modelId: string; version: number; contentHash: string; content: LeadScoringModelContent }> {
  if (orgId) {
    const ptr = await active.get(`${tenantId}::${orgId}`);
    if (ptr && ptr.tenantId === tenantId && ptr.orgId === orgId) {
      const m = await getModelVersion(tenantId, orgId, ptr.modelId, ptr.version);
      if (m) return { modelId: m.modelId, version: m.version, contentHash: m.contentHash, content: m };
    }
  }
  return { modelId: V0_MODEL_ID, version: 0, contentHash: contentHashOf(V0_CONTENT), content: V0_CONTENT };
}
