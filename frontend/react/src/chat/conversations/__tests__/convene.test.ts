import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TFunction } from 'i18next';

// Mock the data clients; keep detectBoardMention + planBoardroomTurns real (pure).
const getBoardByHandle = vi.fn();
const ensureBoardChat = vi.fn();
const getProject = vi.fn();
const listRoster = vi.fn();
vi.mock('../../../features/advisory-board/advisoryBoardClient.js', () => ({ getBoardByHandle: (h: string) => getBoardByHandle(h), ensureBoardChat: (id: string) => ensureBoardChat(id) }));
vi.mock('../../../features/projects/projectsClient.js', () => ({ getProject: (id: string) => getProject(id) }));
vi.mock('../../../agents/rosterClient.js', () => ({ listRoster: (o?: unknown) => listRoster(o) }));

import { buildBoardInterceptor, buildProjectConveneInterceptor, type ConveneDeps } from '../convene.js';
import type { CoreSubmitContext } from '../../lib/chatSubmit.js';

// A `SubmitInterceptor` takes (text, attachments, ctx). These interceptors declare
// only the first two — TS permits that — so ctx is genuinely unused here and the
// omission was harmless at runtime. It was still a type error at every CALL site,
// and passing the real third argument keeps the test honest to the contract: if an
// interceptor ever starts reading ctx, these tests exercise it instead of silently
// handing it `undefined`.
const ctx = {} as CoreSubmitContext;

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
  getBoardByHandle.mockReset(); ensureBoardChat.mockReset();
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
    const out = await buildBoardInterceptor(d)('@@myboard go', undefined, ctx);
    expect(getBoardByHandle).toHaveBeenCalledWith('myboard');
    expect(d.activeAgents.activateAgent).toHaveBeenCalledTimes(2); // chair + advisor
    expect(d.activeAgents.switchTo).toHaveBeenCalledWith('chair');
    expect(d.attachBoard).toHaveBeenCalledWith('sess-1', 'b1', ['agent:chair', 'agent:adv1']);
    expect(d.cadenceStart).toHaveBeenCalled();
    expect(out).toEqual({ kind: 'route', activeAgentId: 'chair', boardSummoned: true });
  });

  it('a PURE summon in an EMPTY chat opens the canonical board conversation (ADR 0278 routing)', async () => {
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', moderatorRosterId: 'r-chair', advisors: ['r-adv1'], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    ensureBoardChat.mockResolvedValue({ sessionId: 'subjc-canonical' });
    const open = vi.fn();
    const d = deps({ isSessionEmpty: () => true, openBoardConversation: open });
    const out = await buildBoardInterceptor(d)('@@myboard', undefined, ctx);
    expect(ensureBoardChat).toHaveBeenCalledWith('b1');
    expect(open).toHaveBeenCalledWith('subjc-canonical');
    expect(out).toEqual({ kind: 'handled' });
    expect(d.attachBoard).not.toHaveBeenCalled(); // no in-place stamp
    expect(d.cadenceStart).not.toHaveBeenCalled(); // cadence untouched
  });

  it('a summon WITH a question stays in place even in an empty chat (the text must land here)', async () => {
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', moderatorRosterId: 'r-chair', advisors: ['r-adv1'], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const open = vi.fn();
    const d = deps({ isSessionEmpty: () => true, openBoardConversation: open });
    const out = await buildBoardInterceptor(d)('@@myboard what should we ship?', undefined, ctx);
    expect(open).not.toHaveBeenCalled();
    expect(d.attachBoard).toHaveBeenCalled(); // the in-place path ran
    expect(out).toEqual({ kind: 'route', activeAgentId: 'chair', boardSummoned: true });
  });

  it('redirect failure falls open to the in-place summon (ensure throws)', async () => {
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', moderatorRosterId: 'r-chair', advisors: ['r-adv1'], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    ensureBoardChat.mockRejectedValue(new Error('403'));
    const open = vi.fn();
    const d = deps({ isSessionEmpty: () => true, openBoardConversation: open });
    const out = await buildBoardInterceptor(d)('@@myboard', undefined, ctx);
    expect(open).not.toHaveBeenCalled();
    expect(d.attachBoard).toHaveBeenCalled();
    expect(out).toEqual({ kind: 'route', activeAgentId: 'chair', boardSummoned: true });
  });

  it('returns null for a non-board message (falls through to @agent)', async () => {
    expect(await buildBoardInterceptor(deps())('just chatting', undefined, ctx)).toBeNull();
    expect(getBoardByHandle).not.toHaveBeenCalled();
  });

  /**
   * ADR 0665 D1 — born red. The board lane promoted whoever activated first into the chair
   * (`if (!chairAgentId) chairAgentId = routed`), a seat that both FRAMES the discussion and
   * writes the SYNTHESIS and that the server 422s a non-member for. ADR 0608 D9 put the
   * refusal on the PROJECT lane ~80 lines above in the same file and never came back here.
   *
   * The previous version of the case below was named "when the board resolves no advisors"
   * while its fixture ALSO had an unresolvable moderator — so after this change it would have
   * kept passing for a different reason than its name. Split, rather than left to drift.
   */
  it('REFUSES when a declared moderator does not resolve — no substitution, nothing convened', async () => {
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', moderatorRosterId: 'r-missing', advisors: ['r-adv1'], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const d = deps();
    const out = await buildBoardInterceptor(d)('@@myboard go', undefined, ctx);

    // `handled`, NOT a falsy outcome: `runCoreSubmit` treats falsy as "not mine" and would
    // send the raw `@@myboard go` text to the model as prose, right after the refusal notice.
    expect(out).toEqual({ kind: 'handled' });
    // Nothing was convened — the advisor that DID resolve must not be seated as chair.
    expect(d.attachBoard).not.toHaveBeenCalled();
    expect(d.cadenceStart).not.toHaveBeenCalled();
    expect(d.activeAgents.switchTo).not.toHaveBeenCalled();
    expect(d.emitSystem).toHaveBeenCalledWith(expect.stringContaining('ModeratorUnavailable'));
  });

  it('CONTROL: a resolving moderator still chairs (the guard is not a blanket refusal)', async () => {
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', moderatorRosterId: 'r-chair', advisors: ['r-adv1'], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const d = deps();
    const out = await buildBoardInterceptor(d)('@@myboard go', undefined, ctx);
    expect(out).toEqual({ kind: 'route', activeAgentId: 'chair', boardSummoned: true });
    expect(d.cadenceStart).toHaveBeenCalled();
  });

  it('SCOPE CONTROL: a board with NO declared moderator still convenes (first-activated chairs)', async () => {
    // `moderatorRosterId` is optional; `planBoardroomTurns` documents first-activated-as-chair
    // for that case. The guard must not fire here, or it turns an intended behaviour into a
    // refusal — the over-correction this ADR's review warned about.
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', advisors: ['r-adv1'], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const d = deps();
    const out = await buildBoardInterceptor(d)('@@myboard go', undefined, ctx);
    expect(out).toEqual({ kind: 'route', activeAgentId: 'adv1', boardSummoned: true });
    expect(d.attachBoard).toHaveBeenCalled();
  });

  it('owns the turn (handled) when a board with no declared moderator resolves no advisors', async () => {
    getBoardByHandle.mockResolvedValue({ boardId: 'b1', advisors: [], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const d = deps();
    const out = await buildBoardInterceptor(d)('@@empty', undefined, ctx);
    expect(out).toEqual({ kind: 'handled' }); // never falls back to a selected agent
    expect(d.attachBoard).not.toHaveBeenCalled();
  });
});

