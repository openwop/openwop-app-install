/**
 * Entities — the anonymous public-read FIELD PROJECTION (ADR 0386 / ADR 0406).
 * `toPublicEntity` is the last projection before the anonymous
 * `/public-entities/*` wire; it must emit ONLY the public shape
 * (entityId / values / termIds / createdAt / updatedAt) and strip every internal,
 * PII, draft-status and per-locale-overlay field.
 *
 * Unit-level and WHITELIST-based, which is what separates it from
 * `entities-public-read.test.ts` (route-level, blacklists five fields): any NEW
 * field leaking onto the wire is red here. Formerly `ent-grade-probe.test.ts`
 * (grading ordinal 234, #3516). Tracker TST-CXG-1.
 *
 * ENTP-1 red when the projection emits an internal field (e.g. `status`).
 * ENTP-2 red when a whitelisted field (e.g. `termIds`) is dropped.
 * ENTP-3 red when a negotiated locale stops resolving values (the overlay map
 *   never reaches the wire either way).
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

describe('Entities — anonymous public-read field projection', () => {
  it('ENTP-1: strips every internal / PII / status / overlay field', () => {
    const out = toPublicEntity(rec);
    const keys = Object.keys(out);
    for (const k of LEAKY) expect(keys).not.toContain(k);
    expect(keys.sort()).toEqual([...PUBLIC].sort()); // EXACTLY the whitelist
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
