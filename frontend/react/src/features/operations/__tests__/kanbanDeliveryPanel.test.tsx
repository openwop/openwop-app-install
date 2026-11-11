/** ADR 1081 — fleet Kanban delivery has honest, panel-local UI states. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { KanbanDeliveryPanel } from '../KanbanDeliveryPanel.js';
import type { KanbanWorkItemDeliverySummary } from '../../../client/operationsClient.js';
import { messages as en } from '../i18n/en.js';

const HEALTHY: KanbanWorkItemDeliverySummary = {
  queue: { pending: 0, claimed: 0, delivered: 4, deadLettered: 0, oldestPendingCreatedAt: null, oldestPendingAgeS: null },
  outcomes: { started: 4, 'not-eligible': 1, deferred: 0, 'workflow-unresolved': 0, retried: 0, 'dead-lettered': 0 },
  window: { startsAt: '2026-11-09T12:00:00Z', endsAt: '2026-11-10T12:00:00Z' },
  perInstance: false, fetchedAt: '2026-11-10T12:00:00Z',
};

afterEach(cleanup);

describe('ADR 1081 — Kanban delivery panel', () => {
  it('HEALTHY: shows fleet scope, queue state, and every closed outcome without identities', () => {
    const { container } = render(<KanbanDeliveryPanel summary={HEALTHY} forbidden={false} failed={false} onRetry={() => undefined} />);
    const panel = within(container);
    expect(panel.getByText(en.kanbanDeliveryHealthy)).toBeTruthy();
    expect(panel.getByText(en.kanbanDeliveryFleetWide)).toBeTruthy();
    expect(panel.getByText(en.kanbanDeliveryQueueWaiting.replace('{{n}}', '0'))).toBeTruthy();
    expect(panel.getByText(en.kanbanDeliveryOutcomeStarted.replace('{{n}}', '4'))).toBeTruthy();
    expect(panel.getByText(en.kanbanDeliveryOutcomeDeadLettered.replace('{{n}}', '0'))).toBeTruthy();
    expect(panel.getByRole('list', { name: en.kanbanDeliveryOutcomesAria }).children).toHaveLength(6);
    expect(panel.queryByText(en.kanbanDeliveryUnavailableTitle)).toBeNull();
  });

  it('FAILED: an unread summary is unavailable, never rendered as healthy or empty', () => {
    const retry = vi.fn();
    render(<KanbanDeliveryPanel summary={null} forbidden={false} failed onRetry={retry} />);
    expect(screen.getByText(en.kanbanDeliveryUnavailableTitle)).toBeTruthy();
    expect(screen.queryByText(en.kanbanDeliveryHealthy)).toBeNull();
    expect(screen.queryByText(en.kanbanDeliveryAttention)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.refresh }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('STALE + ATTENTION: keeps the last truthful reading and labels both the stale read and dead-letter concern', () => {
    const attention: KanbanWorkItemDeliverySummary = {
      ...HEALTHY,
      queue: { ...HEALTHY.queue, pending: 2, deadLettered: 1, oldestPendingCreatedAt: '2026-11-10T11:59:00Z', oldestPendingAgeS: 60 },
      outcomes: { ...HEALTHY.outcomes, retried: 2, 'dead-lettered': 1 },
    };
    render(<KanbanDeliveryPanel summary={attention} forbidden={false} failed onRetry={() => undefined} />);
    expect(screen.getByText(en.kanbanDeliveryStale)).toBeTruthy();
    expect(screen.getByText(en.kanbanDeliveryAttention)).toBeTruthy();
    expect(screen.getByText(en.kanbanDeliveryQueueDead.replace('{{n}}', '1'))).toBeTruthy();
    expect(screen.queryByText(en.kanbanDeliveryHealthy)).toBeNull();
  });
});
