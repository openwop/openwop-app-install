/**
 * `ctx.features['slides']` surface (XCH-SLIDES-1, LLM-EXCHANGE-AUDIT Wave 3) —
 * the app-builder ADR 0358 pattern ported to slides: ONE live catalog
 * projection feeding the pack nodes' prompts, the `openwop:slides.catalog`
 * agent tool, and (via the same SSoT) validation — so the block vocabulary a
 * model sees can never drift from what `validateSlidesDoc`/`blockCatalog`
 * enforce. Read-only; deck reads/writes stay on the canvas surface + artifact
 * registry exactly as before.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { catalogPromptSchema } from '../../host/canvasComponentCatalog.js';
import { SLIDES_CANVAS_TYPE, SLIDE_VARIANTS, blockTypeListForPrompt } from './blockCatalog.js';
import { SLIDE_LAYOUTS, SLIDE_THEMES, SLIDE_TRANSITIONS, validateSlidesDoc } from './validateSlidesDoc.js';

export function slidesCatalogProjection(): {
  canvasTypeId: string;
  blockTypeList: string;
  promptSchema: string;
  layouts: readonly string[];
  variants: readonly string[];
  themes: readonly string[];
  transitions: readonly string[];
} {
  return {
    canvasTypeId: SLIDES_CANVAS_TYPE,
    blockTypeList: blockTypeListForPrompt(),
    promptSchema: catalogPromptSchema(SLIDES_CANVAS_TYPE),
    layouts: SLIDE_LAYOUTS,
    variants: SLIDE_VARIANTS,
    themes: SLIDE_THEMES,
    transitions: SLIDE_TRANSITIONS,
  };
}

export function buildSlidesSurface(_scope: BundleScope): FeatureSurface {
  return {
    getCatalog: async () => slidesCatalogProjection(),
    // XCH-SLIDES-2 (LLM-EXCHANGE-AUDIT Wave 4) — the closed-world verdict for
    // the pack's draft node, so validation errors can be fed BACK to the model
    // for a bounded repair (the app-builder Wave-2 `validate` symmetry).
    validate: async (args) => {
      const deck = (args ?? {}).deck;
      if (!deck || typeof deck !== 'object' || Array.isArray(deck)) {
        throw new OpenwopError('validation_error', '`deck` must be the deck document to validate.', 400, { field: 'deck' });
      }
      const v = validateSlidesDoc(deck as Record<string, unknown>);
      return { ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings };
    },
  };
}
