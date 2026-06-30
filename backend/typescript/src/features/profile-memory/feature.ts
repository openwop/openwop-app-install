/**
 * Personal Memory (ADR 0041). A THIN feature-package — the human counterpart of
 * Agent Knowledge (ADR 0038) — that lets a person train their OWN profile with
 * personal memories, building toward a digital twin of themselves.
 *
 * Adds NO new store and NO parallel architecture: memories live in the shared
 * RFC-0004 subject-memory store (`host/subjectMemory.ts`) under `user:<userId>`,
 * the SAME primitive agents use under `agent:<id>`. The descriptive `Profile`
 * record (ADR 0005) is untouched — memory is referenced by the opaque userId,
 * never inlined.
 *
 * § Correction (2026-06-15) — GRADUATED off the feature toggle (always-on), like
 * `profiles` itself (ADR 0005 § Correction). Personal Memory is a sub-surface of
 * the always-on profiles substrate: it would be odd for a person's own profile to
 * carry an admin-gated tab they can't turn on themselves, and durability (the
 * original gating rationale, ADR 0041 Finding 4) is satisfied — curated notes are
 * durable. The routes now serve unconditionally; identity + self-ownership still
 * gate every handler (`resolveCallerUser` fails closed for anonymous callers, and
 * the subject is always the caller's own `userId`).
 *
 * @see docs/adr/0041-subject-memory.md
 */

import type { BackendFeature } from '../types.js';
import { registerProfileMemoryRoutes } from './routes.js';
import { registerProfileKnowledgeRoutes } from './knowledgeRoutes.js';

export const profileMemoryFeature: BackendFeature = {
  id: 'profile-memory',
  registerRoutes: (deps) => {
    registerProfileMemoryRoutes(deps);
    // ADR 0042 — documents alongside notes (the human "Knowledge & Memory" mirror
    // of the single agent-knowledge feature). Same always-on surface.
    registerProfileKnowledgeRoutes(deps);
  },
  // No `toggleDefault` — graduated to always-on (§ Correction above).
};