describe('buildProjectConveneInterceptor', () => {
  it('a bare @@ in a non-project chat gives honest guidance (handled), not prose', async () => {
    const d = deps({ conveneProjectId: null });
    const out = await buildProjectConveneInterceptor(d)('@@ topic', undefined, ctx);
    expect(out).toEqual({ kind: 'handled' });
    expect(d.emitSystem).toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it('convenes the project team on a bare @@ and owns the turn', async () => {
    // member refs are `agent:<rosterId>`; the moderator must also be a member to be seated.
    getProject.mockResolvedValue({ name: 'Proj', moderatorRosterId: 'r-chair', members: [{ ref: 'agent:r-chair' }, { ref: 'agent:r-adv1' }], turnPolicy: { rounds: 1, order: 'declared', synthesize: false } });
    const d = deps({ conveneProjectId: 'proj-1' });
    const out = await buildProjectConveneInterceptor(d)('@@ kick off', undefined, ctx);
    expect(out).toEqual({ kind: 'handled' });
    expect(getProject).toHaveBeenCalledWith('proj-1');
    expect(d.send).toHaveBeenCalled(); // the chair's opener
  });

  /**
   * ADR 0608 D9 (`CPWF-4`) — born red. `chairAgentId ??= routed` made whichever
   * agent resolved FIRST the chair, and the chair both frames and synthesizes. So
   * an ordinary async-load race in the mention lineup silently promoted advisor #2
   * into the seat the SERVER 422s a non-member for. `projectsService.ts:299`
   * asserted the consumer "falls back to no chair"; it did not.
   */
  it('REFUSES the convene when the configured moderator did not resolve — no silent substitution', async () => {
    getProject.mockResolvedValue({
      name: 'Proj', moderatorRosterId: 'r-chair',
      members: [{ ref: 'agent:r-chair' }, { ref: 'agent:r-adv1' }],
      turnPolicy: { rounds: 1, order: 'declared', synthesize: true },
    });
    // The moderator's roster entry is MISSING from the lineup; every other member
    // is present — the exact async-load race the substitution used to hide.
    listRoster.mockResolvedValue([{ rosterId: 'r-adv1', agentRef: { agentId: 'adv1' } }]);
    const d = deps({ conveneProjectId: 'proj-1' });
    const out = await buildProjectConveneInterceptor(d)('@@ kick off', undefined, ctx);
    expect(out).toEqual({ kind: 'handled' });
    // Nothing was convened, and the refusal is TYPED + localized, not silence.
    expect(d.send).not.toHaveBeenCalled();
    expect(d.cadenceStart).not.toHaveBeenCalled();
    expect(d.emitSystem).toHaveBeenCalledWith('chat:conveneModeratorUnavailable');
  });

  it('POSITIVE CONTROL — when the moderator DOES resolve, the convene runs and it chairs', async () => {
    // Without this, the refusal above is satisfied equally well by a convene that
    // never runs for any reason at all.
    getProject.mockResolvedValue({
      name: 'Proj', moderatorRosterId: 'r-chair',
      members: [{ ref: 'agent:r-chair' }, { ref: 'agent:r-adv1' }],
      turnPolicy: { rounds: 1, order: 'declared', synthesize: true },
    });
    listRoster.mockResolvedValue([
      { rosterId: 'r-chair', agentRef: { agentId: 'chair' } },
      { rosterId: 'r-adv1', agentRef: { agentId: 'adv1' } },
    ]);
    const d = deps({ conveneProjectId: 'proj-1' });
    await buildProjectConveneInterceptor(d)('@@ kick off', undefined, ctx);
    expect(d.emitSystem).not.toHaveBeenCalledWith('chat:conveneModeratorUnavailable');
    expect(d.send).toHaveBeenCalled();
    expect(d.activeAgents.switchTo).toHaveBeenCalledWith('chair');
  });

  it('a project with NO moderator configured still convenes (the refusal is scoped)', async () => {
    getProject.mockResolvedValue({
      name: 'Proj', members: [{ ref: 'agent:r-adv1' }],
      turnPolicy: { rounds: 1, order: 'declared', synthesize: false },
    });
    listRoster.mockResolvedValue([{ rosterId: 'r-adv1', agentRef: { agentId: 'adv1' } }]);
    const d = deps({ conveneProjectId: 'proj-1' });
    await buildProjectConveneInterceptor(d)('@@ go', undefined, ctx);
    expect(d.emitSystem).not.toHaveBeenCalledWith('chat:conveneModeratorUnavailable');
    expect(d.send).toHaveBeenCalled();
  });

  it('does NOT fire for @@<handle> (lets the board interceptor take it)', async () => {
    const d = deps({ conveneProjectId: 'proj-1' });
    expect(await buildProjectConveneInterceptor(d)('@@myboard', undefined, ctx)).toBeNull();
  });
});
