/**
 * Canvas↔GitHub repo binding for two-way sync (ADR 0393 A4).
 *
 * A binding lives in a durable SIDE collection, NOT the canvas facet — the
 * export/lineage.ts lesson: a facet write bumps the canvas version and 409s any
 * live editor session. One binding per canvas, one active branch per binding
 * (the single-active-branch constraint, ADR 0393 A4).
 *
 * The webhook secret is sealed at rest via the shared webhook-secret codec
 * (KMS envelope when configured) and returned exactly ONCE in the bind
 * response; reads never include it.
 */
import { randomBytes } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { onCanvasDeleted } from '../../host/canvasLifecycle.js';
import { sealWebhookSecret, openWebhookSecret } from '../../host/webhookSecretCodec.js';
import { OpenwopError } from '../../types.js';
import { APP_BUILDER_CANVAS_TYPE } from './componentCatalog.js';
import { REPO_NAME_RE } from './publishService.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import type { ExportTarget } from './export/generators.js';

/** GitHub login: alphanumerics + single internal hyphens, ≤39 chars. */
export const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Conservative git branch-name subset: no refspec metacharacters. */
export const GH_BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export interface SyncBinding {
  /** `${tenantId}:${canvasId}` */
  id: string;
  tenantId: string;
  canvasId: string;
  owner: string;
  repo: string;
  /** The ONE active branch (ADR 0393 A4 — no multi-branch fan-in in v1). */
  branch: string;
  target: ExportTarget;
  /** Opaque public webhook-path id — the inbound route key (no collection
   *  scan; the connections-inbound per-resource-URL posture). NOT a secret:
   *  the HMAC signature is the credential. */
  webhookId: string;
  /** Sealed (KMS when configured) HMAC secret for the inbound webhook. */
  sealedWebhookSecret: string;
  boundBy: string;
  boundAt: string;
}

/** The read projection — never carries the secret. */
export interface SyncBindingView {
  canvasId: string;
  owner: string;
  repo: string;
  branch: string;
  target: ExportTarget;
  webhookId: string;
  boundBy: string;
  boundAt: string;
}

const rows = new DurableCollection<SyncBinding>(
  'app-builder:sync-binding',
  (r) => r.id,
  undefined,
  (r) => r.tenantId,
);

/** webhookId → binding key: the inbound route's point lookup (a prefix/list
 *  scan here would be the host_ext_kv full-scan incident all over again). */
interface WebhookRef { webhookId: string; tenantId: string; canvasId: string }
const webhookRefs = new DurableCollection<WebhookRef>(
  'app-builder:sync-webhook',
  (r) => r.webhookId,
  undefined,
  (r) => r.tenantId,
);

const key = (tenantId: string, canvasId: string): string => `${tenantId}:${canvasId}`;

function toView(b: SyncBinding): SyncBindingView {
  return { canvasId: b.canvasId, owner: b.owner, repo: b.repo, branch: b.branch, target: b.target, webhookId: b.webhookId, boundBy: b.boundBy, boundAt: b.boundAt };
}

/** Inbound-route lookup: opaque webhookId → the binding (null when unbound). */
export async function getSyncBindingByWebhookId(webhookId: string): Promise<SyncBinding | null> {
  const ref = await webhookRefs.get(webhookId);
  if (!ref) return null;
  return rows.get(key(ref.tenantId, ref.canvasId));
}

export async function getSyncBinding(tenantId: string, canvasId: string): Promise<SyncBinding | null> {
  return rows.get(key(tenantId, canvasId));
}

export async function getSyncBindingView(tenantId: string, canvasId: string): Promise<SyncBindingView | null> {
  const b = await rows.get(key(tenantId, canvasId));
  return b ? toView(b) : null;
}

/** Unseal the binding's webhook HMAC secret (inbound verification, Phase 2). */
export async function openBindingWebhookSecret(binding: SyncBinding): Promise<string> {
  return openWebhookSecret(binding.sealedWebhookSecret);
}

export async function createSyncBinding(
  tenantId: string,
  canvasId: string,
  args: { owner: string; repo: string; branch: string; target: ExportTarget; boundBy: string },
): Promise<{ view: SyncBindingView; webhookSecret: string }> {
  if (!GH_OWNER_RE.test(args.owner)) {
    throw new OpenwopError('validation_error', '`owner` must be a valid GitHub login.', 400, { field: 'owner' });
  }
  if (!REPO_NAME_RE.test(args.repo)) {
    throw new OpenwopError('validation_error', 'Repository name must be 1-100 chars of letters, digits, ".", "_", "-".', 400, { field: 'repo' });
  }
  if (!GH_BRANCH_RE.test(args.branch) || args.branch.includes('..') || args.branch.startsWith('/') || args.branch.endsWith('/')) {
    throw new OpenwopError('validation_error', '`branch` is not a valid branch name.', 400, { field: 'branch' });
  }
  const webhookSecret = randomBytes(32).toString('hex');
  const binding: SyncBinding = {
    id: key(tenantId, canvasId),
    tenantId,
    canvasId,
    owner: args.owner,
    repo: args.repo,
    branch: args.branch,
    target: args.target,
    webhookId: randomBytes(16).toString('hex'),
    sealedWebhookSecret: await sealWebhookSecret(webhookSecret),
    boundBy: args.boundBy,
    boundAt: new Date().toISOString(),
  };
  // GRADE-DATA 2026-07-17 — CAS insert (create-iff-absent), not check-then-put:
  // two concurrent binds previously both passed the 409 check, and the loser's
  // webhookRefs row orphaned forever pointing at the winner's binding. The ref
  // is written only AFTER the binding row wins the race.
  if (!(await rows.compareAndSwap(null, binding))) {
    throw new OpenwopError('conflict', 'This canvas already has a repo binding — unbind it first (one active branch per canvas).', 409, { canvasId });
  }
  await webhookRefs.put({ webhookId: binding.webhookId, tenantId, canvasId });
  return { view: toView(binding), webhookSecret };
}

