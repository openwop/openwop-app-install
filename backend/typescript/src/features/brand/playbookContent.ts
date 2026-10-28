/**
 * ADR 0959 D5 — brand owns the `brand.preset` playbook content kind: a brand a playbook installs
 * into a client org, through `createBrand` / `updateBrand`. A preset carries the method's
 * positioning; the client's own identity stays theirs.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { registerPlaybookContentAdapter, shallowFieldDiff } from '../../host/playbookContentAdapters.js';
import { ensureBrand, getBrand, updateBrand } from './brandService.js';
import type { Brand } from './types.js';

const FIELDS = ['name', 'description', 'positioning', 'keyPhrases'] as const;
function snapshot(b: Brand) {
  const value: Record<string, unknown> = { name: b.name };
  if (b.description !== undefined) value.description = b.description;
  if (b.positioning !== undefined) value.positioning = b.positioning;
  if (b.keyPhrases !== undefined) value.keyPhrases = b.keyPhrases;
  return { value, revision: b.updatedAt };
}

export function registerBrandPlaybookContent(): void {
  registerPlaybookContentAdapter({
    kind: 'brand.preset',
    label: 'Brand preset',
    parse(payload) {
      const p = (payload ?? {}) as Record<string, unknown>;
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name) throw new OpenwopError('validation_error', 'A brand preset needs a name.', 400, { field: 'content.payload.name' });
      const out: Record<string, unknown> = { name };
      for (const k of FIELDS) if (k !== 'name' && p[k] !== undefined) out[k] = p[k];
      return out;
    },
    async read(ctx, resourceId) {
      const b = await getBrand(ctx.tenantId, resourceId);
      if (!b || b.orgId !== ctx.orgId) return null;
      return snapshot(b);
    },
    diff: shallowFieldDiff,
    async create(ctx, desired) {
      const id = `pb-${createHash('sha256').update(ctx.key).digest('hex').slice(0, 24)}`;
      if (await getBrand(ctx.tenantId, id)) throw new OpenwopError('conflict', 'This preset already exists; its earlier outcome needs review.', 409, { reason: 'content_outcome_unconfirmed', resourceId: id });
      const brand = await ensureBrand(ctx.tenantId, ctx.orgId, id, ctx.by, desired);
      return { resourceId: brand.id, snapshot: snapshot(brand) };
    },
    async update(ctx, resourceId, desired, expected) {
      const b = await getBrand(ctx.tenantId, resourceId);
      if (!b || b.orgId !== ctx.orgId) throw new OpenwopError('not_found', 'Brand not found.', 404, { brandId: resourceId });
      const out = await updateBrand(ctx.tenantId, resourceId, { ...desired, expectedUpdatedAt: String(expected.revision) }, ctx.by);
      if (!out) throw new OpenwopError('not_found', 'Brand not found.', 404, { brandId: resourceId });
      return snapshot(out);
    },
  });
}
