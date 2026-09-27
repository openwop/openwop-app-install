/**
 * Lead conversion (ADR 0209 §3): contact → company + deal, idempotent-by-
 * outcome. ONE function shared by the HTTP route (`routes.ts`) and, per
 * ADR 0208 §2, the (separately-built) `ctx.features.crm` governed write-verb
 * surface — both call THIS so caps / link-validation / status-derivation /
 * events / audit apply identically to humans and agents.
 *
 * CRMGAP-8 (TOCTOU): the get-or-create-company and get-or-create-deal steps
 * below were a plain find-then-create — two concurrent converts for the SAME
 * domain (or the same contact+company) could both miss the find and both
 * create, leaving a duplicate. Each is now guarded by a CAS "claim" row keyed
 * on the dedup identity (`crm:companykeyclaim` / `crm:dealkeyclaim`):
 * `compareAndSwap(null, claim)` is insert-only-if-absent, so exactly ONE
 * concurrent caller wins the claim for a given key; the loser deletes its own
 * just-created row and adopts the winner's instead. This is a small, scoped
 * "first-writer-wins, reconcile after" pattern rather than a lock — no
 * caller ever blocks, and the ordinary (non-racing) path pays one extra CAS
 * write per NEW company/deal only (never on the found-existing path).
 */
import { OpenwopError } from '../../types.js';
import { type Contact, type ContactStage, getContact, updateContact } from './contactsService.js';
import {
  type Company,
  type Deal,
  createCompany,
  createDeal,
  deleteCompany,
  deleteDeal,
  getCompany,
  getDeal,
  getOrCreateDefaultPipeline,
  getPipeline,
  listCompanies,
  listDeals,
} from './crmEntitiesService.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { crmMutated, emitOptsOf, type CrmEmitOptions } from './emit.js';

/** Claim row for the company get-or-create race (CRMGAP-8). `claimId` embeds
 *  the dedup identity (`${tenantId}::${orgId}::domain:<domain>` or
 *  `…::name:<name>`) so `compareAndSwap(null, …)` is a per-key insert-only
 *  claim — the FIRST create to land wins the key. */
interface CompanyKeyClaim {
  claimId: string;
  companyId: string;
}
const companyKeyClaims = new DurableCollection<CompanyKeyClaim>('crm:companykeyclaim', (c) => c.claimId, undefined, (c) => c.claimId.split('::')[0]);

/** Claim row for the deal get-or-create race (CRMGAP-8) — keyed on the
 *  (company, contact) pair a re-convert would otherwise match by list-scan. */
interface DealKeyClaim {
  claimId: string;
  dealId: string;
}
const dealKeyClaims = new DurableCollection<DealKeyClaim>('crm:dealkeyclaim', (c) => c.claimId, undefined, (c) => c.claimId.split('::')[0]);

/** Public-webmail domains never identify a company — fall through to the
 *  name-match path instead (ADR 0209 §3). */
