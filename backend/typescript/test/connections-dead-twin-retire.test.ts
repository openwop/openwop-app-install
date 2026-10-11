/**
 * A successful consent retires the same human's DEAD twin rows for that provider.
 *
 * The defect (prod, 2026-10-10): the Connections table showed two Google and two
 * Gmail rows for one user, one of each `needs-reconsent`. Clicking "Reconnect" on
 * the dead row ran a consent that `findByIdentity` landed on the OTHER row (exact
 * spelling first), so the dead row never changed however many times the user
 * reconnected.
 *
 * The twin is built the way prod got it: the same human connected under the
 * legacy principal spelling and under the canonical `user:` spelling BEFORE the
 * User row joined them (so neither consent saw the other). Then the User row
 * exists, the legacy row dies, and a re-consent as `user:` must retire it.
 *
 * Negative controls: an ACTIVE twin is kept (it still holds a working
 * credential), and another human's dead row is untouched.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  upsertOAuthConnection,
  getConnection,
  __setConnectionStatusForTests,
  __resetConnectionsStore,
} from '../src/features/connections/connectionsService.js';
import { createUser, userIdFor } from '../src/features/users/usersService.js';
import { createApp } from '../src/index.js';

const TENANT = 'twins';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18995, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __resetConnectionsStore();
});

const tokens = (scopes: string[]) =>
  ({ accessToken: 'at', refreshToken: 'rt', scopes, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) as never;

/** Two rows for one human, minted before the User row could alias them. */
async function twinsFor(principal: string, provider: string) {
  const canonical = userIdFor(TENANT, principal);
  const a = await upsertOAuthConnection({ tenantId: TENANT, provider, userId: canonical, tokens: tokens(['read']) });
  const b = await upsertOAuthConnection({ tenantId: TENANT, provider, userId: principal, tokens: tokens(['read']) });
  expect(a.connectionId, 'precondition: two separate rows').not.toBe(b.connectionId);
  await createUser({ tenantId: TENANT, principalId: principal });
  return { canonical, kept: a, twin: b };
}

describe('a consent retires the same human’s dead twins', () => {
  it('a needs-reconsent twin under the other spelling is retired by the next consent', async () => {
    const { canonical, kept, twin } = await twinsFor('oidc:dana', 'google');
    await __setConnectionStatusForTests(twin.connectionId, 'needs-reconsent');

    const landed = await upsertOAuthConnection({ tenantId: TENANT, provider: 'google', userId: canonical, tokens: tokens(['read', 'send']) });
    expect(landed.connectionId).toBe(kept.connectionId);
    expect(await getConnection(TENANT, twin.connectionId), 'the dead twin is gone').toBeNull();
    expect((await getConnection(TENANT, kept.connectionId))?.scopes).toEqual(['read', 'send']);
  });

  it('an ACTIVE twin is kept (negative control: only dead rows are retired)', async () => {
    const { canonical, twin } = await twinsFor('oidc:eli', 'google');
    await upsertOAuthConnection({ tenantId: TENANT, provider: 'google', userId: canonical, tokens: tokens(['read', 'send']) });
    expect((await getConnection(TENANT, twin.connectionId))?.status).toBe('active');
  });

  it('another human’s dead row and another provider’s dead row are untouched', async () => {
    const { canonical } = await twinsFor('oidc:fay', 'google');
    const other = await upsertOAuthConnection({ tenantId: TENANT, provider: 'google', userId: 'oidc:someone-else', tokens: tokens(['read']) });
    await __setConnectionStatusForTests(other.connectionId, 'needs-reconsent');
    const slack = await upsertOAuthConnection({ tenantId: TENANT, provider: 'slack', userId: 'oidc:fay', tokens: tokens(['read']) });
    await __setConnectionStatusForTests(slack.connectionId, 'needs-reconsent');

    await upsertOAuthConnection({ tenantId: TENANT, provider: 'google', userId: canonical, tokens: tokens(['read', 'send']) });
    expect((await getConnection(TENANT, other.connectionId))?.status).toBe('needs-reconsent');
    expect((await getConnection(TENANT, slack.connectionId))?.status).toBe('needs-reconsent');
  });
});
