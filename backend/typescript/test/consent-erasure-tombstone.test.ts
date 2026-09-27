/**
 * CONS-1 — a DSAR erasure must never RE-CONSENT the subject.
 *
 * `deleteSubject` deletes `consent:record`; `isAllowed` with no record used to
 * fall through to `policy.defaultMode === 'opt-out'`, so on an opt-out tenant the
 * erasure flipped `analytics` / `marketing` / `marketing.sms` / `marketing.push`
 * from DENY to ALLOW. Deletion became a GRANT, and the erased subject had no way
 * to re-opt-out.
 *
 * BOTH ARMS are asserted, because a cure that fixed the first by breaking the
 * second (deny-by-default) would be a different defect wearing this one's fix:
 *   ARM A — after erasure, every category the subject refused stays DENIED;
 *   ARM B — a DIFFERENT subject who never consented is UNAFFECTED (the opt-out
 *           default still permits them). The tombstone is per-subject, not a
 *           global posture flip.
 *
 * Plus the symmetric half (erase ↔ re-consent): an erased subject who
 * affirmatively opts in again is permitted, so the fix cannot become a permanent
 * shadow-ban.
 *
 * NON-VACUITY: each assertion below fails on `origin/main` before the fix (ARM A
 * / re-consent) or is the control that a naive deny-by-default cure would break
 * (ARM B). Sabotage-probed by deleting the `isErasureTombstoned` branch in
 * `isAllowed` — see the commit message.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  isAllowed, recordConsent, deleteSubject, setPolicy, isErasureTombstoned, __resetConsentStore, readmitSubject, getConsent,
  mergeConsentCategories, foldConsentOnMerge,
} from '../src/features/consent/consentService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { consentFeature } from '../src/features/consent/feature.js';
import { __resetSubjectErasers, __resetSubjectKeyResolvers } from '../src/host/subjectErasure.js';

// Private storage + an empty eraser registry, scoped to this file (the pattern
// `consent-erasure-outcome.test.ts` established — a shared registry would make
// the fan-out a moving target and would pull a booted app out from under a
// neighbouring suite).
beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  await __resetConsentStore();
  // The toggle default is declared at feature boot; this file does not boot an
  // app, so declare it here. `if (getToggleDefault(...))` would have SKIPPED
  // silently and left the suite asserting the toggle-OFF permissive escape
  // instead of the consent regime — a gate with no exit, in the test.
  const d = consentFeature.toggleDefault;
  expect(d, 'the consent toggle default must exist for this suite to mean anything').toBeTruthy();
  registerToggleDefault(d!);
  await saveConfig({ ...d!, status: 'on' }, 'test');
});

/** The four categories that flipped deny→allow on an opt-out tenant. Email is
 *  NOT in this list because it survived only INCIDENTALLY (CRM retains
 *  `crm:suppression`), and whatsapp because `STRICT_EXPLICIT_OPT_IN`
 *  short-circuits — both are asserted separately below so the incidental saves
 *  are not mistaken for the fix. */
const FLIPPED = ['analytics', 'marketing', 'marketing.sms', 'marketing.push'] as const;

