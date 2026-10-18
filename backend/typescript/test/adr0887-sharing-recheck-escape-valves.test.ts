/**
 * ADR 0887 — the three escape valves of the publisher re-check, each of which
 * the probes cannot see (SH2CD-3):
 *
 *  - architect M1: only a REFUSAL darkens. A session authority that THROWS is an
 *    outage, not "the publisher lost access" — the read must fail as that error
 *    (never the uniform 404), and the failure must not be memoized.
 *  - architect H4: `OPENWOP_SHARE_PUBLISHER_RECHECK=report` serves and logs.
 *  - D1 step 1: a `system:` (visitor-lane) mint is never re-checked, so a
 *    receipt survives without any member behind it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenwopError } from '../src/types.js';

const authority = vi.hoisted(() => ({ fail: false, orgScopeFail: false }));
vi.mock('../src/host/accessControlService.js', async (orig) => {
  const real = await orig<typeof import('../src/host/accessControlService.js')>();
  return {
    ...real,
    assertOrgScope: async (...args: Parameters<typeof real.assertOrgScope>) => {
      if (authority.orgScopeFail) throw new Error('membership store unavailable');
      return real.assertOrgScope(...args);
    },
  };
});
vi.mock('../src/host/sessionAuthority.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/sessionAuthority.js')>()),
  isSessionAuthorityRegistered: () => true,
  resolveSessionSubject: async () => {
    if (authority.fail) throw new OpenwopError('session_authority_unavailable', 'store down', 503, { retry: true });
    return null; // a seed actor: no row
  },
}));

import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { hostExtStorage, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createLink, resolveShared, __resetPublisherVerdictsForTests } from '../src/features/sharing/sharingService.js';

const T = 'shr-0887-valves';
const ORG = 'org-0887-valves';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-0887v-')) });
  initHostExtPersistence(await openStorage('memory://'));
  await createOrg({ tenantId: T, createdBy: 'pub', name: 'Org', orgId: ORG, ownerSubject: 'pub' });
  const now = new Date(Date.now() - 1000).toISOString();
  await hostExtStorage().createChatSession({ sessionId: 'conv-v', tenantId: T, title: 'Valves', createdAt: now, updatedAt: now, messageCount: 0 });
});
afterEach(() => {
  authority.fail = false;
  authority.orgScopeFail = false;
  delete process.env.OPENWOP_SHARE_PUBLISHER_RECHECK;
  __resetPublisherVerdictsForTests();
});

describe('ADR 0887 — escape valves', () => {
  it('a THROWING session authority fails the read as itself (503), not as a dark link, and is not memoized', async () => {
    const link = await createLink(T, ORG, 'pub', { resourceType: 'conversation', resourceId: 'conv-v' });
    authority.fail = true;
    await expect(resolveShared(link.token)).rejects.toMatchObject({ httpStatus: 503 });
    authority.fail = false;
    expect((await resolveShared(link.token)).resourceType, 'the outage was not cached as a refusal').toBe('conversation');
  });

  it('a THROWING membership read (the org-scope step) is likewise an outage, never a dark link', async () => {
    const link = await createLink(T, ORG, 'pub', { resourceType: 'conversation', resourceId: 'conv-v' });
    authority.orgScopeFail = true;
    await expect(resolveShared(link.token)).rejects.toThrow('membership store unavailable');
    authority.orgScopeFail = false;
    expect((await resolveShared(link.token)).resourceType).toBe('conversation');
  });

  it('report mode serves a link whose publisher is gone; enforce (the default) refuses it', async () => {
    // `ghost` holds no membership: its link is dark under enforce.
    const link = await createLink(T, ORG, 'ghost', { resourceType: 'conversation', resourceId: 'conv-v' });
    await expect(resolveShared(link.token)).rejects.toMatchObject({ httpStatus: 404, details: {} });
    __resetPublisherVerdictsForTests();
    process.env.OPENWOP_SHARE_PUBLISHER_RECHECK = 'report';
    expect((await resolveShared(link.token)).resourceType).toBe('conversation');
  });

  it('a system: (visitor-lane) mint is never re-checked — it serves with no member behind it', async () => {
    const link = await createLink(T, ORG, 'system:test-receipt', { resourceType: 'conversation', resourceId: 'conv-v' }, { lane: 'visitor', why: 'test' });
    expect((await resolveShared(link.token)).resourceType).toBe('conversation');
  });
});
