/**
 * CDP-F Phase 1 — purpose-based permitted-use (ADR 0268). `isPermittedForPurpose`
 * is a thin purpose→category adapter over the ONE `isAllowed` chokepoint: it maps
 * a business purpose to the consent category it requires, fails closed on an
 * unknown purpose, and honors the recorded consent under an active consent regime.
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

describe('CDP-F isPermittedForPurpose', () => {
  it('fails closed on an unknown purpose (never reaches consent evaluation)', async () => {
    expect(await isPermittedForPurpose('org:pf', 'subj-1', 'exfiltrate-everything')).toBe(false);
  });

  it('maps a purpose to its category and honors the recorded consent', async () => {
    const tenantId = 'org:pf-enforce';
    // Turn consent enforcement ON so isAllowed reads the record (else it's permissive).
    const def = getToggleDefault('consent');
    if (def) await saveConfig({ ...def, status: 'on' }, tenantId);
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
  });
});
