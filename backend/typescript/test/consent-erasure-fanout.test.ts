/**
 * ADR 0657 D1 / D2 / D6 / D7 / D9 / D10 — the consent eraser on the host fan-out, the
 * tombstone's precedence, the DSAR group readmit, the phone fold, the write barrier.
 *
 * Born red against the 2026-09-11 tree: (D1) the CRM-resolved key's record survived
 * untombstoned and `DELETE /users/:id`'s lane never touched consent; (D2) toggle OFF
 * answered `true` for an erased subject, and a record out-ranked a tombstone; (D7)
 * readmit did not exist — `clearErasureTombstone` fired only from consent writes;
 * (D10) a write on a tombstoned subject landed and CLEARED the tombstone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  eraseSubject, registerSubjectKeyResolver, registerSubjectEraser,
  __resetSubjectErasers, __resetSubjectKeyResolvers,
} from '../src/host/subjectErasure.js';
import { listGovernanceDecisions } from '../src/host/governanceDecisionLog.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { consentFeature } from '../src/features/consent/feature.js';
import { registerConsentErasure, consentSubjectEraser } from '../src/features/consent/erasure.js';
import {
  recordConsent, mergeConsentCategories, getConsent, isAllowed, deleteSubject, readmitSubject, setPolicy,
  isErasureTombstoned, tombstoneKeyForms, __resetConsentStore,
} from '../src/features/consent/consentService.js';

interface RawRecord { tenantId: string; subjectKey: string; categories: Record<string, boolean>; source: string; ts: string }
const rawRecords = new DurableCollection<RawRecord>('consent:record', (r) => `${r.tenantId}:${r.subjectKey}`, undefined, (r) => r.tenantId);

const T = 'tFanout';
// No createApp here, so the toggle default must be registered by hand — otherwise
// `getToggleDefault('consent')` is undefined, `toggle(true)` is a no-op, and every
// toggle-dependent leg below silently runs on the permissive toggle-OFF path.
registerToggleDefault(consentFeature.toggleDefault!);
async function toggle(on: boolean): Promise<void> {
  const d = getToggleDefault('consent'); if (!d) throw new Error('consent toggle default not registered — the legs below would be vacuous');
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetConsentStore();
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  registerConsentErasure();
  await toggle(true);
});

describe('D1 — every resolved key is deleted AND tombstoned, from both doors', () => {
  it('erase an email that resolves to a CRM contact ⇒ the contact-keyed record is gone and tombstoned; rowsTouched counts records only', async () => {
    registerSubjectKeyResolver(async function emailToContact(_t, key) { return key === 'alice@x.test' ? ['crm:c123'] : []; });
    await recordConsent({ tenantId: T, subjectKey: 'alice@x.test', categories: { marketing: true }, source: 'test' });
    await recordConsent({ tenantId: T, subjectKey: 'crm:c123', categories: { marketing: true }, source: 'test' });
    await recordConsent({ tenantId: 'tOther', subjectKey: 'crm:c123', categories: { marketing: true }, source: 'test' });
    const out = await deleteSubject(T, 'alice@x.test');
    expect(out.consentRecord).toBe(true);
    expect(out.erasure.failed).toBe(0);
    expect(out.erasure.keysResolved).toBeGreaterThanOrEqual(1);
    expect(await getConsent(T, 'crm:c123'), 'the RESOLVED key\'s record is gone').toBeNull();
    expect(await isErasureTombstoned(T, 'crm:c123'), 'and tombstoned').toBe(true);
    expect(await isAllowed(T, 'crm:c123', 'marketing'), 'so the audience lane cannot read a stale grant').toBe(false);
    expect(await getConsent('tOther', 'crm:c123'), 'tenant-scoped').not.toBeNull();
    // rowsTouched = record rows deleted by the ERASER (the requested key was deleted first-hand ⇒ 0 there; crm:c123 ⇒ 1)
    expect(out.erasure.rowsTouched).toBe(1);
  });

  it('the users erase door (eraseSubject directly, no deleteSubject) ⇒ tombstone + no record for the userId', async () => {
    await recordConsent({ tenantId: T, subjectKey: 'user-42', categories: { marketing: true }, source: 'test' });
    const r = await eraseSubject(T, 'user-42');
    expect(r.failed).toBe(0);
    expect(r.rowsTouched).toBe(1);
    expect(await getConsent(T, 'user-42')).toBeNull();
    expect(await isErasureTombstoned(T, 'user-42')).toBe(true);
  });

  it('foundNothing stays REACHABLE: an unknown key erases zero rows even though the eraser reports', async () => {
    const r = await eraseSubject(T, 'nobody-here');
    expect(r.reportingErasers).toBeGreaterThan(0);
    expect(r.rowsTouched).toBe(0);
    expect(r.foundNothing).toBe(true);
  });

  it('idempotent: a second DSAR deletes nothing, keeps the original erasedAt, and records a REPEAT (never flips the first receipt)', async () => {
    await recordConsent({ tenantId: T, subjectKey: 'twice', categories: { marketing: true }, source: 'test' });
    const first = await deleteSubject(T, 'twice');
    expect(first.consentRecord).toBe(true);
    const second = await deleteSubject(T, 'twice');
    expect(second.consentRecord).toBe(false);
    expect(second.erasure.failed).toBe(0);
    type P = { reason?: string; repeat?: boolean; priorErasedAt?: string }; // `detail` is SPREAD into the payload
    const rows = (await listGovernanceDecisions(T, { kind: 'retention' })).map((d) => d.payload as P).filter((p) => (p.reason ?? '').startsWith('erasure'));
    expect(rows.map((p) => p.reason)).toContain('erasure_repeat_no_data_found');
    expect(rows.some((p) => p.reason === 'erasure_complete' || p.reason === 'erasure_no_data_found'), 'the first receipt stands').toBe(true);
    const repeat = rows.find((p) => p.reason === 'erasure_repeat_no_data_found')!;
    expect(repeat.repeat).toBe(true);
    expect(typeof repeat.priorErasedAt).toBe('string');
  });
});

describe('D2 — the tombstone out-ranks the toggle AND any record', () => {
  it('toggle OFF + deleteSubject ⇒ isAllowed false (used to be true)', async () => {
    await deleteSubject(T, 'erased-off');
    await toggle(false);
    expect(await isAllowed(T, 'erased-off', 'marketing')).toBe(false);
    expect(await isAllowed(T, 'erased-off', 'analytics')).toBe(false);
    expect(await isAllowed(T, 'someone-else', 'marketing'), 'toggle OFF is still permissive for the un-erased').toBe(true);
  });
  it('a record that pre-dates the barrier never out-ranks a tombstone (toggle ON and OFF)', async () => {
    await deleteSubject(T, 'ghost');
    await rawRecords.put({ tenantId: T, subjectKey: 'ghost', categories: { necessary: true, analytics: true, marketing: true }, source: 'legacy', ts: new Date().toISOString() });
    expect(await isAllowed(T, 'ghost', 'marketing')).toBe(false);
    await toggle(false);
    expect(await isAllowed(T, 'ghost', 'marketing')).toBe(false);
  });
  it('an empty key is never tombstoned and never reads the store', async () => {
    await toggle(false);
    expect(await isAllowed(T, '', 'analytics')).toBe(true);
  });
});

describe('D7 — readmit reverses the whole DSAR group', () => {
  it('erase by userId (email resolved, contact resolved two hops) ⇒ readmit(userId) clears the userId, the email AND the contact tombstones', async () => {
    registerSubjectKeyResolver(async function userToEmail(_t, key) { return key === 'u1' ? ['a@x.test'] : []; });
    registerSubjectKeyResolver(async function emailToContact(_t, key) { return key === 'a@x.test' ? ['crm:c1'] : []; });
    await deleteSubject(T, 'u1');
    for (const k of ['u1', 'a@x.test', 'crm:c1']) expect(await isErasureTombstoned(T, k), `${k} tombstoned by the DSAR`).toBe(true);
    // The resolvers are gone at readmit time in real life (ident rows erased) — simulate by resetting them.
    __resetSubjectKeyResolvers();
    const r = await readmitSubject(T, 'u1', 'The person wrote to support on 2026-09-11 asking to return.');
    expect(r.readmitted).toBe(true);
    expect(r.tombstonesCleared).toBe(3);
    for (const k of ['u1', 'a@x.test', 'crm:c1']) expect(await isErasureTombstoned(T, k), `${k} cleared by the group`).toBe(false);
    // Readmit grants nothing: opt-in policy, no record ⇒ still denied until an affirmative write.
    await setPolicy(T, { defaultMode: 'opt-in' });
    expect(await isAllowed(T, 'crm:c1', 'marketing')).toBe(false);
    await mergeConsentCategories({ tenantId: T, subjectKey: 'crm:c1', categories: { marketing: true }, source: 'public' });
    expect(await isAllowed(T, 'crm:c1', 'marketing')).toBe(true);
    const gov = (await listGovernanceDecisions(T, { kind: 'retention' })).find((d) => (d.payload as { reason?: string }).reason === 'readmit')!;
    expect(gov, 'a governance row for the readmit').toBeTruthy();
    expect(JSON.stringify(gov)).not.toContain('The person wrote'); // the attestation is hashed on the global log
  });
  it('readmit by the RESOLVED key clears only that key\'s forms (it was not the requester)', async () => {
    registerSubjectKeyResolver(async function userToEmail(_t, key) { return key === 'u2' ? ['b@x.test'] : []; });
    await deleteSubject(T, 'u2');
    const r = await readmitSubject(T, 'b@x.test', 'Address owner asked to be re-admitted by phone today.');
    expect(r.tombstonesCleared).toBe(1);
    expect(await isErasureTombstoned(T, 'u2')).toBe(true);
  });
  it('not erased ⇒ readmitted:false, 0 cleared; a short attestation is a typed 400', async () => {
    expect(await readmitSubject(T, 'never-erased', 'A perfectly adequate attestation sentence.')).toEqual({ readmitted: false, tombstonesCleared: 0 });
    await expect(readmitSubject(T, 'x', 'too short')).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('D9 — phone-shaped keys fold to E.164 on write AND read', () => {
  it('tombstone the formatted number, look up the bare one', async () => {
    expect(tombstoneKeyForms('+1 (555) 000-1111')).toEqual(['+1 (555) 000-1111', '+15550001111']);
    expect(tombstoneKeyForms('Alice@X.test')).toEqual(['Alice@X.test', 'alice@x.test']);
    expect(tombstoneKeyForms('crm:c1')).toEqual(['crm:c1']);
    await deleteSubject(T, '+1 (555) 000-1111');
    expect(await isErasureTombstoned(T, '+15550001111')).toBe(true);
    await expect(recordConsent({ tenantId: T, subjectKey: '+15550001111', categories: { marketing: true }, source: 'whatsapp' })).rejects.toMatchObject({ code: 'subject_erased' });
  });
});

describe('D10 — the tombstone is the write barrier', () => {
  it('a write that lands between the tombstone and the record delete is REMOVED by the post-write re-check', async () => {
    // Simulate the CONS-25 interleaving with a sabotaged eraser that writes consent mid-fan-out:
    // the DSAR has already tombstoned; a racing merge must not leave a row behind.
    __resetSubjectErasers();
    registerSubjectEraser(consentSubjectEraser);
    registerSubjectEraser(async function racingPublicWriter(tenantId, key) {
      if (key !== 'racer') return { rowsTouched: 0 };
      await expect(mergeConsentCategories({ tenantId, subjectKey: key, categories: { marketing: true }, source: 'public' })).rejects.toMatchObject({ code: 'subject_erased' });
      // A writer that bypasses the entry barrier (a row put straight into the store) is what the belt catches:
      await rawRecords.put({ tenantId, subjectKey: key, categories: { necessary: true, analytics: false, marketing: true }, source: 'public', ts: new Date().toISOString() });
      return { rowsTouched: 0 };
    });
    await recordConsent({ tenantId: T, subjectKey: 'racer', categories: { marketing: true }, source: 'test' });
    const out = await deleteSubject(T, 'racer');
    expect(out.erasure.failed).toBe(0);
    expect(await getConsent(T, 'racer'), 'the belt re-delete removed the raced row').toBeNull();
    expect(await isErasureTombstoned(T, 'racer')).toBe(true);
  });
});
