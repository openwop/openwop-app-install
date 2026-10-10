/**
 * Structured handoffs (ADR 0829) — every transfer of work carries a record of
 * the intent, the decisions made and who made them, the open questions, what
 * was tried, and a confidence, stamped once on the event that carries it.
 *
 * This entry owns the ADR 0829 P5 tripwire evidence (`evidence.ts`: one
 * superadmin read route and its usage store), the ADR 0854 approval handoffs and
 * the handoff channel cards. The emission lives in core
 * (`host/handoff/handoffRecord.ts`, called from the `core.dispatch` loop and the
 * executor's suspend site) and never imports this package.
 *
 * ALWAYS ON since 2026-10-07 (maintainer decision): no toggle. It was shipped
 * OFF for a pilot, then default ON; a stored per-workspace override could still
 * hide it, so the toggle was removed.
 *
 * @see docs/adr/0829-structured-handoff-record.md
 */
import type { BackendFeature } from '../types.js';
import { registerHandoffObserver } from '../../host/handoff/handoffObservers.js';
import { handoffEvidenceObserver, registerHandoffEvidenceRoute } from './evidence.js';
import { handoffCardObserver } from './handoffCards.js';
import { registerApprovalHandoffErasure, registerApprovalHandoffRoutes } from './approvalHandoffs.js';

export const structuredHandoffsFeature: BackendFeature = {
  id: 'structured-handoffs',
  registerRoutes: (deps) => {
    // ADR 0829 P5 — measure the protocol tripwire instead of recollecting it.
    registerHandoffObserver(handoffEvidenceObserver(deps.storage));
    registerHandoffEvidenceRoute(deps);
    // ADR 0854 D2 — a card in the project's chat / bound channels when a handoff reaches a person.
    registerHandoffObserver(handoffCardObserver(deps.storage));
    // ADR 0854 D1 — "Ask someone else to decide" (never grants authority).
    registerApprovalHandoffRoutes(deps);
    registerApprovalHandoffErasure();
  },
};
