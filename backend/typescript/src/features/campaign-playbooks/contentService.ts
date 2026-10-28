/**
 * ADR 0959 D5 (P4) — a playbook's content items (`{slot, kind, payload}`), installed into the
 * client org through the owner's adapter (`host/playbookContentAdapters.ts`).
 *
 * Idempotent per (tenant, org, playbook, slot): a playbook-owned mapping row records the
 * resource the slot made, the hash of what was last applied, and the hash of the resource as it
 * read right after. So:
 *  - a repeat apply of the same content writes nothing;
 *  - a changed item updates the resource, unless someone edited it since (its read no longer
 *    hashes to the recorded snapshot) — then it needs `overwrite` (`content_edited`), and an owner
 *    that refuses the update now (a live CMS page) is `content_locked`;
 *  - a slot a newer version dropped is left in place and reported, never deleted.
 * Creation takes a put-if-absent claim first, so a retry can never make a second resource; a
 * claim left by a crash is reclaimable after 10 minutes. The plan (`planContent`) only reads.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { getPlaybookContentAdapter, type PlaybookContentAdapter, type PlaybookContentSnapshot } from '../../host/playbookContentAdapters.js';
import { OpenwopError } from '../../types.js';
import { playbookHashOf } from './playbookStore.js';
import type { PlaybookInstallation, PlaybookVersion } from './types.js';

export interface PlaybookContentRow {
  key: string;
  tenantId: string;
  orgId: string;
  playbookId: string;
  slot: string;
  kind: string;
  status: 'creating' | 'updating' | 'applied';
  claimedAt: string;
  resourceId?: string;
  appliedHash?: string;
  snapshotHash?: string;
  at?: string;
}
export type ContentAction = 'add' | 'update' | 'unchanged' | 'removed';
export interface ContentItemPlan { slot: string; kind: string; action: ContentAction; fields: string[]; edited: boolean; locked?: string }
export interface ContentApplyResult {
  applied: Array<{ slot: string; resourceId: string; action: 'created' | 'updated' }>;
  unchanged: string[];
  removed: string[];
  failed: Array<{ slot: string; reason: string; message: string }>;
}

const rows = new DurableCollection<PlaybookContentRow>('campaign-playbooks:content', (r) => r.key, undefined, (r) => r.tenantId);
const STALE_CLAIM_MS = 10 * 60_000;
const rowKey = (tenantId: string, orgId: string, playbookId: string, slot: string): string => `${tenantId}::${orgId}::${playbookId}::${slot}`;
const desiredHashOf = (kind: string, payload: Record<string, unknown>): string => playbookHashOf({ kind, payload });
const snapshotHashOf = (value: Record<string, unknown>): string => playbookHashOf(value);

function adapterOf(kind: string): PlaybookContentAdapter {
  const a = getPlaybookContentAdapter(kind);
  if (!a) throw new OpenwopError('validation_error', `No feature on this host provides "${kind}" content.`, 422, { reason: 'content_kind_unknown', kind });
  return a;
}

async function rowsFor(tenantId: string, orgId: string, playbookId: string): Promise<PlaybookContentRow[]> {
  return (await rows.listByPrefix(`${tenantId}::${orgId}::${playbookId}::`)).filter((r) => r.tenantId === tenantId && r.orgId === orgId && r.playbookId === playbookId);
}

/** D6.1 — what installing `version`'s content for this client would do. Reads only. */
export async function planContent(install: PlaybookInstallation, version: PlaybookVersion): Promise<ContentItemPlan[]> {
  const { tenantId, orgId, playbookId } = install;
  const existing = new Map((await rowsFor(tenantId, orgId, playbookId)).map((r) => [r.slot, r]));
  const out: ContentItemPlan[] = [];
  for (const item of version.content ?? []) {
    const adapter = getPlaybookContentAdapter(item.kind);
    const row = existing.get(item.slot);
    if (!adapter) { out.push({ slot: item.slot, kind: item.kind, action: 'add', fields: [], edited: false, locked: 'no feature on this host provides this kind' }); continue; }
    if (row?.status === 'updating' || row?.status === 'creating') { out.push({ slot: item.slot, kind: item.kind, action: row.resourceId ? 'update' : 'add', fields: [], edited: true, locked: 'An earlier write has an unconfirmed outcome; review the resource before replacing it.' }); continue; }
    if (!row || !row.resourceId) { out.push({ slot: item.slot, kind: item.kind, action: 'add', fields: Object.keys(item.payload).sort(), edited: false }); continue; }
    const snap = await adapter.read({ tenantId, orgId }, row.resourceId);
    if (!snap) { out.push({ slot: item.slot, kind: item.kind, action: 'add', fields: Object.keys(item.payload).sort(), edited: false }); continue; }
    const edited = snapshotHashOf(snap.value) !== row.snapshotHash;
    const same = row.appliedHash === desiredHashOf(item.kind, item.payload);
    out.push({ slot: item.slot, kind: item.kind, action: same ? 'unchanged' : 'update', fields: same ? [] : adapter.diff(snap.value, item.payload), edited: !same && edited, ...(snap.locked && !same ? { locked: snap.locked } : {}) });
  }
  const slots = new Set((version.content ?? []).map((c) => c.slot));
  for (const [slot, row] of existing) if (!slots.has(slot)) out.push({ slot, kind: row.kind, action: 'removed', fields: [], edited: false });
  return out;
}

