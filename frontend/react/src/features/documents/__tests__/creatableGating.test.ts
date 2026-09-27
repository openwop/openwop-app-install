/**
 * Grade/review tripwire (2026-07-10, the DOCNEW-1 class): the creation gallery
 * and the documents list gate first-party canvas types through HARD-CODED
 * per-toggle useFeatureAccess maps (hooks must stay static). A new
 * CREATABLE_CANVAS_TYPES row whose toggleId is missing from those literals
 * silently never renders — exactly how canvas.document shipped invisible.
 * This test pins the maps to the registry so the NEXT type fails loudly here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CREATABLE_CANVAS_TYPES } from '../../../canvas/creatableTypes.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('first-party canvas types are gated through the ONE shared access map', () => {
  it('useCreatableTypeAccess has an entry for every creatable type', () => {
    const src = readFileSync(join(here, '../../../canvas/useCreatableTypeAccess.ts'), 'utf8');
    for (const t of CREATABLE_CANVAS_TYPES) {
      expect(src.includes(`useFeatureAccess('${t.toggleId}')`), `missing useFeatureAccess('${t.toggleId}') in useCreatableTypeAccess — the type will silently never render`).toBe(true);
    }
  });
  for (const file of ['../NewDocumentModal.tsx', '../DocumentsPage.tsx']) {
    it(`${file} consumes the shared map (no drifting local copy)`, () => {
      const src = readFileSync(join(here, file), 'utf8');
      expect(src.includes('useCreatableTypeAccess()'), `${file} must gate through the shared hook`).toBe(true);
    });
  }
});
