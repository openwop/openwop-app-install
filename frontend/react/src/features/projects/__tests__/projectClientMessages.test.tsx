/**
 * ADR 1099 D7 (P3c) — the firm's side of a project's client threads.
 *
 *   - one thread per outside collaborator, each under their name, with the
 *     firm's replies shown as "Your team";
 *   - a reply posts to THAT collaborator's thread and the list refreshes;
 *   - a 404 (the switch off, or no access) renders nothing; a failed read says so
 *     with a retry, never as "no messages";
 *   - read-only access shows the threads with no reply box.
 *
 * Sabotage: posting to the first thread's collaborator for every reply reds
 * "replies to that collaborator"; mapping a 500 to the empty list reds "a failed read".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { config } from '../../../client/config.js';
import type { Project } from '../projectsClient.js';
import type { ClientThread } from '../projectClientAccessClient.js';
import { ProjectClientMessages } from '../ProjectClientMessages.js';

const URL_ = `${config.baseUrl}/host/openwop-app/projects/p1/client-threads`;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let queue: Response[] = [];
const PROJECT = { id: 'p1', orgId: 'o1', name: 'Kitchen and bath', tenantId: 't', workflows: [], boardId: 'b' } as unknown as Project;
const THREADS: ClientThread[] = [
  { collaboratorId: 'ccb_g', label: 'The Garcias', entries: [
    { entryId: 'e1', author: { kind: 'collaborator', label: 'The Garcias' }, text: 'Can we move the walkthrough?', createdAt: '2026-11-25T10:00:00Z' },
    { entryId: 'e2', author: { kind: 'member', userId: 'user:u1' }, text: 'Friday works.', createdAt: '2026-11-25T11:00:00Z' },
  ] },
  { collaboratorId: 'ccb_b', label: 'Oak Builders', entries: [
    { entryId: 'e3', author: { kind: 'collaborator', label: 'Oak Builders' }, text: 'Cabinets arrive Monday.', createdAt: '2026-11-25T09:00:00Z' },
  ] },
];

beforeEach(() => {
  fetchMock.mockReset();
  queue = [];
  fetchMock.mockImplementation(async () => queue.shift() ?? json(500, { error: 'internal', message: 'unexpected request' }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ProjectClientMessages', () => {
  it('shows one thread per collaborator, the firm as "Your team"', async () => {
    queue.push(json(200, { threads: THREADS }));
    render(<ProjectClientMessages project={PROJECT} canWrite />);
    expect(await screen.findByText('Can we move the walkthrough?')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'The Garcias' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Oak Builders' })).toBeTruthy();
    expect(screen.getByText(/Your team/)).toBeTruthy();
    expect(screen.getByText('Cabinets arrive Monday.')).toBeTruthy();
  });

  it('a reply posts to that collaborator\'s thread and refreshes', async () => {
    queue.push(json(200, { threads: THREADS }));
    render(<ProjectClientMessages project={PROJECT} canWrite />);
    const box = await screen.findByLabelText('Reply to Oak Builders');
    fireEvent.change(box, { target: { value: 'Thanks, noted.' } });
    queue.push(json(201, { entry: {} }), json(200, { threads: THREADS }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Send reply' })[1]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`${URL_}/ccb_b`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Thanks, noted.' });
  });

  it('a 404 renders nothing; a failed read says so with a retry', async () => {
    queue.push(json(404, { error: 'not_found', message: 'Not found.' }));
    const { container } = render(<ProjectClientMessages project={PROJECT} canWrite />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('[data-testid="project-client-messages"]')).toBeNull());
    cleanup();
    queue.push(json(500, { error: 'internal', message: 'x' }));
    render(<ProjectClientMessages project={PROJECT} canWrite />);
    expect(await screen.findByText('Messages could not be loaded.')).toBeTruthy();
    expect(screen.queryByText(/No messages yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('read-only access shows the threads with no reply box', async () => {
    queue.push(json(200, { threads: THREADS }));
    render(<ProjectClientMessages project={PROJECT} canWrite={false} />);
    expect(await screen.findByText('Can we move the walkthrough?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send reply' })).toBeNull();
  });
});
