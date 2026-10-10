/**
 * ADR 0820 §7 — Campaign brief's READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * Hooks are listed uncapped (`listAllHooks`); the UI list caps at 200.
 */
import { listBriefVersions, listBriefs } from './briefService.js';
import { listPersonas } from './personaService.js';
import { listAllHooks } from './hookBankService.js';
import { listAngles } from './angleService.js';
import { listVocEvidence } from './vocService.js';
import { listTargetingPacks } from './targetingService.js';
import { collectPerOrg, type FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportCampaignBriefData(tenantId: string): Promise<FeatureDataSections> {
  const briefs = await listBriefs(tenantId);
  const versions: unknown[] = [];
  const angles: unknown[] = [];
  const vocEvidence: unknown[] = [];
  const targetingPacks: unknown[] = [];
  for (const b of briefs) {
    versions.push(...await listBriefVersions(tenantId, b.id));
    angles.push(...await listAngles(tenantId, b.id));
    vocEvidence.push(...await listVocEvidence(tenantId, b.id));
    targetingPacks.push(...await listTargetingPacks(tenantId, b.id));
  }
  return {
    briefs, versions, angles, vocEvidence, targetingPacks,
    personas: await listPersonas(tenantId),
    hooks: await collectPerOrg(tenantId, (orgId) => listAllHooks(tenantId, orgId)),
  };
}
