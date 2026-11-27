/**
 * ADR 1099 P4 — the client portal page.
 *   - D9: a grant with `chat` renders the SHARED ConversationView in outsider mode
 *     (no `/` or `@` pickers, no attachments), loads the host-kept history, sends a
 *     turn and shows the reply; a turn refused for the day says so and the
 *     unanswered line goes; a grant without `chat` has no chat.
 *   - D10: only sections the server lists AND a feature registered are mounted, in
 *     the server's order; a least view is rendered by the host without mounting the
 *     component; one failing section does not hide the others; an answered turn
 *     re-reads the sections.
 *
 * The live-fetch guard (ADR 0661) is part of the witness: in outsider mode the
 * composer must not fetch the viewer's own workflow list (it did, until P4 gated
 * `refreshWorkflowMentionCache` on `plainText`).
 *
 * Sabotage-witnessed (2026-11-26, one at a time, each red): `outsider={false}` on
 * PortalChat (3 red: the live fetch and the sigils); mounting the component on
 * `available:false` ("least view"); rendering every registered section without
 * the server list ("only listed"); dropping `onAnswered()` ("re-reads").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as C from '../collabClient.js';
import type { FeaturePortalSection, PortalSectionProps } from '../../registry.js';

const h = vi.hoisted(() => ({
  getGrant: vi.fn<typeof C.getGrant>(),
  listPortalTurns: vi.fn<typeof C.listPortalTurns>(),
  sendPortalTurn: vi.fn<typeof C.sendPortalTurn>(),
  clearPortalTurns: vi.fn<typeof C.clearPortalTurns>(),
  listPortalSections: vi.fn<typeof C.listPortalSections>(),
  readPortalSection: vi.fn<typeof C.readPortalSection>(),
}));
vi.mock('../collabClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

function Due({ data }: PortalSectionProps): JSX.Element {
  const rows = Array.isArray(data.due) ? (data.due as Array<{ decision: string }>) : [];
  return <ul>{rows.map((r) => <li key={r.decision}>{r.decision}</li>)}</ul>;
}
function Dates(): JSX.Element { return <p>Rough-in: Dec 4</p>; }
const SECTIONS: FeaturePortalSection[] = [
  { kind: 'project', id: 'acme.due', titleKey: 'homeTitle', i18nNamespace: 'collab', component: Due },
  { kind: 'project', id: 'acme.dates', titleKey: 'intakeHistory', i18nNamespace: 'collab', component: Dates },
  { kind: 'project', id: 'acme.unlisted', titleKey: 'retry', i18nNamespace: 'collab', component: () => <p>MUST NOT MOUNT</p> },
];
vi.mock('../../featureExtensions.js', () => ({ featurePortalSections: () => SECTIONS }));

import { CollabGrantPage } from '../CollabPages.js';
import { CollabError } from '../collabClient.js';

const grant = (chat: boolean): Awaited<ReturnType<typeof C.getGrant>> => ({
  grant: { grantId: 'cgr_p', resourceKind: 'project', actions: ['view', 'comment'], expiresAt: '2026-12-19T12:00:00Z' },
  title: 'Kitchen and bath', resource: { kind: 'project', status: 'active' }, chat,
});

function at(): void {
  render(<MemoryRouter initialEntries={['/collab/cgr_p']}><Routes><Route path="/collab/:grantId" element={<CollabGrantPage />} /></Routes></MemoryRouter>);
}

beforeEach(() => {
  // jsdom has no scrollIntoView; the feed's stick-to-bottom effect calls it.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  for (const f of Object.values(h)) f.mockReset();
  h.listPortalTurns.mockResolvedValue([]);
  h.listPortalSections.mockResolvedValue([{ id: 'acme.dates', order: 10 }, { id: 'acme.due', order: 20 }, { id: 'other.no-component', order: 30 }]);
  h.readPortalSection.mockImplementation(async (_g, id) => (id === 'acme.due' ? { available: true, due: [{ decision: 'Shower tile' }] } : { available: true }));
});
afterEach(cleanup);

describe('the portal chat (D9)', () => {
  it('renders the shared conversation in outsider mode, with the host-kept history', async () => {
    h.getGrant.mockResolvedValue(grant(true));
    h.listPortalTurns.mockResolvedValue([{ role: 'collaborator', text: 'What is due?', at: '1' }, { role: 'agent', text: 'The shower tile.', at: '2' }]);
    at();
    const chat = await screen.findByRole('region', { name: 'Ask about your project' });
    expect(await within(chat).findByText('The shower tile.')).toBeTruthy();
    expect(within(chat).getByRole('combobox')).toBeTruthy();
    // Outsider mode: nothing that reaches the viewer's own workspace.
    expect(within(chat).queryByRole('button', { name: /agent/i })).toBeNull();
    expect(within(chat).queryByRole('button', { name: /attach/i })).toBeNull();
    expect(screen.getByRole('link', { name: 'Skip to the conversation' }).getAttribute('href')).toBe('#portal-chat');
  });

  it('sends a turn, shows the reply, and re-reads the sections', async () => {
    h.getGrant.mockResolvedValue(grant(true));
    h.sendPortalTurn.mockResolvedValue('Pick the tile by Friday.');
    at();
    const chat = await screen.findByRole('region', { name: 'Ask about your project' });
    await waitFor(() => expect(h.readPortalSection).toHaveBeenCalledTimes(2));
    fireEvent.change(within(chat).getByRole('combobox'), { target: { value: 'What next?' } });
    fireEvent.keyDown(within(chat).getByRole('combobox'), { key: 'Enter' });
    expect(await within(chat).findByText('Pick the tile by Friday.')).toBeTruthy();
    expect(h.sendPortalTurn).toHaveBeenCalledWith('cgr_p', 'What next?');
    await waitFor(() => expect(h.readPortalSection).toHaveBeenCalledTimes(4));
  });

  it('a turn refused for the day says so, and the unanswered line goes', async () => {
    h.getGrant.mockResolvedValue(grant(true));
    h.sendPortalTurn.mockRejectedValue(new CollabError('limit', 429));
    at();
    const chat = await screen.findByRole('region', { name: 'Ask about your project' });
    fireEvent.change(within(chat).getByRole('combobox'), { target: { value: 'Hello?' } });
    fireEvent.keyDown(within(chat).getByRole('combobox'), { key: 'Enter' });
    expect(await within(chat).findByText('The assistant has reached its limit for today. Try again tomorrow.')).toBeTruthy();
    expect(within(chat).queryByText('Hello?')).toBeNull();
  });

  it('a grant without chat has no chat and no skip link', async () => {
    h.getGrant.mockResolvedValue(grant(false));
    at();
    expect(await screen.findByText('Kitchen and bath')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Ask about your project' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Skip to the conversation' })).toBeNull();
    expect(h.listPortalTurns).not.toHaveBeenCalled();
  });
});

describe('portal sections (D10)', () => {
  it('only listed sections with a registered component, in the server\'s order', async () => {
    h.getGrant.mockResolvedValue(grant(false));
    at();
    expect(await screen.findByText('Shower tile')).toBeTruthy();
    expect(screen.getByText('Rough-in: Dec 4')).toBeTruthy();
    expect(screen.queryByText('MUST NOT MOUNT')).toBeNull();
    const order = [...document.querySelectorAll('[data-portal-section]')].map((e) => e.getAttribute('data-portal-section'));
    expect(order).toEqual(['acme.dates', 'acme.due']);
    expect(h.readPortalSection.mock.calls.map((c) => c[1]).sort()).toEqual(['acme.dates', 'acme.due']);
  });

  it('a least view is rendered by the host, without mounting the component', async () => {
    h.getGrant.mockResolvedValue(grant(false));
    h.readPortalSection.mockImplementation(async (_g, id) => (id === 'acme.due' ? { available: false, message: 'Nothing is due from you.' } : { available: true }));
    at();
    expect(await screen.findByText('Nothing is due from you.')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('one failing section does not hide the others; its own refusal sentence is shown', async () => {
    h.getGrant.mockResolvedValue(grant(false));
    h.readPortalSection.mockImplementation(async (_g, id) => {
      if (id === 'acme.due') throw new CollabError('This project is archived.', 409);
      return { available: true };
    });
    at();
    expect(await screen.findByText('This project is archived.')).toBeTruthy();
    expect(screen.getByText('Rough-in: Dec 4')).toBeTruthy();
  });
});
