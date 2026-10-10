/**
 * ADR 0194 (#1429) — locks the toggle-console taxonomy carved out of the
 * overloaded generic 'Business Tools' category (companion to
 * cdp-feature-grouping.test.ts, sales-commerce-grouping.test.ts and the
 * no-business-tools-category.test.ts floor): a customer/revenue 'CRM' cluster and
 * a content-authoring 'Studio' cluster, plus forms' ADR 0330 graduation to
 * 'Author'. The feature-toggle console groups features by exactly this string.
 *
 * The `dependsOn: ['crm']` half this file used to carry (email/csm/commerce) is
 * owned by `feature-dependency-parity.test.ts` › "the undeclared-edge gap does not
 * silently widen (ratchet)" — removing csm's declared crm edge turns that ratchet
 * red (wave-4 grade-tests probe w4g3-sg-csm-dep-parity), and a phantom forms→crm
 * edge is refused by its "every DECLARED dependency is backed by a real import".
 *
 * SABOTAGE: recategorise crm (or documents) → the matching case is red.
 */
import { describe, it, expect } from 'vitest';
import { crmFeature } from '../src/features/crm/feature.js';
import { emailFeature } from '../src/features/email/feature.js';
import { formsFeature } from '../src/features/forms/feature.js';
import { csmFeature } from '../src/features/csm/feature.js';
import { analyticsFeature } from '../src/features/analytics/feature.js';
import { documentsFeature } from '../src/features/documents/feature.js';
import { notebooksFeature } from '../src/features/notebooks/feature.js';
import { podcastsFeature } from '../src/features/podcasts/feature.js';
import { productionFeature } from '../src/features/production/feature.js';

describe('CRM + Studio feature grouping', () => {
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
});
