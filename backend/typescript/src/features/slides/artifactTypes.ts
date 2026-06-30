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

/** JSON Schema (2020-12) for a `canvas.slides` deck. Closed shape per slide. */
export function slidesSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['slides'],
    properties: {
      title: { type: 'string', maxLength: 200 },
      // Named theme token; the renderer maps unknown themes to the default.
      theme: { type: 'string', enum: ['default', 'light', 'dark', 'editorial', 'vibrant'] },
      slides: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['layout'],
          properties: {
            layout: { type: 'string', enum: ['title', 'title-bullets', 'section', 'quote', 'image', 'blank'] },
            title: { type: 'string', maxLength: 240 },
            subtitle: { type: 'string', maxLength: 400 },
            bullets: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 400 } },
            // A quote slide's attributed source.
            attribution: { type: 'string', maxLength: 200 },
            // An image slide references a host media token / URL (not raw bytes).
            imageUrl: { type: 'string', maxLength: 2000 },
            // Speaker notes — rendered only in the workbench, not on the slide.
            notes: { type: 'string', maxLength: 4000 },
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
