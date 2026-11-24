/**
 * Missing raw201 positive: mounted real WorkspaceCreateSection, real tenancy
 * client and real config. The create ACK is the exact five-field route shape,
 * with no active/tenant field. This file must run in the runner's fresh actual
 * module realm; it never clears production uncertainty or mocks client owners.
 * A post-completion GET proof is checked before the final action assertions;
 * it is not an invented pre-callback read barrier. Native/setup all UNRUN.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from 'i18next';

vi.unmock('../../client/workspaceClient.js');
vi.unmock('../../client/config.js');
vi.unmock('../../client/v2Wire.js');
// Preserve the existing real-client fixture's unused requestJson import seams.
// ApiError and every workspace client/config/completion operation remain real.
vi.mock('../../client/entitlementRefresh.js', () => ({ noteRequestStatus: vi.fn() }));
vi.mock('../../client/sessionRefusal.js', () => ({ noteSessionRefusal: vi.fn() }));
vi.mock('../../auth/reloadIntoSession.js', () => ({ reloadIntoSession: vi.fn() }));

import { WorkspaceCreateSection } from '../WorkspaceCreateSection.js';
import {
  getWorkspaceTransitionSnapshot, isCurrentWorkspaceRead, revalidateWorkspace,
  type WorkspaceTransitionSnapshot,
} from '../../client/workspaceClient.js';
import { onAuthChange } from '../../client/config.js';
import { reloadIntoSession } from '../../auth/reloadIntoSession.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

let disposers: Array<() => void> = [];
beforeEach(() => {
  disposers = [];
  vi.mocked(reloadIntoSession).mockReset();
});
afterEach(async () => {
  cleanup();
  try {
    // No response is held in this fixture. Drain the public current claim before
    // restoring transport, including when an assertion exposed a product error.
    await waitFor(() => expect(getWorkspaceTransitionSnapshot().pendingCount).toBe(0));
  } finally {
    for (const off of disposers) off();
    disposers = [];
    vi.unstubAllGlobals();
  }
});

async function mountedRawCreate(finalAction: 'callback' | 'reload') {
  const workspaceId = finalAction === 'callback' ? 'raw-created-callback' : 'raw-created-reload';
  const name = finalAction === 'callback' ? 'Raw callback workspace' : 'Raw reload workspace';
  const slug = finalAction === 'callback' ? 'raw-callback' : 'raw-reload';
  // backend/typescript/src/routes/workspaces.ts:141. Do not cast this ACK to
  // WorkspaceSummary or manufacture active from the requested/returned target.
  const rawCreateAck = { workspaceId, name, slug, roles: ['owner'], kind: 'shared' };
  expect(Object.keys(rawCreateAck).sort()).toEqual(['kind', 'name', 'roles', 'slug', 'workspaceId']);
  expect(Reflect.has(rawCreateAck, 'active')).toBe(false);
  expect(Reflect.has(rawCreateAck, 'tenant')).toBe(false);
  expect(Reflect.has(rawCreateAck, 'tenantId')).toBe(false);

  const trace: string[] = [];
  const actionStates: WorkspaceTransitionSnapshot[] = [];
  const onCreated = vi.fn(() => {
    trace.push('callback');
    actionStates.push(getWorkspaceTransitionSnapshot());
  });
  vi.mocked(reloadIntoSession).mockImplementation(() => {
    trace.push('reload');
    actionStates.push(getWorkspaceTransitionSnapshot());
  });
  disposers.push(onAuthChange(() => { trace.push('auth'); }));

  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/workspaces') && init?.method === 'POST') {
      trace.push('create');
      return json(rawCreateAck, 201);
    }
    if (url.endsWith(`/workspaces/${workspaceId}/switch`) && init?.method === 'POST') {
      trace.push('enter');
      return json({ ok: true, active: workspaceId });
    }
    if (url.endsWith('/me/workspaces') && (init?.method === undefined || init.method === 'GET')) {
      trace.push('read');
      return json({
        active: workspaceId, personal: 'raw201-personal-fixture',
        // The real GET lists personal first, separately from the shared row.
        workspaces: [
          { workspaceId: 'raw201-personal-fixture', name: 'Personal workspace',
            slug: 'personal', roles: ['owner'], kind: 'personal', active: false },
          { ...rawCreateAck, active: true },
        ],
      });
    }
    throw new Error(`unexpected_raw201_test_transport ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const label = t('orgs:createWorkspace');
  expect(label).not.toBe('createWorkspace');
  expect(label).not.toBe('orgs:createWorkspace');
  render(finalAction === 'callback'
    ? <WorkspaceCreateSection onCreated={onCreated} />
    : <WorkspaceCreateSection />);
  const field = screen.getByRole('textbox') as HTMLInputElement;
  const button = screen.getByRole('button', { name: label }) as HTMLButtonElement;
  fireEvent.change(field, { target: { value: `  ${name}  ` } });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(field.value).toBe(''));
  await waitFor(() => expect(field.disabled).toBe(false));

  // Real create→enter, not a synthetic component/client success. An ACK-only
  // path is unverified; the actual completion's ordinary auth event ran.
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const create = fetchMock.mock.calls[0]!;
  const enter = fetchMock.mock.calls[1]!;
  expect(String(create[0])).toMatch(/\/workspaces$/);
  expect(create[1]?.method).toBe('POST');
  expect(JSON.parse(String(create[1]?.body))).toEqual({ name });
  expect(String(enter[0])).toMatch(new RegExp(`/workspaces/${workspaceId}/switch$`));
  expect(enter[1]?.method).toBe('POST');
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });

  // A separate actual public read supplies proof. The action may already have
  // been invoked synchronously; no async lease or backend/UID proof is implied.
  let proof: Awaited<ReturnType<typeof revalidateWorkspace>> | undefined;
  await act(async () => { proof = await revalidateWorkspace(); });
  if (!proof) throw new Error('raw201_read_did_not_return_proof');
  expect(isCurrentWorkspaceRead(proof), 'real post-create GET positive before final-effect oracles').toBe(true);
  expect(proof.result.active).toBe(workspaceId);
  expect(proof.result.workspaces).toHaveLength(2);
  expect(proof.result.workspaces[0]).toMatchObject({
    workspaceId: 'raw201-personal-fixture', kind: 'personal', active: false,
  });
  expect(proof.result.workspaces[1]).toMatchObject({ workspaceId, kind: 'shared', active: true });
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'ready', pendingCount: 0 });

  expect(actionStates).toHaveLength(1);
  expect(actionStates[0]).toMatchObject({ phase: 'unverified', pendingCount: 0 });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(String(fetchMock.mock.calls[2]![0])).toMatch(/\/me\/workspaces$/);
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(2);
  expect(field.value).toBe('');
  expect(field.disabled).toBe(false);
  expect(button.disabled).toBe(true);
  return { onCreated, trace };
}

describe('WorkspaceCreateSection actual raw create201 acknowledgement', () => {
  it('enters the returned workspace and invokes the mounted callback once without an active field in create ACK', async () => {
    const result = await mountedRawCreate('callback');
    expect(result.onCreated).toHaveBeenCalledTimes(1);
    expect(reloadIntoSession).not.toHaveBeenCalled();
    expect(result.trace).toEqual(['create', 'enter', 'auth', 'callback', 'read']);
  });

  it('enters the returned workspace and invokes the default reload boundary once without an active field in create ACK', async () => {
    const result = await mountedRawCreate('reload');
    expect(reloadIntoSession).toHaveBeenCalledTimes(1);
    expect(result.onCreated).not.toHaveBeenCalled();
    expect(result.trace).toEqual(['create', 'enter', 'auth', 'reload', 'read']);
  });
});
