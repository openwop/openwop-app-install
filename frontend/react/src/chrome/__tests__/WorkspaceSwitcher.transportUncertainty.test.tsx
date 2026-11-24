/**
 * One mounted real-caller sequence: positive switch, then an actually dispatched
 * create rejection. The final reload seam stays in-page to observe both halves.
 * Actual config/client/completion algorithms are real. Brand is presentation only.
 * No production uncertainty reset or separate-case ordering. Fresh-file module
 * isolation, native setup/types, RED/GREEN and sabotage remain UNRUN.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { t } from 'i18next';

const pending = vi.hoisted(() => ({ operations: [] as Promise<unknown>[] }));

vi.unmock('../../client/config.js');
vi.unmock('../../client/v2Wire.js');
vi.mock('../../client/entitlementRefresh.js', () => ({ noteRequestStatus: vi.fn() }));
vi.mock('../../client/sessionRefusal.js', () => ({ noteSessionRefusal: vi.fn() }));
vi.mock('../../auth/reloadIntoSession.js', () => ({ reloadIntoSession: vi.fn() }));
vi.mock('../../brand/BrandProvider.js', () => ({
  useBrand: () => ({ productName: 'Test', instanceName: 'Test workspace', markSrc: '/test.svg', markSrcDark: '' }),
}));

// Transparent observation of actual promises for owned teardown, not a client
// algorithm or completion mock. The caller receives the same real promise.
vi.mock('../../client/workspaceClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/workspaceClient.js')>();
  return {
    ...actual,
    switchWorkspace: (id: string) => {
      const operation = actual.switchWorkspace(id); pending.operations.push(operation); return operation;
    },
    createAndEnterWorkspace: (name: string) => {
      const operation = actual.createAndEnterWorkspace(name); pending.operations.push(operation); return operation;
    },
  };
});

import { WorkspaceSwitcher } from '../WorkspaceSwitcher.js';
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

it('completes a real switch first, then keeps dispatched create uncertainty with no extra reload or name loss', async () => {
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
  const expected = t('common:workspaceChangeCouldNotFinish');
  expect(expected).not.toBe('workspaceChangeCouldNotFinish');
  expect(expected).not.toBe('common:workspaceChangeCouldNotFinish');
  const privateMarker = 'PRIVATE_SWITCHER_DISPATCHED_TRANSPORT_DETAIL';
  let active = 'A';
  let rejectionDispatched = false;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/workspaces')) return json({
      active, personal: 'personal', workspaces: ['A', 'B'].map((id) => ({
        workspaceId: id, name: `Workspace ${id}`, slug: id.toLowerCase(),
        roles: ['owner'], kind: 'shared', active: id === active,
      })),
    });
    if (url.endsWith('/workspaces/B/switch') && init?.method === 'POST') {
      active = 'B'; return json({ ok: true, active: 'B' });
    }
    if (url.endsWith('/workspaces') && init?.method === 'POST') {
      rejectionDispatched = true;
      throw new TypeError(privateMarker);
    }
    throw new Error(`unexpected_test_transport ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const writes = () => fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
  render(<MemoryRouter><WorkspaceSwitcher /></MemoryRouter>);
  const select = await screen.findByRole('combobox') as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('A'));
  expect(select.querySelector('option[value="B"]')).not.toBeNull();

  fireEvent.change(select, { target: { value: 'B' } });
  await waitFor(() => expect(reloadIntoSession).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(select.value).toBe('B'));
  await waitFor(() => expect(select.disabled).toBe(false));
  expect(writes()).toHaveLength(1);
  expect(String(writes()[0]![0])).toMatch(/\/workspaces\/B\/switch$/);
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });

  // Same mounted caller; controlled final reload did not replace its realm.
  fireEvent.change(select, { target: { value: '__new__' } });
  const field = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'Keep this workspace draft' } });
  expect(field.disabled).toBe(false);
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(rejectionDispatched).toBe(true));
  await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
  expect(writes()).toHaveLength(2);
  expect(String(writes()[1]![0])).toMatch(/\/workspaces$/);
  expect(JSON.parse(String(writes()[1]![1]?.body))).toEqual({ name: 'Keep this workspace draft' });
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'uncertain', pendingCount: 0 });
  expect(reloadIntoSession).toHaveBeenCalledTimes(1);
  expect(field.value).toBe('Keep this workspace draft');
  expect(document.body.textContent).not.toContain(privateMarker);
  expect(document.body.textContent).not.toContain('workspace_transition_uncertain');

  await act(async () => { fireAuthChanged(); });
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'uncertain', pendingCount: 0 });
  expect(writes()).toHaveLength(2);
  expect(reloadIntoSession).toHaveBeenCalledTimes(1);
  expect(field.value).toBe('Keep this workspace draft');
});
