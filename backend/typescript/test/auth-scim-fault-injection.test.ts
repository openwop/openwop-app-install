/**
 * ADR 0617 D5 / `USERS-10` — the SCIM leaver is TWO durable writes with no
 * transaction; the deny is written FIRST and the IdP's retry is the compensation.
 * These are the two fault-injection witnesses the ADR names, driven over the
 * REAL `/scim/v2/Users/:id` PATCH route (the lane an IdP actually retries):
 *
 *   (1) `denyLinkedSubject` THROWS  ⇒ route non-2xx, NO deny row, status still
 *       `active` — the retry re-runs BOTH writes;
 *   (2) `setUserStatus` THROWS after the deny ⇒ route non-2xx, deny row PRESENT
 *       (the SAML lane is already shut), status still `active` — the retry
 *       closes the SCIM half; the deny write is idempotent so it lands again
 *       harmlessly.
 *
 * And the ORDER is asserted directly: the deny is observable BEFORE the status
 * write is attempted (fault 2 sees the row). Pre-fix the order was status THEN
 * deny, which left the SAML door open until the retry.
 *
 * Faults are injected through `vi.mock` wrappers over the real modules
 * (the `auth-saml-disabled-user.test.ts` idiom), toggled per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';
import { registerScimAuthRoutes } from '../src/routes/authScim.js';
import { __resetUsersStore, getUser } from '../src/features/users/usersService.js';
import { provisionUser } from '../src/host/auth/scimProvisioningService.js';
import { __resetSubjectLinkStore, isLinkedSubjectDenied } from '../src/host/auth/subjectLinkService.js';

const faults = vi.hoisted(() => ({ denyThrows: false, statusThrows: false, denySeenBeforeStatus: null as boolean | null }));

vi.mock('../src/host/auth/subjectLinkService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/auth/subjectLinkService.js')>();
  return {
    ...actual,
    denyLinkedSubject: async (tenantId: string, externalId: string) => {
      if (faults.denyThrows) throw new Error('injected: deny store unavailable');
      return actual.denyLinkedSubject(tenantId, externalId);
    },
  };
});
vi.mock('../src/features/users/usersService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/users/usersService.js')>();
  const link = await import('../src/host/auth/subjectLinkService.js');
  return {
    ...actual,
    setUserStatus: async (...args: Parameters<typeof actual.setUserStatus>) => {
      if (faults.statusThrows) {
        // Record the ORDER: is the deny row already there when the status write is attempted?
        const row = await actual.getUser(args[0]);
        faults.denySeenBeforeStatus = row?.externalId ? await link.isLinkedSubjectDenied(row.tenantId, row.externalId) : null;
        throw new Error('injected: status write failed');
      }
      return actual.setUserStatus(...args);
    },
  };
});

const SCIM_BEARER = 'scim-fault-bearer-0123456789abcdef';
const TENANT = 'scim-fault';
const dir = mkdtempSync(join(tmpdir(), 'owop-scim-fault-'));
let server: http.Server;
let port: number;

async function patch(id: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/scim/v2/Users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SCIM_BEARER}` },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.OPENWOP_SCIM_BEARER = SCIM_BEARER;
  process.env.OPENWOP_SCIM_TENANT = TENANT;
  const app: Express = express();
  app.use(express.json());
  registerScimAuthRoutes(app);
  app.use(errorEnvelopeMiddleware());
  server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENWOP_SCIM_BEARER;
  delete process.env.OPENWOP_SCIM_TENANT;
});
beforeEach(async () => {
  faults.denyThrows = false;
  faults.statusThrows = false;
  faults.denySeenBeforeStatus = null;
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(join(dir, 'scim.db')));
  await __resetUsersStore();
  await __resetSubjectLinkStore();
});

describe('ADR 0617 D5 — deny-first leaver with the IdP retry as compensation', () => {
  it('(1) deny store throws ⇒ non-2xx, NO deny row, status still active; the retry then lands both', async () => {
    const u = await provisionUser({ tenantId: TENANT, userName: 'leaver.one@acme.test', externalId: 'ext-fault-1' });
    faults.denyThrows = true;
    const res = await patch(u.userId, { active: false });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await isLinkedSubjectDenied(TENANT, 'ext-fault-1')).toBe(false);
    expect((await getUser(u.userId))!.status).toBe('active');

    faults.denyThrows = false; // the IdP retries the same PATCH
    const retry = await patch(u.userId, { active: false });
    expect(retry.status).toBe(200);
    expect(await isLinkedSubjectDenied(TENANT, 'ext-fault-1')).toBe(true);
    expect((await getUser(u.userId))!.status).toBe('disabled');
  });

  it('(2) status write throws AFTER the deny ⇒ non-2xx, deny row PRESENT (SAML shut), status still active; the retry closes the SCIM half', async () => {
    const u = await provisionUser({ tenantId: TENANT, userName: 'leaver.two@acme.test', externalId: 'ext-fault-2' });
    faults.statusThrows = true;
    const res = await patch(u.userId, { active: false });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await isLinkedSubjectDenied(TENANT, 'ext-fault-2')).toBe(true); // the fail-closed lane landed FIRST
    expect(faults.denySeenBeforeStatus, 'the deny must be written BEFORE the status write is attempted').toBe(true);
    expect((await getUser(u.userId))!.status).toBe('active');

    faults.statusThrows = false;
    const retry = await patch(u.userId, { active: false });
    expect(retry.status).toBe(200);
    expect((await getUser(u.userId))!.status).toBe('disabled');
    expect(await isLinkedSubjectDenied(TENANT, 'ext-fault-2')).toBe(true); // idempotent re-write
  });

  it('the seam lane (`deactivate-user` by externalId) has the same ordering', async () => {
    process.env.OPENWOP_TEST_SCIM_URL = 'http://scim.invalid';
    try {
      await provisionUser({ tenantId: TENANT, userName: 'leaver.three@acme.test', externalId: 'ext-fault-3' });
      faults.statusThrows = true;
      const res = await fetch(`http://127.0.0.1:${port}/v1/host/openwop-app/auth/scim/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SCIM_BEARER}` },
        body: JSON.stringify({ scimUrl: 'x', op: 'deactivate-user', externalId: 'ext-fault-3' }),
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await isLinkedSubjectDenied(TENANT, 'ext-fault-3')).toBe(true);
      expect(faults.denySeenBeforeStatus).toBe(true);
    } finally {
      delete process.env.OPENWOP_TEST_SCIM_URL;
    }
  });
});
