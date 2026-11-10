/**
 * ADR 0958 P5 — the collaboration audit review, the agency side.
 *
 *   - collaborators off (404 "not enabled") or not this client's manager (403)
 *     → renders nothing;
 *   - a failed read is said with a retry, never shown as "no activity";
 *   - events read newest first as the server sends them, with today's name, and
 *     an erased person as "A removed collaborator"; an action this build does
 *     not know is said generically, never as a raw key;
 *   - the first 20 show, then "Show all"; a truncated read says where the rest is.
 *
 * Stubbed at the FETCH level, so the read's URL (keyed by the client's orgId) is
 * asserted and each refusal is the server's body through the real `asJson`.
 *
 * Sabotage (witnessed, wave 78): mapping a failed read to an empty list reds the
 * failed case; dropping the 403 or the 404 "not enabled" branch of `hidden()`
 * reds that it.each row; rendering `e.action` raw reds the unknown-action
 * assertion; showing the erased person as "Unknown" reds case 3; reordering the
 * events reds cases 3–4; passing the raw kind id or action ids into the detail
 * line reds case 4; a different first-page size or no truncation note reds case 5.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { config } from '../../../client/config.js';
import type { CollabAuditEvent } from '../collabAuditClient.js';
import { ClientCollabAuditSection } from '../ClientCollabAuditSection.js';

const AUDIT_URL = `${config.baseUrl}/host/openwop-app/campaign-ops/clients/o1/collaborators/audit`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const serve = (events: CollabAuditEvent[], truncated = false): void => { fetchMock.mockResolvedValueOnce(json(200, { events, truncated })); };

const ev = (seq: number, action: string, extra: Partial<CollabAuditEvent> = {}): CollabAuditEvent => ({
  seq, at: `2026-10-27T10:${String(seq % 60).padStart(2, '0')}:00Z`, action, collaboratorId: 'ccb_1',
  collaborator: { displayName: 'Dana Studio', kind: 'vendor' }, ...extra,
});

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ClientCollabAuditSection', () => {
  it.each([
    ['collaborators off', 404, { error: 'not_found', message: 'External collaborators is not enabled for this tenant.' }],
    ['not this client’s manager', 403, { error: 'forbidden', message: 'Forbidden.' }],
  ] as const)('renders nothing when %s', async (_label, status, body) => {
    fetchMock.mockResolvedValueOnce(json(status, body));
    const { container } = render(<ClientCollabAuditSection orgId="o1" />);
    // The loading state renders the heading, so this wait cannot pass before the read settles.
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([AUDIT_URL]);
  });

  it('a failed read is said with a retry, never shown as no activity', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: 'internal', message: 'boom' }));
    render(<ClientCollabAuditSection orgId="o1" />);
    expect((await screen.findAllByText(/Couldn’t load the activity/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('No collaborator activity for this client yet.')).toBeNull();
    serve([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No collaborator activity for this client yet.')).toBeTruthy();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([AUDIT_URL, AUDIT_URL]);
  });

  it('shows events with today’s names, an erased person as removed, and unknown actions generically', async () => {
    serve([
      ev(5, 'some.future-action'),
      ev(4, 'grant.create', { resource: { kind: 'campaign', id: 'c1' }, actions: ['view', 'upload'] }),
      ev(3, 'intake.submit', { files: 2 }),
      ev(2, 'intake.accept'),
      ev(1, 'collaborator.invite', { collaboratorId: 'ccb_gone', collaborator: null }),
    ]);
    render(<ClientCollabAuditSection orgId="o1" />);
    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Dana Studioother activity'),
      expect.stringContaining('was given access'),
      expect.stringContaining('sent files'),
      expect.stringContaining('Dana Studiohad files accepted'),
      expect.stringContaining('A removed collaboratorwas invited'),
    ]);
    expect(items[1]!.textContent).toContain('Campaign: view, send files');
    expect(document.body.textContent).not.toMatch(/campaign: view|creative-brief/);
    expect(items[2]!.textContent).toContain('2 file(s)');
    expect(document.body.textContent).not.toContain('some.future-action');
  });

  it('says grant kinds and actions in words; an unknown kind or action generically', async () => {
    serve([
      ev(3, 'grant.revoke', { resourceKind: 'creative-brief' }),
      ev(2, 'grant.create', { resource: { kind: 'future-kind', id: 'x' }, actions: ['view', 'future-action'] }),
    ]);
    render(<ClientCollabAuditSection orgId="o1" />);
    const items = await screen.findAllByRole('listitem');
    expect(items[0]!.textContent).toContain('lost accessBrief');
    expect(items[1]!.textContent).toContain('Item: view, other');
    expect(document.body.textContent).not.toMatch(/future-kind|future-action|creative-brief/);
  });

  it('shows the first 20, then all; a truncated read says where the rest is', async () => {
    serve(Array.from({ length: 25 }, (_, i) => ev(25 - i, 'grant.revoke')), true);
    render(<ClientCollabAuditSection orgId="o1" />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(20));
    expect(screen.getByText(/full log is in the governance audit export/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 25' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
  });
});
