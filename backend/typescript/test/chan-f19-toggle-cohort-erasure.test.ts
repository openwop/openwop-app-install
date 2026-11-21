/**
 * CHAN-F19 #12 (ADR 0464 §9, user decisions 2026-11-19) — a person in feature-toggle
 * beta cohorts on a DSAR.
 *
 * A toggle row's `betaCohort` admits principal ids (a SAML subject can be an email) and
 * its `updatedBy` names the saving operator. The host store was ledgered "no-subject",
 * so an erased person stayed in every closed beta; session replay's pending toggle-write
 * copies held the same ids. Decisions: remove the person from every beta cohort (they
 * lose closed-beta access) and strip them from the pending copies.
 *
 * Boots the real app and erases through `eraseSubject`. Pins:
 *  - C1: the subject's principal (found from the User row the DSAR names) leaves the
 *    cohort; other members stay; their `updatedBy` is redacted;
 *  - C2: an emptied cohort keeps the sentinel, so the closed beta stays CLOSED for
 *    everyone (an empty cohort would read as an OPEN beta);
 *  - C3: the principal alias is home-tenant only: a DSAR in another tenant does not
 *    remove it;
 *  - C4: a pending session-replay copy of a written row no longer holds the principal.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ERASED_COHORT_MEMBER, getStoredConfig, resolveToggle, saveConfig } from '../src/host/featureToggles/service.js';
import { createUser } from '../src/features/users/usersService.js';
import { ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

let n = 0;
async function person(tag: string) {
  const tenantId = `f19l-${tag}-${n++}`;
  const principalId = `saml:${tag}-${n}@example.test`;
  const { userId } = await createUser({ tenantId, principalId });
  return { tenantId, principalId, userId };
}

/** A closed beta on a real toggle (beta + a cohort), saved by `by`. */
async function closedBeta(id: string, cohort: string[], by: string) {
  const def = getToggleDefault(id);
  if (!def) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...def, status: 'beta', betaCohort: cohort }, by);
}

describe('CHAN-F19 #12 — a person in feature-toggle beta cohorts on a DSAR', () => {
  it('C1 removes the subject\'s principal from the cohort, keeps the others, redacts their updatedBy', async () => {
    const ana = await person('ana');
    await closedBeta('crm', [ana.principalId, 'saml:keep@example.test', 'ws:keep-tenant'], ana.principalId);

    await eraseSubject(ana.tenantId, ana.userId);

    const row = await getStoredConfig('crm');
    expect(row?.betaCohort).toEqual(['saml:keep@example.test', 'ws:keep-tenant']);
    expect(row?.updatedBy).toBe(ERASED_USER_REF);
    expect((await resolveToggle('crm', { tenantId: 'elsewhere', userId: 'saml:keep@example.test' }))?.enabled).toBe(true);
  });

  it('C2 an emptied cohort keeps the sentinel, so the closed beta stays closed', async () => {
    const bia = await person('bia');
    await closedBeta('crm', [bia.principalId], 'saml:admin@example.test');
    expect((await resolveToggle('crm', { tenantId: 'elsewhere', userId: 'saml:z@example.test' }))?.enabled, 'non-vacuity: closed').toBe(false);

    await eraseSubject(bia.tenantId, bia.userId);

    expect((await getStoredConfig('crm'))?.betaCohort).toEqual([ERASED_COHORT_MEMBER]);
    expect((await resolveToggle('crm', { tenantId: 'elsewhere', userId: 'saml:z@example.test' }))?.enabled).toBe(false);
    expect((await resolveToggle('crm', { tenantId: bia.tenantId, userId: bia.principalId }))?.enabled).toBe(false);
  });

  it('C3 the principal alias is home-tenant only', async () => {
    const cai = await person('cai');
    await closedBeta('crm', [cai.principalId], 'saml:admin@example.test');

    await eraseSubject(`f19l-other-${n++}`, cai.userId);

    expect((await getStoredConfig('crm'))?.betaCohort).toEqual([cai.principalId]);
  });

  it('C4 a pending session-replay copy of the written row no longer holds the principal', async () => {
    const dan = await person('dan');
    // A replay toggle: saving it records a pending copy (the write intent) before the row.
    await closedBeta('analytics', [dan.principalId, 'saml:keep@example.test'], dan.principalId);
    const pending = async () => (await hostExtStorage().kvList('hostext:analytics:replay-toggle-writes:')).map((r) => r.value);
    expect((await pending()).some((v) => v.includes(dan.principalId)), 'non-vacuity: a pending copy names them').toBe(true);

    await eraseSubject(dan.tenantId, dan.userId);

    const after = await pending();
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((v) => v.includes(dan.principalId))).toBe(false);
    expect(after.some((v) => v.includes('saml:keep@example.test'))).toBe(true);
  });
});
