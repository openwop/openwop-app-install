/**
 * ADR 0338 §D3 — submission sinks run in REGISTRATION order, and the
 * email-consent sink reads the contactId marker the crm-contact sink writes,
 * so `crmFeature` MUST register before `emailFeature` in BACKEND_FEATURES.
 * If this pin fails, form email opt-ins silently skip (no grant recorded) —
 * an innocent reordering/alphabetization would break consent capture with no
 * error anywhere. Architect-review finding (2026-07-10).
 */
import { describe, expect, it } from 'vitest';
import { BACKEND_FEATURES } from '../src/features/index.js';

describe('feature registration order (ADR 0338 §D3)', () => {
  // FRMWF-7 / ADR 0648 D5 — `service-desk/intake.ts` reads the CRM sink's
  // `contactId` marker with the comment "registered before us". That held only
  // by array POSITION (crm ~2nd, service-desk ~117th); an alphabetization of
  // BACKEND_FEATURES would silently degrade every form-sourced ticket to the
  // slower email-lookup fallback with zero red. Pinned, like `crm < email` below.
  it('crm registers before service-desk — the ticket sink reuses the contactId marker', () => {
    const ids = BACKEND_FEATURES.map((f) => f.id);
    const crm = ids.indexOf('crm');
    const sd = ids.indexOf('service-desk');
    expect(crm, 'crm must be registered').toBeGreaterThanOrEqual(0);
    expect(sd, 'service-desk must be registered').toBeGreaterThanOrEqual(0);
    expect(crm).toBeLessThan(sd);
  });

  it('crm registers before email — the consent sink depends on the contactId marker', () => {
    const ids = BACKEND_FEATURES.map((f) => f.id);
    const crm = ids.indexOf('crm');
    const email = ids.indexOf('email');
    expect(crm).toBeGreaterThanOrEqual(0);
    expect(email).toBeGreaterThanOrEqual(0);
    expect(crm).toBeLessThan(email);
  });
});

describe('the registry has no undefined entry (import-cycle tripwire)', () => {
  // MEASURED 2026-09-23: adding an import from `host/superadmin.ts` (which most
  // feature modules import) to `middleware/auth.ts` (which imports a feature
  // module) closed a cycle, and `BACKEND_FEATURES` ended up holding an
  // `undefined`. Nothing named the cycle: it surfaced as
  // `strategy-cross-org` dying on "Cannot read properties of undefined (reading
  // 'requiredPacks')" inside createApp, one layer from the cause. A registry of
  // module references is exactly where a cycle lands first, so assert it here.
  it('every BACKEND_FEATURES entry is a real feature with an id', () => {
    const bad = BACKEND_FEATURES.map((f, i) => [i, f] as const).filter(([, f]) => !f || typeof f.id !== 'string' || f.id.length === 0);
    expect(bad.map(([i]) => i), 'an undefined/id-less entry means a module was still initialising when the array was built — an import cycle').toEqual([]);
    expect(BACKEND_FEATURES.length).toBeGreaterThan(100);
  });
});
