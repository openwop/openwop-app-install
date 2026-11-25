/**
 * ADR 1099 P1 — the project's Client access tab.
 *
 *   - a refusal of the read (403/404) says only admins can do this; a failed
 *     read is said with a retry, never as "no one has access";
 *   - only live grants on THIS project are listed (not another project's, not an
 *     expired or revoked one, not a removed person);
 *   - inviting opens a dialog (issue 5921: no inline create form), calls the
 *     invite route, then the grant route with this project's id, the chosen
 *     actions and expiry, and shows the link once;
 *   - a grant that fails AFTER the invite still shows the one-time link, and says
 *     access was not given;
 *   - giving access to someone already invited is a dialog too, and grants this
 *     project;
 *   - taking access back waits on a danger confirm; cancelling calls nothing.
 *
 * Every request is stubbed at the FETCH level, so each case asserts the exact
 * route, method and body.
 *
 * Sabotage (each red alone): list grants of any project → "only this project";
 * grant before checking the invite succeeded, or send another project's id →
 * "invites, then grants"; drop the link when the grant fails → "still shows the
 * link"; revoke without the confirm → "behind a confirm";
 * map a 500 to the empty list → "a failed read".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { config } from '../../../client/config.js';
import type { Project } from '../projectsClient.js';
import type { OrgCollaborator, ProjectGrant } from '../projectClientAccessClient.js';

const c = vi.hoisted(() => ({ confirm: vi.fn<(opts: { title: string; danger?: boolean }) => Promise<boolean>>(), copyToClipboard: vi.fn() }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: c.confirm }));
vi.mock('../../../ui/copyToClipboard.js', () => ({ copyToClipboard: c.copyToClipboard }));

import { ProjectClientAccessTab } from '../ProjectClientAccessTab.js';

const B = `${config.baseUrl}/host/openwop-app/orgs/o1/collaborators`;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
// Requests are answered in order from `queue`, except the grantable read (the
// audience labels), which every load makes and which answers from `grantable`.
let queue: Response[] = [];
let grantable: () => Response = () => json(200, { kinds: [{ kind: 'project', actions: ['view', 'comment'], items: [] }] });
const enqueue = (...r: Response[]): void => { queue.push(...r); };
const GRANTABLE = `${B}/grantable`;
const requests = (): Array<[string, string, unknown]> =>
  fetchMock.mock.calls.filter(([url]) => url !== GRANTABLE).map(([url, init]) => [url, init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : undefined]);

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';
const PROJECT = { id: 'p1', orgId: 'o1', name: 'Kitchen and bath', tenantId: 't', workflows: [], boardId: 'b', canWrite: true } as unknown as Project;
const grant = (id: string, extra: Partial<ProjectGrant> = {}): ProjectGrant => ({
  grantId: id, collaboratorId: 'x', resource: { kind: 'project', id: 'p1' }, actions: ['view', 'comment'], expiresAt: FUTURE, status: 'active', createdAt: '2026-11-01T00:00:00Z', ...extra,
});
const person = (id: string, grants: ProjectGrant[], extra: Partial<OrgCollaborator> = {}): OrgCollaborator => ({
  collaboratorId: id, kind: 'client-stakeholder', email: `${id}@outside.test`, displayName: `Person ${id}`,
  status: 'active', mode: 'signed-in', accepted: true, grants, ...extra,
});

beforeEach(() => {
  c.confirm.mockReset(); c.copyToClipboard.mockReset();
  fetchMock.mockReset();
  queue = [];
  grantable = () => json(200, { kinds: [{ kind: 'project', actions: ['view', 'comment'], items: [] }] });
  fetchMock.mockImplementation(async (url) => (url === GRANTABLE ? grantable() : (queue.shift() ?? json(500, { error: 'internal', message: 'unexpected request' }))));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = () => render(<ProjectClientAccessTab project={PROJECT} />);

describe('ProjectClientAccessTab — reading', () => {
  it.each([403, 404])('a %s says only admins can do this', async (status) => {
    enqueue(json(status, { error: 'not_found', message: 'Not found.' }));
    mount();
    expect(await screen.findByText(/Only workspace admins/)).toBeTruthy();
    expect(screen.queryByText(/No one outside the workspace/)).toBeNull();
  });

  it('a failed read is said with a retry, never as no one has access', async () => {
    enqueue(json(500, { error: 'internal', message: 'boom' }));
    mount();
    expect((await screen.findAllByText(/Couldn't load who has access/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No one outside the workspace/)).toBeNull();
    enqueue(json(200, { collaborators: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No one outside the workspace/)).toBeTruthy();
  });

  it('lists only live grants on this project', async () => {
    enqueue(json(200, { collaborators: [
      person('a', [grant('g1')]),
      person('b', [grant('g2', { resource: { kind: 'project', id: 'p-other' } })]),
      person('c', [grant('g3', { expiresAt: PAST })]),
      person('d', [grant('g4', { status: 'revoked' })]),
      person('e', [grant('g5')], { status: 'revoked' }),
      person('f', [grant('g6', { resource: { kind: 'campaign', id: 'p1' } })]),
    ] }));
    mount();
    const list = await screen.findByRole('list', { name: 'People outside the workspace with access' });
    expect(list.textContent).toContain('Person a');
    for (const other of ['Person b', 'Person c', 'Person d', 'Person e', 'Person f']) expect(list.textContent).not.toContain(other);
  });
});

describe('ProjectClientAccessTab — actions', () => {
  it('invites, then grants this project, and shows the link once', async () => {
    enqueue(json(200, { collaborators: [] }));
    mount();
    await screen.findByText(/No one outside the workspace/);
    fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    fireEvent.change(screen.getByLabelText(/^They are/), { target: { value: 'vendor' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Oak Builders' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'site@oak.test' } });
    fireEvent.change(screen.getByLabelText(/^Access/), { target: { value: 'view' } });
    fireEvent.change(screen.getByLabelText(/^For/), { target: { value: '90' } });
    enqueue(json(201, { collaborator: person('n', []), invite: { token: 'tok-1', expiresAt: FUTURE } }));
    enqueue(json(201, { grant: grant('g-new') }));
    enqueue(json(200, { collaborators: [person('n', [grant('g-new')])] }));
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByLabelText(/Invite link for Oak Builders/)).toBeTruthy();
    const [, invite, grantReq] = requests();
    expect(invite).toEqual([B, 'POST', { kind: 'vendor', displayName: 'Oak Builders', email: 'site@oak.test' }]);
    expect(grantReq).toEqual([`${B}/n/grants`, 'POST', { resource: { kind: 'project', id: 'p1' }, actions: ['view'], expiresInDays: 90 }]);
  });

  it('a refused invite shows the server message and grants nothing', async () => {
    enqueue(json(200, { collaborators: [] }));
    mount();
    await screen.findByText(/No one outside the workspace/);
    fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Casey' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'casey@outside.test' } });
    enqueue(json(409, { error: 'conflict', message: 'This person is already a collaborator for this client.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('This person is already a collaborator for this client.')).toBeTruthy();
    expect(requests().some(([url]) => url.endsWith('/grants'))).toBe(false);
    expect(screen.queryByLabelText(/Invite link for/)).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a grant that fails after the invite still shows the link, and says access was not given', async () => {
    enqueue(json(200, { collaborators: [] }));
    mount();
    await screen.findByText(/No one outside the workspace/);
    fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Robin' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'robin@outside.test' } });
    enqueue(json(201, { collaborator: person('r', []), invite: { token: 'tok-2', expiresAt: FUTURE } }));
    enqueue(json(500, { error: 'internal', message: 'boom' }));
    enqueue(json(200, { collaborators: [person('r', [])] }));
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    const link = await screen.findByLabelText(/Invite link for Robin/);
    expect((link as HTMLInputElement).value).toContain('/collab/accept/tok-2');
    expect(screen.getByText(/couldn't give them access to this project/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('giving someone already invited access is a dialog that grants this project', async () => {
    enqueue(json(200, { collaborators: [person('a', [grant('g1', { resource: { kind: 'project', id: 'p-other' } })])] }));
    mount();
    await screen.findByText(/No one outside the workspace/);
    fireEvent.click(screen.getByRole('button', { name: 'Give someone already invited access' }));
    fireEvent.change(screen.getByLabelText(/^Person/), { target: { value: 'a' } });
    enqueue(json(201, { grant: grant('g2') })); enqueue(json(200, { collaborators: [person('a', [grant('g2')])] }));
    fireEvent.click(screen.getByRole('button', { name: 'Give access' }));
    expect(await screen.findByText('Person a now has access.')).toBeTruthy();
    expect(requests()[1]).toEqual([`${B}/a/grants`, 'POST', { resource: { kind: 'project', id: 'p1' }, actions: ['view', 'comment'], expiresInDays: 30 }]);
  });

  it('taking access back is behind a danger confirm; cancelling calls nothing', async () => {
    enqueue(json(200, { collaborators: [person('a', [grant('g1')])] }));
    mount();
    await screen.findByText('Person a');
    c.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: "Take back Person a's access" }));
    await waitFor(() => expect(c.confirm).toHaveBeenCalledTimes(1));
    expect(c.confirm.mock.calls[0]?.[0].danger).toBe(true);
    expect(requests()).toHaveLength(1);
    c.confirm.mockResolvedValueOnce(true);
    enqueue(json(200, { grant: grant('g1', { status: 'revoked' }) })); enqueue(json(200, { collaborators: [] }));
    fireEvent.click(screen.getByRole('button', { name: "Take back Person a's access" }));
    expect(await screen.findByText('Person a no longer has access.')).toBeTruthy();
    expect(requests()[1]).toEqual([`${B}/a/grants/g1`, 'DELETE', undefined]);
  });
});

describe('ProjectClientAccessTab — audience (ADR 1099, decided 2026-11-23)', () => {
  it('offers the workspace\'s labels, defaults to the most limited view, and sends the chosen one', async () => {
    grantable = () => json(200, { kinds: [{ kind: 'project', actions: ['view', 'comment'], audiences: ['builder', 'client'], items: [] }] });
    enqueue(json(200, { collaborators: [] }));
    mount();
    await screen.findByText(/No one outside the workspace/);
    fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    const picker = screen.getByLabelText(/^Sees this project as/) as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'builder', 'client']);
    fireEvent.change(picker, { target: { value: 'builder' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Oak Builders' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'site@oak.test' } });
    enqueue(
      json(201, { collaborator: person('n', []), invite: { token: 'tok-3', expiresAt: FUTURE } }),
      json(201, { grant: grant('g-new', { audience: 'builder' }) }),
      json(200, { collaborators: [person('n', [grant('g-new', { audience: 'builder' })])] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('Sees as builder')).toBeTruthy();
    expect(requests()[2]).toEqual([`${B}/n/grants`, 'POST', { resource: { kind: 'project', id: 'p1' }, actions: ['view', 'comment'], expiresInDays: 30, audience: 'builder' }]);
  });

  it('no labels offered: no picker, and the grant carries no audience', async () => {
    enqueue(json(200, { collaborators: [] }));
    mount();
    await screen.findByText(/No one outside the workspace/);
    fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    expect(screen.queryByLabelText(/^Sees this project as/)).toBeNull();
  });

  it('a failed read of the labels says so, offers no picker, and never blocks the list', async () => {
    grantable = () => json(500, { error: 'internal', message: 'boom' });
    enqueue(json(200, { collaborators: [] }));
    mount();
    expect(await screen.findByText(/Couldn't load the viewing options/)).toBeTruthy();
    expect(screen.getByText(/No one outside the workspace/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    expect(screen.queryByLabelText(/^Sees this project as/)).toBeNull();
  });
});
