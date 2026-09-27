/**
 * ADR 0665 D3 — `private` means hidden from the list, NOT inaccessible to workspace writers.
 *
 * The type docblock said "only the creator may read/convene" and the UI label said "Private
 * (only me)". Neither is what `resolveBoardAccess` does: an org `workspace:write` holder has
 * authority over the board SUBJECT regardless of visibility. That is the documented
 * cross-feature rule — ADR 0054 D5 / ADR 0045, "membership never grants write" — and
 * `projectsService.levelFor` implements it identically.
 *
 * So the RULE is not changed here; the promises were. This test pins the rule, so a future
 * reader who finds the two surprising changes the label and the docblock deliberately rather
 * than "fixing" the resolver and silently diverging the two features.
 *
 * (The recon for this iteration filed the opposite: that advisory-board uniquely had two
 * disagreeing rules while projects were consistent. Measured — projects do the same thing.)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createBoard, resolveBoardAccess } from '../src/features/advisory-board/service.js';
import { createRosterEntry } from '../src/host/rosterService.js';

let tenantId = '';
let creator = '';
let writer = '';
let reader = '';
let advisorRosterId = '';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  const ws = await createWorkspace({ name: 'Board rule', ownerSubject: 'oidc:bd-owner' });
  tenantId = ws.tenantId;
  const seat = async (pid: string, roles: string[]): Promise<string> => {
    const u = await upsertFromPrincipal({ tenantId, principalId: pid, source: 'oidc' });
    await createMember({ tenantId, orgId: tenantId, subject: u.userId, displayName: pid, roles });
    return u.userId;
  };
  creator = await seat('oidc:bd-creator', ['editor']);
  writer = await seat('oidc:bd-writer', ['editor']);
  reader = await seat('oidc:bd-reader', ['viewer']);
  // A real advisor: `createBoard` validates the roster ids, so a synthetic one cannot be used.
  advisorRosterId = (await createRosterEntry({ tenantId, persona: `Advisor ${Math.random().toString(16).slice(2)}`, agentRef: { agentId: 'agent:adv' }, roleKey: 'advisor' })).rosterId;
});

describe('ADR 0665 D3 — what `private` actually means', () => {
  it('a workspace WRITER who is not the creator has authority over a private board', async () => {
    const board = await createBoard(tenantId, tenantId, creator, { name: 'Sealed', visibility: 'private', advisors: [advisorRosterId] } as never);
    // This is the documented rule, not a defect: visibility ≠ authority (ADR 0054 D5).
    expect(await resolveBoardAccess(tenantId, board.boardId, writer)).toBe('write');
    // Non-vacuity: the creator obviously has access, so a pass above is not "everyone gets none".
    expect(await resolveBoardAccess(tenantId, board.boardId, creator)).not.toBe('none');
  });

  it('a workspace READER who is not the creator does NOT — private still hides it from them', async () => {
    const board = await createBoard(tenantId, tenantId, creator, { name: 'Sealed', visibility: 'private', advisors: [advisorRosterId] } as never);
    expect(await resolveBoardAccess(tenantId, board.boardId, reader)).toBe('none');
  });

  it('the same reader DOES reach a shared board — so `private` is doing real work', async () => {
    const board = await createBoard(tenantId, tenantId, creator, { name: 'Open', visibility: 'shared', advisors: [advisorRosterId] } as never);
    expect(await resolveBoardAccess(tenantId, board.boardId, reader)).toBe('read');
  });

  it('an unknown board is fail-closed', async () => {
    expect(await resolveBoardAccess(tenantId, 'b-nope', writer)).toBe('none');
  });
});
