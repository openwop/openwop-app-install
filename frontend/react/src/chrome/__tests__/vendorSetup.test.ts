/**
 * First-run vendor setup eligibility (day-1 UX P8 / ADR 0188) — pins:
 *  - only OAuth-CONFIGURED providers count toward a vendor group (a host with
 *    dark Connect buttons never shows the wizard);
 *  - vendor seeding follows the SSO identity, Microsoft preferred when both.
 *
 * Sabotage that turns it red: count unconfigured or non-oauth2 providers (the
 * api_key fixture carries a RECOGNIZED vendor, so only the kind check excludes it);
 * require EVERY vendor to be configured; prefer Google over Microsoft.
 */
import { describe, expect, it } from 'vitest';

import { pickVendorGroups, seedVendor } from '../VendorSetupPrompt.js';
import type { Provider } from '../../features/connections/connectionsClient.js';

function p(id: string, vendor: string | undefined, oauthConfigured: boolean, kind = 'oauth2'): Provider {
  return { id, label: id, kind, reach: 'openapi', refreshable: true, oauthConfigured, ...(vendor ? { vendor } : {}) };
}

describe('pickVendorGroups', () => {
  it('groups only configured oauth providers under recognized vendors', () => {
    const { groups, eligible } = pickVendorGroups([
      p('google', 'Google', true),
      p('gmail', 'Google', false), // unconfigured — excluded
      p('microsoft-graph', 'Microsoft 365', true),
      p('google-apikey', 'Google', true, 'api_key'), // not oauth2 — excluded even under a recognized vendor
      p('slack', 'Slack', true), // unrecognized vendor for the wizard — excluded
    ]);
    expect(eligible).toBe(true);
    expect(groups.get('Google')?.map((x) => x.id)).toEqual(['google']);
    expect(groups.get('Microsoft 365')?.map((x) => x.id)).toEqual(['microsoft-graph']);
  });

  it('ineligible when nothing is configured (never a dead wizard)', () => {
    const { eligible } = pickVendorGroups([p('google', 'Google', false), p('microsoft-graph', 'Microsoft 365', false)]);
    expect(eligible).toBe(false);
  });

  it('eligible when any ONE recognized vendor is configured', () => {
    expect(pickVendorGroups([p('google', 'Google', true), p('microsoft-graph', 'Microsoft 365', false)]).eligible).toBe(true);
  });
});

describe('seedVendor', () => {
  it('follows the SSO identity', () => {
    expect(seedVendor(['google.com'])).toBe('Google');
    expect(seedVendor(['microsoft.com'])).toBe('Microsoft 365');
    expect(seedVendor(['github.com'])).toBeNull();
    expect(seedVendor(['google.com', 'microsoft.com'])).toBe('Microsoft 365');
  });
});
