/**
 * ADR 0923 D4–D7 — change sets: the hashed package an approval names.
 *
 * Immutable once proposed (only `status` moves, by CAS). Regenerating after a
 * request edit or an asset move always mints a new change set with a new hash;
 * the old one goes `stale`.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { contentHashOf } from './contentHash.js';
import { adapterFor } from './adapters/registry.js';
import { getAsset } from './assetService.js';
import { getRequest, markProposed, requestSourceOf } from './requestService.js';
import { validateProposal, type ProposalAssetContext } from './validation.js';
import type { ChangeSet, ChangeSetEntry, ChangeSetStatus } from './types.js';

const changeSets = new DurableCollection<ChangeSet>(
  'campaign-ops:changeset',
  (c) => `${c.tenantId}::${c.orgId}::${c.changeSetId}`,
  undefined,
  (c) => c.tenantId,
);
/** One change set per idempotency key: a fork or a retried node returns the first. */
interface KeyClaim { tenantId: string; key: string; changeSetId: string }
const keyClaims = new DurableCollection<KeyClaim>('campaign-ops:changeset-key', (k) => `${k.tenantId}::${k.key}`, undefined, (k) => k.tenantId);

const nowIso = (): string => new Date().toISOString();

/** ADR 0923 D6. Model, cost, timestamps and status are NOT in the hash. */
export function changeSetHashOf(cs: Pick<ChangeSet, 'orgId' | 'requestId' | 'requestVersion' | 'entries'>): string {
  const entries = [...cs.entries]
    .sort((a, b) => a.assetId.localeCompare(b.assetId))
    .map((e) => ({ assetId: e.assetId, destination: e.destination, sourceVersion: e.sourceVersion, sourceContentHash: e.sourceContentHash, edits: e.edits, targetContentHash: e.targetContentHash }));
  return contentHashOf({ orgId: cs.orgId, requestId: cs.requestId, requestVersion: cs.requestVersion, entries });
}

