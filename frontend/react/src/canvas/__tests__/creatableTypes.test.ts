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
    const ids = new Set(DEFINITIONS.map((d) => d.canvasTypeId));
    for (const row of CREATABLE_CANVAS_TYPES) {
      expect(ids.has(row.canvasTypeId), `registry row ${row.canvasTypeId} has no definition`).toBe(true);
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