describe('CONS-1 — erasure must not re-consent the subject', () => {
  it('ARM A: after a DSAR erasure every category stays DENIED under an opt-out policy', async () => {
    const T = 'tConsTombA';
    await setPolicy(T, { defaultMode: 'opt-out' });
    await recordConsent({
      tenantId: T,
      subjectKey: 'subject-refused',
      categories: { analytics: false, marketing: false, 'marketing.sms': false, 'marketing.push': false },
      source: 'test',
    });
    for (const c of FLIPPED) expect(await isAllowed(T, 'subject-refused', c), `pre-erasure ${c}`).toBe(false);

    const out = await deleteSubject(T, 'subject-refused');
    expect(out.consentRecord).toBe(true);

    // THE assertion this whole finding is about. On `origin/main` every one of
    // these returns TRUE after the erasure.
    for (const c of FLIPPED) expect(await isAllowed(T, 'subject-refused', c), `post-erasure ${c}`).toBe(false);
    // …and the two channels that survived incidentally still do.
    expect(await isAllowed(T, 'subject-refused', 'marketing.email')).toBe(false);
    expect(await isAllowed(T, 'subject-refused', 'marketing.whatsapp')).toBe(false);
    // `necessary` is unconditional and MUST NOT be broken by the tombstone.
    expect(await isAllowed(T, 'subject-refused', 'necessary')).toBe(true);
  });

  it('ARM A2: erasing a subject who never recorded anything also denies (an erasure IS an objection)', async () => {
    const T = 'tConsTombA2';
    await setPolicy(T, { defaultMode: 'opt-out' });
    expect(await isAllowed(T, 'never-recorded', 'marketing')).toBe(true); // opt-out default, pre-erasure
    const out = await deleteSubject(T, 'never-recorded');
    expect(out.consentRecord).toBe(false);
    expect(await isAllowed(T, 'never-recorded', 'marketing')).toBe(false);
  });

  it('ARM B: an UNRELATED subject who never consented is unaffected by someone else\'s erasure', async () => {
    const T = 'tConsTombB';
    await setPolicy(T, { defaultMode: 'opt-out' });
    await recordConsent({ tenantId: T, subjectKey: 'erased-one', categories: { marketing: false }, source: 'test' });
    await deleteSubject(T, 'erased-one');
    // The cure must be PER-SUBJECT. A deny-by-default cure would turn these
    // false and silently change the tenant's chosen posture.
    for (const c of FLIPPED) expect(await isAllowed(T, 'bystander', c), `bystander ${c}`).toBe(true);
    expect(await isErasureTombstoned(T, 'bystander')).toBe(false);
    expect(await isErasureTombstoned(T, 'erased-one')).toBe(true);
    // …and the tombstone is TENANT-scoped: the same key in another tenant is clean.
    expect(await isErasureTombstoned('tConsTombB-other', 'erased-one')).toBe(false);
  });

  it('symmetric half (ADR 0657 D7/D10): an erased subject cannot be written back by ANY consent write — an attested re-admit lifts the tombstone, and THEN the opt-in is permitted', async () => {
    const T = 'tConsTombC';
    await setPolicy(T, { defaultMode: 'opt-out' });
    await deleteSubject(T, 'returning');
    expect(await isAllowed(T, 'returning', 'marketing')).toBe(false);
    // Before ADR 0657 this write CLEARED the tombstone ("cleared, not shadowed") — an un-attested
    // second un-erase door open to every public writer (CONS-25). Now it is refused.
    await expect(recordConsent({ tenantId: T, subjectKey: 'returning', categories: { marketing: true }, source: 'test' }))
      .rejects.toMatchObject({ code: 'subject_erased' });
    expect(await isErasureTombstoned(T, 'returning'), 'a refused write never touches the tombstone').toBe(true);
    expect(await getConsent(T, 'returning'), 'and never lands a row').toBeNull();
    const r = await readmitSubject(T, 'returning', 'The subject emailed support on 2026-09-11 asking to hear from us again.');
    expect(r).toEqual({ readmitted: true, tombstonesCleared: 1 });
    expect(await isErasureTombstoned(T, 'returning')).toBe(false);
    // Readmit grants nothing of its own: with no record the subject simply follows the tenant's
    // policy default again (opt-out ⇒ permitted), exactly as before the erasure.
    expect(await isAllowed(T, 'returning', 'marketing'), 'readmit restores the policy default, nothing more').toBe(true);
    await recordConsent({ tenantId: T, subjectKey: 'returning', categories: { marketing: true }, source: 'test' });
    expect(await isAllowed(T, 'returning', 'marketing')).toBe(true);
  });

  it('the tombstone retains NO subject-identifying value (it is a tenant-salted digest)', async () => {
    const T = 'tConsTombD';
    const PHONE = '+15551230000'; // ADR 0394 — a subjectKey may be a raw E.164 number
    await deleteSubject(T, PHONE);
    const raw = new DurableCollection<Record<string, unknown>>('consent:erasure-tombstone', (r) => String(r.subjectHash));
    const rows = await raw.list();
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain(PHONE);
    expect(String(rows[0]!.subjectHash)).toMatch(/^[0-9a-f]{64}$/);
    // …and it is still functionally addressable by the key it does not store.
    expect(await isErasureTombstoned(T, PHONE)).toBe(true);
  });
});

