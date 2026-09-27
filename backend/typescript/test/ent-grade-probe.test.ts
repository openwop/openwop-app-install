/**
 * GRADING PROBE — "Entities" (FEATURES.md ordinal 234). Evidence only. GREEN +
 * CI-safe (pure projection; no boot, no store, no network).
 *
 * Witnesses Headline #2 — the anonymous public-read exfil surface's FIELD
 * PROJECTION guarantee. `toPublicEntity` is the last projection before the
 * anonymous `/public-entities/*` wire; it must emit ONLY the public shape
 * (entityId / values / termIds / createdAt / updatedAt) and strip every
 * internal + PII + draft-status + per-locale-overlay field. Combined with the
 * (separately-traced) `gatePublicType` funnel + draft-exclusion-before-paginate,
 * this is why a non-published / internal field never reaches an anon caller.
 *
 * ENTP-1: the projection strips recordKey / tenantId / projectId / typeId /
 *     status / localizations / ext / orgId / createdBy / updatedBy — the output
 *     key set is a subset of the public whitelist, containing NONE of those.
 * ENTP-2: the whitelisted fields (entityId, values, termIds, timestamps) survive.
 * ENTP-3: with a negotiated locale, the localization OVERLAY MAP never reaches
 *     the wire (only resolved scalar values do).
 */
import { describe, it, expect } from 'vitest';
import { toPublicEntity, type EntityRecord } from '../src/features/entities/entitiesService.js';

const rec: EntityRecord = {
  recordKey: 'tenantX:proj:post|e1',
  entityId: 'e1',
  tenantId: 'tenantX',
  projectId: 'proj',
  typeId: 'tenantX:proj:post',
  values: { title: 'Hello', views: 3, pinned: true },
  termIds: ['news'],
  status: 'draft', // even a draft record, the projection must not emit `status`
  localizations: { es: { title: 'Hola' } },
  ext: { blocks: [{ secret: 'internal' }] },
  orgId: 'org-9',
  createdBy: 'user:alice-PII',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'user:bob-PII',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const LEAKY = ['recordKey', 'tenantId', 'projectId', 'typeId', 'status', 'localizations', 'ext', 'orgId', 'createdBy', 'updatedBy'];
const PUBLIC = ['entityId', 'values', 'termIds', 'createdAt', 'updatedAt'];

describe('Entities — anonymous public-read field projection (by execution)', () => {
  it('ENTP-1: strips every internal / PII / status / overlay field', () => {
    const out = toPublicEntity(rec);
    const keys = Object.keys(out);
    for (const k of LEAKY) expect(keys).not.toContain(k);
    expect(keys.every((k) => PUBLIC.includes(k))).toBe(true); // whitelist-only
    // spot-check PII strings never appear anywhere in the serialized output
    expect(JSON.stringify(out)).not.toContain('PII');
    expect(JSON.stringify(out)).not.toContain('internal');
  });

  it('ENTP-2: the whitelisted public fields survive', () => {
    const out = toPublicEntity(rec);
    expect(out.entityId).toBe('e1');
    expect(out.values).toEqual({ title: 'Hello', views: 3, pinned: true });
    expect(out.termIds).toEqual(['news']);
    expect(out.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(out.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('ENTP-3: a negotiated locale resolves values but never emits the overlay map', () => {
    const out = toPublicEntity(rec, { negotiated: 'es', baseLocale: 'en' });
    expect(Object.keys(out)).not.toContain('localizations');
    expect(out.values.title).toBe('Hola'); // resolved to the negotiated locale
  });
});
