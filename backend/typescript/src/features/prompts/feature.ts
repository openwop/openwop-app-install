/**
 * Prompt library (ADR 0116, backlog B6) — a curated, RBAC-gated, shareable,
 * versioned catalog of prompts, insertable into the chat composer via `/prompt`.
 * COMPOSES the existing prompt store (the catalog REFERENCES templates, never
 * copies them), ADR 0013 sharing, ADR 0053/RFC 0027 templates.
 *
 * ALWAYS-ON (ADR 0820 §8.6 / core-audit M8 correction): the `prompts` toggle this header
 * used to describe was removed when the feature graduated (ADR 0134 / 2026-06-24);
 * there is no per-tenant switch. Gating is RBAC and visibility only.
 *
 * @see docs/adr/0116-prompt-library.md
 */
import type { BackendFeature } from '../types.js';
import { registerPromptLibraryRoutes } from './routes.js';
import { buildPromptSurface } from './promptSurface.js';

export const promptsFeature: BackendFeature = {
  id: 'prompts',
  requiredPacks: ['feature.prompts.nodes'], // NP-HOLE-PROMPTS-1
  registerRoutes: (deps) => {
    registerPromptLibraryRoutes(deps);
  },
  // ADR 0116 Phase 4 — the ctx.features.prompts workflow surface (toggle-gated at the seam).
  surface: { id: 'prompts', build: buildPromptSurface },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
