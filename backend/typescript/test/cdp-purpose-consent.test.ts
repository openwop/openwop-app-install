/**
 * CDP-F Phase 1 — purpose-based permitted-use (ADR 0268). `isPermittedForPurpose`
 * is a thin purpose→category adapter over the ONE `isAllowed` chokepoint: it maps
 * a business purpose to the consent category it requires, fails closed on an
 * unknown purpose, and honors the recorded consent under an active consent regime.
 *
 * Sabotage that reds it (w38 probes): dropping the `isPurpose` guard; an open
 * vocabulary; remapping analytics / advertising / marketing-sms / transactional.
 *
 * Toggle hygiene (w38): `saveConfig`'s second argument is `savedBy`, not a scope — the
 * consent toggle is GLOBAL. Each case sets the state it needs and restores the default
 * in `finally`. The unknown-purpose case runs with enforcement OFF on purpose: `isAllowed`
 * is then permissive for every category, so a `false` can ONLY come from the purpose
 * guard (with enforcement ON, the opt-in default would deny anyway and mask it).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { isPurpose, isPermittedForPurpose, recordConsent } from '../src/features/consent/consentService.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // createApp initializes the durable host-ext store the consent collection uses.
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('CDP-F isPurpose', () => {
  it('recognizes the closed purpose vocabulary and rejects the rest', () => {
    expect(isPurpose('marketing-email')).toBe(true);
    expect(isPurpose('advertising')).toBe(true);
    expect(isPurpose('transactional')).toBe(true);
    expect(isPurpose('passport')).toBe(false);
    expect(isPurpose('')).toBe(false);
  });
});

const setConsentToggle = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('consent');
  if (!def) throw new Error('consent toggle default missing');
  await saveConfig({ ...def, status }, 'test');
};

describe('CDP-F isPermittedForPurpose', () => {
  it('fails closed on an unknown purpose (never reaches consent evaluation)', async () => {
    await setConsentToggle('off');
    try {
      // positive control: enforcement OFF is permissive for a KNOWN purpose
      expect(await isPermittedForPurpose('org:pf', 'subj-1', 'analytics')).toBe(true);
      expect(await isPermittedForPurpose('org:pf', 'subj-1', 'exfiltrate-everything')).toBe(false);
    } finally {
      await setConsentToggle('off');
    }
  });

  it('maps a purpose to its category and honors the recorded consent', async () => {
    const tenantId = 'org:pf-enforce';
    // Turn consent enforcement ON (globally — see the header) so isAllowed reads the
    // record (else it's permissive); restored to the default OFF in `finally`.
    await setConsentToggle('on');
    try {
      await recordConsent({
        tenantId,
        subjectKey: 'subj-2',
        categories: { marketing: true, 'marketing.email': true, 'marketing.sms': false, analytics: false },
        source: 'test',
        legalBasis: 'consent',
      });
      expect(await isPermittedForPurpose(tenantId, 'subj-2', 'marketing-email')).toBe(true);
      expect(await isPermittedForPurpose(tenantId, 'subj-2', 'marketing-sms')).toBe(false);
      expect(await isPermittedForPurpose(tenantId, 'subj-2', 'analytics')).toBe(false);
      expect(await isPermittedForPurpose(tenantId, 'subj-2', 'transactional')).toBe(true); // necessary is always allowed
      expect(await isPermittedForPurpose(tenantId, 'subj-2', 'advertising')).toBe(true); // rides the broad marketing grant
    } finally {
      await setConsentToggle('off');
    }
  });
});