/**
 * Review F8 — which writes may CLEAR an erasure tombstone.
 *
 * D1's symmetric half clears the tombstone on every category write, so that an
 * erased subject who affirmatively opts in again is permitted (without it the
 * fix would be a permanent shadow-ban). That reasoning is about a SUBJECT-driven
 * write, and `foldConsentOnMerge` is not one: a CRM contact merge is an
 * OPERATOR's bookkeeping act, and nobody changed their mind.
 *
 * It cannot GRANT — it only ever writes `false` — which is why this is a
 * narrower finding than CONS-1. But the tombstone is precisely the marker
 * `isAllowed`'s NO-RECORD branch denies on, so erasing it means a later state
 * with no record falls back to the permissive policy default. That is the same
 * "a bookkeeping operation may narrow a permission, never widen one" rule the
 * fold's own MOST-RESTRICTIVE-WINS docblock states.
 */
describe('review F8 — a bookkeeping write must not erase an objection marker', () => {
  it('foldConsentOnMerge leaves the survivor\'s tombstone standing', async () => {
    await setPolicy('tF8', { defaultMode: 'opt-out' }); // the permissive posture that makes this matter
    // The SOURCE contact recorded an opt-out; the SURVIVOR was erased.
    await recordConsent({ tenantId: 'tF8', subjectKey: 'crm:src', categories: { marketing: false }, source: 'preference-center' });
    await deleteSubject('tF8', 'crm:survivor');
    expect(await isErasureTombstoned('tF8', 'crm:survivor')).toBe(true);

    // ADR 0657 D10 — the survivor is erased, so the barrier refuses the carry-over write:
    // the fold reports `false` (nothing written) instead of landing a row on an erased subject.
    expect(await foldConsentOnMerge('tF8', 'crm:src', 'crm:survivor')).toBe(false);

    // The marker survives the merge…
    expect(await isErasureTombstoned('tF8', 'crm:survivor'), 'a CRM merge is not an act of consent').toBe(true);
    // …so when the record is gone again, the no-record path still DENIES rather
    // than falling through to `opt-out`. This is the property the marker exists
    // for, and the one clearing it would have silently removed.
    await deleteSubject('tF8', 'crm:survivor');
    expect(await isAllowed('tF8', 'crm:survivor', 'analytics')).toBe(false);
  });

  it('ADR 0657 D10 — a public merge on an erased subject is REFUSED, not a second un-erase door; the shadow is lifted only by an attested re-admit', async () => {
    // This leg used to guard the OPPOSITE ("a genuine consent write STILL clears it"). The
    // permanent shadow-ban ADR 0586 D1 rejected is avoided by the readmit door, not by
    // letting any public writer clear the marker (that was CONS-25).
    await setPolicy('tF8b', { defaultMode: 'opt-in' });
    await deleteSubject('tF8b', 'visitor:x');
    expect(await isErasureTombstoned('tF8b', 'visitor:x')).toBe(true);

    await expect(mergeConsentCategories({ tenantId: 'tF8b', subjectKey: 'visitor:x', categories: { analytics: true }, source: 'public' }))
      .rejects.toMatchObject({ code: 'subject_erased' });
    expect(await isErasureTombstoned('tF8b', 'visitor:x'), 'the refused write left the marker standing').toBe(true);
    expect(await isAllowed('tF8b', 'visitor:x', 'analytics')).toBe(false);
    await readmitSubject('tF8b', 'visitor:x', 'Visitor asked to be re-admitted via the site contact form.');
    await mergeConsentCategories({ tenantId: 'tF8b', subjectKey: 'visitor:x', categories: { analytics: true }, source: 'public' });
    expect(await isErasureTombstoned('tF8b', 'visitor:x')).toBe(false);
    expect(await isAllowed('tF8b', 'visitor:x', 'analytics')).toBe(true);

    // And the wholesale writer is barred the same way (D10), and re-admitted the same way.
    await deleteSubject('tF8b', 'visitor:y');
    await expect(recordConsent({ tenantId: 'tF8b', subjectKey: 'visitor:y', categories: { analytics: true }, source: 'public' })).rejects.toMatchObject({ code: 'subject_erased' });
    expect(await isErasureTombstoned('tF8b', 'visitor:y')).toBe(true);
    await readmitSubject('tF8b', 'visitor:y', 'Visitor asked to be re-admitted via the site contact form.');
    await recordConsent({ tenantId: 'tF8b', subjectKey: 'visitor:y', categories: { analytics: true }, source: 'public' });
    expect(await isErasureTombstoned('tF8b', 'visitor:y')).toBe(false);
  });
});
