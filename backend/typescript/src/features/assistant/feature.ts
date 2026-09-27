/**
 * Executive Assistant / Chief-of-Staff feature (ADR 0023).
 *
 * A self-contained feature-package (ADR 0001) added by appending to
 * BACKEND_FEATURES — zero core edits. It OWNS one new concept: the structured
 * memory graph (assistantService). Every other concern is composed from existing
 * host surfaces — RAG is the `kb` feature, action items are host.kanban, people
 * are CRM, approvals are the Notifications/heartbeat loop, credentials are the
 * Connections broker (ADR 0024), and all I/O is the existing core node packs.
 *
 * Faces: REST (routes) + ctx.features.assistant (surface) + the
 * feature.assistant.{nodes,agents} packs.
 *
 * § Correction (2026-06-12): NO toggle (graduated below). The three
 * prioritization PROFILES (ADR 0023 §4) were originally pitched as toggle
 * variants stamped into `run.metadata.featureVariant`, but nothing in the
 * assistant ever READ that variant — `composeBriefing`, the `prioritize`
 * surface, and the board projection all take an explicit profile arg defaulting
 * to `balanced`. The variants were vestigial, so graduating the toggle drops no
 * behavior. (A future per-workspace surfacing posture would be a setting on the
 * agent/profile, not a resurrected toggle.)
 */

import type { BackendFeature } from '../types.js';
import { registerAssistantRoutes } from './routes.js';
import { buildAssistantSurface } from './surface.js';
import { registerAssistantLoopWorkflows } from './loops.js';
import { registerAssistantActionApproval } from './actionApproval.js';
import { registerAssistantActionExecutions } from './actionExecution.js';
import { registerAssistantAgentTools } from './agentTools.js';
import { backfillCommitmentIndexes, purgeTenantAssistantIndexes } from './assistantService.js';
import { eraseAssistantSubject } from './erasure.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerTenantPurgeHook } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.assistant');

export const assistantFeature: BackendFeature = {
  id: 'assistant',
  registerRoutes: (deps) => {
    registerAssistantRoutes(deps);
    // ADR 0023 §12 T2 — the loop workflow definitions enter the catalog at
    // boot (tenant-agnostic; activation is the per-tenant scheduler job).
    registerAssistantLoopWorkflows();
    // ADR 0023 §12 T4/T6 — the single approval loop: the core approvals
    // routes decide assistant actions through this handler (core owns the
    // hook), and the winning claim dispatches execution via runStarter with
    // these deps (T6).
    registerAssistantActionApproval({ storage: deps.storage, hostSuite: deps.hostSuite });
    registerAssistantActionExecutions();
    // CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — restore the personas' agency in the ONE
    // chat: register the assistant-owned capabilities as real chat tools (ADR
    // 0308 seam) so the allowlisted ids resolve instead of being silently dropped.
    registerAssistantAgentTools();
    // COS-1 — GDPR subject erasure + the PII declarations (importing the module
    // runs its module-scope `declarePiiFields` calls). Registered
    // UNCONDITIONALLY, like strategy's: an erasure must never depend on a
    // toggle, and this feature has no toggle to depend on anyway.
    registerSubjectEraser(eraseAssistantSubject);
    // PMXWF-1 (ADR 0590) — tenant-teardown pre-hook: the commitment secondary
    // indexes key `${tenantId}:…` with no top-level `tenantId`, so the generic
    // purgeTenantHostExt walk cannot reach them (they would orphan on account
    // deletion). Registered unconditionally, like the eraser above.
    registerTenantPurgeHook('assistant', purgeTenantAssistantIndexes);
    // ADR 0029 — index commitment rows written before the secondary indexes
    // existed. Fire-and-forget so it never blocks boot, and — COS-4 — safe to be
    // fire-and-forget because the READ path no longer depends on it:
    // `listCommitments` reads through the base collection's COMPLETE built-in
    // tenant index (`listForTenantIndexed`), so an un-backfilled ADR 0029 row is
    // NOT invisible (the old docblock here claimed "a backfill failure degrades
    // to the old scan behavior" — the inverse of the truth: before COS-4 an
    // unindexed commitment was INVISIBLE, not degraded). The backfill is now
    // gated on a DURABLE marker, so it runs at most once fleet-wide instead of
    // re-scanning the cross-tenant collection on every cold start.
    void backfillCommitmentIndexes()
      .then((n) => {
        if (n > 0) log.info('assistant commitment indexes backfilled', { rows: n });
      })
      .catch((err) => log.warn('assistant index backfill failed', { error: String(err) }));
  },
  // Face 2 (ADR 0014): `ctx.features.assistant` — the typed graph surface the
  // loop node-pack calls (reads + idempotent role:action writes).
  surface: { id: 'assistant', build: buildAssistantSurface },
  requiredPacks: [
    // WF-COS-2/3 — bumped WITH the pack (1.3.0 -> 1.4.0). This pin is the
    // registry install TARGET, so a bumped pack with an unbumped pin fetches the
    // OLD content and the `role:"side-effect"` flip would never reach the host.
    { name: 'feature.assistant.nodes', version: '1.4.2' },
    { name: 'feature.assistant.agents', version: '1.0.3' },
  ],
  // § Correction (2026-06-11) — graduated OFF the feature toggle. The Chief of
  // Staff is now a real roster agent (capability.ts) and its surfaces live on
  // the generic agent-workspace page (the standalone /assistant page is
  // removed) — there is no separate product to A/B. The graph + loops + the
  // ctx.features.assistant surface are always-on substrate, like Connections
  // (ADR 0024 § Correction). No `toggleDefault`; routes serve unconditionally.
};
