/**
 * Grade/review tripwire (2026-07-10, the DOCNEW-1 class): the creation gallery
 * and the documents list gate first-party canvas types through HARD-CODED
 * per-toggle useFeatureAccess maps (hooks must stay static). A new
 * CREATABLE_CANVAS_TYPES row whose toggleId is missing from those literals
 * silently never renders — exactly how canvas.document shipped invisible.
 * This test pins the maps to the registry so the NEXT type fails loudly here.
 *
 * DOCT-DEBT-3 (grade-tests w14): case 1 used to be a source-text `includes()`,
 * so an entry under the WRONG key (`drawing: useFeatureAccess('drawings')`) or a
 * crossed id passed green while the consumer's `map[def.toggleId]` read
 * `undefined`. It now RUNS the hook with exactly one toggle on per type.
 * Sabotage witnesses: drop the `document-editor` entry → case 1 red; rename the
 * `drawings` key → case 1 red; replace DocumentsPage's hook call with a local
 * map → case 2 red.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderHook } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { CREATABLE_CANVAS_TYPES } from '../../../canvas/creatableTypes.js';

const toggles = vi.hoisted(() => ({ on: '' }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => makeFeatureAccess({ enabled: id === toggles.on, status: 'on', isBeta: false, variant: null, loading: false }),
}));

import { useCreatableTypeAccess } from '../../../canvas/useCreatableTypeAccess.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('first-party canvas types are gated through the ONE shared access map', () => {
  it('useCreatableTypeAccess has an entry for every creatable type', () => {
    for (const t of CREATABLE_CANVAS_TYPES) {
      toggles.on = t.toggleId;
      const { result, unmount } = renderHook(() => useCreatableTypeAccess());
      expect(result.current[t.toggleId]?.enabled, `useCreatableTypeAccess()['${t.toggleId}'] must read useFeatureAccess('${t.toggleId}') — the type will silently never render`).toBe(true);
      for (const other of CREATABLE_CANVAS_TYPES) {
        if (other.toggleId === t.toggleId) continue;
        expect(result.current[other.toggleId]?.enabled, `'${other.toggleId}' must not follow the '${t.toggleId}' toggle`).toBe(false);
      }
      unmount();
    }
  });
  for (const file of ['../NewDocumentModal.tsx', '../DocumentsPage.tsx']) {
    it(`${file} consumes the shared map (no drifting local copy)`, () => {
      const src = readFileSync(join(here, file), 'utf8');
      expect(src.includes('useCreatableTypeAccess()'), `${file} must gate through the shared hook`).toBe(true);
    });
  }
});
