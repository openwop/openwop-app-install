import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TFunction } from 'i18next';

// Mock the data clients; keep detectBoardMention + planBoardroomTurns real (pure).
const getBoardByHandle = vi.fn();
const getProject = vi.fn();
const listRoster = vi.fn();
vi.mock('../../../features/advisory-board/advisoryBoardClient.js', () => ({ getBoardByHandle: (h: string) => getBoardByHandle(h) }));
vi.mock('../../../features/projects/projectsClient.js', () => ({ getProject: (id: string) => getProject(id) }));
vi.mock('../../../agents/rosterClient.js', () => ({ listRoster: (o?: unknown) => listRoster(o) }));

import { buildBoardInterceptor, buildProjectConveneInterceptor, type ConveneDeps } from '../convene.js';

function deps(over: Partial<ConveneDeps> = {}): ConveneDeps {
  return {
    agentEntries: [
      { agentId: 'chair', slug: 'chair', displayName: 'Chair', modelClass: 'std' },
      { agentId: 'adv1', slug: 'adv1', displayName: 'Adv 1', modelClass: 'std' },
    ] as never,
    activeAgents: { activateAgent: vi.fn((e: { agentId: string }) => e.agentId), switchTo: vi.fn() },
    cadenceStart: vi.fn(),
    send: vi.fn(() => Promise.resolve()),
    config: { provider: 'demo', model: 'm', credentialRef: 'r' } as never,
    emitSystem: vi.fn(),
    t: ((k: string) => k) as unknown as TFunction,
    attachBoard: vi.fn(() => Promise.resolve()),
    getSessionId: () => 'sess-1',
    conveneProjectId: null,
    ...over,
  };
}

beforeEach(() => {
  getBoardByHandle.mockReset();
  getProject.mockReset();
  listRoster.mockReset().mockResolvedValue([
    { rosterId: 'r-chair', agentRef: { agentId: 'chair' } },
    { rosterId: 'r-adv1', agentRef: { agentId: 'adv1' } },
  ]);
});

describe('buildBoardInterceptor', () => {
  it('summons the council, attaches the board, queues the cadence, routes to the chair', async () => {
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', moderatorRosterId: 'r-chair', advisors: ['r-adv1'], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const d = deps();
    const out = await buildBoardInterceptor(d)('@@myboard go', undefined);
    expect(getBoardByHandle).toHaveBeenCalledWith('myboard');
    expect(d.activeAgents.activateAgent).toHaveBeenCalledTimes(2); // chair + advisor
    expect(d.activeAgents.switchTo).toHaveBeenCalledWith('chair');
    expect(d.attachBoard).toHaveBeenCalledWith('sess-1', 'b1', ['agent:chair', 'agent:adv1']);
    expect(d.cadenceStart).toHaveBeenCalled();
    expect(out).toEqual({ kind: 'route', activeAgentId: 'chair', boardSummoned: true });
  });

  it('returns null for a non-board message (falls through to @agent)', async () => {
    expect(await buildBoardInterceptor(deps())('just chatting', undefined)).toBeNull();
    expect(getBoardByHandle).not.toHaveBeenCalled();
  });

  it('owns the turn (handled) when the board resolves no advisors', async () => {
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', moderatorRosterId: 'r-missing', advisors: [], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const d = deps();
    const out = await buildBoardInterceptor(d)('@@empty', undefined);
    expect(out).toEqual({ kind: 'handled' }); // never falls back to a selected agent
    expect(d.attachBoard).not.toHaveBeenCalled();
  });
});

describe('buildProjectConveneInterceptor', () => {
  it('a bare @@ in a non-project chat gives honest guidance (handled), not prose', async () => {
    const d = deps({ conveneProjectId: null });
    const out = await buildProjectConveneInterceptor(d)('@@ topic', undefined);
    expect(out).toEqual({ kind: 'handled' });
    expect(d.emitSystem).toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it('convenes the project team on a bare @@ and owns the turn', async () => {
    // member refs are `agent:<rosterId>`; the moderator must also be a member to be seated.
    getProject.mockResolvedValue({ name: 'Proj', moderatorRosterId: 'r-chair', members: [{ ref: 'agent:r-chair' }, { ref: 'agent:r-adv1' }], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const d = deps({ conveneProjectId: 'proj-1' });
    const out = await buildProjectConveneInterceptor(d)('@@ kick off', undefined);
    expect(out).toEqual({ kind: 'handled' });
    expect(getProject).toHaveBeenCalledWith('proj-1');
    expect(d.send).toHaveBeenCalled(); // the chair's opener
  });

  it('does NOT fire for @@<handle> (lets the board interceptor take it)', async () => {
    const d = deps({ conveneProjectId: 'proj-1' });
    expect(await buildProjectConveneInterceptor(d)('@@myboard', undefined)).toBeNull();
  });
});
