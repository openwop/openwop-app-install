/**
 * A schedule enabled before ADR 0003 moved the subject to `User.userId` keeps
 * the OLD principal (`oidc:<uid>`) as its `actingUserId`, while the user's live
 * connection is stored under the new `user:<id>`. MEASURED 2026-09-28 in prod:
 * both assistant loops resolved no credential, fetched Google with NO token, and
 * notified a 403 every tick. The broker now treats the two halves of the durable
 * User join as one person, in that user's own tenant only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  __resetConnectionsStore,
  createSecretConnection,
  resolveConnectionCredential,
  credentialStatusFor,
} from '../src/features/connections/connectionsService.js';
import { createUser } from '../src/features/users/usersService.js';

const TENANT = 't-alias-home';
const PRINCIPAL = 'oidc:alias-uid';

describe('the broker resolves a legacy-principal actor to its User (and back)', () => {
  let userId: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __resetConnectionsStore();
    userId = (await createUser({ tenantId: TENANT, principalId: PRINCIPAL })).userId;
  });

  it('a run acting as the OLD principal gets the connection stored under the User id', async () => {
    await createSecretConnection({ tenantId: TENANT, provider: 'servicenow', kind: 'api_key', secret: 'NEW', scope: 'user', userId });
    const r = await resolveConnectionCredential({ tenantId: TENANT, provider: 'servicenow', actingUserId: PRINCIPAL });
    expect(r?.secret).toBe('NEW');
    expect(r?.provenance.scopeAxis).toBe('user');
  });

  it('a run acting as the User id gets a connection stored under the old principal', async () => {
    await createSecretConnection({ tenantId: TENANT, provider: 'zoom', kind: 'api_key', secret: 'OLD', scope: 'user', userId: PRINCIPAL });
    expect((await resolveConnectionCredential({ tenantId: TENANT, provider: 'zoom', actingUserId: userId }))?.secret).toBe('OLD');
    expect((await credentialStatusFor({ tenantId: TENANT, provider: 'zoom', actingUserId: userId, scopes: [] })).status).toBe('ok');
  });

  it('the EXACT id wins over an alias when the user holds both', async () => {
    await createSecretConnection({ tenantId: TENANT, provider: 'heygen', kind: 'api_key', secret: 'BY-PRINCIPAL', scope: 'user', userId: PRINCIPAL });
    await createSecretConnection({ tenantId: TENANT, provider: 'heygen', kind: 'api_key', secret: 'BY-USER', scope: 'user', userId });
    expect((await resolveConnectionCredential({ tenantId: TENANT, provider: 'heygen', actingUserId: userId }))?.secret).toBe('BY-USER');
    expect((await resolveConnectionCredential({ tenantId: TENANT, provider: 'heygen', actingUserId: PRINCIPAL }))?.secret).toBe('BY-PRINCIPAL');
  });

  it('never aliases across tenants, and never to a different person', async () => {
    // Same principal string, OTHER tenant: that tenant has no User for it, so no alias.
    await createSecretConnection({ tenantId: 't-alias-other', provider: 'runway', kind: 'api_key', secret: 'X', scope: 'user', userId });
    expect(await resolveConnectionCredential({ tenantId: 't-alias-other', provider: 'runway', actingUserId: PRINCIPAL })).toBeNull();
    // A different principal in the SAME tenant is not this user.
    await createSecretConnection({ tenantId: TENANT, provider: 'runway', kind: 'api_key', secret: 'MINE', scope: 'user', userId });
    expect(await resolveConnectionCredential({ tenantId: TENANT, provider: 'runway', actingUserId: 'oidc:someone-else' })).toBeNull();
  });
});
