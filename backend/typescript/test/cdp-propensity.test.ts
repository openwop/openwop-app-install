/**
 * CDP-C — contact propensity scoring (ADR 0265). Reuses the priority-matrix
 * weighted-scoring engine; contact-derived so deterministic + replay-safe. A
 * recent, complete, customer-stage contact scores high; a churned, sparse, stale
 * one scores low.
 *
 * Expected values are derived independently here (weighted-sum, weights recency 4 /
 * completeness 3 / stage 5, Σw = 12), never by calling the scorer:
 *   hot  = (4·10 + 3·8 + 5·10) / 12 = 9.50   (fresh; email + 2 ids + company ⇒ 3·2+2 = 8)
 *   cold = (4·0  + 3·2 + 5·1)  / 12 = 0.92   (200 days stale ⇒ 0; email only ⇒ 2)
 *
 * Sabotage that reds it (w38 probes): the customer stage score; the churned stage
 * score; recency pinned at 10; completeness pinned at 0 (the complete-vs-sparse leg).
 */
import { describe, expect, it } from 'vitest';
import { contactPropensity } from '../src/features/crm/propensityService.js';
import type { Contact } from '../src/features/crm/contactsService.js';

function contact(over: Partial<Contact>): Contact {
  const now = new Date().toISOString();
  const base: Contact = { contactId: 'crm:x', tenantId: 't', name: 'C', stage: 'lead', customFields: {}, createdAt: now, updatedAt: now };
  return { ...base, ...over };
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
    expect(contactPropensity(hot)).toBeCloseTo(9.5, 2);
  });

  it('scores a churned, sparse, stale contact low', () => {
    const cold = contact({ stage: 'churned', updatedAt: daysAgo(200), email: 'z@x.test' });
    expect(contactPropensity(cold)).toBeCloseTo(0.92, 2);
  });

  it('a complete profile outscores a sparse one at the same stage and recency', () => {
    const sparse = contact({ stage: 'qualified' });
    const complete = contact({
      stage: 'qualified',
      email: 'c@x.test',
      company: 'Acme',
      identifiers: [{ type: 'phone', value: '+15551110001', source: 'm' }],
    });
    // sparse: (4·10 + 3·0 + 5·7)/12 = 6.25; complete: (4·10 + 3·6 + 5·7)/12 = 7.75
    expect(contactPropensity(sparse)).toBeCloseTo(6.25, 2);
    expect(contactPropensity(complete)).toBeCloseTo(7.75, 2);
  });
});