const FREE_MAIL_DOMAINS = new Set(['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'icloud.com']);

/** Stage advance is forward-only — only `lead → qualified` is defined; every
 *  other stage is left as-is (never regressed, never skipped ahead). */
const FORWARD_STAGE: Partial<Record<ContactStage, ContactStage>> = { lead: 'qualified' };

export interface ConvertContactResult {
  contact: Contact;
  company: Company;
  deal: Deal;
  created: { company: boolean; deal: boolean };
}

/** Claim a (tenant, org, key) identity for a just-created row via insert-only
 *  CAS. Returns `true` when THIS caller's row won the key; `false` when
 *  another concurrent create already claimed it first (CRMGAP-8). */
async function claimCompanyKey(tenantId: string, orgId: string, key: string, companyId: string): Promise<boolean> {
  const claimId = `${tenantId}::${orgId}::${key}`;
  return companyKeyClaims.compareAndSwap(null, { claimId, companyId });
}
async function readCompanyKeyClaim(tenantId: string, orgId: string, key: string): Promise<CompanyKeyClaim | null> {
  return companyKeyClaims.get(`${tenantId}::${orgId}::${key}`);
}
async function claimDealKey(tenantId: string, orgId: string, key: string, dealId: string): Promise<boolean> {
  const claimId = `${tenantId}::${orgId}::${key}`;
  return dealKeyClaims.compareAndSwap(null, { claimId, dealId });
}
async function readDealKeyClaim(tenantId: string, orgId: string, key: string): Promise<DealKeyClaim | null> {
  return dealKeyClaims.get(`${tenantId}::${orgId}::${key}`);
}

/** Get-or-create the conversion target company (ADR 0209 §3 step 1), TOCTOU-safe
 *  (CRMGAP-8): match by case-folded email domain first (skipping free-mail
 *  domains), else by case-folded companyName ?? contact.company. When no
 *  existing match is found, create — then, IF a dedup key exists (domain or
 *  name), claim it via CAS. Losing the claim race means another concurrent
 *  convert already won it first: delete this caller's now-redundant row and
 *  adopt the winner instead, so two concurrent converts for the same identity
 *  settle on exactly ONE company. */
async function getOrCreateCompanyForConvert(input: {
  tenantId: string;
  orgId: string;
  contact: Contact;
  actor: string;
  companyName?: string;
}): Promise<{ company: Company; created: boolean }> {
  const { tenantId, orgId, contact, actor } = input;
  const emailDomain = contact.email?.split('@')[1]?.trim().toLowerCase();
  const matchDomain = emailDomain && !FREE_MAIL_DOMAINS.has(emailDomain) ? emailDomain : undefined;
  const matchName = (input.companyName ?? contact.company)?.trim().toLowerCase();

  const existingCompanies = await listCompanies(tenantId, orgId);
  const found = matchDomain
    ? existingCompanies.find((c) => c.domain?.trim().toLowerCase() === matchDomain)
    : matchName
      ? existingCompanies.find((c) => c.name.trim().toLowerCase() === matchName)
      : undefined;
  if (found) return { company: found, created: false };

  const dedupeKey = matchDomain ? `domain:${matchDomain}` : matchName ? `name:${matchName}` : undefined;
  // ADR 0627 D2 — created SILENTLY: the row is provisional until the claim
  // below lands (a lost race DELETES it), so `convertContact` emits
  // `company.created` only for the reconciled outcome.
  const created = await createCompany({
    tenantId,
    orgId,
    name: input.companyName ?? contact.company ?? contact.name,
    ...(matchDomain ? { domain: matchDomain } : {}),
    createdBy: actor,
    silent: true,
  });
  if (!dedupeKey) return { company: created, created: true }; // nothing to race on — no shared identity to dedup against.

  const won = await claimCompanyKey(tenantId, orgId, dedupeKey, created.companyId);
  if (won) return { company: created, created: true };
  // Lost the race: another concurrent convert's create already claimed this
  // key. Adopt the winner and undo our own now-redundant row.
  const winnerClaim = await readCompanyKeyClaim(tenantId, orgId, dedupeKey);
  const winnerCompany = winnerClaim && winnerClaim.companyId !== created.companyId ? await getCompany(tenantId, orgId, winnerClaim.companyId) : null;
  if (winnerCompany) {
    await deleteCompany(tenantId, orgId, created.companyId, { silent: true }); // never existed, as far as the event stream is concerned
    return { company: winnerCompany, created: false };
  }
  // The winner row vanished (deleted between claim and read) — keep our own.
  return { company: created, created: true };
}

/** Get-or-create the conversion deal (ADR 0209 §3 step 2), TOCTOU-safe
 *  (CRMGAP-8) via the same claim-and-reconcile pattern as the company step,
 *  keyed on the (company, contact) pair. An existing OPEN deal for
 *  (contact, company) wins over creating another one — a re-convert is a
 *  no-op past this point. */
async function getOrCreateDealForConvert(input: {
  tenantId: string;
  orgId: string;
  contactId: string;
  actor: string;
  company: Company;
  contactName: string;
  pipelineId: string;
  stageId: string;
  dealTitle?: string;
}): Promise<{ deal: Deal; created: boolean }> {
  const { tenantId, orgId, contactId, actor, company } = input;
  const companyDeals = await listDeals(tenantId, orgId, { companyId: company.companyId });
  const found = companyDeals.find((d) => d.contactId === contactId && d.status === 'open');
  if (found) return { deal: found, created: false };

  const created = await createDeal({
    tenantId,
    orgId,
    title: input.dealTitle ?? `${company.name} — ${input.contactName}`,
    pipelineId: input.pipelineId,
    stageId: input.stageId,
    companyId: company.companyId,
    contactId,
    createdBy: actor,
    actor,
    validateCompany: async () => true,
    validateContact: async () => true,
    silent: true, // ADR 0627 D2 — provisional until the claim lands (see the company step)
  });
  const dedupeKey = `${company.companyId}::${contactId}`;
  const won = await claimDealKey(tenantId, orgId, dedupeKey, created.dealId);
  if (won) return { deal: created, created: true };
  const winnerClaim = await readDealKeyClaim(tenantId, orgId, dedupeKey);
  const winnerDeal = winnerClaim && winnerClaim.dealId !== created.dealId ? await getDeal(tenantId, orgId, winnerClaim.dealId) : null;
  if (winnerDeal) {
    await deleteDeal(tenantId, orgId, created.dealId, { silent: true });
    return { deal: winnerDeal, created: false };
  }
  return { deal: created, created: true };
}

export async function convertContact(input: {
  tenantId: string;
  orgId: string;
  contactId: string;
  actor: string;
  companyName?: string;
  pipelineId?: string;
  dealTitle?: string;
} & Omit<CrmEmitOptions, 'actor'>): Promise<ConvertContactResult> {
  const contact = await getContact(input.contactId);
  if (!contact || contact.tenantId !== input.tenantId || contact.mergedInto) {
    throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: input.contactId });
  }

  // 1. Get-or-create the company — TOCTOU-safe (CRMGAP-8, see helper doc above).
  const { company, created: companyCreated } = await getOrCreateCompanyForConvert({
    tenantId: input.tenantId,
    orgId: input.orgId,
    contact,
    actor: input.actor,
    ...(input.companyName ? { companyName: input.companyName } : {}),
  });

  // 2. Get-or-create the deal in the target pipeline's first stage — TOCTOU-safe
  //    (CRMGAP-8, see helper doc above).
  const pipeline = input.pipelineId
    ? await getPipeline(input.tenantId, input.orgId, input.pipelineId)
    : await getOrCreateDefaultPipeline(input.tenantId, input.orgId);
  if (!pipeline) throw new OpenwopError('not_found', 'Pipeline not found in this org.', 404, { pipelineId: input.pipelineId });
  const firstStage = pipeline.stages[0];
  if (!firstStage) throw new OpenwopError('validation_error', 'Pipeline has no stages.', 409, { pipelineId: pipeline.pipelineId });

  const { deal, created: dealCreated } = await getOrCreateDealForConvert({
    tenantId: input.tenantId,
    orgId: input.orgId,
    contactId: input.contactId,
    actor: input.actor,
    company,
    contactName: contact.name,
    pipelineId: pipeline.pipelineId,
    stageId: firstStage.stageId,
    ...(input.dealTitle ? { dealTitle: input.dealTitle } : {}),
  });

  // 3. Advance the contact's stage — forward only, never regressed.
  const emit = emitOptsOf(input);
  const nextStage = FORWARD_STAGE[contact.stage];
  const updatedContact = nextStage ? ((await updateContact(input.contactId, { stage: nextStage }, emit)) ?? contact) : contact;

  // ADR 0627 D2 — the convert lane's emits, ONE site for the route AND the
  // surface verb: `created` only for a company/deal this convert actually
  // minted (the get-or-create + claim reconcile above decides that), then
  // `converted` for the contact.
  if (companyCreated) crmMutated({ entity: 'company', verb: 'created', tenantId: input.tenantId, orgId: input.orgId, entityId: company.companyId, ...emit });
  if (dealCreated) crmMutated({ entity: 'deal', verb: 'created', tenantId: input.tenantId, orgId: input.orgId, entityId: deal.dealId, ...emit });
  crmMutated({ entity: 'contact', verb: 'converted', tenantId: input.tenantId, orgId: input.orgId, entityId: updatedContact.contactId, ...emit });
  return { contact: updatedContact, company, deal, created: { company: companyCreated, deal: dealCreated } };
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetConvertClaims(): Promise<void> {
  await companyKeyClaims.__clear();
  await dealKeyClaims.__clear();
}
