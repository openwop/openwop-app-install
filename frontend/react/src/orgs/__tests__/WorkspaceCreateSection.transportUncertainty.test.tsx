/**
 * One mounted real-caller sequence: positive create+enter, then a dispatched
 * transport rejection. The second half must not pass from failed admission.
 * Actual client/config/completion algorithms remain real; no state reset.
 * A fresh test-file module realm is a prerequisite, not proved here. All native,
 * import/type, RED/GREEN and sabotage checks are UNRUN. Cleanup only unmounts.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { t } from 'i18next';

const pending = vi.hoisted(() => ({ operations: [] as Promise<unknown>[] }));

vi.unmock('../../client/config.js');
vi.unmock('../../client/v2Wire.js');
vi.mock('../../client/entitlementRefresh.js', () => ({ noteRequestStatus: vi.fn() }));
vi.mock('../../client/sessionRefusal.js', () => ({ noteSessionRefusal: vi.fn() }));
vi.mock('../../auth/reloadIntoSession.js', () => ({ reloadIntoSession: vi.fn() }));
// Observe the real public promise solely to drain task-owned work in cleanup.
// Return that SAME promise; no delivery gate or client/completion algorithm copy.
vi.mock('../../client/workspaceClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/workspaceClient.js')>();
  return { ...actual, createAndEnterWorkspace: (name: string) => {
    const operation = actual.createAndEnterWorkspace(name);
    pending.operations.push(operation);
    return operation;
  } };
});

import { WorkspaceCreateSection } from '../WorkspaceCreateSection.js';
import { getWorkspaceTransitionSnapshot } from '../../client/workspaceClient.js';
import { fireAuthChanged } from '../../client/config.js';
import { reloadIntoSession } from '../../auth/reloadIntoSession.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
afterEach(async () => {
  cleanup();
  try { await Promise.allSettled(pending.operations); }
  finally { vi.unstubAllGlobals(); }
});

it('completes a real create first, then keeps dispatched transport uncertainty without another final effect or name clear', async () => {
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
  const expected = t('common:workspaceChangeCouldNotFinish');
  expect(expected).not.toBe('workspaceChangeCouldNotFinish');
  expect(expected).not.toBe('common:workspaceChangeCouldNotFinish');
  const privateMarker = 'PRIVATE_CREATE_DISPATCHED_TRANSPORT_DETAIL';
  let rejectNextCreate = false;
  let rejectionDispatched = false;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/workspaces') && init?.method === 'POST') {
      if (rejectNextCreate) {
        rejectionDispatched = true;
        throw new TypeError(privateMarker);
      }
      return json({ workspaceId: 'C', name: 'Positive workspace', slug: 'positive',
        roles: ['owner'], kind: 'shared', active: false }, 201);
    }
    if (url.endsWith('/workspaces/C/switch') && init?.method === 'POST') return json({ ok: true, active: 'C' });
    throw new Error(`unexpected_test_transport ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const writes = () => fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
  const onCreated = vi.fn();
  render(<WorkspaceCreateSection onCreated={onCreated} />);
  const field = screen.getByRole('textbox') as HTMLInputElement;
  const button = screen.getByRole('button', { name: t('orgs:createWorkspace') }) as HTMLButtonElement;

  fireEvent.change(field, { target: { value: 'Positive workspace' } });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(field.value).toBe(''));
  await waitFor(() => expect(field.disabled).toBe(false));
  expect(writes()).toHaveLength(2);
  expect(String(writes()[0]![0])).toMatch(/\/workspaces$/);
  expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({ name: 'Positive workspace' });
  expect(String(writes()[1]![0])).toMatch(/\/workspaces\/C\/switch$/);
  expect(reloadIntoSession).not.toHaveBeenCalled();
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });

  // Same mounted caller and real client. No reset or separate-case ordering.
  rejectNextCreate = true;
  fireEvent.change(field, { target: { value: 'Keep this draft' } });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(rejectionDispatched).toBe(true));
  await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
  expect(writes()).toHaveLength(3);
  expect(String(writes()[2]![0])).toMatch(/\/workspaces$/);
  expect(JSON.parse(String(writes()[2]![1]?.body))).toEqual({ name: 'Keep this draft' });
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'uncertain', pendingCount: 0 });
  expect(onCreated).toHaveBeenCalledTimes(1);
  expect(reloadIntoSession).not.toHaveBeenCalled();
  expect(field.value).toBe('Keep this draft');
  expect(document.body.textContent).not.toContain(privateMarker);
  expect(document.body.textContent).not.toContain('workspace_transition_uncertain');

  // Normal public auth invalidation is not an uncertainty reset or UID proof.
  await act(async () => { fireAuthChanged(); });
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'uncertain', pendingCount: 0 });
  expect(writes()).toHaveLength(3);
  expect(onCreated).toHaveBeenCalledTimes(1);
  expect(reloadIntoSession).not.toHaveBeenCalled();
  expect(field.value).toBe('Keep this draft');
});
