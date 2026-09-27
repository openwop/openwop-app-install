/**
 * `demo-dealers` seeder (ADR 0281 — dealer-network PRM).
 *
 * Solstice Roasters' reseller channel over the Phase-3 CRM: 8 dealers (each a
 * reseller partner referencing a demo-crm company) with channel tiers + one
 * suspended partner, 1–3 retail outlets per dealer carrying real lat/lng (which
 * ALSO feed the ADR 0282 `/sales-map` pins), a partner-portal token per dealer,
 * and a handful of deal registrations in mixed states (pending/approved/
 * rejected). `dependsOn: ['demo-crm']` (a dealer must reference a live company).
 *
 * Toggle-gated on `dealers`; skips honestly (never flips). Dealer/outlet rows
 * carry NO `createdBy` (the create `actor` is discarded), so demo rows are
 * anchored on their `companyId` ∈ the demo-crm company set — count/clear select
 * exactly those. Clear uses the real cascade (`deleteDealer` → outlets,
 * `deleteDealerPrmData` → registrations + tokens).
 */
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import {
  createDealer, listDealers, deleteDealer,
  createOutlet, listOutlets,
} from '../features/dealers/entities/dealer.js';
import {
  createRegistration, decideRegistration, listRegistrations,
  mintPartnerToken, deleteDealerPrmData,
} from '../features/dealers/entities/registration.js';
import { SOLSTICE_COMPANIES, demoCrmCompanyId, outletCoords } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoDealers');

export const DEMO_DEALERS_ACTOR = 'demo:dealers';

interface DemoDealer {
  slug: string;              // demo-crm company slug
  tier: string;
  status: 'active' | 'suspended';
  outlets: number;           // how many outlets (rides the company hqCity coords)
  registrations?: { dealTitle: string; companyName: string; decision?: 'approved' | 'rejected' }[];
}

/** 8 companies promoted to reseller dealers (chains/groups that resell Solstice). */
const DEALERS: readonly DemoDealer[] = [
  { slug: 'greenleaf-markets', tier: 'Platinum', status: 'active', outlets: 3, registrations: [{ dealTitle: 'Q3 endcap program — 40 stores', companyName: 'Greenleaf Markets', decision: 'approved' }] },
  { slug: 'harvest-grocers', tier: 'Platinum', status: 'active', outlets: 3, registrations: [{ dealTitle: 'Private-label cold brew pilot', companyName: 'Harvest Grocers' }] },
  { slug: 'daily-grind-co', tier: 'Gold', status: 'active', outlets: 2 },
  { slug: 'terrace-cafe-group', tier: 'Gold', status: 'active', outlets: 2, registrations: [{ dealTitle: 'Espresso equipment bundle', companyName: 'Terrace Café Group', decision: 'rejected' }] },
  { slug: 'sunbeam-roastery-bar', tier: 'Gold', status: 'active', outlets: 1 },
  { slug: 'cornerstone-provisions', tier: 'Silver', status: 'active', outlets: 1, registrations: [{ dealTitle: 'Regional distribution — Southwest', companyName: 'Cornerstone Provisions' }] },
  { slug: 'meadowlark-foods', tier: 'Silver', status: 'active', outlets: 1 },
  { slug: 'urban-pantry-coop', tier: 'Silver', status: 'suspended', outlets: 1 },
];

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

/** Demo dealers = those whose companyId is in the demo-crm company set. */
async function demoDealerIds(tenantId: string, orgId: string): Promise<string[]> {
  const demoCompanyIds = new Set(DEALERS.map((d) => demoCrmCompanyId(tenantId, d.slug)));
  return (await listDealers(tenantId, orgId)).filter((d) => demoCompanyIds.has(d.companyId)).map((d) => d.dealerId);
}

export async function countDemoDealers(tenantId: string): Promise<number> {
  const orgId = await orgIdFor(tenantId);
  const dealerIds = await demoDealerIds(tenantId, orgId);
  let outlets = 0;
  for (const id of dealerIds) outlets += (await listOutlets(tenantId, orgId, { dealerId: id })).length;
  return dealerIds.length + outlets;
}

export async function seedDemoDealers(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await resolveOne('dealers', { tenantId }))?.enabled) {
    return { created: 0, details: { skipped: 'dealers feature is off' } };
  }
  const orgId = await orgIdFor(tenantId);
  let created = 0;
  let outlets = 0;
  let regs = 0;

  // companyId → existing demo dealer (idempotency anchor; no createdBy to key on).
  const byCompany = new Map((await listDealers(tenantId, orgId)).map((d) => [d.companyId, d]));

  for (const spec of DEALERS) {
    const company = SOLSTICE_COMPANIES.find((c) => c.slug === spec.slug);
    if (!company) continue;
    const companyId = demoCrmCompanyId(tenantId, spec.slug);
    let dealer = byCompany.get(companyId);
    if (!dealer) {
      dealer = await createDealer(tenantId, orgId, { companyId, name: company.name, tier: spec.tier, status: spec.status }, DEMO_DEALERS_ACTOR);
      byCompany.set(companyId, dealer);
      created += 1;
      // Partner-portal token — one per dealer (mint rotates; only mint on create).
      await mintPartnerToken(tenantId, orgId, dealer.dealerId);
    }

    // Outlets (idempotent by name within the dealer).
    const existingOutletNames = new Set((await listOutlets(tenantId, orgId, { dealerId: dealer.dealerId })).map((o) => o.name));
    for (let i = 0; i < spec.outlets; i += 1) {
      const name = spec.outlets === 1 ? `${company.name} — ${company.hqCity}` : `${company.name} — Store ${i + 1}`;
      if (existingOutletNames.has(name)) continue;
      const coords = outletCoords(spec.slug, i);
      await createOutlet(tenantId, orgId, dealer.dealerId, {
        name,
        address: `${company.hqCity}`,
        ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
        status: 'active',
      }, DEMO_DEALERS_ACTOR);
      outlets += 1;
    }

    // Deal registrations (idempotent by dealTitle within the dealer).
    const existingRegTitles = new Set((await listRegistrations(tenantId, orgId, { dealerId: dealer.dealerId })).map((r) => r.dealTitle));
    for (const r of spec.registrations ?? []) {
      if (existingRegTitles.has(r.dealTitle)) continue;
      const reg = await createRegistration(tenantId, orgId, dealer.dealerId, { dealTitle: r.dealTitle, companyName: r.companyName });
      if (r.decision) await decideRegistration(tenantId, orgId, reg.regId, r.decision, DEMO_DEALERS_ACTOR);
      regs += 1;
    }
  }

  const details = { dealers: created, outlets, registrations: regs };
  log.info('demo_dealers_seeded', { tenantId, created: created + outlets + regs, ...details });
  return { created: created + outlets + regs, details };
}

export async function clearDemoDealers(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  const dealerIds = await demoDealerIds(tenantId, orgId);
  let cleared = 0;
  for (const id of dealerIds) {
    await deleteDealerPrmData(tenantId, orgId, id); // registrations + partner tokens
    if (await deleteDealer(tenantId, orgId, id)) cleared += 1; // cascades outlets
  }
  log.info('demo_dealers_cleared', { tenantId, cleared });
  return { cleared };
}
