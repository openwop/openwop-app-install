/**
 * CDP-C — contact propensity scoring (ADR 0265). Reuses the priority-matrix
 * weighted-scoring engine; contact-derived so deterministic + replay-safe. A
 * recent, complete, customer-stage contact scores high; a churned, sparse, stale
 * one scores low.
 */
import { describe, expect, it } from 'vitest';
import { contactPropensity } from '../src/features/crm/propensityService.js';
import type { Contact } from '../src/features/crm/contactsService.js';

function contact(over: Partial<Contact>): Contact {
  const now = new Date().toISOString();
  return { contactId: 'crm:x', tenantId: 't', name: 'C', stage: 'lead', customFields: {}, createdAt: now, updatedAt: now, ...over } as Contact;
}
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

describe('CDP-C contactPropensity', () => {
  it('scores a recent, complete, customer-stage contact high', () => {
    const hot = contact({
      stage: 'customer',
      updatedAt: new Date().toISOString(),
      email: 'a@x.test',
      company: 'Acme',
      identifiers: [{ type: 'phone', value: '+15551110000', source: 'm' }, { type: 'loyalty', value: 'L1', source: 'm' }],
    });
    expect(contactPropensity(hot)).toBeGreaterThanOrEqual(7);
  });

  it('scores a churned, sparse, stale contact low', () => {
    const cold = contact({ stage: 'churned', updatedAt: daysAgo(200), email: 'z@x.test' });
    expect(contactPropensity(cold)).toBeLessThanOrEqual(4);
  });

  it('is deterministic and orders hot above cold', () => {
    const hot = contact({ stage: 'customer', email: 'a@x.test', company: 'Acme', identifiers: [{ type: 'phone', value: '1', source: 'm' }] });
    const cold = contact({ stage: 'churned', updatedAt: daysAgo(120) });
    expect(contactPropensity(hot)).toBe(contactPropensity(hot)); // stable
    expect(contactPropensity(hot)).toBeGreaterThan(contactPropensity(cold));
  });
});
