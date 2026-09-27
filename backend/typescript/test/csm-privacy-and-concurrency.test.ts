/**
 * ADR 0582 §7/§8 — `csm:account` privacy (CSM-4, CSM-12) and write concurrency
 * (CSM-6, CSM-7, CSM-13).
 *
 * `Account.owner` was invisible to ALL THREE privacy mechanisms at once: no
 * `declarePiiFields`, no `SubjectEraser`, no retention purger — and
 * `looksLikePiiName('owner')` is FALSE, so even the undeclared-PII backstop
 * missed it. The only thing that ever reclaimed it was ADR 0284 tenant teardown.
 * The ADR 0464 feature-store gate could not have caught this either: it binds
 * five field-name shapes and `owner` is none of them, so this store had never
 * been classified in EITHER direction.
 *
 * Every write was an unguarded read-modify-write whole-row `put`, so two
 * concurrent PATCHes lost a field and a PATCH racing a DELETE RESURRECTED the
 * deleted row.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { classificationOf, isPiiField, isKnownPiiFieldName } from '../src/host/dataClassification.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import {
  __resetCsmStore,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from '../src/features/csm/accountsService.js';

const T = 't-privacy';

// The service layer is exercised directly (no HTTP), but host-ext persistence
// and the erasure/retention registries are wired at boot — so boot the app.
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});
beforeEach(async () => {
  await __resetCsmStore();
});

describe('CSM-4 — `owner` is declared, classified and erasable', () => {
  it('is a declared PII field, which makes the whole entity confidential-pii', () => {
    expect(isPiiField('csm:account', 'owner')).toBe(true);
    // The classification is what log masking and the retention sweep key on;
    // without a declared field the entity defaulted to `internal`.
    expect(classificationOf('csm:account')).toBe('confidential-pii');
    // The account NAME is a company, not a person — deliberately not declared,
    // so this is an assertion about the boundary rather than a blanket claim.
    expect(isPiiField('csm:account', 'name')).toBe(false);
  });

  // ADR 0582 §12 — the declaration is ENTITY-SCOPED. `declarePiiFields` puts a
  // name into an entity-agnostic union that `maskPiiDeep` applies to EVERY log
  // bag in the app, so declaring a word as generic as `owner` globally would
  // rewrite an unrelated `owner` key — app-builder's sync-binding `owner` is a
  // GITHUB LOGIN, not a person — to `pii_<sha>`. That is the same repo-owner
  // false-positive class the ADR cites when refusing to widen the ERASURE
  // matcher, so it must not be introduced into the LOG-MASK union instead.
  it('does NOT put the generic name `owner` into the global log-mask union', () => {
    expect(
      isKnownPiiFieldName('owner'),
      '`owner` must stay out of the entity-agnostic union — it would mask every `owner` log key app-wide, incl. GitHub repo owners',
    ).toBe(false);
    // The entity-aware query is unaffected — erasure/retention/export still see it.
    expect(isPiiField('csm:account', 'owner')).toBe(true);
    // Non-vacuity: a genuinely distinctive declared name IS in the union, so
    // this is not asserting that the union is simply empty.
    expect(isKnownPiiFieldName('ssn') || isKnownPiiFieldName('sampleGoal')).toBe(true);
  });

  it('a DSAR redacts the owner IN PLACE and leaves the tenant\'s commercial record intact', async () => {
    const mine = await createAccount({ tenantId: T, name: 'Globex', healthScore: 40, arr: 250_000, arrCurrency: 'USD', renewalDate: '2027-03-01', owner: 'user:cs-1' });
    const theirs = await createAccount({ tenantId: T, name: 'Initech', healthScore: 60, owner: 'user:cs-2' });

    await eraseSubject(T, 'user:cs-1');

    const after = await getAccount(mine.accountId);
    // Anonymize-do-not-delete (the `crm/erasure.ts` shape): the ARR, the renewal
    // date and the health score are the TENANT's data, not the CS owner's.
    expect(after, 'the account itself must survive a DSAR').toBeTruthy();
    expect(after!.owner).not.toBe('user:cs-1');
    expect(after!.arr).toBe(250_000);
    expect(after!.renewalDate).toBe('2027-03-01');
    expect(after!.healthScore).toBe(40);
    // ...and nobody else's attribution is touched.
    expect((await getAccount(theirs.accountId))!.owner).toBe('user:cs-2');
  });

  // ADR 0582 §13 — the LIMIT of the leg above, pinned so the coverage claim
  // cannot be read wider than it is. The test above uses `owner:'user:cs-1'`,
  // the DOCUMENTED contract ("an opaque CS-owner subject id"). The field's only
  // real PRODUCER is a free-text "Account owner" box in the SPA, and
  // `eraseCsmSubject` matches on EXACT equality with the subject key — so for a
  // display name the DSAR sweep does nothing at all. This is deliberately
  // asserted rather than fixed with a substring/fuzzy match, which would erase
  // the wrong people. Real coverage for that case is the age-based retention
  // purger (value-agnostic) + ADR 0284 tenant teardown; closing it properly
  // means normalising `owner` to a subject ref at the write boundary.
  it('DOCUMENTED GAP — a free-text owner NAME is NOT reached by the DSAR sweep', async () => {
    const acct = await createAccount({ tenantId: T, name: 'Umbrella', healthScore: 55, owner: 'Dana Scully' });
    // The DSAR runs for the very person whose NAME is in the field.
    await eraseSubject(T, 'user:dana');
    expect(
      (await getAccount(acct.accountId))!.owner,
      'a display-name owner survives erasure today — the sweep keys on an exact subject match',
    ).toBe('Dana Scully');
  });

  it('erasure is tenant-scoped — another workspace\'s row with the same owner is untouched', async () => {
    const here = await createAccount({ tenantId: T, name: 'Here Co', owner: 'user:shared' });
    const elsewhere = await createAccount({ tenantId: 't-other', name: 'Elsewhere Co', owner: 'user:shared' });
    await eraseSubject(T, 'user:shared');
    expect((await getAccount(here.accountId))!.owner).not.toBe('user:shared');
    expect((await getAccount(elsewhere.accountId))!.owner).toBe('user:shared');
  });
});

describe('CSM-12 — retention reaches `csm:account`', () => {
  it('redacts an aged owner without deleting the commercial record', async () => {
    const aged = await createAccount({ tenantId: T, name: 'Ancient Co', arr: 1000, owner: 'user:cs-old' });
    // A cutoff in the future puts every existing row past it.
    const results = await purgeRetained(T, 'confidential-pii', new Date(Date.now() + 60_000).toISOString());
    const csm = results.find((r) => r.feature === 'csm');
    expect(csm, 'CSM must register a retention purger at all — it registered none before').toBeTruthy();
    expect(csm!.ok).toBe(true);
    expect(csm!.deleted).toBe(1); // one row REDACTED, reported honestly as the count acted on

    const after = await getAccount(aged.accountId);
    expect(after, 'retention must never delete the account row itself').toBeTruthy();
    expect(after!.owner).not.toBe('user:cs-old');
    expect(after!.arr, 'the tenant\'s ARR is not the person\'s data').toBe(1000);
  });

  it('leaves a row NEWER than the cutoff alone, and never runs without a tenant', async () => {
    const fresh = await createAccount({ tenantId: T, name: 'Fresh Co', owner: 'user:cs-new' });
    const past = new Date(Date.now() - 60_000).toISOString();
    const results = await purgeRetained(T, 'confidential-pii', past);
    expect(results.find((r) => r.feature === 'csm')!.deleted).toBe(0);
    expect((await getAccount(fresh.accountId))!.owner).toBe('user:cs-new');
    // Fail-closed: an ambiguous tenant is never a global sweep.
    expect(await purgeRetained('', 'confidential-pii', new Date(Date.now() + 60_000).toISOString())).toEqual([]);
    expect((await getAccount(fresh.accountId))!.owner).toBe('user:cs-new');
  });

  it('only the confidential-pii sweep touches this store', async () => {
    const a = await createAccount({ tenantId: T, name: 'Internal Co', owner: 'user:cs-x' });
    const results = await purgeRetained(T, 'internal', new Date(Date.now() + 60_000).toISOString());
    expect(results.find((r) => r.feature === 'csm')!.deleted).toBe(0);
    expect((await getAccount(a.accountId))!.owner).toBe('user:cs-x');
  });
});

describe('CSM-6/CSM-7 — writes are compare-and-swap', () => {
  it('a PATCH racing a DELETE returns null (a 404 at the route) and does NOT resurrect the row', async () => {
    const a = await createAccount({ tenantId: T, name: 'Doomed Co', healthScore: 50 });
    // Delete lands between the caller's read and its write — the exact TOCTOU
    // that used to re-`put` the whole row back into the store.
    await deleteAccount(a.accountId);
    const updated = await updateAccount(a.accountId, { name: 'Renamed' });
    expect(updated, 'a vanished row must not be re-created by a patch').toBeNull();
    expect(await getAccount(a.accountId)).toBeNull();
    expect(await listAccounts(T)).toHaveLength(0);
  });

  it('two concurrent PATCHes of DIFFERENT fields both survive (no lost update)', async () => {
    const a = await createAccount({ tenantId: T, name: 'Racy Co', healthScore: 50 });
    // Issued together against the same starting row: with a bare get→put the
    // loser's field was silently dropped.
    const [byName, byOwner] = await Promise.all([
      updateAccount(a.accountId, { name: 'Renamed Co' }),
      updateAccount(a.accountId, { owner: 'user:cs-9' }),
    ]);
    expect(byName).toBeTruthy();
    expect(byOwner).toBeTruthy();
    const final = await getAccount(a.accountId);
    expect(final!.name).toBe('Renamed Co');
    expect(final!.owner).toBe('user:cs-9');
  });
});
