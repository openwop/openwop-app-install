/**
 * Slides canvas artifact type (ADR 0153 Phase 1 — the pilot canvas). Registers
 * `canvas.slides` through the host artifact-type registry (ADR 0055), so a chat
 * agent or workflow run can emit a structured slide deck that (a) validates before
 * the `artifact.created` run event and (b) renders inline in the chat artifact
 * workbench via the ADR 0153 Phase-0 renderer registry. No new wire surface —
 * `canvas.slides` is a host-pinned artifact type this host renders itself.
 *
 * The payload is CONSTRAINED JSON against a fixed element schema (the safe
 * model-emits-typed-JSON pattern, ADR 0153 §R4) — never executable code. The
 * pilot keeps the schema inline here; the shared component-catalog registry lands
 * in Phase 2 (app-builder), where it is first consumed.
 */

import { registerArtifactType } from '../../host/artifactTypes.js';
import { SLIDE_BLOCKS } from './blockCatalog.js';

/** JSON Schema (2020-12) for a `canvas.slides` deck. Closed shape per slide. */
export function slidesSchema(): Record<string, unknown> {
  return {
    $defs: {
      slideBlock: {
        type: 'object',
        additionalProperties: false,
        required: ['type'],
        properties: {
          // Grade pass 2026-07-10 (I1): the closed vocabulary is enforced at
          // the ARTIFACT boundary too (the seam AI output actually crosses),
          // single-sourced from the block catalog — not just on editor PATCH.
          type: { type: 'string', enum: SLIDE_BLOCKS.map((b) => b.type) },
          props: { type: 'object' },
          children: { type: 'array', maxItems: 40, items: { $ref: '#/$defs/slideBlock' } },
          // ADR 0344 2b (additive): the chassis tree traits — the shared editor
          // panel can set them on any tree-trait type, so the slides renderer +
          // export honor `hidden` and the editor refuses gestures on `locked`.
          hidden: { type: 'boolean' },
          locked: { type: 'boolean' },
        },
      },
    },
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['slides'],
    properties: {
      title: { type: 'string', maxLength: 200 },
      // Named theme token; the renderer maps unknown themes to the default.
      theme: { type: 'string', enum: ['default', 'light', 'dark', 'editorial', 'vibrant', 'brand'] },
      slides: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['layout'],
          properties: {
            layout: { type: 'string', enum: ['title', 'title-bullets', 'section', 'quote', 'image', 'blank', 'blocks'] },
          // ADR 0328 Phase 3 — blocks-based slides: a closed component tree
          // (geometry belongs to `variant`; blocks never carry x/y).
          variant: { type: 'string', enum: ['full', 'hero', 'split', 'two-col'] },
          blocks: {
            type: 'array',
            maxItems: 40,
            items: { $ref: '#/$defs/slideBlock' },
          },
            title: { type: 'string', maxLength: 240 },
            subtitle: { type: 'string', maxLength: 400 },
            bullets: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 400 } },
            // A quote slide's attributed source.
            attribution: { type: 'string', maxLength: 200 },
            // An image slide references a host media token / URL (not raw bytes).
            imageUrl: { type: 'string', maxLength: 2000 },
            // Speaker notes — rendered only in the workbench, not on the slide.
            notes: { type: 'string', maxLength: 4000 },
            // ADR 0328 Phase 4 — presenter semantics: a skipped slide stays in
            // the deck but is passed over in present mode (and dimmed in the strip).
            skip: { type: 'boolean' },
            // ADR 0328 Phase 5 — motion: how this slide ENTERS in present mode
            // ('magic' = content-key state-diff matching, the Keynote model).
            transition: { type: 'string', enum: ['none', 'fade', 'magic'] },
            // Blocks slides only: reveal blocks one step per advance (the
            // build order IS the block order — blocks-not-freeform).
            build: { type: 'boolean' },
          // ADR 0328 Phase 2 — a closed per-slide background accent.
          background: { type: 'string', enum: ['default', 'accent'] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
}

let registered = false;

/** Register `canvas.slides`. Idempotent; called at boot from the slides feature. */
export function registerSlidesArtifactType(): void {
  if (registered) return;
  registerArtifactType({
    artifactTypeId: 'canvas.slides',
    title: 'Slide Deck',
    schema: slidesSchema(),
    // Export facets the Documents render path (ADR 0057) can satisfy.
    export: ['slides', 'pdf'],
    registrationSource: 'host',
  });
  registered = true;
}
