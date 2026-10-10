import { describe, expect, it } from 'vitest';
import { canonicalAgentId } from '../agentIdAliases.js';

/** ADR 0763 — the SPA mirror must agree with the backend rule
 *  (`backend/typescript/test/adr0763-agent-id-aliases.test.ts` pins the same cases). */
describe('canonicalAgentId (SPA mirror)', () => {
  it.each([
    ['feature.crm.agents.sales-ops', 'vendor.openwop-app.crm.agents.sales-ops'],
    ['feature.commerce.buyer.agents.procurement-concierge', 'vendor.openwop-app.commerce.buyer.agents.procurement-concierge'],
    ['career-agent', 'vendor.openwop-app.career-agent.agents.default'],
    ['vendor.openwop-app.crm.agents.sales-ops', 'vendor.openwop-app.crm.agents.sales-ops'],
    ['core.openwop.agents.sdr.default', 'core.openwop.agents.sdr.default'],
    ['feature.crm.nodes.enrich', 'feature.crm.nodes.enrich'],
    ['host:iris', 'host:iris'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalAgentId(input)).toBe(expected);
  });
});
