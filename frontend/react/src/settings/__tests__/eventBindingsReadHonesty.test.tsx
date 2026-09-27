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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const host = vi.hoisted(() => ({ listHostEventBindings: vi.fn() }));
vi.mock('../../client/hostEventBindingsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listHostEventBindings: host.listHostEventBindings };
});

const wf = vi.hoisted(() => ({ listWorkflowSummaries: vi.fn() }));
vi.mock('../../workflows/workflowsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listWorkflowSummaries: wf.listWorkflowSummaries };
});

import { EventBindingsPage } from '../EventBindingsPage.js';

function view(): void {
  render(<MemoryRouter><EventBindingsPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  host.listHostEventBindings.mockResolvedValue([]);
  wf.listWorkflowSummaries.mockResolvedValue([]);
});
afterEach(cleanup);

describe('UX-GOV-3 — a failed workflow read never claims the tenant has none', () => {
  it('FAILURE: discloses the read failed and warns about raw IDs', async () => {
    wf.listWorkflowSummaries.mockRejectedValue(new Error('wf_500'));
    view();
    expect(await screen.findByText(/workflow list could not be loaded/i)).toBeTruthy();
    // The instructive false claim must be gone.
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

  it('HEALTHY: a populated list raises no warning', async () => {
    wf.listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf_1', name: 'Nightly sync' }]);
    view();
    await screen.findByText(/Nightly sync/i);
    expect(screen.queryByText(/workflow list could not be loaded/i)).toBeNull();
    expect(screen.queryByText(/No workflows yet/i)).toBeNull();
  });
});
