/**
 * Prompt library (ADR 0116, backlog B6) — a curated, RBAC-gated, shareable,
 * versioned catalog of prompts, insertable into the chat composer via `/prompt`.
 * COMPOSES the existing prompt store (the catalog REFERENCES templates, never
 * copies them), ADR 0013 sharing, ADR 0053/RFC 0027 templates. A `prompts` toggle,
 * off by default, bucketed per TENANT (a shared team asset).
 *
 * @see docs/adr/0116-prompt-library.md
 */
import type { BackendFeature } from '../types.js';
import { registerPromptLibraryRoutes } from './routes.js';
import { buildPromptSurface } from './promptSurface.js';

export const promptsFeature: BackendFeature = {
  id: 'prompts',
  registerRoutes: (deps) => {
    registerPromptLibraryRoutes(deps);
  },
  // ADR 0116 Phase 4 — the ctx.features.prompts workflow surface (toggle-gated at the seam).
  surface: { id: 'prompts', build: buildPromptSurface },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
