/**
 * ADR 0975 D8 — a live KickTodo operator can open and continue the Studio's
 * Challenge Author chat with authorization ENFORCED, and nothing wider.
 *
 * MEASURED on kicktodo.com (2026-10-26), minutes after enforcement went on:
 * `authorization.denied runs:create` on the Studio chat's `POST /runs`, and
 * `authorization.denied approvals:respond` on the conversation's `gate`. The
 * operator role (ADR 0910 D1) is viewer + `host:kicktodo:manage` +
 * `host:byok:manage`, so the only way to start a Challenge Factory run was shut.
 * The same pass found D1's entry-gate fallback dead under enforcement: it caught
 * `forbidden_scope`, but `refuseScope` throws `forbidden` (+ `requiredScope`), and
 * the D1 test had mocked the code it expected.
 *
 * Everything here runs the REAL scope check (`requireProtocolScope`, real
 * membership: a viewer member) with enforcement on. The one stand-in is
 * `hasKicktodoManageAuthority` (a live activation), so each case can say who
 * holds manage authority.
 *
 * Pins: a Challenge Author conversation starts (201, stamped, no challenge header)
 * for a viewer with manage authority; any other agent, no agent, or no manage
 * authority is 403; a caller cannot forge the stamp. A stamped run's turn to the
 * Challenge Author is admitted for its owner; a turn to another agent, a `bypass`
 * turn, someone else's run, an unstamped conversation, or an ended activation is
 * refused; D1's Factory gate is admitted through the real refusal; a narrowed
 * API key is never widened.
 *
 * Red when (sabotage-witnessed): the start-grant branch in `POST /runs` is
 * removed; the agent check in either predicate is removed; the owner check is
 * removed; `grantMayStandIn` matches only `forbidden_scope` again; the key-lane
 * exclusion is removed; the stamp is no longer stripped from caller metadata.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const authority = vi.hoisted(() => ({ managers: new Set<string>() }));
vi.mock('../src/features/featureRoute.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/featureRoute.js')>()),
  hasKicktodoManageAuthority: async (_tenantId: string, subject?: string) => !!subject && authority.managers.has(subject),
}));

import { createApp } from '../src/index.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { loadOwnedRunForDecision } from '../src/routes/interrupts.js';
import { RUN_START_GRANT_METADATA_KEY, registerRunStartGrant, resetRunStartGrantsForTests } from '../src/host/runStartGrant.js';
import { challengeAuthorChatStartGrant } from '../src/features/kicktodo-creator/routes.js';
import { stripCallerAttribution } from '../src/host/runDispatch.js';
import { CHALLENGE_AUTHOR_AGENT_ID } from '../src/features/kicktodo-creator/challengeAuthorService.js';
import { CHALLENGE_FACTORY_WORKFLOW_ID } from '../src/features/kicktodo-creator/builtinWorkflows.js';
import { CONVERSATION_WORKFLOW_ID } from '../src/host/conversation.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let ws = '';
let operator = '';
let otherViewer = '';
let operatorCookie = '';
const saved: Record<string, string | undefined> = {};
const OTHER_AGENT = 'vendor.openwop-app.example.agents.someone-else';

const cookieFor = (userId: string, tenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: tenant, tier: 'user', userId, personalTenant: `ws:home-${userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const viewer = async (principalId: string): Promise<string> => {
  const user = await upsertFromPrincipal({ tenantId: ws, principalId, source: 'oidc' });
  await createMember({ tenantId: ws, orgId: ws, subject: user.userId, displayName: principalId, roles: ['viewer'] });
  return user.userId;
};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTHORIZATION_ENFORCEMENT', 'OPENWOP_SESSION_SECRET', 'OPENWOP_AUTH_DISABLE_COOKIES']) saved[k] = process.env[k];
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0975-d8', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  ws = (await createWorkspace({ name: 'KickTodo D8', ownerSubject: 'oidc:d8-owner' })).tenantId;
  operator = await viewer('oidc:d8-operator');
  otherViewer = await viewer('oidc:d8-other');
  operatorCookie = cookieFor(operator, ws);
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { authority.managers = new Set([operator]); });

const startChat = (metadata: Record<string, unknown>, cookie = operatorCookie): Promise<Response> =>
  fetch(`${BASE}/runs`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: CONVERSATION_WORKFLOW_ID, inputs: {}, metadata }) });

describe('ADR 0975 D8 — starting the Challenge Author chat (POST /runs, enforcement on)', () => {
  it('a viewer with manage authority opens a Challenge Author conversation: 201, stamped, no challenge', async () => {
    const res = await startChat({ chatSessionId: 's-1', agentScope: CHALLENGE_AUTHOR_AGENT_ID });
    expect(res.status).toBe(201);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const { runId } = (await res.json()) as { runId: string };
    const run = await storage.getRun(runId.includes('/') ? runId.slice(runId.indexOf('/') + 1) : runId);
    expect((run?.metadata as Record<string, unknown>)[RUN_START_GRANT_METADATA_KEY]).toEqual({ grant: 'kicktodo-challenge-author', agentId: CHALLENGE_AUTHOR_AGENT_ID });
  });

  it('any other agent, or no agent, is still `runs:create` (403 + insufficient_scope)', async () => {
    for (const metadata of [{ agentScope: OTHER_AGENT }, { chatSessionId: 's-2' }]) {
      const res = await startChat(metadata);
      expect(res.status).toBe(403);
      expect(res.headers.get('www-authenticate') ?? '').toMatch(/insufficient_scope/);
    }
  });

  it('without manage authority (activation ended) the same request is refused', async () => {
    authority.managers.clear();
    expect((await startChat({ agentScope: CHALLENGE_AUTHOR_AGENT_ID })).status).toBe(403);
  });

  it('the admission is the registered grant\'s: with none registered, the same request is refused', async () => {
    resetRunStartGrantsForTests();
    try {
      expect((await startChat({ agentScope: CHALLENGE_AUTHOR_AGENT_ID })).status).toBe(403);
    } finally {
      registerRunStartGrant([CONVERSATION_WORKFLOW_ID], challengeAuthorChatStartGrant);
    }
    expect((await startChat({ agentScope: CHALLENGE_AUTHOR_AGENT_ID })).status).toBe(201);
  });

  it('a caller cannot forge the stamp: it is stripped from caller metadata', () => {
    expect(stripCallerAttribution({ [RUN_START_GRANT_METADATA_KEY]: { grant: 'kicktodo-challenge-author', agentId: CHALLENGE_AUTHOR_AGENT_ID }, keep: 1 })).toEqual({ keep: 1 });
  });
});

async function seedRun(workflowId: string, owner: string, stamped: boolean): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  await storage.insertRun({
    runId, workflowId, tenantId: ws, status: 'waiting-approval', inputs: {}, configurable: {}, createdAt: now, updatedAt: now,
    metadata: { actingUserId: owner, ...(stamped ? { [RUN_START_GRANT_METADATA_KEY]: { grant: 'kicktodo-challenge-author', agentId: CHALLENGE_AUTHOR_AGENT_ID } } : {}) },
  } as RunRecord);
  return runId;
}
function decisionReq(subject: string, resumeValue: unknown, auth: Record<string, unknown> = { kind: 'subject' }): Request & { removed: string[] } {
  const removed: string[] = [];
  return {
    tenantId: ws, userId: subject, personalTenant: `ws:home-${subject}`,
    principal: { principalId: subject, tenants: [ws], token: '', auth },
    body: { resumeValue },
    headers: {}, protocol: 'http', get: (h: string) => (h.toLowerCase() === 'host' ? 'localhost' : undefined),
    res: { setHeader: () => undefined, removeHeader: (h: string) => { removed.push(h.toLowerCase()); } },
    removed,
  } as unknown as Request & { removed: string[] };
}
const turnTo = (to: string, extra: Record<string, unknown> = {}): unknown => ({ operation: 'exchange', turn: { content: 'run the factory', to }, ...extra });

describe('ADR 0975 D8 — continuing it (the conversation gate, real refusal)', () => {
  it('the owner\'s stamped conversation: a turn to the Challenge Author is admitted, and the challenge withdrawn', async () => {
    const runId = await seedRun(CONVERSATION_WORKFLOW_ID, operator, true);
    const req = decisionReq(operator, turnTo(CHALLENGE_AUTHOR_AGENT_ID));
    await expect(loadOwnedRunForDecision(req, storage, runId)).resolves.toBeUndefined();
    expect(req.removed).toContain('www-authenticate');
    await expect(loadOwnedRunForDecision(decisionReq(operator, { operation: 'close' }), storage, runId)).resolves.toBeUndefined();
  });

  it('refused: another agent, a bypass turn, someone else\'s run, an unstamped conversation, an ended activation', async () => {
    const mine = await seedRun(CONVERSATION_WORKFLOW_ID, operator, true);
    const refuse = (req: Request, runId: string) => expect(loadOwnedRunForDecision(req, storage, runId)).rejects.toMatchObject({ httpStatus: 403 });
    await refuse(decisionReq(operator, turnTo(OTHER_AGENT)), mine);
    await refuse(decisionReq(operator, turnTo(CHALLENGE_AUTHOR_AGENT_ID, { permissionMode: 'bypass' })), mine);
    authority.managers.add(otherViewer);
    await refuse(decisionReq(otherViewer, turnTo(CHALLENGE_AUTHOR_AGENT_ID)), mine);
    await refuse(decisionReq(operator, turnTo(CHALLENGE_AUTHOR_AGENT_ID)), await seedRun(CONVERSATION_WORKFLOW_ID, operator, false));
    authority.managers.clear();
    await refuse(decisionReq(operator, turnTo(CHALLENGE_AUTHOR_AGENT_ID)), mine);
  });

  it('D1 through the REAL refusal: the operator decides their own Factory run\'s gate', async () => {
    const runId = await seedRun(CHALLENGE_FACTORY_WORKFLOW_ID, operator, false);
    await expect(loadOwnedRunForDecision(decisionReq(operator, { action: 'accept' }), storage, runId)).resolves.toBeUndefined();
  });

  it('a narrowed API key is never widened by a grant, even for its owner\'s own run', async () => {
    const runId = await seedRun(CHALLENGE_FACTORY_WORKFLOW_ID, operator, false);
    await expect(loadOwnedRunForDecision(decisionReq(operator, { action: 'accept' }, { kind: 'api-key', scopes: ['runs:read'] }), storage, runId))
      .rejects.toMatchObject({ httpStatus: 403 });
  });
});
