/**
 * Agent-author feature surface (ADR 0514 P1) — the typed
 * `ctx.features['agent-author']` the pack's nodes call. Toggle-gated at the
 * registry seam (the `agent-author` toggle, default OFF per ADR 0514 §4).
 *
 * @see docs/adr/0514-agent-author-describe-to-create.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import {
  buildAgentAuthorCatalog,
  validateAgentDraft,
  persistAgentDraft,
} from './agentAuthorService.js';
import { stashAgentDraft } from './draftStash.js';

export function buildAgentAuthorSurface(scope: BundleScope): FeatureSurface {
  return {
    /** The closed world: visible agents, the tenant's workflow ids, the current
     *  roster (read-before-write), and the legal autonomy levels. */
    getCatalog: async () => ({ ...(await buildAgentAuthorCatalog({ tenantId: scope.tenantId })) }),

    /** Validate a candidate roster-entry draft WITHOUT persisting; returns
     *  `{ ok, errors }` so the model can repair on the errors (ONE bounded
     *  repair — the doctrine). */
    validateDraft: async (args) => {
      const v = await validateAgentDraft((args ?? {}).draft, { tenantId: scope.tenantId });
      return { ok: v.ok, errors: v.errors };
    },

    /** Validate AND create through the SHARED wizard path (`createRosterEntry`
     *  — deterministic id, duplicate-409, CAS). The agent lands DISABLED for
     *  human review-and-enable in its workspace. */
    persistDraft: async (args) => persistAgentDraft((args ?? {}).draft, { tenantId: scope.tenantId }),

    /** OQ1 draft mode: validate, then STASH for the wizard prefill instead of
     *  creating. Requires an acting user (the stash is subject-keyed) — a
     *  typed failure otherwise, never a silent no-op. */
    stashDraft: async (args) => {
      if (!scope.actingUserId) throw new Error('stashDraft requires an acting user — the draft stash is per-user.');
      const v = await validateAgentDraft((args ?? {}).draft, { tenantId: scope.tenantId });
      if (!v.ok) throw new Error(`draft not valid: ${v.errors.join(' ')}`);
      await stashAgentDraft(scope.tenantId, scope.actingUserId, v.draft);
      return { stashed: true, persona: v.draft.persona };
    },
  };
}
