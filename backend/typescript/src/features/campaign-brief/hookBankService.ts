/**
 * Hook-bank service (ADR 0403 Phase 2) — the ORG-scoped, brief-independent
 * library of hook lines. Hooks are emitted as `candidate` when angles are
 * persisted (a PROJECTION of the angle's own hookVariants — the angle stays
 * the durable truth) and promoted `candidate → tested → retired` by a HUMAN
 * through the promote route ONLY. Promotion is deliberately NOT a surface op:
 * a model able to promote its own hooks would self-certify content that the
 * `assembleContext` projection then feeds back into channel generation as
 * attested (architect ruling (e)).
 *
 * Idempotency: hook ids are DETERMINISTIC — sha256(tenant, org, normalized
 * text) — so a retried/replayed emission heals instead of duplicating, and a
 * re-emission never demotes an already-tested hook back to candidate.
 *
 * Store: `campaign-brief:hook`, `tenant::org::id` keyed (org-scoped: the bank
 * survives brief deletion by design — tested hooks outlive campaigns).
 *
 * @see docs/adr/0403-market-intel-pipeline.md
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import type { HookVariant } from './angleService.js';

export const HOOK_STATUSES = ['candidate', 'tested', 'retired'] as const;
export type HookStatus = (typeof HOOK_STATUSES)[number];

/** The enforced promotion lattice — anything else is a typed 422. */
const HOOK_TRANSITIONS: Readonly<Record<HookStatus, readonly HookStatus[]>> = {
  candidate: ['tested', 'retired'],
  tested: ['retired'],
  retired: [],
};

export interface Hook {
  id: string;
  tenantId: string;
  orgId: string;
  text: string;
  format: string;
  /** The angle whose variant first emitted this hook (advisory back-pointer). */
  angleId?: string;
  status: HookStatus;
  /** Advisory pointer at a campaign-intel performance artifact — an opaque
   *  bounded string, never validated cross-feature (architect ruling). */
  metricRef?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// MI-4 (grade pass): a quote-derived hook line can carry a real person's
// name — declare it to the ADR 0381 classification seam like the VOC quote.
declarePiiFields('campaign-brief.hook', ['text']);

const hooks = new DurableCollection<Hook>('campaign-brief:hook', (h) => `${h.tenantId}::${h.orgId}::${h.id}`);

const TEXT_MAX = 300;
const FORMAT_MAX = 60;
const METRIC_REF_MAX = 200;
const LIST_DEFAULT_LIMIT = 200;

export const HOOK_LIMITS = { textMax: TEXT_MAX, formatMax: FORMAT_MAX, metricRefMax: METRIC_REF_MAX } as const;

const normText = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Deterministic id: same org + same (normalized) line = the SAME bank entry,
 *  whichever angle re-emits it. */
export function deterministicHookId(tenantId: string, orgId: string, text: string): string {
  return `hk-${createHash('sha256').update(`${tenantId}::${orgId}::${normText(text)}`, 'utf8').digest('hex').slice(0, 32)}`;
}

export interface HookEmissionResult {
  /** Hooks newly added to the bank by this emission. */
  emitted: Hook[];
  /** Hook ids that already existed (kept verbatim — never demoted). */
  skippedExisting: string[];
  /** Per-variant emission errors (isolated — one bad row never aborts the rest). */
  errors: Array<{ text: string; message: string }>;
}

/** Emit an angle's hook variants into the org bank as `candidate` hooks.
 *  Idempotent + non-destructive: an existing id is left untouched. */
export async function emitCandidateHooks(
  tenantId: string,
  orgId: string,
  angleId: string,
  variants: readonly HookVariant[],
  createdBy: string,
): Promise<HookEmissionResult> {
  const out: HookEmissionResult = { emitted: [], skippedExisting: [], errors: [] };
  const now = new Date().toISOString();
  for (const v of variants) {
    const text = cleanString(v.text, TEXT_MAX);
    if (!text) continue;
    const id = deterministicHookId(tenantId, orgId, text);
    try {
      const existing = await hooks.get(`${tenantId}::${orgId}::${id}`);
      if (existing) { out.skippedExisting.push(id); continue; }
      const hook: Hook = {
        id, tenantId, orgId, text,
        format: cleanString(v.format, FORMAT_MAX) || 'unspecified',
        angleId, status: 'candidate', createdBy, createdAt: now, updatedAt: now,
      };
      await hooks.put(hook);
      out.emitted.push(hook);
    } catch (err) {
      out.errors.push({ text: text.slice(0, 80), message: err instanceof Error ? err.message : 'emission failed' });
    }
  }
  return out;
}

export async function listHooks(tenantId: string, orgId: string, filter?: { status?: HookStatus; limit?: number }): Promise<Hook[]> {
  const all = await hooks.listByPrefix(`${tenantId}::${orgId}::`);
  const limit = filter?.limit && filter.limit > 0 ? Math.min(filter.limit, LIST_DEFAULT_LIMIT) : LIST_DEFAULT_LIMIT;
  return all
    .filter((h) => h.tenantId === tenantId && (!filter?.status || h.status === filter.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export async function getHook(tenantId: string, orgId: string, hookId: string): Promise<Hook | null> {
  const h = await hooks.get(`${tenantId}::${orgId}::${hookId}`);
  return h && h.tenantId === tenantId ? h : null;
}

/** The HUMAN promotion write (route-only). Enforces the transition lattice;
 *  `metricRef` is optional, advisory, bounded. */
export async function promoteHook(
  tenantId: string,
  orgId: string,
  hookId: string,
  nextStatus: string,
  metricRef?: unknown,
): Promise<Hook | null> {
  const hook = await getHook(tenantId, orgId, hookId);
  if (!hook) return null;
  if (!(HOOK_STATUSES as readonly string[]).includes(nextStatus)) {
    throw new OpenwopError('validation_error', `status must be one of: ${HOOK_STATUSES.join(', ')}.`, 422, { field: 'status' });
  }
  const next = nextStatus as HookStatus;
  if (!HOOK_TRANSITIONS[hook.status].includes(next)) {
    throw new OpenwopError('validation_error', `Illegal hook transition ${hook.status} → ${next}.`, 422, { from: hook.status, to: next });
  }
  const updated: Hook = {
    ...hook,
    status: next,
    ...(optionalCleanString(metricRef, METRIC_REF_MAX) ? { metricRef: optionalCleanString(metricRef, METRIC_REF_MAX) } : {}),
    updatedAt: new Date().toISOString(),
  };
  await hooks.put(updated);
  return updated;
}

/** Test-only. */
export async function __resetHookStore(): Promise<void> {
  await hooks.__clear();
}
