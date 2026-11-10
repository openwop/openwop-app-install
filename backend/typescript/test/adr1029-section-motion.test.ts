/**
 * ADR 1029 D2 — a section's `motion` is a closed presentation enum on the BASE
 * layer of every host section type except `fields`.
 *
 * Pins:
 *   1. each known value is kept; an unknown or non-string value is dropped, so a
 *      page that sets none stays byte-identical (the values are literals here,
 *      never the server's own list, so shrinking that list reds this case);
 *   2. `fields` (the protocol's open section body, RFC 0206) never filters its
 *      keys through the enum: a field named "motion" stays the author's text
 *      whatever it says (the renderer ignores it, pinned in the frontend
 *      `sectionMotion.test.tsx`). `buildSectionData` has no per-type branch
 *      besides `fields`, so three host types stand for the rest;
 *   3. a locale overlay never carries it (motion is not content), and the base
 *      value stands;
 *   4. the shared-section lane keeps it: `createSharedSection` and
 *      `updateSharedSection` build base data without `validateSection` (the
 *      architect review's finding), so the enum lives in `buildSectionData`;
 *   5. a base `motion` never changes a translation's source digest.
 *
 * Sabotage-witnessed (w86 grade-tests): keeping any value reds 1; dropping
 * `zoom` from `SECTION_MOTIONS` reds 1; removing the `fields` early return reds 2
 * (`'slowly, please'` loses its key); letting overlays keep it reds 3; building
 * shared create or update data with the typed builder alone reds 4; a digest that
 * reads the base `motion` reds 5.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  validateSection, createSharedSection, updateSharedSection, sourceDigestOf,
} from '../src/features/cms/cmsService.js';

const MINE = 'user:adr1029';
const ORG = 'org:adr1029';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('ADR 1029 — the motion enum on base data', () => {
  it('keeps every known value and drops anything else', () => {
    for (const motion of ['none', 'reveal', 'stagger', 'rise', 'slide-start', 'slide-end', 'zoom']) {
      expect(validateSection({ type: 'richText', data: { text: 'Body', motion } }).data.motion).toBe(motion);
    }
    for (const junk of ['spin', '', 3, null, { v: 'reveal' }]) {
      expect(validateSection({ type: 'richText', data: { text: 'Body', motion: junk } }).data).toEqual({ text: 'Body' });
    }
  });

  it('is kept on host section types (hero, columns, faq) and never filtered on `fields`', () => {
    expect(validateSection({ type: 'hero', data: { heading: 'H', motion: 'rise' } }).data.motion).toBe('rise');
    expect(validateSection({ type: 'columns', data: { columns: [], motion: 'stagger' } }).data.motion).toBe('stagger');
    expect(validateSection({ type: 'faq', data: { items: [{ q: 'Why?', a: 'Because.' }], motion: 'none' } }).data.motion).toBe('none');
    // On `fields` the name is just a user's field: kept as their text, whatever it
    // says, and never filtered through the enum.
    expect(validateSection({ type: 'fields', data: { motion: 'reveal' } }).data).toEqual({ motion: 'reveal' });
    expect(validateSection({ type: 'fields', data: { motion: 'slowly, please' } }).data).toEqual({ motion: 'slowly, please' });
  });

  it('a locale overlay never carries motion; the base value stands', () => {
    const s = validateSection({
      type: 'richText',
      data: { text: 'Body', motion: 'reveal' },
      localizations: { es: { text: 'Cuerpo', motion: 'rise' } },
    });
    expect(s.data.motion).toBe('reveal');
    expect(s.localizations?.es).toEqual({ text: 'Cuerpo' });
  });

  it('the shared-section lane keeps it on create and update', async () => {
    const created = await createSharedSection(MINE, ORG, { name: 'Band', type: 'cta', data: { heading: 'Go', label: 'Start', url: '/start', motion: 'reveal' } }, 'u');
    expect(created.data.motion).toBe('reveal');
    const updated = await updateSharedSection(MINE, ORG, created.sharedSectionId, { data: { heading: 'Go', label: 'Start', url: '/start', motion: 'stagger' } }, 'u');
    expect(updated?.data.motion).toBe('stagger');
  });

  it('a base motion never changes a translation\'s source digest', () => {
    const overlay = { text: 'Cuerpo' };
    expect(sourceDigestOf({ text: 'Body', motion: 'rise' }, overlay)).toBe(sourceDigestOf({ text: 'Body' }, overlay));
  });
});
