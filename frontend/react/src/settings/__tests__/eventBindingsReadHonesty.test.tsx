/**
 * UX_UPGRADE-governance P3 — a failed workflow read degrades this page in TWO
 * ways, and neither announced itself.
 *
 * `refresh()` did `listWorkflowSummaries().catch(() => [])`:
 *
 * 1. The picker rendered "No workflows yet — create one in Workflows first" —
 *    an instructive false claim telling the operator to create a workflow they
 *    may already have (the shape this programme keeps finding).
 * 2. Subtler: `workflowLabel` falls back to `?? id`. That fallback is DESIGNED
 *    for one edge case — the comment above it says "an uninstantiated or
 *    another-tenant-registered workflow, still runnable" — but on a failed read
 *    EVERY existing binding renders a raw workflow id instead of a name. A
 *    per-row fallback silently became a page-wide degradation that looks like
 *    data corruption rather than a transient failure.
 *
 * Both arms asserted: a failed read says so, and a tenant that genuinely has no
 * workflows still gets the real "create one first" guidance.
 *
 * Twin note: `eventBindings.readFailure.test.tsx` is the BINDINGS read failing on this
 * page; this file is the WORKFLOWS read. Sabotage that turns it red: swallow the
 * workflow failure without raising the flag; drop the warning Notice; show "No workflows
 * yet" (or always "unavailable") in the picker; never reset the flag on a clean read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { HostEventBinding } from '../../client/hostEventBindingsClient.js';
import type { WorkflowSummaryDTO } from '../../workflows/workflowsClient.js';

type HostClient = typeof import('../../client/hostEventBindingsClient.js');
type WfClient = typeof import('../../workflows/workflowsClient.js');
const host = vi.hoisted(() => ({
  listHostEventBindings: vi.fn<HostClient['listHostEventBindings']>(),
  getHostEventCatalog: vi.fn<HostClient['getHostEventCatalog']>(),
}));
vi.mock('../../client/hostEventBindingsClient.js', async (orig) => ({
  ...(await orig<HostClient>()),
  listHostEventBindings: host.listHostEventBindings,
  getHostEventCatalog: host.getHostEventCatalog,
}));

const wf = vi.hoisted(() => ({ listWorkflowSummaries: vi.fn<WfClient['listWorkflowSummaries']>() }));
vi.mock('../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<WfClient>()),
  listWorkflowSummaries: wf.listWorkflowSummaries,
}));

import { EventBindingsPage } from '../EventBindingsPage.js';

/** A binding to an existing workflow — what the failed workflow read degrades. */
const BINDING: HostEventBinding = {
  bindingId: 'hevb:1', tenantId: 't1', eventType: 'host.crm.contact.created', workflowId: 'wf_1', enabled: true,
  createdBy: 'user-1', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
};
const NIGHTLY: WorkflowSummaryDTO = {
  workflowId: 'wf_1', kind: 'workflow', name: 'Nightly sync', nodeCount: 3,
  createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
};

function view(): void {
  render(<MemoryRouter><EventBindingsPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.resetAllMocks();
  host.listHostEventBindings.mockResolvedValue([]);
  host.getHostEventCatalog.mockResolvedValue([]);
  wf.listWorkflowSummaries.mockResolvedValue([]);
});
afterEach(cleanup);

describe('UX-GOV-3 — a failed workflow read never claims the tenant has none', () => {
  it('FAILURE: discloses the read failed and warns about raw IDs', async () => {
    host.listHostEventBindings.mockResolvedValue([BINDING]);
    wf.listWorkflowSummaries.mockRejectedValue(new Error('wf_500'));
    view();
    expect(await screen.findByText(/workflow list could not be loaded/i)).toBeTruthy();
    // The degradation the warning names: the existing binding shows its RAW id.
    expect(within(screen.getByRole('table')).getByText('wf_1')).toBeTruthy();
    // The picker says the list is unavailable — the instructive false claim is gone.
    expect(screen.getByText('Workflow list unavailable — retry')).toBeTruthy();
    expect(screen.queryByText(/No workflows yet/i)).toBeNull();
  });

  it('EMPTY: a tenant that genuinely has none still gets "create one first"', async () => {
    // The other arm — without it, "always unavailable" would pass the test above
    // while destroying real onboarding guidance.
    wf.listWorkflowSummaries.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No workflows yet/i)).toBeTruthy();
    expect(screen.queryByText(/workflow list could not be loaded/i)).toBeNull();
  });

  it('HEALTHY: a populated list raises no warning and names the bound workflow', async () => {
    host.listHostEventBindings.mockResolvedValue([BINDING]);
    wf.listWorkflowSummaries.mockResolvedValue([NIGHTLY]);
    view();
    expect(await within(await screen.findByRole('table')).findByText('Nightly sync')).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('wf_1')).toBeNull();
    expect(screen.queryByText(/workflow list could not be loaded/i)).toBeNull();
    expect(screen.queryByText(/No workflows yet/i)).toBeNull();
  });
});
