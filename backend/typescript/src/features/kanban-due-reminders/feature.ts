/**
 * ADR 1138 D4 — kanban due reminders. A tenant-bucket toggle (default OFF) and a
 * small daemon: every {@link DUE_SWEEP_TICK_MS} it sweeps a slice of the tenants that have
 * the toggle on (see `dueSweep.ts`). No routes, no packs: reminders are ordinary
 * addressed notifications, so they arrive wherever the host already delivers
 * them (inbox, push, the recipient's email/Teams preferences).
 */

import type { BackendFeature } from '../types.js';
import { runUnderWorkerContract } from '../../storage/eventEraAdapter.js';
import { createLogger } from '../../observability/logger.js';
import { DUE_SWEEP_TICK_MS, KANBAN_DUE_REMINDERS_TOGGLE, dueSweepTenantSource, dueSweepTickAt, sweepDueTick } from './dueSweep.js';

const log = createLogger('feature.kanban-due-reminders');

export const kanbanDueRemindersFeature: BackendFeature = {
  id: KANBAN_DUE_REMINDERS_TOGGLE,
  registerRoutes: () => {},
  demo: {
    unseededReason:
      'Stores nothing of its own. It reads kanban cards (dueAt + assignee), which the kanban seeders own, and sends notifications at sweep time. Seeding reminders would fabricate notification history, and fixed seed dates fall outside the 7-day overdue window within a week. To demo it, turn the toggle on for a tenant with assigned, dated cards.',
  },
  toggleDefault: {
    id: KANBAN_DUE_REMINDERS_TOGGLE,
    label: 'Due-date reminders',
    description:
      'Remind the person a board card is assigned to when it is due within two days, and again when it is overdue. One notice each per due date; moving the date re-arms them. Cards in a finished lane, and people who can no longer see the board, get none.',
    category: 'Productivity',
    status: 'off',
    bucketUnit: 'tenant',
    salt: KANBAN_DUE_REMINDERS_TOGGLE,
  },
  onStart: (ctx) => {
    let running = false;
    // Roster tenants plus every tenant with a board: an adopter with boards and no
    // roster agents would otherwise never be swept.
    const tenants = dueSweepTenantSource(ctx.listRosterTenants);
    const run = (): void => {
      if (running) return;
      running = true;
      const now = Date.now();
      void sweepDueTick(tenants, dueSweepTickAt(now), now)
        .catch((err) => log.warn('due_sweep_failed', { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => { running = false; });
    };
    const timer = setInterval(() => runUnderWorkerContract(run), DUE_SWEEP_TICK_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  },
};
