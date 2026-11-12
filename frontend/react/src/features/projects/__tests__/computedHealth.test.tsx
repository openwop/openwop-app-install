/**
 * ADR 1091 D3 — the Overview shows a provider's computed health (carried on the
 * single-project read) with its reason and source beside the charter's own
 * value, and says so when the two differ. Nothing new without a reading.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProjectOverviewTab } from '../ProjectOverviewTab.js';

const computed = (level: string, reason: string, source = 'Test records') => ({ level, reason, source, asOf: '2027-01-25', providerId: 'x' });
const project = (charter?: Record<string, unknown>, c?: unknown) => ({ id: 'p1', tenantId: 't', orgId: 'o', name: 'Atlas', workflows: [], boardId: 'b', canWrite: true, ...(charter ? { charter } : {}), ...(c ? { computedHealth: c } : {}) });
const show = (p: unknown) => render(<ProjectOverviewTab project={p as never} canWrite onSaved={() => undefined} />);
afterEach(cleanup);

describe('ADR 1091 — computed health on the Overview', () => {
  it('shows the reading, its source, and the manual value when they differ', () => {
    show(project({ goal: 'Ship', health: 'on-track' }, computed('at-risk', 'Two decisions are late.')));
    expect(screen.getByText(/Two decisions are late\. \(from Test records\)/)).toBeTruthy();
    expect(screen.getByText(/Set by hand:/)).toBeTruthy();
  });

  it('agreeing values show no "set by hand" line', () => {
    show(project({ goal: 'Ship', health: 'at-risk' }, computed('at-risk', 'Two decisions are late.')));
    expect(screen.queryByText(/Set by hand:/)).toBeNull();
  });

  it('shows the reading on a project with no charter yet', () => {
    show(project(undefined, computed('off-track', 'A permit expired.', 'Permits')));
    expect(screen.getByText(/A permit expired\./)).toBeTruthy();
  });

  it('shows nothing new without a reading', () => {
    show(project({ goal: 'Ship' }));
    expect(screen.queryByLabelText('Computed health')).toBeNull();
  });
});
