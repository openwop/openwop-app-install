/**
 * ADR 0954 D5 — territories answers lead routing's "which territory?" question
 * from the client org's ACTIVE territory model and its `contact` rules (first
 * match, ADR 0272 ordering). Registered unconditionally at boot; the toggle is
 * checked per call, so a tenant with territories off routes no lead by territory.
 */
import { setLeadTerritoryResolver } from '../../host/leadTerritoryRouting.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getActiveModelId, getTerritory } from './entities/territories.js';
import { evaluateRecord, listRules } from './entities/assignment.js';

export function registerLeadTerritoryRouting(): void {
  setLeadTerritoryResolver(async (tenantId, orgId, lead) => {
    if (!(await resolveOne('territories', { tenantId }))?.enabled) return null;
    const modelId = await getActiveModelId(tenantId, orgId);
    if (!modelId) return null;
    const match = evaluateRecord(await listRules(tenantId, orgId, modelId), 'contact', lead);
    if (!match) return null;
    const territory = await getTerritory(tenantId, orgId, modelId, match.territoryId);
    return {
      territoryId: territory.territoryId,
      ruleId: match.ruleId,
      memberSubjectIds: territory.memberSubjectIds,
      ...(territory.managerSubjectId ? { managerSubjectId: territory.managerSubjectId } : {}),
    };
  });
}
