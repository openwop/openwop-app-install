/**
 * Chat memory auto-extraction (ADR 0120, backlog B10) — opt-in extraction of
 * durable memory from chat into the existing subject-memory namespace. FENCED
 * like a consent grant (ADR 0044): fail-closed, per-user opt-in. Phase 1 ships
 * ONLY the grant gate — no extraction yet. A `memory-auto-extract` toggle, off by
 * default, bucketed per USER (it writes into one person's personal memory).
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import type { BackendFeature } from '../types.js';
import { registerMemoryExtractRoutes } from './routes.js';

export const memoryAutoExtractFeature: BackendFeature = {
  id: 'memory-auto-extract',
  registerRoutes: (deps) => {
    registerMemoryExtractRoutes(deps);
  },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
