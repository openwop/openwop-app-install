/**
 * CHAN-F19 #9 (ADR 0464 §9, user decisions 2026-11-18) — a CRM contact's NAME in the
 * org's own deal and company records.
 *
 * Convert titles a deal `<company> — <contact name>`, and (before this change) named a
 * new company after the contact when no company name was given. The crm eraser
 * anonymizes the contact but keeps deals and companies as business records, so the
 * erased person's name survived in both. Decisions: (a) anonymize a company named after
 * the contact, and stop naming new companies after the person; (b) in deals linked to
 * the contact, replace the contact's exact former name in the title.
 *
 * Boots the real app and erases through `eraseSubject`. Pins:
 *  - N1 (legacy shape): a company named exactly after the contact is renamed to the
 *    placeholder; the deal title loses both occurrences; amount and links are kept;
 *  - N2 (scope): a deal of ANOTHER contact whose title contains the same name, and a
 *    company named the same that no deal of the subject points at, are untouched;
 *  - N3 (the stated limit of decision (b)): a title the user edited to spell the name in
 *    a different case is NOT matched — the exact-name rule leaves it;
 *  - N4 (stop): a convert with no company name and a free-mail address names the company
 *    `UNNAMED_COMPANY`, never the person.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { createCompany, getCompany } from '../src/features/crm/entities/companies.js';
import { createDeal, getDeal } from '../src/features/crm/entities/deals.js';
import { convertContact, UNNAMED_COMPANY } from '../src/features/crm/convertService.js';
import { ERASED_VALUE } from '../src/features/crm/erasure.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
});

const ok = { validateCompany: async () => true, validateContact: async () => true };
let n = 0;

async function fixture() {
  const tenantId = `crm-f19-names-${n++}`;
  const orgId = 'org-1';
  const name = 'Maria Silva';
  const maria = await createContact({ tenantId, name, email: `maria${n}@gmail.com`, stage: 'lead' });
  const other = await createContact({ tenantId, name: 'Joao Costa', email: `joao${n}@gmail.com`, stage: 'lead' });
  // The legacy convert shape: a company named after the contact, a default-titled deal.
  const named = await createCompany({ tenantId, orgId, name, createdBy: 'user:rep' });
  const deal = await createDeal({ tenantId, orgId, title: `${name} — ${name}`, amount: 5000, companyId: named.companyId, contactId: maria.contactId, createdBy: 'user:rep', ...ok });
  // A user-edited title spelling the name in another case.
  const edited = await createDeal({ tenantId, orgId, title: 'Follow-up with MARIA SILVA', contactId: maria.contactId, createdBy: 'user:rep', ...ok });
  // Out of scope: another contact's deal naming her, and a same-named company she has no deal with.
  const otherDeal = await createDeal({ tenantId, orgId, title: `Referral from ${name}`, contactId: other.contactId, createdBy: 'user:rep', ...ok });
  const lookalike = await createCompany({ tenantId, orgId, name, createdBy: 'user:rep', domain: 'silva-imports.example' });
  // Her deal at a properly named company: the company keeps its name; only hers leaves the title.
  const acme = await createCompany({ tenantId, orgId, name: 'Acme Ltd', createdBy: 'user:rep' });
  const acmeDeal = await createDeal({ tenantId, orgId, title: `Acme Ltd — ${name}`, companyId: acme.companyId, contactId: maria.contactId, createdBy: 'user:rep', ...ok });
  return { tenantId, orgId, name, maria, named, deal, edited, otherDeal, lookalike, acme, acmeDeal };
}

describe('CHAN-F19 #9 — a contact\'s name in deals and companies on a DSAR', () => {
  it('N1 renames the company named after her and strips her name from her deal titles', async () => {
    const f = await fixture();
    await eraseSubject(f.tenantId, f.maria.contactId);
    expect((await getCompany(f.tenantId, f.orgId, f.named.companyId))?.name).toBe(ERASED_VALUE);
    const d = await getDeal(f.tenantId, f.orgId, f.deal.dealId);
    expect(d?.title).toBe(`${ERASED_VALUE} — ${ERASED_VALUE}`);
    expect(d).toMatchObject({ amount: 5000, companyId: f.named.companyId, contactId: f.maria.contactId });
    // A real company on one of her deals keeps its name; only hers leaves that title.
    expect((await getCompany(f.tenantId, f.orgId, f.acme.companyId))?.name).toBe('Acme Ltd');
    expect((await getDeal(f.tenantId, f.orgId, f.acmeDeal.dealId))?.title).toBe(`Acme Ltd — ${ERASED_VALUE}`);
  });

  it('N2 leaves another contact\'s deal and an unrelated same-named company alone', async () => {
    const f = await fixture();
    await eraseSubject(f.tenantId, f.maria.contactId);
    expect((await getDeal(f.tenantId, f.orgId, f.otherDeal.dealId))?.title).toBe(`Referral from ${f.name}`);
    expect((await getCompany(f.tenantId, f.orgId, f.lookalike.companyId))?.name).toBe(f.name);
  });

  it('N3 (known limit of decision (b)): a title spelling the name in another case is not matched', async () => {
    const f = await fixture();
    await eraseSubject(f.tenantId, f.maria.contactId);
    expect((await getDeal(f.tenantId, f.orgId, f.edited.dealId))?.title).toBe('Follow-up with MARIA SILVA');
  });

  it('N5 a retry after the title leg fails still strips the name (the leg runs before the anonymize)', async () => {
    const f = await fixture();
    // Fail the FIRST entity write that puts the placeholder into a row: the title leg's
    // CAS. If that leg ran after the contact anonymize (leg 6), the first pass would have
    // erased the contact's name already, and the retry would have no name to match.
    const storage = hostExtStorage();
    const cas = storage.kvCompareAndSwap.bind(storage);
    let failed = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!failed && key.includes('entity:record') && typeof next === 'string' && next.includes(ERASED_VALUE)) {
        failed = true;
        throw new Error('injected title-leg failure');
      }
      return cas(key, expected, next);
    });
    let first: Awaited<ReturnType<typeof eraseSubject>>;
    try { first = await eraseSubject(f.tenantId, f.maria.contactId); }
    finally { spy.mockRestore(); }
    expect(failed, 'the injection fired').toBe(true);
    expect(first.failed, 'the first pass reports the failure').toBeGreaterThan(0);
    await eraseSubject(f.tenantId, f.maria.contactId);
    expect((await getDeal(f.tenantId, f.orgId, f.deal.dealId))?.title).toBe(`${ERASED_VALUE} — ${ERASED_VALUE}`);
    expect((await getCompany(f.tenantId, f.orgId, f.named.companyId))?.name).toBe(ERASED_VALUE);
  });

  it('N4 a convert with no company name never names the company after the person', async () => {
    const tenantId = `crm-f19-names-convert-${n++}`;
    const c = await createContact({ tenantId, name: 'Ana Pereira', email: 'ana@gmail.com', stage: 'lead' });
    const r = await convertContact({ tenantId, orgId: 'org-1', contactId: c.contactId, actor: 'user:rep' });
    expect(r.created.company).toBe(true);
    expect(r.company.name).toBe(UNNAMED_COMPANY);
    expect(r.company.name).not.toContain('Ana');
  });
});
