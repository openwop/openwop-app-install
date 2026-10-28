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
 * Sabotage: mapping a failed read to an empty list reds the failed case;
 * rendering `e.action` raw reds the unknown-action assertion; passing the
 * raw kind id or action ids into the detail line reds the kind/action case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ listCollabAudit: vi.fn() }));
vi.mock('../collabAuditClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

import { ClientCollabAuditSection, auditActionKey } from '../ClientCollabAuditSection.js';
import { CampaignOpsError } from '../campaignOpsClient.js';

const ev = (seq: number, action: string, extra: Record<string, unknown> = {}) => ({
  seq, at: `2026-10-27T10:${String(seq % 60).padStart(2, '0')}:00Z`, action, collaboratorId: 'ccb_1',
  collaborator: { displayName: 'Dana Studio', kind: 'vendor' }, ...extra,
});

beforeEach(() => { h.listCollabAudit.mockReset(); });
afterEach(cleanup);

describe('ClientCollabAuditSection', () => {
  it.each([
    ['collaborators off', new CampaignOpsError('External collaborators is not enabled for this tenant.', 404)],
    ['not this client’s manager', new CampaignOpsError('Forbidden.', 403)],
  ])('renders nothing when %s', async (_label, err) => {
    h.listCollabAudit.mockRejectedValueOnce(err);
    const { container } = render(<ClientCollabAuditSection orgId="o1" />);
    await waitFor(() => expect(h.listCollabAudit).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('a failed read is said with a retry, never shown as no activity', async () => {
    h.listCollabAudit.mockRejectedValueOnce(new CampaignOpsError('boom', 500));
    render(<ClientCollabAuditSection orgId="o1" />);
    expect((await screen.findAllByText(/Couldn’t load the activity/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('No collaborator activity for this client yet.')).toBeNull();
    h.listCollabAudit.mockResolvedValueOnce({ events: [], truncated: false });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No collaborator activity for this client yet.')).toBeTruthy();
  });

  it('shows events with today’s names, an erased person as removed, and unknown actions generically', async () => {
    h.listCollabAudit.mockResolvedValueOnce({
      truncated: false,
      events: [
        ev(4, 'some.future-action'),
        ev(3, 'grant.create', { resource: { kind: 'campaign', id: 'c1' }, actions: ['view', 'upload'] }),
        ev(2, 'intake.submit', { files: 2 }),
        ev(1, 'collaborator.invite', { collaboratorId: 'ccb_gone', collaborator: null }),
      ],
    });
    render(<ClientCollabAuditSection orgId="o1" />);
    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Dana Studioother activity'),
      expect.stringContaining('was given access'),
      expect.stringContaining('sent files'),
      expect.stringContaining('A removed collaboratorwas invited'),
    ]);
    expect(items[1]!.textContent).toContain('Campaign: view, send files');
    expect(document.body.textContent).not.toMatch(/campaign: view|creative-brief/);
    expect(items[2]!.textContent).toContain('2 file(s)');
    expect(document.body.textContent).not.toContain('some.future-action');
    expect(auditActionKey('intake.accept')).toBe('auditAction_intake_accept');
  });

  it('says grant kinds and actions in words; an unknown kind or action generically', async () => {
    h.listCollabAudit.mockResolvedValueOnce({
      truncated: false,
      events: [
        ev(3, 'grant.revoke', { resourceKind: 'creative-brief' }),
        ev(2, 'grant.create', { resource: { kind: 'future-kind', id: 'x' }, actions: ['view', 'future-action'] }),
      ],
    });
    render(<ClientCollabAuditSection orgId="o1" />);
    const items = await screen.findAllByRole('listitem');
    expect(items[0]!.textContent).toContain('lost accessBrief');
    expect(items[1]!.textContent).toContain('Item: view, other');
    expect(document.body.textContent).not.toMatch(/future-kind|future-action|creative-brief/);
  });

  it('shows the first 20, then all; a truncated read says where the rest is', async () => {
    h.listCollabAudit.mockResolvedValueOnce({ truncated: true, events: Array.from({ length: 25 }, (_, i) => ev(25 - i, 'grant.revoke')) });
    render(<ClientCollabAuditSection orgId="o1" />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(20));
    expect(screen.getByText(/full log is in the governance audit export/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 25' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
  });
});
