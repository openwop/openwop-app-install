/**
 * Inbound GitHub→builder sync (ADR 0393 A3/A5, Phase 2).
 *
 * Public per-binding webhook (`/app-builder-sync/webhook/:webhookId`) riding
 * the connections-inbound posture: NO host credential — the GitHub HMAC
 * signature over the raw body IS the credential, verified constant-time
 * against the binding's sealed secret; tenant comes from the stored binding,
 * never the request. The opaque webhookId is a point lookup (no scans).
 *
 * Decision ladder per receipt (each ack'd 200 so GitHub doesn't retry):
 *   ping                      → ack
 *   wrong branch / deleted    → ignored
 *   duplicate delivery id     → duplicate (idempotent redelivery no-op)
 *   our own echo (marker +    → skipped_self (A3.1 — actor marker with the
 *     version == canvas)         version tiebreak)
 *   basis mismatch            → fallback branch (the canvas moved since the
 *     (manifest ≠ canvas ver)    repo last synced — applying would clobber
 *                                builder edits; fail-closed, A5)
 *   invalid model             → fallback branch (typed rejection, never a
 *                                partial apply, A3.3)
 *   CAS conflict on apply     → fallback branch (concurrent editor write, A5)
 *   else                      → applied via surface.applyRepair (the ONE
 *                                governed CAS write — same gate as the agent
 *                                render tool)
 *
 * The fallback branch (`openwop-sync-<ts>`) is ONE ref-create pointing at the
 * pushed commit — the inbound content is preserved at a stable ref while the
 * active branch and the live canvas stay untouched (Lovable's exact model).
 * Every receipt emits one structured log line + a host event (ADR 0208 seam).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { getCanvasForTenant } from '../../host/canvasSurface.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import type { Storage } from '../../storage/storage.js';
import { buildAppBuilderSurface } from './surface.js';
import { validateAppDoc } from './validateAppDoc.js';
import { gh } from './publishService.js';
import { getSyncBindingByWebhookId, openBindingWebhookSecret, recordSyncDelivery, unrecordSyncDelivery, type SyncBinding } from './syncBinding.js';
import { syncPushToGitHub } from './githubSync.js';
import { parseSyncMarker, MODEL_FILE, GENERATED_MANIFEST } from './githubSync.js';
import { OpenwopError } from '../../types.js';

const log = createLogger('features.app-builder.syncWebhook');

export type SyncWebhookOutcome =
  | 'ack' | 'ignored' | 'duplicate' | 'skipped_self'
  | 'applied' | 'fallback_basis' | 'fallback_invalid' | 'fallback_cas';

export interface SyncWebhookResult {
  status: number;
  outcome: SyncWebhookOutcome | 'unknown_webhook' | 'bad_signature';
  detail?: string;
  fallbackBranch?: string;
}

// Delivery-id dedup lives in syncBinding.ts (binding-scoped state, cascaded on
// unbind/canvas-delete) — imported here, never duplicated.

function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

function egressDeps(storage: Storage, binding: SyncBinding): BrokeredEgressDeps {
  // No session exists on a webhook — the acting principal is the admin who
  // wired the channel (the binding's durable owner), the tenant the binding's.
  return { storage, tenantId: binding.tenantId, runId: `sync-inbound:${binding.canvasId}`, actingUserId: binding.boundBy };
}

async function fetchRepoFile(deps: BrokeredEgressDeps, binding: SyncBinding, path: string, ref: string): Promise<string | null> {
  const repoPath = `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repo)}`;
  const res = await gh(deps, 'GET', `${repoPath}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return null;
  if (res.status !== 200 || typeof res.json.content !== 'string') {
    throw new OpenwopError('egress_blocked', `GitHub content read failed (${res.status}) for '${path}'.`, 502, { status: res.status, path });
  }
  return Buffer.from(res.json.content, 'base64').toString('utf8');
}

/** One ref-create preserving the inbound commit on a fallback branch (A5). */
async function pushFallbackRef(deps: BrokeredEgressDeps, binding: SyncBinding, sha: string): Promise<string | undefined> {
  const repoPath = `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repo)}`;
  const branch = `openwop-sync-${Date.now()}`;
  const res = await gh(deps, 'POST', `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (res.status !== 201) {
    log.error('sync_fallback_ref_failed', { tenantId: binding.tenantId, canvasId: binding.canvasId, status: res.status });
    return undefined;
  }
  return branch;
}

async function conclude(
  binding: SyncBinding,
  deliveryId: string,
  outcome: SyncWebhookOutcome,
  extra: Record<string, unknown> = {},
): Promise<void> {
  log.info('sync_webhook_receipt', { tenantId: binding.tenantId, canvasId: binding.canvasId, deliveryId, outcome, ...extra });
  await emitHostEvent({
    type: `host.app-builder.sync.${outcome.replace(/_/g, '-')}`,
    tenantId: binding.tenantId,
    payload: { canvasId: binding.canvasId, deliveryId, ...extra },
  });
}

export async function handleSyncWebhook(args: {
  storage: Storage;
  webhookId: string;
  rawBody: Buffer;
  signature: string | undefined;
  event: string | undefined;
  deliveryId: string;
}): Promise<SyncWebhookResult> {
  const binding = await getSyncBindingByWebhookId(args.webhookId);
  if (!binding) return { status: 404, outcome: 'unknown_webhook' };

  const secret = await openBindingWebhookSecret(binding);
  if (!verifySignature(secret, args.rawBody, args.signature)) {
    log.info('sync_webhook_bad_signature', { tenantId: binding.tenantId, canvasId: binding.canvasId, deliveryId: args.deliveryId });
    return { status: 401, outcome: 'bad_signature' };
  }

  if (args.event === 'ping') return { status: 200, outcome: 'ack' };
  if (args.event !== 'push') return { status: 200, outcome: 'ignored', detail: `event '${args.event ?? 'none'}' is not a push` };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(args.rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { status: 400, outcome: 'ignored', detail: 'unparseable payload' };
  }

  const ref = typeof payload.ref === 'string' ? payload.ref : '';
  const after = typeof payload.after === 'string' ? payload.after : '';
  if (ref !== `refs/heads/${binding.branch}`) {
    return { status: 200, outcome: 'ignored', detail: 'not the active branch' };
  }
  if (payload.deleted === true || /^0+$/.test(after)) {
    return { status: 200, outcome: 'ignored', detail: 'branch deletion' };
  }
  // A malformed `after` must never fall through to a ref-less contents fetch
  // (which would silently read the DEFAULT branch instead of the pushed ref).
  if (!/^[0-9a-f]{40,64}$/.test(after)) {
    return { status: 200, outcome: 'ignored', detail: 'no usable head sha' };
  }

  if (!(await recordSyncDelivery(binding.tenantId, binding.canvasId, args.deliveryId))) {
    // Redelivered webhook — already handled; idempotent ack, no build.
    return { status: 200, outcome: 'duplicate' };
  }
  // GRADE-CODE 2026-07-17 — from here on, a transient failure (a GitHub read
  // 502, a storage blip) must NOT leave the delivery id recorded: GitHub's
  // redelivery would be acked `duplicate` and the push silently dropped. The
  // catch compensates the dedup record, then rethrows to the error envelope so
  // GitHub retries.
  try {
    return await processVerifiedPush(args, binding);
  } catch (err) {
    await unrecordSyncDelivery(binding.tenantId, binding.canvasId, args.deliveryId).catch(() => undefined);
    throw err;
  }
}

async function processVerifiedPush(
  args: { storage: Storage; webhookId: string; rawBody: Buffer; signature: string | undefined; event: string | undefined; deliveryId: string },
  binding: SyncBinding,
): Promise<SyncWebhookResult> {
  const payload = JSON.parse(args.rawBody.toString('utf8')) as Record<string, unknown>;
  const after = typeof payload.after === 'string' ? payload.after : '';

  const canvas = await getCanvasForTenant(binding.tenantId, binding.canvasId);
  if (!canvas || canvas.canvasTypeId !== 'canvas.app-builder') {
    await conclude(binding, args.deliveryId, 'ignored', { detail: 'canvas gone' });
    return { status: 200, outcome: 'ignored', detail: 'canvas gone' };
  }

  // A3.1 skip-self: our own echo carries the actor marker; the version
  // tiebreak defends against a marker on a genuinely newer external commit.
  const headCommit = payload.head_commit as Record<string, unknown> | undefined;
  const headMessage = typeof headCommit?.message === 'string' ? headCommit.message : '';
  const markerVersion = parseSyncMarker(headMessage);
  if (markerVersion !== null && markerVersion === canvas.version) {
    await conclude(binding, args.deliveryId, 'skipped_self', {});
    return { status: 200, outcome: 'skipped_self' };
  }

  const deps = egressDeps(args.storage, binding);

  // A3.2 — the model is the ONLY round-trippable artifact; generated source is
  // ignored on inbound by construction (we simply never read it).
  const modelRaw = await fetchRepoFile(deps, binding, MODEL_FILE, after);
  if (modelRaw === null) {
    await conclude(binding, args.deliveryId, 'ignored', { detail: 'no app.model.json at the pushed ref' });
    return { status: 200, outcome: 'ignored', detail: 'no app.model.json at the pushed ref' };
  }
  let model: unknown;
  try {
    model = JSON.parse(modelRaw);
  } catch {
    const fallbackBranch = await pushFallbackRef(deps, binding, after);
    await conclude(binding, args.deliveryId, 'fallback_invalid', { reason: 'model is not valid JSON', fallbackBranch });
    return { status: 200, outcome: 'fallback_invalid', ...(fallbackBranch ? { fallbackBranch } : {}) };
  }

  // Basis check (fail-closed): the pushed manifest records the model version
  // the repo last synced from. If the canvas has moved past it, applying would
  // silently clobber builder edits — that is the A5 CAS-conflict class.
  const manifestRaw = await fetchRepoFile(deps, binding, GENERATED_MANIFEST, after);
  let basisVersion: number | null = null;
  if (manifestRaw !== null) {
    try {
      const parsed = JSON.parse(manifestRaw) as { modelVersion?: unknown };
      if (typeof parsed.modelVersion === 'number') basisVersion = parsed.modelVersion;
    } catch { /* unreadable manifest → basis unknown → fail closed below */ }
  }
  if (basisVersion === null || basisVersion !== canvas.version) {
    const fallbackBranch = await pushFallbackRef(deps, binding, after);
    await conclude(binding, args.deliveryId, 'fallback_basis', { basisVersion, canvasVersion: canvas.version, fallbackBranch });
    return { status: 200, outcome: 'fallback_basis', ...(fallbackBranch ? { fallbackBranch } : {}) };
  }

  // A3.3 bounded import — closed-world validation BEFORE any write; the whole
  // push is rejected on error, never a partial apply. STRICTER than the editor
  // gate on shape: `validateAppDoc` coerces a non-array `screens` to [] (a
  // legitimate mid-edit editor state), which on THIS path would silently wipe
  // the canvas to an empty app from one malformed hand-edit. Inbound requires
  // the editor's own invariant up front: ≥1 screen, exactly one initial.
  const screens = (model as { screens?: unknown }).screens;
  const initialCount = Array.isArray(screens)
    ? screens.filter((s) => (s as { isInitial?: unknown })?.isInitial === true).length
    : 0;
  if (!Array.isArray(screens) || screens.length === 0 || initialCount !== 1) {
    const fallbackBranch = await pushFallbackRef(deps, binding, after);
    await conclude(binding, args.deliveryId, 'fallback_invalid', { reason: 'model must carry at least one screen with exactly one isInitial home', fallbackBranch });
    return { status: 200, outcome: 'fallback_invalid', detail: 'model must carry at least one screen with exactly one isInitial home', ...(fallbackBranch ? { fallbackBranch } : {}) };
  }
  const v = validateAppDoc(model);
  if (v.errors.length) {
    const fallbackBranch = await pushFallbackRef(deps, binding, after);
    await conclude(binding, args.deliveryId, 'fallback_invalid', { errorCount: v.errors.length, firstError: v.errors[0]!.message, fallbackBranch });
    return { status: 200, outcome: 'fallback_invalid', detail: v.errors[0]!.message, ...(fallbackBranch ? { fallbackBranch } : {}) };
  }

  // A3.4 — the ONE governed CAS write (surface.applyRepair: validate + CAS,
  // exactly the agent-tool render path).
  try {
    const surface = buildAppBuilderSurface({ tenantId: binding.tenantId });
    await surface.applyRepair!({ canvasId: binding.canvasId, expectedVersion: canvas.version, app: model });
  } catch (err) {
    if (err instanceof OpenwopError && (err.httpStatus === 409 || err.code === 'conflict')) {
      const fallbackBranch = await pushFallbackRef(deps, binding, after);
      await conclude(binding, args.deliveryId, 'fallback_cas', { fallbackBranch });
      return { status: 200, outcome: 'fallback_cas', ...(fallbackBranch ? { fallbackBranch } : {}) };
    }
    throw err;
  }

  await conclude(binding, args.deliveryId, 'applied', { fromVersion: canvas.version });
  // GRADE-CODE 2026-07-17 — refresh the repo's manifest AFTER an apply: the
  // canvas version just advanced, so without a fresh outbound sync the dev's
  // NEXT push always failed the basis check into a fallback branch. Best-effort
  // fire-and-forget: the marker commit makes the echo skip-self, and a failure
  // only means the next push takes the (safe) fallback path as before.
  void (async () => {
    const applied = await getCanvasForTenant(binding.tenantId, binding.canvasId);
    if (applied) await syncPushToGitHub(deps, binding, { app: applied.state, modelVersion: applied.version });
  })().catch((err: unknown) => {
    log.warn('sync_post_apply_refresh_failed', { tenantId: binding.tenantId, canvasId: binding.canvasId, error: err instanceof Error ? err.message : String(err) });
  });
  return { status: 200, outcome: 'applied' };
}
