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
import { backfillCommitmentIndexes } from './assistantService.js';
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
    // ADR 0029 — index commitment rows written before the secondary indexes
    // existed. Fire-and-forget: a backfill failure degrades to the old scan
    // behavior for stale rows, never blocks boot.
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
    { name: 'feature.assistant.nodes', version: '1.3.0' },
    { name: 'feature.assistant.agents', version: '1.0.0' },
  ],
  // § Correction (2026-06-11) — graduated OFF the feature toggle. The Chief of
  // Staff is now a real roster agent (chiefOfStaff.ts) and its surfaces live on
  // the generic agent-workspace page (the standalone /assistant page is
  // removed) — there is no separate product to A/B. The graph + loops + the
  // ctx.features.assistant surface are always-on substrate, like Connections
  // (ADR 0024 § Correction). No `toggleDefault`; routes serve unconditionally.
};
