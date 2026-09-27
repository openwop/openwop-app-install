/**
 * The anonymous→signed-in content merge (ADR 0434 Phase 3).
 *
 * Split out of `localContentAdoption.ts` so it can be LAZY-IMPORTED: it runs at
 * most once per session, on a transition most page loads never make, and
 * carrying it in the entry chunk pushed the app over its gzip budget.
 *
 * The invariant: **union, never destroy, and prefer the signed-in copy on a
 * true collision.** `adoptAnonScoped` removes the anonymous source only after
 * the merged write is CONFIRMED, so a quota failure leaves the work recoverable
 * rather than dropping it.
 */

import { STORAGE_KEYS, adoptAnonScoped } from '../platform/storage.js';
import { adoptAnonUserPrompts } from '../prompts/userPrompts.js';
import type { SavedWorkflow } from '../builder/schema/workflow.js';

const BUILDER_VERSION = 1;

function isWorkflowIndex(v: unknown): v is Record<string, SavedWorkflow> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function adoptAnonContent(subject: string): void {
  // Draft workflows: a keyed map, so a genuine union. The signed-in copy wins an
  // id collision — it is the one the backend also knows about.
  adoptAnonScoped(
    STORAGE_KEYS.builderWorkflows,
    subject,
    BUILDER_VERSION,
    isWorkflowIndex,
    (anon, user) => ({ ...anon, ...(user ?? {}) }),
  );

  // Prompts — the highest-stakes key of the four: local-ONLY, so anything not
  // adopted here is stranded at the anonymous key with no server copy to
  // recover from. Owned by its own module because the envelope shape differs.
  adoptAnonUserPrompts(subject);

  // The two CHAT keys are deliberately NOT adopted. They are cold-start caches
  // for a thread that already write-throughs to the backend, and the backend
  // performs its own anon-sandbox adoption on sign-in (`/migrate-tenant`). The
  // drawer re-reads from the server, so copying the local mirror across would
  // duplicate work the authoritative store already did.
}