async function claimCreate(key: string, base: Omit<PlaybookContentRow, 'status' | 'claimedAt'>): Promise<PlaybookContentRow | null> {
  const now = new Date();
  const claim: PlaybookContentRow = { ...base, status: 'creating', claimedAt: now.toISOString() };
  if (await rows.putIfAbsent(claim)) return claim;
  const cur = await rows.get(key);
  if (cur && cur.status === 'creating' && now.getTime() - Date.parse(cur.claimedAt) > STALE_CLAIM_MS && (await rows.compareAndSwap(cur, claim))) return claim;
  return null;
}

/** D5 — install (or move to) `version`'s content for this client. Idempotent per slot. */
export async function applyContent(install: PlaybookInstallation, version: PlaybookVersion, by: string, opts: { overwrite?: boolean } = {}): Promise<ContentApplyResult> {
  const { tenantId, orgId, playbookId } = install;
  const result: ContentApplyResult = { applied: [], unchanged: [], removed: [], failed: [] };
  for (const item of version.content ?? []) {
    const key = rowKey(tenantId, orgId, playbookId, item.slot);
    const ctx = { tenantId, orgId, by, key };
    try {
      const adapter = adapterOf(item.kind);
      const desired = adapter.parse(item.payload);
      const desiredHash = desiredHashOf(item.kind, desired);
      const row = await rows.get(key);
      const record = async (cur: PlaybookContentRow, resourceId: string, action: 'created' | 'updated', snap: PlaybookContentSnapshot): Promise<void> => {
        const next: PlaybookContentRow = { ...cur, kind: item.kind, status: 'applied', resourceId, appliedHash: desiredHash, snapshotHash: snapshotHashOf(snap.value), at: new Date().toISOString() };
        if (!(await rows.compareAndSwap(cur, next))) throw new OpenwopError('conflict', 'This content changed while it was being applied.', 409, { reason: 'content_changed' });
        result.applied.push({ slot: item.slot, resourceId, action });
      };
      if (row?.status === 'updating' && opts.overwrite !== true) {
        result.failed.push({ slot: item.slot, reason: 'content_outcome_unconfirmed', message: 'An earlier write has an unconfirmed outcome. Review the resource before replacing it.' });
        continue;
      }
      if (row && row.tenantId === tenantId && (row.status === 'applied' || row.status === 'updating') && row.resourceId) {
        if (row.kind !== item.kind) { result.failed.push({ slot: item.slot, reason: 'content_kind_changed', message: 'Changing a slot to another content kind requires a new slot.' }); continue; }
        if (row.status === 'applied' && row.appliedHash === desiredHash) { result.unchanged.push(item.slot); continue; }
        const snap = await adapter.read({ tenantId, orgId }, row.resourceId);
        if (!snap) {
          const created = await adapter.create(ctx, desired);
          await record(row, created.resourceId, 'created', created.snapshot);
          continue;
        }
        if (snap.locked) { result.failed.push({ slot: item.slot, reason: 'content_locked', message: snap.locked }); continue; }
        if (snapshotHashOf(snap.value) !== row.snapshotHash && opts.overwrite !== true) {
          result.failed.push({ slot: item.slot, reason: 'content_edited', message: 'This was edited since the playbook last wrote it; applying replaces those edits.' });
          continue;
        }
        const claimed: PlaybookContentRow = { ...row, status: 'updating', claimedAt: new Date().toISOString() };
        if (!(await rows.compareAndSwap(row, claimed))) throw new OpenwopError('conflict', 'Another apply owns this content item.', 409, { reason: 'content_changed' });
        const updated = await adapter.update(ctx, row.resourceId, desired, snap);
        await record(claimed, row.resourceId, 'updated', updated);
        continue;
      }
      const claimed = await claimCreate(key, { key, tenantId, orgId, playbookId, slot: item.slot, kind: item.kind });
      if (!claimed) { result.failed.push({ slot: item.slot, reason: 'content_in_progress', message: 'Another apply is creating this item.' }); continue; }
      // A failed acknowledgement does not prove the owner wrote nothing. Keep
      // the claim; deterministic owner IDs prevent a duplicate after a retry.
      const created = await adapter.create(ctx, desired);
      await record(claimed, created.resourceId, 'created', created.snapshot);
    } catch (err) {
      const d = (err instanceof OpenwopError ? err.details : undefined) as { reason?: string } | undefined;
      result.failed.push({ slot: item.slot, reason: d?.reason ?? (err instanceof OpenwopError ? err.code : 'error'), message: err instanceof Error ? err.message : String(err) });
    }
  }
  const slots = new Set((version.content ?? []).map((c) => c.slot));
  for (const r of await rowsFor(tenantId, orgId, playbookId)) if (!slots.has(r.slot)) result.removed.push(r.slot);
  return result;
}