export async function deleteSyncBinding(tenantId: string, canvasId: string): Promise<boolean> {
  const k = key(tenantId, canvasId);
  const existing = await rows.get(k);
  if (!existing) return false;
  // Ref first: a mid-way failure leaves the webhook path DEAD (fail-closed),
  // never a live webhook pointing at a deleted binding.
  await webhookRefs.delete(existing.webhookId);
  await rows.delete(k);
  // GRADE-DATA 2026-07-17 — the delivery-dedup row is binding-scoped state; a
  // re-bound canvas must not inherit the old binding's delivery-id history.
  await deleteSyncDeliveryHistory(tenantId, canvasId);
  return true;
}

// ── Delivery-id dedup (binding-scoped; lives here so unbind can cascade it
//    without a syncWebhook↔syncBinding import cycle) ─────────────────────────
interface DeliveryRow { id: string; tenantId: string; deliveryIds: string[] }
const deliveries = new DurableCollection<DeliveryRow>(
  'app-builder:sync-deliveries',
  (r) => r.id,
  undefined,
  (r) => r.tenantId,
);
const MAX_DELIVERIES = 100;

/** Record a delivery id; false when already recorded (a redelivery). */
export async function recordSyncDelivery(tenantId: string, canvasId: string, deliveryId: string): Promise<boolean> {
  const k = key(tenantId, canvasId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await deliveries.get(k);
    if (cur?.deliveryIds.includes(deliveryId)) return false;
    const next: DeliveryRow = {
      id: k,
      tenantId,
      deliveryIds: [...(cur?.deliveryIds ?? []).slice(-(MAX_DELIVERIES - 1)), deliveryId],
    };
    if (await deliveries.compareAndSwap(cur ?? null, next)) return true;
  }
  // A persistent CAS loser processes anyway — replay stays bounded by the
  // skip-self + CAS-apply guards downstream.
  return true;
}

/** GRADE-CODE 2026-07-17 — compensate a FAILED receipt: un-record the id so
 *  GitHub's redelivery retries the push instead of being acked `duplicate`
 *  (a transient mid-processing failure previously dropped the push forever). */
export async function unrecordSyncDelivery(tenantId: string, canvasId: string, deliveryId: string): Promise<void> {
  const k = key(tenantId, canvasId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await deliveries.get(k);
    if (!cur || !cur.deliveryIds.includes(deliveryId)) return;
    const next: DeliveryRow = { ...cur, deliveryIds: cur.deliveryIds.filter((d) => d !== deliveryId) };
    if (await deliveries.compareAndSwap(cur, next)) return;
  }
}

export async function deleteSyncDeliveryHistory(tenantId: string, canvasId: string): Promise<void> {
  await deliveries.delete(key(tenantId, canvasId));
}

/** Cascade: a deleted canvas takes its binding with it (no orphaned webhook wiring). */
export function registerSyncBindingCleanup(): void {
  onCanvasDeleted('app-builder-sync-binding', async ({ tenantId, canvasId, canvasTypeId }) => {
    if (canvasTypeId !== APP_BUILDER_CANVAS_TYPE) return;
    await deleteSyncBinding(tenantId, canvasId);
  });
}

/** What an erased attribution becomes — same token as documents/environments;
 *  not '' (that reads as "nobody set it", a different fact from "erased"). */
export const ERASED_SUBJECT = 'erased:subject';

/**
 * UX_UPGRADE-app-builder R2 (AB2-M1) — subject erasure for the ONE app-builder
 * identifier no other eraser reaches.
 *
 * App-builder's canvases and version snapshots are already covered by the HOST
 * canvas eraser (`canvasSurface.ts` `eraseSubjectCanvas`, ADR 0464): the canvas
 * store is shared, so its erasure is host-owned — the same ownership doctrine
 * `canvasRetention.ts` follows from the other side (the typeId owner purges its
 * slice; the host owns store-generic behaviour). `ExportLineageEntry` carries no
 * user identifier at all.
 *
 * That leaves exactly this feature-owned row: `SyncBinding.boundBy`, the user
 * who bound the GitHub repo. `eraseSubject`'s fan-out never reached it, so a
 * data-subject erasure returned success with the person's id still on their
 * sync bindings.
 *
 * ANONYMIZED, and only that field. `owner`/`repo`/`branch` are the sync's
 * machine coordinates — anonymizing them destroys a live binding the ORG
 * configured. `owner` MAY be a personal GitHub login; whether an erasure
 * request must also sever an org's intentional repo binding is an OPERATOR
 * decision (the environments audit-ledger precedent), flagged in
 * `UX_UPGRADE-app-builder.md` rather than decided silently here.
 *
 * Idempotent (the tombstone write is a no-op the second time); tenant-scoped
 * via the collection's own tenant index — a bounded scan, not a full listing.
 */
export async function eraseSyncBindingSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  for (const b of await rows.listForTenantIndexed(tenantId)) {
    if (b.boundBy !== subjectKey) continue;
    await rows.put({ ...b, boundBy: ERASED_SUBJECT });
  }
}

/** Registered from `feature.ts` so the wiring is greppable and testable. */
export function registerAppBuilderErasure(): void {
  registerSubjectEraser(eraseSyncBindingSubject);
}
