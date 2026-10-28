/**
 * ADR 0954 D5 — lead routing asks territories "which territory does this lead
 * fall in, and who is in it?" through this seam, because CRM may not import
 * territories (territories depends on CRM). The territories feature registers
 * the resolver at boot; unregistered, or the territories toggle off for the
 * tenant, the answer is `null` and a `territory` routing rule matches nobody.
 */
export interface LeadForRouting {
  stage?: string;
  company?: string;
  owner?: string;
  source?: string;
  band?: string;
  score?: number;
}

export interface LeadTerritoryMatch {
  territoryId: string;
  ruleId: string;
  memberSubjectIds: readonly string[];
  managerSubjectId?: string;
}

export type LeadTerritoryResolver = (tenantId: string, orgId: string, lead: LeadForRouting) => Promise<LeadTerritoryMatch | null>;

let resolver: LeadTerritoryResolver | null = null;

export function setLeadTerritoryResolver(fn: LeadTerritoryResolver): void {
  resolver = fn;
}

export async function resolveLeadTerritory(tenantId: string, orgId: string, lead: LeadForRouting): Promise<LeadTerritoryMatch | null> {
  return resolver ? resolver(tenantId, orgId, lead) : null;
}
