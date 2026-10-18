import { describe, expect, it } from 'vitest';
import { canonicalAgentId } from '../agentIdAliases.js';

/** ADR 0763 — the SPA mirror must agree with the backend rule: the explicit map,
 *  then `isLegacyFeatureAgentId` in `backend/typescript/src/executor/agentIdAliases.ts`
 *  (a `feature.` id with an `agents` segment at index ≥ 2 that is not the last).
 *  The backend test (`adr0763-agent-id-aliases.test.ts`) pins that rule with its
 *  own ids; these cases pin the same rule here. Breaks it: a stored legacy id that
 *  no longer compares equal to its canonical id, or a non-agent id rewritten. */
describe('canonicalAgentId (SPA mirror)', () => {
  it.each([
    ['feature.crm.agents.sales-ops', 'vendor.openwop-app.crm.agents.sales-ops'],
    ['feature.commerce.buyer.agents.procurement-concierge', 'vendor.openwop-app.commerce.buyer.agents.procurement-concierge'],
    ['career-agent', 'vendor.openwop-app.career-agent.agents.default'],
    ['vendor.openwop-app.crm.agents.sales-ops', 'vendor.openwop-app.crm.agents.sales-ops'],
    ['core.openwop.agents.sdr.default', 'core.openwop.agents.sdr.default'],
    ['feature.crm.nodes.enrich', 'feature.crm.nodes.enrich'],
    ['feature.crm.agents', 'feature.crm.agents'], // `agents` is the last segment — no agent name, not an agent id
    ['host:iris', 'host:iris'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalAgentId(input)).toBe(expected);
  });
});
