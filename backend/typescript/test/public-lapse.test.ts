/**
 * ADR 0820 §7 (G9) — the owner-lapse policy helper (`host/publicLapse.ts`), and
 * the two source-level pins around it:
 *   - the LANES that apply it (a reviewed list, so a public lane cannot quietly
 *     drop the check), and
 *   - the COMPLIANCE lanes that must NEVER apply it (unsubscribe, preferences,
 *     bounce, WhatsApp STOP/START, consent capture, consent-carrying form sinks).
 * The per-lane HTTP behaviour is in `public-lapse-lanes.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { registerTenantEntitlementCheck } from '../src/host/entitlementSeam.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  PUBLIC_LAPSE_GRACE_ENV, VERDICT_TTL_MS, __resetPublicLapse, checkOwnerPublicAccess,
  ownerLapseVerdict, publicLapseGraceDays, registerEntitlementEndedAtSource,
} from '../src/host/publicLapse.js';
import { OpenwopError } from '../src/types.js';

const DAY = 86_400_000;
const SELLABLE = 'docs'; // in the content bundle on main
const T = 't-lapse';

let mode: 'ok' | 'refuse' | 'fault' = 'ok';
let calls = 0;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerTenantEntitlementCheck(async () => {
    calls++;
    if (mode === 'refuse') throw new OpenwopError('forbidden', 'Your plan (free) does not include this feature.', 403, {});
    if (mode === 'fault') throw new Error('entitlement store unreachable');
  });
});
afterAll(() => { delete process.env[PUBLIC_LAPSE_GRACE_ENV]; });
beforeEach(async () => {
  await __resetPublicLapse();
  delete process.env[PUBLIC_LAPSE_GRACE_ENV];
  mode = 'ok';
  calls = 0;
});

describe('ADR 0820 §7 — the knob', () => {
  it('unset, empty or invalid ⇒ policy OFF, and NOTHING is read (today’s behaviour, exactly)', async () => {
    mode = 'refuse';
    for (const v of [undefined, '', '  ', 'abc', '-3']) {
      if (v === undefined) delete process.env[PUBLIC_LAPSE_GRACE_ENV]; else process.env[PUBLIC_LAPSE_GRACE_ENV] = v;
      expect(publicLapseGraceDays()).toBeNull();
      expect(await ownerLapseVerdict(SELLABLE, T)).toEqual({ serve: true, reason: 'policy-off' });
    }
    expect(calls).toBe(0);
  });

  it('a number is the grace in days (0 is legal: off at the moment of lapse)', () => {
    process.env[PUBLIC_LAPSE_GRACE_ENV] = '14';
    expect(publicLapseGraceDays()).toBe(14);
    process.env[PUBLIC_LAPSE_GRACE_ENV] = '0';
    expect(publicLapseGraceDays()).toBe(0);
  });
});

describe('ADR 0820 §7 — the verdict', () => {
  beforeEach(() => { process.env[PUBLIC_LAPSE_GRACE_ENV] = '14'; });

  it('POSITIVE control: an entitled owner is served', async () => {
    expect(await ownerLapseVerdict(SELLABLE, T)).toEqual({ serve: true, reason: 'entitled' });
  });

  it('a feature in no paid bundle has nothing to lapse (core: orgs, billing)', async () => {
    // chat-widget/service-desk became sellable with ADR 0820 §8 (#4421), so the not-sellable
    // witnesses are core ids, which are unsellable before and after the reclassification.
    mode = 'refuse';
    expect((await ownerLapseVerdict('orgs', T)).reason).toBe('not-sellable');
    expect((await ownerLapseVerdict('billing', T)).reason).toBe('not-sellable');
    expect(calls).toBe(0);
  });

  it('observed clock: refused ⇒ grace from the first refusal, then lapsed after N days', async () => {
    mode = 'refuse';
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    expect(await ownerLapseVerdict(SELLABLE, T, t0)).toMatchObject({ serve: true, reason: 'grace' });
    expect(await ownerLapseVerdict(SELLABLE, T, t0 + 13 * DAY)).toMatchObject({ serve: true, reason: 'grace' });
    const late = await ownerLapseVerdict(SELLABLE, T, t0 + 14 * DAY + VERDICT_TTL_MS);
    expect(late).toMatchObject({ serve: false, reason: 'lapsed', graceEndsAt: new Date(t0 + 14 * DAY).toISOString() });
  });

  it('a registered billing source wins over the observed clock (grant ended 20 days ago ⇒ lapsed now)', async () => {
    mode = 'refuse';
    const now = Date.now();
    registerEntitlementEndedAtSource(async () => new Date(now - 20 * DAY).toISOString());
    expect(await ownerLapseVerdict(SELLABLE, T, now)).toMatchObject({ serve: false, reason: 'lapsed' });
    // …and a source that does not know falls back to the observed clock.
    registerEntitlementEndedAtSource(async () => null);
    expect(await ownerLapseVerdict(SELLABLE, 't-other', now)).toMatchObject({ serve: true, reason: 'grace' });
  });

  it('grace 0 ⇒ unavailable at the first refusal', async () => {
    process.env[PUBLIC_LAPSE_GRACE_ENV] = '0';
    mode = 'refuse';
    expect(await ownerLapseVerdict(SELLABLE, T)).toMatchObject({ serve: false, reason: 'lapsed' });
  });

  it('an entitlement FAULT serves (a billing outage must not darken every tenant’s pages)', async () => {
    process.env[PUBLIC_LAPSE_GRACE_ENV] = '0';
    mode = 'fault';
    expect(await ownerLapseVerdict(SELLABLE, T)).toEqual({ serve: true, reason: 'fault' });
  });

  it('a FAULT in the billing source serves too', async () => {
    process.env[PUBLIC_LAPSE_GRACE_ENV] = '0';
    mode = 'refuse';
    registerEntitlementEndedAtSource(async () => { throw new Error('boom'); });
    expect(await ownerLapseVerdict(SELLABLE, T)).toEqual({ serve: true, reason: 'fault' });
  });

  it('re-entitlement resets the clock, so a later lapse gets a full window', async () => {
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    mode = 'refuse';
    await ownerLapseVerdict(SELLABLE, T, t0);
    mode = 'ok';
    expect((await ownerLapseVerdict(SELLABLE, T, t0 + 20 * DAY)).reason).toBe('entitled');
    mode = 'refuse';
    const t1 = t0 + 20 * DAY + VERDICT_TTL_MS;
    expect(await ownerLapseVerdict(SELLABLE, T, t1)).toMatchObject({ serve: true, reason: 'grace', graceEndsAt: new Date(t1 + 14 * DAY).toISOString() });
  });

  it('verdicts are cached per (feature, owner) for the TTL — one entitlement read per minute on a hot lane', async () => {
    const now = Date.now();
    await ownerLapseVerdict(SELLABLE, T, now);
    await ownerLapseVerdict(SELLABLE, T, now + 1000);
    expect(calls).toBe(1);
    await ownerLapseVerdict(SELLABLE, T, now + VERDICT_TTL_MS + 1);
    expect(calls).toBe(2);
  });
});

describe('ADR 0820 §7 — checkOwnerPublicAccess (toggle + lapse)', () => {
  it('toggle OFF ⇒ unavailable even with the knob unset; ON ⇒ served', async () => {
    // No boot here, so the registry is empty: register a default for the same id.
    if (!getToggleDefault(SELLABLE)) registerToggleDefault({ id: SELLABLE, status: 'on', bucketUnit: 'tenant', salt: SELLABLE });
    const d = getToggleDefault(SELLABLE);
    if (!d) throw new Error('docs toggle default missing');
    await saveConfig({ ...d, status: 'off' }, 'test');
    expect(await checkOwnerPublicAccess(SELLABLE, T)).toEqual({ serve: false, reason: 'toggle-off' });
    await saveConfig({ ...d, status: 'on' }, 'test');
    expect(await checkOwnerPublicAccess(SELLABLE, T)).toEqual({ serve: true, reason: 'policy-off' });
  });
});

// ── source pins ──────────────────────────────────────────────────────────────
const SRC = join(__dirname, '..', 'src');
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const usesLapse = (text: string): boolean => /\b(ownerPublicRuntimeLapsed|checkOwnerPublicAccess|ownerLapseVerdict)\(/.test(text);

/** Every public runtime the gating audit named (G9). Removing one is a reviewed diff. */
const LAPSE_LANES = [
  'features/campaign-connectors/routes.ts', // pixels + conversions relay
  'features/chat-widget/publicGateway.ts',  // public widget gateway (§8.2)
  'features/commerce/routes.ts',            // storefront, product, checkout, one-click, quote accept
  'features/commerce/ucp/routes.ts',        // UCP merchant lane
  'features/dealers/routes.ts',             // partner portal
  'features/docs/docsService.ts',           // docs site + llms.txt
  'features/funnels/routes.ts',             // funnel runtime
  'features/podcasts/publicRoutes.ts',      // show/episode pages, feed.xml, audio
  'features/service-desk/widgetRoutes.ts',  // service-desk widget
  'features/webinars/formsSubmissionSink.ts', // webinar registration sink
  'middleware/customDomain.ts',             // custom-domain serving
].sort();

