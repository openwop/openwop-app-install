/**
 * ADR 0488 D1 — the tutorials kernel lane, against the REAL entities kernel.
 *
 * WHY THIS FILE EXISTS. `tutorials-service.test.ts` mocks the entire kernel
 * (`vi.mock('../src/features/entities/entitiesService.js')`), which is right for
 * testing the degraded-mode floor but means it cannot see whether the kernel
 * would ACCEPT what we send it. It could not: `tutorials.lesson` declared three
 * field types outside the kernel's closed vocabulary and passed no
 * `extensionKinds`, so `mintSystemType` threw on every call and the type was
 * never created in any workspace — the ADR's entire tenant-editable /
 * localizable / AI-authorable premise was dead behind the seed floor, green the
 * whole time.
 *
 * This is the program's THIRD instance of "built, tested, and not reachable",
 * and the second where a mock was the thing hiding it. So this test uses the
 * real service end-to-end and asserts on ROWS, never on a call count.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { seedTutorials, listTutorials, getTutorial, countTutorialRows, clearTutorialRows } from '../src/features/tutorials/tutorialsService.js';
import { SEED_TUTORIALS } from '../src/features/tutorials/seedTutorials.js';
import { TUTORIAL_DOC_KIND, TUTORIAL_FIELDS, TUTORIAL_TYPE } from '../src/features/tutorials/tutorialType.js';
import { getSystemEntity } from '../src/features/entities/entitiesService.js';
import { FIELD_TYPES, getFieldKindValidator } from '../src/host/customFields/index.js';

const TENANT = `t-tut-mint-${process.pid}`;

beforeAll(async () => {
  // Bare-storage harness (the demo-entities-seed pattern). NOTE the entities
  // toggle is deliberately NOT registered/enabled here: `entitiesService` gates
  // at the ROUTE layer, not the service, so the kernel lane is reachable exactly
  // as tutorials calls it in production.
  initHostExtPersistence(await openStorage('memory://'));
});

beforeEach(async () => {
  await clearTutorialRows(TENANT).catch(() => undefined);
});

describe('ADR 0488 D1 — the mint actually succeeds against the real kernel', () => {
  it('seeds REAL ROWS (the regression: this threw on every call and created none)', async () => {
    const res = await seedTutorials(TENANT);
    expect(res.created).toBe(SEED_TUTORIALS.length);
    // The assertion that matters — rows exist, not "the mint was called".
    expect(await countTutorialRows(TENANT)).toBe(SEED_TUTORIALS.length);
  });

  it('serves those rows as source=kernel, NOT the seed floor', async () => {
    await seedTutorials(TENANT);
    const { tutorials, degraded } = await listTutorials(TENANT);
    expect(degraded).toBe(false);
    expect(tutorials.length).toBe(SEED_TUTORIALS.length);
    // Before the fix every one of these was 'seed' — the floor masking a dead lane.
    expect(tutorials.map((t) => t.source)).toEqual(tutorials.map(() => 'kernel'));
  });

  it('round-trips the STRUCTURED fields (phases survive the extension kind)', async () => {
    await seedTutorials(TENANT);
    const seed = SEED_TUTORIALS.find((t) => t.phases.length > 0);
    expect(seed, 'fixture guard: no seeded tutorial has phases').toBeDefined();
    const view = await getTutorial(TENANT, seed!.id);
    expect(view?.source).toBe('kernel');
    expect(view?.phases.length).toBe(seed!.phases.length);
    // The nested run bindings are what "Show me this phase" launches — prove the
    // nesting survived storage rather than only the top-level array length.
    expect(view?.phases.map((p) => p.chainId)).toEqual(seed!.phases.map((p) => p.chainId));
  });

  it('is idempotent: re-seeding the same version creates nothing new', async () => {
    await seedTutorials(TENANT);
    const again = await seedTutorials(TENANT);
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(SEED_TUTORIALS.length);
    expect(await countTutorialRows(TENANT)).toBe(SEED_TUTORIALS.length);
  });

  it('writes rows the kernel can read back by id', async () => {
    await seedTutorials(TENANT);
    const row = await getSystemEntity(TENANT, TUTORIAL_TYPE, SEED_TUTORIALS[0]!.id);
    expect(row).not.toBeNull();
    expect((row!.values as Record<string, unknown>).slug).toBe(SEED_TUTORIALS[0]!.id);
  });
});

describe('ADR 0488 D1 — the field table stays inside what the kernel accepts', () => {
  it('every declared field type is a built-in OR the registered extension kind', () => {
    const allowed = new Set<string>([...FIELD_TYPES, TUTORIAL_DOC_KIND]);
    const rogue = (TUTORIAL_FIELDS as readonly { key: string; type: string }[]).filter((f) => !allowed.has(f.type));
    expect(
      rogue.map((f) => `${f.key}:${f.type}`),
      'A field type outside the closed vocabulary makes mintSystemType throw, which '
      + 'silently kills the whole kernel lane (the type is never created). Add the kind '
      + 'to extensionKinds and register a validator, or use a built-in type.',
    ).toEqual([]);
    // Non-vacuity: the table must actually be exercising both lanes.
    expect(TUTORIAL_FIELDS.some((f) => f.type === TUTORIAL_DOC_KIND)).toBe(true);
    expect(TUTORIAL_FIELDS.some((f) => (FIELD_TYPES as readonly string[]).includes(f.type))).toBe(true);
  });

  it('`localizable` is only claimed on string fields (the kernel rejects it elsewhere)', () => {
    const bad = (TUTORIAL_FIELDS as readonly { key: string; type: string; localizable?: boolean }[])
      .filter((f) => f.localizable === true && f.type !== 'string');
    expect(bad.map((f) => f.key)).toEqual([]);
  });

  it('the extension kind is registered before any mint can reference it', () => {
    expect(getFieldKindValidator(TUTORIAL_DOC_KIND)).toBeDefined();
  });
});

describe('the tutorial-doc validator bounds what it cannot type', () => {
  const validate = (v: unknown): unknown => getFieldKindValidator(TUTORIAL_DOC_KIND)!.validate(v, { key: 'phases', label: 'Phases', type: TUTORIAL_DOC_KIND, required: true });

  it('accepts plain JSON content', () => {
    expect(validate([{ id: 'p1', steps: [{ id: 's1', title: 'x' }] }])).toBeDefined();
  });

  it('rejects values that would not survive a storage round-trip', () => {
    expect(() => validate({ when: new Date() })).toThrow(/plain JSON data/);
    expect(() => validate({ fn: () => 1 })).toThrow(/plain JSON data/);
    expect(() => validate({ n: Number.NaN })).toThrow(/non-finite/);
  });

  it('rejects unbounded nesting', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(() => validate(deep)).toThrow(/nests deeper/);
  });
});