export async function getChangeSet(tenantId: string, orgId: string, changeSetId: string): Promise<ChangeSet | null> {
  const c = await changeSets.get(`${tenantId}::${orgId}::${changeSetId}`);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

export async function listChangeSets(tenantId: string, orgId: string): Promise<ChangeSet[]> {
  return (await changeSets.listForTenantIndexed(tenantId))
    .filter((c) => c.tenantId === tenantId && c.orgId === orgId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The editable fields' current values for every asset of the request (the
 *  planner reads before it proposes). */
export async function proposalContextOf(tenantId: string, orgId: string, assetIds: readonly string[]): Promise<Array<ProposalAssetContext & { label: string; sourceVersion: number }>> {
  const out: Array<ProposalAssetContext & { label: string; sourceVersion: number }> = [];
  for (const id of assetIds) {
    const asset = await getAsset(tenantId, orgId, id);
    const snap = asset ? await adapterFor(asset.destination)?.read(asset, { tenantId }) : null;
    if (!asset || !snap) throw new OpenwopError('not_found', 'An asset of this request is gone.', 404, { assetId: id, reason: 'asset_gone' });
    const fields: Record<string, string> = {};
    for (const f of asset.editableFields) if (typeof snap.fields[f] === 'string') fields[f] = snap.fields[f];
    out.push({ assetId: id, label: asset.label, editableFields: asset.editableFields, fields, sourceVersion: snap.version });
  }
  return out;
}

export type ProposeOutcome =
  | { kind: 'created' | 'existing'; changeSet: ChangeSet }
  | { kind: 'no_changes' }
  | { kind: 'invalid'; errors: string[] };

/**
 * ADR 0923 D5 — validate the planner's edits against a FRESH read of every
 * asset, then mint the change set. `invalid` is returned (not thrown) so the
 * node can make its one error-fed repair with these exact errors.
 */
export async function proposeChangeSet(input: {
  tenantId: string; orgId: string; requestId: string; version: number;
  proposal: unknown; idempotencyKey: string; createdBy: string;
  model?: { provider?: string; model?: string };
}): Promise<ProposeOutcome> {
  const claimId = `${input.tenantId}::${input.idempotencyKey}`;
  const claimed = await keyClaims.get(claimId);
  if (claimed) {
    const existing = await getChangeSet(input.tenantId, input.orgId, claimed.changeSetId);
    if (existing) return { kind: 'existing', changeSet: existing };
  }
  const req = await getRequest(input.tenantId, input.orgId, input.requestId);
  if (!req) throw new OpenwopError('not_found', 'Request not found.', 404, { requestId: input.requestId });
  if (req.version !== input.version) throw new OpenwopError('conflict', 'This request was edited; the old version is no longer worked on.', 409, { reason: 'request_changed' });
  if (req.status !== 'proposing' || !req.interpretation) {
    throw new OpenwopError('validation_error', `This request is not ready for a proposal (status: ${req.status}).`, 409, { reason: 'not_ready', status: req.status });
  }
  const ctx = await proposalContextOf(input.tenantId, input.orgId, req.assetIds);
  const source = requestSourceOf(req);
  const checked = validateProposal(input.proposal, { assets: ctx, intents: req.interpretation.intents, requestText: source.text, answers: source.answers });
  if (!checked.ok) return { kind: 'invalid', errors: checked.errors };
  if (checked.value.length === 0) {
    await markProposed(input.tenantId, input.orgId, input.requestId, input.version, null);
    return { kind: 'no_changes' };
  }

  const entries: ChangeSetEntry[] = [];
  for (const p of checked.value) {
    const asset = await getAsset(input.tenantId, input.orgId, p.assetId);
    const adapter = asset ? adapterFor(asset.destination) : undefined;
    const preview = asset && adapter ? await adapter.preview(asset, p.edits, { tenantId: input.tenantId }) : { refused: 'asset_gone' as const };
    if ('refused' in preview) return { kind: 'invalid', errors: [`asset ${p.assetId}: ${preview.refused}${'field' in preview && preview.field ? ` (${preview.field})` : ''}`] };
    const label = ctx.find((c) => c.assetId === p.assetId)?.label ?? p.assetId;
    entries.push({
      assetId: p.assetId,
      destination: asset!.destination,
      label,
      sourceVersion: preview.sourceVersion,
      sourceContentHash: preview.sourceContentHash,
      edits: p.edits,
      targetContentHash: preview.targetFieldsHash,
    });
  }
  const now = nowIso();
  const base = { orgId: input.orgId, requestId: input.requestId, requestVersion: input.version, entries };
  const cs: ChangeSet = {
    tenantId: input.tenantId,
    ...base,
    changeSetId: `cset:${randomUUID()}`,
    hash: changeSetHashOf(base),
    status: 'proposed',
    ...(input.model && (input.model.provider || input.model.model) ? { model: input.model } : {}),
    idempotencyKey: input.idempotencyKey,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  // Write the row, THEN claim the key. A racing duplicate that loses the claim
  // deletes its own row and returns the winner's; a crash between the two
  // leaves an unreferenced row, never a claim pointing at nothing.
  await changeSets.put(cs);
  if (!(await keyClaims.compareAndSwap(null, { tenantId: input.tenantId, key: input.idempotencyKey, changeSetId: cs.changeSetId }))) {
    await changeSets.delete(`${input.tenantId}::${input.orgId}::${cs.changeSetId}`);
    const winner = await keyClaims.get(claimId);
    const existing = winner ? await getChangeSet(input.tenantId, input.orgId, winner.changeSetId) : null;
    if (existing) return { kind: 'existing', changeSet: existing };
    throw new OpenwopError('conflict', 'A proposal for this request is already being created.', 409, { reason: 'proposal_in_flight' });
  }
  await markProposed(input.tenantId, input.orgId, input.requestId, input.version, cs.changeSetId);
  return { kind: 'created', changeSet: cs };
}

/** Status moves by CAS. Returns null when the change set is not in `from`. */
export async function transitionChangeSet(
  tenantId: string, orgId: string, changeSetId: string, from: readonly ChangeSetStatus[], to: ChangeSetStatus,
  extra: Partial<Pick<ChangeSet, 'staleReason'>> = {},
): Promise<ChangeSet | null> {
  const cur = await getChangeSet(tenantId, orgId, changeSetId);
  if (!cur || !from.includes(cur.status)) return null;
  const next: ChangeSet = { ...cur, ...extra, status: to, updatedAt: nowIso() };
  return (await changeSets.compareAndSwap(cur, next)) ? next : null;
}

/** ADR 0923 D1 — an edited request leaves its old change set unapprovable. */
export async function markStaleForRequest(tenantId: string, orgId: string, changeSetId: string | undefined): Promise<void> {
  if (!changeSetId) return;
  await transitionChangeSet(tenantId, orgId, changeSetId, ['proposed', 'in_review'], 'stale', { staleReason: 'request_changed' });
}

/** ADR 0923 D7 — the per-asset field diff, computed from the stored edits, so
 *  what is shown is exactly what is hashed. */
export async function diffOf(tenantId: string, cs: ChangeSet): Promise<Array<{ assetId: string; label: string; fields: Array<{ field: string; before: string; after: string }> }>> {
  const out: Array<{ assetId: string; label: string; fields: Array<{ field: string; before: string; after: string }> }> = [];
  for (const e of cs.entries) {
    const asset = await getAsset(tenantId, cs.orgId, e.assetId);
    const preview = asset ? await adapterFor(asset.destination)?.preview(asset, e.edits, { tenantId }) : undefined;
    const touched = [...new Set(e.edits.map((x) => x.field))];
    if (!preview || 'refused' in preview) {
      // The asset moved since the proposal: show the stored edits themselves.
      out.push({ assetId: e.assetId, label: e.label, fields: e.edits.map((x) => ('before' in x ? { field: x.field, before: x.before, after: x.after } : { field: x.field, before: x.find, after: x.replace })) });
      continue;
    }
    out.push({ assetId: e.assetId, label: e.label, fields: touched.map((f) => ({ field: f, before: preview.before[f] ?? '', after: preview.after[f] ?? '' })) });
  }
  return out;
}

/** Remove every change set (and its idempotency claim) of one client. */
export async function purgeChangeSetsForOrg(tenantId: string, orgId: string): Promise<number> {
  let n = 0;
  for (const c of await listChangeSets(tenantId, orgId)) {
    await keyClaims.delete(`${tenantId}::${c.idempotencyKey}`);
    if (await changeSets.delete(`${tenantId}::${orgId}::${c.changeSetId}`)) n++;
  }
  return n;
}