/** Data-subject-rights lanes: reachable whatever the owner's plan. NEVER lapsed. */
const NEVER_LAPSED = [
  'features/email/routes.ts',              // public-email unsubscribe (/u), preferences (/p), provider events
  'features/email/bounceWebhooks.ts',      // bounce/complaint ingestion
  'features/email/formsConsentSink.ts',    // a form's marketing opt-in
  'features/whatsapp/compliance.ts',       // STOP/START keyword ladder
  'features/whatsapp/whatsappService.ts',  // inbound handling that applies it
  'features/consent/routes.ts',            // public consent capture/read
  'features/consent/consentService.ts',
  'features/crm/formsSubmissionSink.ts',   // a form submission (it carries consent)
  'features/forms/routes.ts',              // the public form-submission door
];

describe('ADR 0820 §7 — source pins', () => {
  it('the set of files applying the owner-lapse policy matches the reviewed lane list', () => {
    const actual = walk(SRC)
      .map((f) => relative(SRC, f).split('\\').join('/'))
      .filter((rel) => rel !== 'host/publicLapse.ts' && usesLapse(readFileSync(join(SRC, rel), 'utf8')))
      .sort();
    expect(actual).toEqual(LAPSE_LANES);
  });

  it('compliance lanes are NEVER lapsed', () => {
    for (const rel of NEVER_LAPSED) {
      const text = readFileSync(join(SRC, rel), 'utf8'); // throws if a pinned file moved: re-pin it
      expect(usesLapse(text) || text.includes('publicLapse'), rel).toBe(false);
    }
  });
});
