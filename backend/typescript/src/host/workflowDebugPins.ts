/**
 * ADR 0475 — the workflow debug-pin store: draft-side pinned NODE OUTPUTS for
 * the debug loop (execute-from-step, failed-run→editor).
 *
 * A pin says "when debugging, pretend node X completed with THIS output".
 * Pins are deliberately OFF the definition (they must never move
 * `revisionHashOf` — the ADR 0474 invariant) and their ONLY consumer is the
 * debug-run route: published/production launches never read them (the n8n
 * honesty rule — pinned data cannot leak into production).
 *
 * Storage: the `uiStateStore`/`canvasSurface` host-ext idiom — a tenant-scoped
 * `DurableCollection` with a composite key. Values pass the SAME secret-strip
 * + free-text sanitize discipline as the event log they usually come from,
 * and are size-capped (a pin is debugging state, not a blob store).
 */

import { DurableCollection } from './hostExtPersistence.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { sanitizeFreeTextDeep } from '../byok/textRedaction.js';
import { onWorkflowDeleted } from './workflowsRegistry.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';
import { OpenwopError } from '../types.js';

export interface WorkflowDebugPin {
  /** `${tenantId}:${encodeURIComponent(workflowId)}:${encodeURIComponent(nodeId)}` */
  key: string;
  tenantId: string;
  workflowId: string;
  nodeId: string;
  /** The pinned node OUTPUT (the `node.completed.payload.outputs` shape). */
  output: Record<string, unknown>;
  /** The run this pin was prefetched from, when it came from one. */
  sourceRunId?: string;
  createdAt: string;
  createdBy?: string;
}

const store = new DurableCollection<WorkflowDebugPin>(
  'workflow:debug-pin',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const keyOf = (tenantId: string, workflowId: string, nodeId: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:${encodeURIComponent(nodeId)}`;
const prefixOf = (tenantId: string, workflowId: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:`;

/** Bounds: a pin is debug state. 64KB/value, 200 pins per (tenant, workflow). */
export const PIN_VALUE_MAX_BYTES = 64 * 1024;
export const PINS_PER_WORKFLOW_MAX = 200;

// Pins die with the definition (the ADR 0474 registry deletion seam).
onWorkflowDeleted(async (workflowId, tenantIds) => {
  // Field match only (review L1): rows carry their own workflowId, and a key
  // substring match could over-delete a pin whose nodeId embeds another
  // workflow's id. Grade-data M7 — when the caller names the owning
  // tenant(s), scan only their `${tenantId}:` slices (the retention GC
  // deletes drafts in a loop; a per-delete full scan is the host_ext_kv
  // incident shape). Unknown tenant ⇒ full-scan fallback (boot/seed paths).
  const rows = tenantIds && tenantIds.length > 0
    ? (await Promise.all(tenantIds.map((t) => store.listByPrefix(`${t}:`)))).flat()
    : await store.list();
  for (const r of rows) {
    if (r.workflowId === workflowId) await store.delete(r.key);
  }
});

export async function putDebugPin(input: {
  tenantId: string;
  workflowId: string;
  nodeId: string;
  output: Record<string, unknown>;
  sourceRunId?: string;
  createdBy?: string;
}): Promise<WorkflowDebugPin> {
  const sanitized = sanitizeFreeTextDeep(stripSecretsFromPersisted(input.output)) as Record<string, unknown>;
  const size = JSON.stringify(sanitized).length;
  if (size > PIN_VALUE_MAX_BYTES) {
    throw new OpenwopError('validation_error', `Pinned output too large (${size} bytes; max ${PIN_VALUE_MAX_BYTES}).`, 400, { nodeId: input.nodeId });
  }
  const existing = await listDebugPins(input.tenantId, input.workflowId);
  if (!existing.some((p) => p.nodeId === input.nodeId) && existing.length >= PINS_PER_WORKFLOW_MAX) {
    throw new OpenwopError('validation_error', `Pin cap reached (${PINS_PER_WORKFLOW_MAX}) — unpin something first.`, 400, {});
  }
  const pin: WorkflowDebugPin = {
    key: keyOf(input.tenantId, input.workflowId, input.nodeId),
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    output: sanitized,
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    createdAt: new Date().toISOString(),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  };
  await store.put(pin);
  return pin;
}

export async function listDebugPins(tenantId: string, workflowId: string): Promise<WorkflowDebugPin[]> {
  return (await store.listByPrefix(prefixOf(tenantId, workflowId)))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

export async function deleteDebugPin(tenantId: string, workflowId: string, nodeId: string): Promise<boolean> {
  return store.delete(keyOf(tenantId, workflowId, nodeId));
}

export async function clearDebugPins(tenantId: string, workflowId: string): Promise<number> {
  const rows = await store.listByPrefix(prefixOf(tenantId, workflowId));
  for (const r of rows) await store.delete(r.key);
  return rows.length;
}

/** ADR 0464 — DSAR subject-eraser: DELETE the subject's pins in the tenant
 *  (a pin is disposable debug state — deletion is the honest erasure; the
 *  pinned OUTPUT may itself quote the subject, so redacting only `createdBy`
 *  would under-erase). Tenant-bounded by the `${tenantId}:` key prefix. */
export async function eraseSubjectDebugPins(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const r of await store.listByPrefix(`${tenantId}:`)) {
    if (r.createdBy && forms.has(r.createdBy)) await store.delete(r.key);
  }
}

/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list). */
export function registerDebugPinErasure(): void {
  registerSubjectEraser(eraseSubjectDebugPins);
}
