/**
 * ADR 0314 — the creation-gallery registry is DELIBERATE duplication (the
 * gallery may not import feature definitions; canvas/ may not import
 * features/*), so this test is the seam that keeps it honest: every row must
 * match its real definition field-for-field, every first-party type must have
 * a row, and the i18n keys the cards render must exist in the canvas catalog.
 */
import { describe, it, expect } from 'vitest';
import { CREATABLE_CANVAS_TYPES, canvasTypeNameKey } from '../creatableTypes.js';
import { messages as canvasEn } from '../i18n/en.js';
import { slidesDefinition } from '../../features/slides/definition.js';
import { drawingsDefinition } from '../../features/drawings/definition.js';
import { cadDefinition } from '../../features/cad/definition.js';
import { campaignStudioDefinition } from '../../features/campaign-studio/definition.js';
import { appBuilderDefinition } from '../../features/app-builder/definition.js';
import { documentDefinition } from '../../features/document-editor/definition.js';

const DEFINITIONS = [slidesDefinition, drawingsDefinition, cadDefinition, campaignStudioDefinition, appBuilderDefinition, documentDefinition] as const;

/** Every first-party canvas definition module, discovered — the hand list above
 *  could not notice a NEW definition with no gallery row (w46). */
const definitionModules = import.meta.glob<Record<string, unknown>>('../../features/*/definition.tsx', { eager: true });
function discoveredCanvasTypeIds(): Set<string> {
  const ids = new Set<string>();
  for (const mod of Object.values(definitionModules)) {
    for (const exp of Object.values(mod)) {
      if (!exp || typeof exp !== 'object' || !('canvasTypeId' in exp)) continue;
      const id = (exp as { canvasTypeId: unknown }).canvasTypeId;
      if (typeof id === 'string' && id.startsWith('canvas.')) ids.add(id);
    }
  }
  return ids;
}

/** Named, asserted exemptions — first-party types deliberately absent from the
 *  creation gallery. Adding one is a decision; it must be written here. */
const NOT_CREATABLE: ReadonlyMap<string, string> = new Map([
  ['canvas.challenge-outline', 'created per-candidate by the backend ensure route, never from the gallery (ADR 0458 §2.3)'],
]);

describe('creatableTypes registry ↔ feature definitions', () => {
  it('pins every registry row to its real definition (id, toggle, base path, editor path)', () => {
    for (const def of DEFINITIONS) {
      const row = CREATABLE_CANVAS_TYPES.find((r) => r.canvasTypeId === def.canvasTypeId);
      expect(row, `missing registry row for ${def.canvasTypeId}`).toBeTruthy();
      expect(row!.toggleId).toBe(def.toggleId);
      expect(row!.basePath).toBe(def.clientBasePath);
      expect(row!.editorPath).toBe(def.editorPath);
    }
  });

  it('has no orphan rows (a row whose definition was removed/renamed)', () => {
    const ids = new Set<string>(DEFINITIONS.map((d) => d.canvasTypeId));
    for (const row of CREATABLE_CANVAS_TYPES) {
      expect(ids.has(row.canvasTypeId), `registry row ${row.canvasTypeId} has no definition`).toBe(true);
    }
  });

  it('every discovered first-party definition has a row, except the named exemptions', () => {
    const discovered = discoveredCanvasTypeIds();
    // Non-vacuity floor: the glob really found the definitions (7 today).
    expect(discovered.size).toBeGreaterThanOrEqual(7);
    const rows = new Set(CREATABLE_CANVAS_TYPES.map((r) => r.canvasTypeId));
    const missing = [...discovered].filter((id) => !rows.has(id) && !NOT_CREATABLE.has(id));
    expect(missing).toEqual([]);
    // Every exemption is real (a discovered type) and really has no row.
    for (const id of NOT_CREATABLE.keys()) {
      expect(discovered.has(id), `exemption ${id} names no definition`).toBe(true);
      expect(rows.has(id), `exempt ${id} has a gallery row`).toBe(false);
    }
  });

  it('every card key resolves in the canvas i18n catalog', () => {
    const catalog = canvasEn as Record<string, string>;
    for (const row of CREATABLE_CANVAS_TYPES) {
      expect(typeof catalog[row.nameKey], `canvas ns missing ${row.nameKey}`).toBe('string');
      expect(typeof catalog[row.hintKey], `canvas ns missing ${row.hintKey}`).toBe('string');
    }
  });

  it('canvasTypeNameKey resolves known types and nulls unknown (pack) types', () => {
    expect(canvasTypeNameKey('canvas.slides')).toBe('type_slides');
    expect(canvasTypeNameKey('canvas.checklist')).toBeNull();
  });
});
