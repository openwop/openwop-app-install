/**
 * ADR 0775 P4 (`ARWF-11`) — the SPA side of the agent stale-write guards.
 *
 * - An edit built from a read copy carries that copy's version as `If-Match`.
 * - A stale-version refusal (`409`, `details.reason: 'stale_write'`) reads as
 *   "someone changed this agent", never as a status code, and is told apart
 *   from another 409 (a persona-name clash) by the reason, not the message.
 * - Appending a workflow re-reads and appends to the CURRENT list on a stale
 *   refusal, so a workflow added elsewhere is not dropped.
 * - The profile PUT now merges, so the voice panel clears a removed voice with
 *   `null`; omitting it would keep the old voice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '../../client/errorEnvelope.js';
import { isStaleWrite, writeErrorMessage } from '../agentWriteAccess.js';
import { appendRosterWorkflow, updateRosterEntry, type AgentProfile, type RosterEntry } from '../rosterClient.js';

type RosterClient = typeof import('../rosterClient.js');
const { getAgentProfile, putAgentProfile, listStoredRefs } = vi.hoisted(() => ({
  getAgentProfile: vi.fn<RosterClient['getAgentProfile']>(),
  putAgentProfile: vi.fn<RosterClient['putAgentProfile']>(),
  listStoredRefs: vi.fn<typeof import('../../byok/lib/byokClient.js')['listStoredRefs']>(),
}));
vi.mock('../../byok/lib/byokClient.js', async (orig) => ({
  ...(await orig<typeof import('../../byok/lib/byokClient.js')>()),
  listStoredRefs,
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const STALE = { code: 'conflict', message: 'This agent changed since you loaded it.', details: { reason: 'stale_write' } };

const entry = (workflows: string[], etag: string): RosterEntry => ({
  rosterId: 'host:pat', persona: 'Pat', agentRef: { agentId: 'a', channel: 'stable' },
  workflows, tenantId: 't', enabled: true, etag,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
/** The `If-Match` header a fetch call carried (null when absent). */
const ifMatchOf = (init: RequestInit | undefined): string | null => new Headers(init?.headers).get('If-Match');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.doUnmock('../rosterClient.js'); });
beforeEach(() => vi.resetAllMocks());

describe('stale-write classification', () => {
  it('reads a stale_write 409 as "changed since you opened it", and only that 409', () => {
    const stale = new ApiError('x', 409, 'x', 'stale_write');
    const clash = new ApiError('Persona taken', 409, 'Persona taken', undefined);
    expect(isStaleWrite(stale)).toBe(true);
    expect(isStaleWrite(clash)).toBe(false);
    expect(writeErrorMessage(stale, 'forbidden', 'changed')).toBe('changed');
    expect(writeErrorMessage(clash, 'forbidden', 'changed')).toBe('Persona taken');
  });
});

describe('roster client', () => {
  it('sends the read version as a quoted If-Match, and none when it has no version', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, entry([], 'v2')));
    vi.stubGlobal('fetch', fetchMock);
    await updateRosterEntry('host:pat', { label: 'x' }, { ifMatch: 'v1' });
    await updateRosterEntry('host:pat', { label: 'y' });
    expect(ifMatchOf(fetchMock.mock.calls[0]![1])).toBe('"v1"');
    expect(ifMatchOf(fetchMock.mock.calls[1]![1])).toBeNull();
  });

  it('a stale append re-reads the agent and appends to its CURRENT list', async () => {
    const bodies: unknown[] = [];
    const patchVersions: Array<string | null> = [];
    const reads: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'PATCH') {
        bodies.push(JSON.parse(String(init.body)));
        patchVersions.push(ifMatchOf(init));
        return bodies.length === 1 ? json(409, STALE) : json(200, entry(['wf.a', 'wf.other', 'wf.new'], 'v3'));
      }
      reads.push(String(url));
      return json(200, entry(['wf.a', 'wf.other'], 'v2')); // the re-read: someone added wf.other
    });
    vi.stubGlobal('fetch', fetchMock);
    const saved = await appendRosterWorkflow(entry(['wf.a'], 'v1'), 'wf.new');
    expect(bodies).toEqual([{ workflows: ['wf.a', 'wf.new'] }, { workflows: ['wf.a', 'wf.other', 'wf.new'] }]);
    // The retry writes against the version it just RE-READ, not the stale one.
    expect(patchVersions).toEqual(['"v1"', '"v2"']);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/\/host\/openwop-app\/roster\/host%3Apat$/);
    expect(saved.workflows).toEqual(['wf.a', 'wf.other', 'wf.new']);
  });

  it('a non-stale failure is not retried', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(403, { code: 'forbidden', message: 'no' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(appendRosterWorkflow(entry(['wf.a'], 'v1'), 'wf.new')).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('voice panel against the merging profile PUT', () => {
  it('clears a removed voice with null and sends the loaded version', async () => {
    vi.doMock('../rosterClient.js', async (orig) => ({
      ...(await orig<typeof import('../rosterClient.js')>()),
      getAgentProfile, putAgentProfile,
    }));
    const { AgentVoicePanel } = await import('../AgentVoicePanel.js');
    const loaded: AgentProfile = {
      profileId: 'p-pat', tenantId: 't', roleKey: 'custom', etag: 'p1',
      autonomy: { level: 'review', specLevel: 'draft-only' },
      configParameters: { voice: { provider: 'openai', voiceId: 'alloy' } },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    getAgentProfile.mockResolvedValue(loaded);
    listStoredRefs.mockResolvedValue([]);
    putAgentProfile.mockImplementation(async () => ({ ...loaded, etag: 'p2' }));
    render(<AgentVoicePanel rosterId="host:pat" />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Voice ID'), { target: { value: '' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save voice' })); });
    expect(putAgentProfile).toHaveBeenCalledTimes(1);
    const [, input, opts] = putAgentProfile.mock.calls[0]!;
    expect(input.configParameters).toBeNull();
    expect(input).not.toHaveProperty('channels'); // governance fields are no longer resent
    expect(opts).toEqual({ ifMatch: 'p1' });
  });
});
