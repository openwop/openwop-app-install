/**
 * ADR 0945 Q1 — the client's edit-mode opt-in checkbox. It reflects the
 * server's setting, saves through PUT, and a refusal (a non-admin: 403) is an
 * announced message — the box never claims a state the server did not store.
 *
 * Stubbed at the FETCH level: the read is `GET …/grounding-settings`, the save
 * `PUT` to the same URL with `{ editModeEnabled }`, and the refusal is the
 * server's 403 body through the client's own error path.
 *
 * Sabotage (witnessed, wave 78): render the inverse of the stored value → both
 * cases red; send the inverse of the click, or a non-PUT → case 1 red; tick the
 * box before the server answers, or drop the server's message → case 2 red.
 * Equivalent mutant (recorded): on success the box is set from the RESPONSE; a
 * server that echoes the request cannot tell that from setting it to the click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { config } from '../../../client/config.js';

// The embedded JudgeCheckPanel stays closed: it reads nothing until opened.
vi.mock('../../../byok/lib/byokClient.js', () => ({ listStoredRefs: async () => [], getAiDefault: async () => null }));

import GroundingSettingsPanel from '../GroundingSettingsPanel.js';

const URL_ = `${config.baseUrl}/host/openwop-app/creative-briefs/orgs/o1/grounding-settings`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const requests = (): Array<[string, string, unknown]> =>
  fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : undefined]);

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('GroundingSettingsPanel', () => {
  it('shows the stored setting and saves a change', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { editModeEnabled: false })).mockResolvedValueOnce(json(200, { editModeEnabled: true }));
    render(<GroundingSettingsPanel orgId="o1" />);
    const box = await screen.findByRole('checkbox', { name: 'Allow edit mode for this client' });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
    expect(requests()).toEqual([[URL_, 'GET', undefined], [URL_, 'PUT', { editModeEnabled: true }]]);
  });

  it('a refused save leaves the box as stored and says why', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { editModeEnabled: false }))
      .mockResolvedValueOnce(json(403, { error: 'forbidden', message: 'Only an admin of this client can change this.' }));
    render(<GroundingSettingsPanel orgId="o1" />);
    const box = await screen.findByRole('checkbox', { name: 'Allow edit mode for this client' });
    fireEvent.click(box);
    expect(await screen.findAllByText('Only an admin of this client can change this.')).not.toHaveLength(0);
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(requests()).toEqual([[URL_, 'GET', undefined], [URL_, 'PUT', { editModeEnabled: true }]]);
  });
});
