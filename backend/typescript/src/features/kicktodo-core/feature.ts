/**
 * kicktodo-core — the KickTodo consumer product spine (ADR 0414; PRD §9.2).
 *
 * Self-contained feature-package (ADR 0001): challenge definitions
 * (published-immutable), enrollments (one bounded ADR 0412 goal each), the
 * daily-action loop on the subject-owned Kanban board (deterministic card
 * ids + plan-revision supersession), check-ins, and the bounded Today
 * aggregate. Composes existing owners only — no parallel run/goal/schedule/
 * board/notification/money model (the ADR's contract).
 *
 * Toggle: default OFF, `bucketUnit: user` (a personal product; the KickTodo
 * distribution compiles it in and flips it ON). Category `KickTodo` — the
 * bundle grouping lands in `distributions/bundles.json` once the creator
 * package joins it (an empty grouping violates catalog invariants).
 */

import type { BackendFeature } from '../types.js';
import { registerKicktodoLoopWorkflows } from './builtinWorkflows.js';
import { registerKicktodoCoreRoutes } from './routes.js';
import { registerKicktodoGoalVerifier } from './progressService.js';
import { registerKicktodoAgentTools } from './agentTools.js';
import { registerKicktodoArtifactTypes } from './artifactSchemas.js';
import { registerChallengeCatalogSection } from './challengeCatalogSection.js';
import { buildKicktodoCoreSurface } from './surface.js';
import { registerKickbotLifecycleHooks } from './kickbotService.js';
import { seedKicktodoConveneTurnWorkflow } from './conveneTurnWorkflow.js';
import { registerKicktodoCoreCompliance } from './compliance.js';
import { registerKicktodoApprovalsExceptionSource } from './exceptionSources.js';

export const kicktodoCoreFeature: BackendFeature = {
  id: 'kicktodo-core',
  /**
   * ADR 0684 phase 3 — the default participant org + shared workspace.
   *
   * Declared HERE rather than reserved in `accessControlService` beside
   * `host-site`: that would be one line cheaper and would make core a registry
   * of product names, which is the ADR 0001 boundary. The feature that means it
   * owns the id.
   *
   * The tenant IS the shared participant workspace (ADR 0684 §2), so the
   * catalog, enrollments, circles and the leaderboard are same-tenant reads and
   * nothing crosses a tenant boundary. `enrollmentService.ts:175` fetches the
   * challenge from the ENROLLING tenant, which is why co-location — rather than
   * a cross-tenant bridge — is the shape.
   *
   * Hyphen for the org, colon for the tenant (`systemSite.ts:30-31`). The org id
   * is what a signed-out SPA puts in `/public/<orgId>/challenges`, so it stays
   * boring on purpose.
   */
  defaultOrg: {
    // `host-kicktodo` is BOTH the org id and the tenant id — a workspace root.
    // The tenant was `host:kicktodo` until the ADR 0684 correction; see the
    // ADR's §3 note for why the colon form made the workspace unenterable.
    id: 'host-kicktodo',
    name: 'KickTodo',
  },
  registerRoutes: (deps) => {
    registerKicktodoLoopWorkflows(); // ADR 0472 P4
    registerKicktodoCoreRoutes(deps);
    // ADR 0414 P3 — the deterministic progress judge every enrollment goal
    // declares (`kicktodo:progress-evidence`); goals fail closed without it.
    registerKicktodoGoalVerifier();
    // ADR 0414 P4 — the chat-grounding read tools (pack-allowlisted; fail
    // empty without an acting user) + the host-native kicktodo.* artifact types.
    // ADR 0459 P1 — the replan ACTION tool needs the run-starter deps (it dispatches
    // the replan workflow directly, the ADR 0458 factory.run pattern).
    registerKicktodoAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
    registerKicktodoArtifactTypes();
    // ADR 0641 phase 4 — the `challengeCatalog` content section. A registry
    // INVERSION: this feature registers, `host/contentDataSources.ts` holds only
    // the map, and `publishing` resolves through it without importing KickTodo.
    // Registered ESSENTIAL, so an acquisition page whose catalog resolves empty
    // fails the prerender rather than publishing intact chrome around nothing.
    registerChallengeCatalogSection();
    // ADR 0442 P5 (live-convene) — the turn-workflow a convened specialist runs
    // on (single host agent-runner node, managed cred, posts advice back). Fired
    // by the `convene` tool via a fire-now scheduler job (the schedule-followup
    // seam — a chat tool can reach the scheduler, not the run-starter).
    seedKicktodoConveneTurnWorkflow();
    // ADR 0689 — KickBot speaks first rides the SAME convene turn-workflow above
    // (a proactive guide turn is one agent-runner node with a different agent and
    // task); no second in-tree workflow, per the shrink-only pin-site ratchet.
    // ADR 0442 P3 — leave-no-trace for the managed KickBot guidance KB the
    // provisioning saga creates (drop the collection when KickBot is deleted;
    // the per-user memory scope is the participant's own and needs no cleanup).
    registerKickbotLifecycleHooks();
    // ADR 0458 Phase 0 — the ONE subject-eraser + retention-purger + subject-key
    // resolver for this package (registerRoutes runs for every feature regardless
    // of toggle, so erasure works even when KickTodo is turned off).
    registerKicktodoCoreCompliance();
    // ADR 0460 Phase 2 — the KickTodo approvals feed of the admin Exception Ledger
    // (a read over the shared approvals queue; the host exception-projection seam).
    registerKicktodoApprovalsExceptionSource();
  },
  toggleDefault: {
    id: 'kicktodo-core',
    label: 'KickTodo',
    description:
      'Guided challenges: enroll, daily actions on your board, check-ins, and judged completion through standing goals (ADR 0414).',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'user',
    salt: 'kicktodo-core',
  },
  // Goals is core substrate (always-on), but the dependency is real: the
  // enrollment saga creates one ADR 0412 goal per enrollment. Declaring it is
  // free (an always-on dep never locks) and records the relationship.
  dependsOn: ['goals'],
  // ADR 0414 P4 — the ctx.features['kicktodo-core'] workflow surface the
  // feature.kicktodo.nodes pack composes.
  surface: { id: 'kicktodo-core', build: buildKicktodoCoreSurface },
  // Version-pinned packs (replay determinism, RFC 0076): a pack bump requires
  // bumping these pins in lockstep.
  requiredPacks: [
    // ADR 0459 — nodes P1 apply-revision-commands + session-reminder; grade-fix
    // enrich-plan-revision. agents = the replan-composer handoff skill.
    // ADR 0463 — nodes 1.21.0 (replan-clarify a2ui leg), agents 1.7.0 (the
    // plan-revision `clarification` arm). Pins move in lockstep.
    // ADR 0689 — nodes 1.28.0 (kickbot-coach-turn, the reminder-loop's second node).
    { name: 'feature.kicktodo.nodes', version: '1.30.0' },
    { name: 'feature.kicktodo.agents', version: '1.9.0' },
  ],
};
