/**
 * ADR 0115 Phase 5 — per-tenant image-generation spend governance. A daily
 * image-count budget (image gen is a metered, paid call). `OPENWOP_IMAGE_MAX_PER_DAY`
 * (default 50; 0/unset = uncapped). Mirrors the ADR 0114 code-exec budget. Checked
 * BEFORE the provider dispatch + recorded by the number of images returned.
 *
 * @see docs/adr/0115-image-generation-node.md
 */
import { DurableCollection } from './hostExtPersistence.js';

interface ImageCount { key: string; count: number }
const counts = new DurableCollection<ImageCount>('imagegen:budget', (c) => c.key);

export function imageMaxPerDay(): number {
  const n = parseInt(process.env.OPENWOP_IMAGE_MAX_PER_DAY ?? '50', 10);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

export interface ImageBudgetCheck { allowed: boolean; used: number; max: number; remaining: number }

export async function checkImageBudget(tenantId: string, day: string): Promise<ImageBudgetCheck> {
  const max = imageMaxPerDay();
  if (max <= 0) return { allowed: true, used: 0, max: 0, remaining: Infinity }; // uncapped
  const used = (await counts.get(`${tenantId}:${day}`))?.count ?? 0;
  return { allowed: used < max, used, max, remaining: Math.max(0, max - used) };
}

export async function recordImages(tenantId: string, day: string, n: number): Promise<void> {
  if (imageMaxPerDay() <= 0 || n <= 0) return;
  const key = `${tenantId}:${day}`;
  // MKP-3: atomic increment — a plain read-then-write loses concurrent increments
  // (two parallel image runs both read `cur` and write `cur+n`, dropping one). Use
  // compare-and-swap with a bounded retry (image gen per tenant/day is low-concurrency,
  // so the budget comfortably covers realistic contention). Best-effort post-success
  // accounting (like emitCost): on contention exhaustion, under-count rather than throw
  // — never fail a call that already produced images.
  for (let attempt = 0; attempt < 12; attempt++) {
    const existing = await counts.get(key);
    const next: ImageCount = { key, count: (existing?.count ?? 0) + n };
    if (await counts.compareAndSwap(existing ?? null, next)) return;
  }
}
