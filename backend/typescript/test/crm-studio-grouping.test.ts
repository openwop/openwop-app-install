import { describe, it, expect } from 'vitest';
import { crmFeature } from '../src/features/crm/feature.js';
import { emailFeature } from '../src/features/email/feature.js';
import { formsFeature } from '../src/features/forms/feature.js';
import { csmFeature } from '../src/features/csm/feature.js';
import { commerceFeature } from '../src/features/commerce/feature.js';
import { analyticsFeature } from '../src/features/analytics/feature.js';
import { documentsFeature } from '../src/features/documents/feature.js';
import { notebooksFeature } from '../src/features/notebooks/feature.js';
import { podcastsFeature } from '../src/features/podcasts/feature.js';
import { productionFeature } from '../src/features/production/feature.js';

/**
 * Locks the taxonomy carved out of the overloaded generic 'Business Tools'
 * category (companion to cdp-feature-grouping.test.ts): a customer/revenue 'CRM'
 * cluster and a content-authoring 'Studio' cluster, with the CRM sub-features
 * that genuinely import the CRM store declaring it as a hard dependency so the
 * feature-toggle console renders the coupling.
 */
describe('CRM + Studio feature grouping + dependency declaration', () => {
  it('the CRM cluster shares the one CRM category', () => {
    // commerce graduated to its own 'Commerce' section once merchandising features
    // landed (see sales-commerce-grouping.test.ts), so it's no longer here.
    // forms graduated to 'Author' as the standalone capture primitive (ADR 0330).
    for (const f of [crmFeature, emailFeature, csmFeature, analyticsFeature]) {
      expect(f.toggleDefault?.category).toBe('CRM');
    }
    expect(formsFeature.toggleDefault?.category).toBe('Author');
  });

  it('the Studio cluster shares the one Studio category', () => {
    for (const f of [documentsFeature, notebooksFeature, podcastsFeature, productionFeature]) {
      expect(f.toggleDefault?.category).toBe('Studio');
    }
  });

  it('every feature that imports the CRM store declares the hard dep', () => {
    // email already did; csm (accountsService → ../crm) and commerce
    // (commerceService/routes → ../crm) were the undeclared gaps closed earlier.
    // commerce now lives in the Commerce section but the crm hard-dep still holds.
    // forms no longer imports ../crm AT ALL (ADR 0330 — the crm-contact sink is
    // registered BY crm), so the rule's contrapositive applies: no import, no dep.
    for (const f of [emailFeature, csmFeature, commerceFeature]) {
      expect(f.dependsOn ?? []).toContain('crm');
    }
    expect(formsFeature.dependsOn ?? []).toEqual([]);
  });
});
