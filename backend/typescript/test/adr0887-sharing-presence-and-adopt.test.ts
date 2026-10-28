/**
 * ADR 0887 — two witnesses the route probes cannot reach cheaply.
 *
 *  - D1 step 2 (architect H1): in a shared `ws:` workspace, membership of the ROOT
 *    is what presence means. Removing someone from the root deletes only the
 *    root's twins, so a sub-org row survives and `assertOrgScope` on that sub-org
 *    still passes. The publisher's link must go dark anyway.
 *  - D5: adopting is publishing, so the adopter passes the resource entitlement —
 *    a writer who cannot read the resource cannot take the link over.
 *
 * Service-level on purpose: it drives the same `createLink` / `resolveShared` /
 * `adoptLink` the routes call, with real org + member rows.
 *
 * Tracker TST-BHF-1. Red when (sabotage-witnessed, wave 62): the publisher re-check
 * skips the shared-workspace ROOT membership test (`publisherAbsence`), or `adoptLink`
 * skips the adopter's resource entitlement.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createOrg, createMember, deleteMember } from '../src/host/accessControlService.js';
import { adoptLink, createLink, resolveShared, __resetPublisherVerdictsForTests } from '../src/features/sharing/sharingService.js';
import { createEntry, updateEntry } from '../src/features/prompts/promptLibraryService.js';
import { createTenantTemplate } from '../src/host/tenantPromptTemplates.js';

const WS = 'ws:adr0887-presence';
let SUB = '';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0887-')) });
  initHostExtPersistence(await openStorage('memory://'));
  await createTenantTemplate(WS, { templateId: 'tpl-0887p', version: '1.0.0', kind: 'user', text: 'Presence body', name: 'tpl-0887p' });
  // The workspace root (orgId === tenantId) and one sub-org.
  await createOrg({ tenantId: WS, orgId: WS, name: 'WS', createdBy: 'owner', ownerSubject: 'owner' });
  SUB = (await createOrg({ tenantId: WS, name: 'Sub', createdBy: 'owner', ownerSubject: 'owner' })).orgId;
  for (const subject of ['pub', 'other']) {
    await createMember({ tenantId: WS, orgId: WS, subject, displayName: subject, roles: ['editor'] });
    await createMember({ tenantId: WS, orgId: SUB, subject, displayName: subject, roles: ['editor'] });
  }
});

describe('ADR 0887 D1 — a publisher removed from the workspace ROOT is gone, sub-org twin or not', () => {
  it('the link darkens although the sub-org row still grants workspace:write', async () => {
    const entry = await createEntry(WS, SUB, 'pub', { name: 'Ws prompt', promptRef: 'tpl-0887p', visibility: 'shared' });
    const link = await createLink(WS, SUB, 'pub', { resourceType: 'prompt', resourceId: entry.entryId });
    expect((await resolveShared(link.token)).resource.name).toBe('Ws prompt');

    const { listMembers } = await import('../src/host/accessControlService.js');
    const rootRow = (await listMembers(WS, WS)).find((m) => m.subject === 'pub')!;
    expect(await deleteMember(rootRow.memberId)).toBe(true);
    expect((await listMembers(WS, SUB)).some((m) => m.subject === 'pub'), 'non-vacuity: the sub-org twin survives').toBe(true);

    __resetPublisherVerdictsForTests();
    await expect(resolveShared(link.token)).rejects.toMatchObject({ httpStatus: 404, details: {} });
  });
});

describe('ADR 0887 D5 — adopting is publishing', () => {
  it('a writer who cannot read the resource cannot adopt its dark link; its owner can', async () => {
    // `other` owns a prompt that is shared; `owner` publishes it; `owner` then loses
    // the sub-org (dark); `other` makes it private. A third writer must not adopt.
    await createMember({ tenantId: WS, orgId: SUB, subject: 'third', displayName: 'third', roles: ['editor'] });
    await createMember({ tenantId: WS, orgId: WS, subject: 'third', displayName: 'third', roles: ['editor'] });
    await createMember({ tenantId: WS, orgId: SUB, subject: 'leaver', displayName: 'leaver', roles: ['editor'] });
    await createMember({ tenantId: WS, orgId: WS, subject: 'leaver', displayName: 'leaver', roles: ['editor'] });
    const entry = await createEntry(WS, SUB, 'other', { name: 'Adoptable', promptRef: 'tpl-0887p', visibility: 'shared' });
    const link = await createLink(WS, SUB, 'leaver', { resourceType: 'prompt', resourceId: entry.entryId });

    const { listMembers } = await import('../src/host/accessControlService.js');
    for (const org of [WS, SUB]) {
      const row = (await listMembers(WS, org)).find((m) => m.subject === 'leaver')!;
      await deleteMember(row.memberId);
    }
    await updateEntry(WS, SUB, entry.entryId, 'other', { name: 'Adoptable', promptRef: 'tpl-0887p', visibility: 'private' });

    // ADR 0993 D2 — the private prompt's entitlement answers the uniform 404.
    await expect(adoptLink(WS, SUB, link.token, 'third')).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
    const adopted = await adoptLink(WS, SUB, link.token, 'other');
    expect(adopted.createdBy).toBe('other');
    __resetPublisherVerdictsForTests();
    expect((await resolveShared(link.token)).resource.name).toBe('Adoptable');
  });
});
