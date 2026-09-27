/**
 * CLNP-7 — the SCIM provision seam REFUSES a body shape it does not read.
 *
 * USERS-21 made the seam SEND one flat shape, but it still ACCEPTED every shape: every
 * field is optional and `userName` falls back to the default principal, so an
 * unrecognised key was silently dropped and the caller got 201 for a user they never
 * named. Witnessed over the real auth middleware + seam + error envelope, because a
 * 400-vs-201 is only observable at the HTTP boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authMiddleware } from '../src/middleware/auth.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';
import { registerScimAuthRoutes } from '../src/routes/authScim.js';
import { DEFAULT_SCIM_USER } from '../src/host/auth/scimProvisioningService.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetUsersStore } from '../src/features/users/usersService.js';
import { __resetSubjectLinkStore } from '../src/host/auth/subjectLinkService.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-scim-closed-'));
let server: http.Server;
let port: number;

const seam = (body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/v1/host/openwop-app/auth/scim/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_SCIM_URL = 'http://scim.invalid/scim/v2';
  delete process.env.OPENWOP_SCIM_BEARER;
  const app: Express = express();
  app.use(express.json());
  app.use(authMiddleware());
  registerScimAuthRoutes(app);
  app.use(errorEnvelopeMiddleware());
  server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENWOP_TEST_SCIM_URL;
});
beforeEach(async () => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(join(dir, 'scim.db')));
  await __resetUsersStore();
  await __resetSubjectLinkStore();
});

describe('CLNP-7 — closed-world body on the SCIM provision seam', () => {
  it.each([
    ['legacy nested `user:{}`', { scimUrl: 'x', op: 'create-user', user: { userName: 'nested@acme.test' } }, ['user']],
    ['a case-typo `UserName`', { scimUrl: 'x', op: 'create-user', UserName: 'typo@acme.test' }, ['UserName']],
    [
      'a literal RFC 7643 User',
      { scimUrl: 'x', op: 'create-user', schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'rfc@acme.test', emails: [{ value: 'rfc@acme.test' }], name: { givenName: 'R' } },
      ['schemas', 'emails', 'name'],
    ],
  ])('%s is 400 naming the unknown keys — never 201 with the default principal', async (_label, body, unknown) => {
    const res = await seam(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { details?: { unknown?: string[] } };
    expect(json.details?.unknown).toEqual(unknown);
  });

  it('a non-object body is 400', async () => {
    const res = await seam(['create-user']);
    expect(res.status).toBe(400);
  });

  it('positive control: the conformance profile body `{scimUrl, op}` still provisions the default user', async () => {
    // auth-scim-profile.test.ts sends exactly this — the default is intended THERE.
    const res = await seam({ scimUrl: 'x', op: 'create-user' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { principal: { displayName?: string } };
    expect(json.principal.displayName).toBe(DEFAULT_SCIM_USER.displayName);
  });

  it('positive control: every key the handler reads is accepted', async () => {
    const res = await seam({ scimUrl: 'x', op: 'create-user', userName: 'full@acme.test', email: 'full@acme.test', displayName: 'Full' });
    expect(res.status).toBe(201);
  });
});
