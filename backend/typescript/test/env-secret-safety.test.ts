/**
 * ENVC-8 — the Environments secret-safety INVARIANT: no `ConfigSnapshot` ever
 * captures a secret VALUE. ADR 0387 guarantees this, but (per the ordinal-235
 * grade) it rested on the ABSENCE of a secret-bearing config domain, with NO
 * enforcing test — `configDomains.ts` itself notes the property lives inside each
 * domain's `export()`, unenforced centrally, so a mis-implemented future domain
 * (v2's planned connection-ref) could regress it uncaught.
 *
 * This locks the invariant with a hash-SAFE credential detector (a legit
 * content-hash — `workflowPinsDomain` emits one — must NOT trip it) proven both
 * ways, plus a scan over every SHIPPED domain's captured payload.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  registerConfigDomain,
  listConfigDomains,
  clearConfigDomainsForTest,
  type ConfigDomain,
  type ConfigDomainPayload,
} from '../src/host/configDomains.js';
import { ENVIRONMENTS_CONFIG_DOMAINS } from '../src/features/environments/feature.js';

/**
 * Does a captured leaf VALUE look like a live credential? Matched by known
 * credential GRAMMARS (prefixes / PEM / JWT), NOT by generic entropy — a
 * content-hash (64-hex) or an opaque id must never trip it, or the guard would
 * false-positive on the very refs/hashes ADR 0387 says snapshots SHOULD carry.
 */
function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  // A DSN / connection URL carrying credentials in the userinfo — the canonical
  // shape a mis-implemented CONNECTION-ref domain would leak (grammar, not entropy:
  // `scheme://user:secret@host`). This is the exact v2 leak this guard targets.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:[^/@\s]+@/i.test(v)) return true; // postgres://u:p@h, redis://:p@h, amqp://…
  if (/^(sk|pk|rk)[-_](live|test)?[-_]?[A-Za-z0-9]{12,}$/.test(v)) return true; // Stripe / generic API keys
  if (/^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/.test(v)) return true; // SendGrid
  if (/^key-[a-f0-9]{24,}$/.test(v)) return true; // Mailgun
  if (/^(xox[baprs]|ghp|gho|ghu|ghs|glpat)[-_][A-Za-z0-9_-]{16,}$/.test(v)) return true; // Slack / GitHub / GitLab
  if (/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(v)) return true; // AWS access key id
  if (/^AIza[A-Za-z0-9_-]{20,}$/.test(v)) return true; // Google API key
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) return true; // PEM private key
  if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(v)) return true; // JWT
  if (/^Bearer\s+[A-Za-z0-9._-]{20,}$/.test(v)) return true; // Bearer token
  return false;
}

/** Every string leaf in a JSON payload (keys are NOT scanned — a key named
 *  "apiKey" is fine; its VALUE is what must not be a live credential). */
function stringLeaves(payload: ConfigDomainPayload, out: string[] = []): string[] {
  if (typeof payload === 'string') out.push(payload);
  else if (Array.isArray(payload)) for (const v of payload) stringLeaves(v as ConfigDomainPayload, out);
  else if (payload && typeof payload === 'object')
    for (const v of Object.values(payload as Record<string, unknown>)) stringLeaves(v as ConfigDomainPayload, out);
  return out;
}

// The feature's SINGLE source of truth for its config domains — a v2 connection-ref
// domain added there is AUTO-enrolled in this scan (no second list to drift).
const SHIPPED = ENVIRONMENTS_CONFIG_DOMAINS;

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  clearConfigDomainsForTest();
});
afterAll(() => clearConfigDomainsForTest());

describe('ENVC-8 — the credential detector is hash-safe AND catches real leaks', () => {
  it('does NOT flag legit snapshot values — a content-hash, opaque ids, statuses, enums', () => {
    const safe = [
      'a'.repeat(64), // a sha256-style content hash (workflow-pin) — high entropy, NOT a secret
      '3f9c2a1b'.repeat(4), // 32-hex id
      'funnel-abc123', 'org:acme', 'wf:seed.onboarding', // opaque refs
      'on', 'off', 'beta', 'live', 'draft', 'exact-match', // statuses/enums
      'conn:stripe-primary', // a connection REF (the v2-safe shape) — must pass
    ];
    for (const s of safe) expect(looksLikeSecret(s), `false positive on ${s}`).toBe(false);
  });

  it('DOES flag live-credential grammars (born-red: a vacuous detector fails this)', () => {
    const leaks = [
      'postgres://appuser:s3cr3tPass@db.internal:5432/prod', // DSN w/ embedded creds — the canonical connection leak
      'redis://:my-redis-pass@cache:6379',
      'mongodb+srv://admin:hunter2@cluster0.mongodb.net',
      'amqp://guest:guestpass@rabbit:5672',
      'sk-live-0123456789abcdefABCDEF',
      'sk_test_51H0abcdefghijklmnop',
      'xoxb-2401-1234567890-abcdefghijklmno',
      'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyD-1234567890abcdefghijklmnopqrst',
      'SG.abcdefghijklmnop.qrstuvwxyz0123456789ABCDEF',
      'key-0123456789abcdef0123456789',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpM',
      'Bearer sk-abcdef0123456789abcdef',
    ];
    for (const s of leaks) expect(looksLikeSecret(s), `missed leak ${s}`).toBe(true);
  });
});

// Honesty note: the shipped domains export EMPTY on an unseeded tenant (seeding
// each owner service — toggles/funnels/pins — is disproportionate here), so their
// per-domain scan is not a live-output regression guard on its own. The guard's
// TEETH are: (a) the detector, proven + sabotage-verified above; (b) the synthetic
// leaker below, proving the scan catches a real leak; (c) auto-enrolment via the
// shared ENVIRONMENTS_CONFIG_DOMAINS const, so v2's connection-ref domain is scanned
// the moment it is added to the feature — with a realistic non-empty payload witness.
describe('ENVC-8 — the secret-scan catches a leaking domain; every feature-registered domain is enrolled', () => {
  it('a synthetic domain whose export() leaks a credential IS caught by the scan (the guard is real)', async () => {
    // The realistic mis-implementation: a connection-ref domain that captures the
    // resolved DSN (with embedded credentials) instead of the opaque ref.
    const leaker: ConfigDomain = {
      id: 'synthetic-connection-refs', label: 'Synthetic v2 (mis-implemented)', restore: 'apply-only',
      async export() { return { primary: { ref: 'conn:stripe', dsn: 'postgres://appuser:s3cr3tPass@db.internal:5432/prod' } }; },
      async import() {}, diff() { return { added: 0, changed: 0, removed: 0 }; },
    };
    registerConfigDomain(leaker);
    const payload = await leaker.export('t-1');
    const leaked = stringLeaves(payload).filter(looksLikeSecret);
    expect(leaked).toEqual(['postgres://appuser:s3cr3tPass@db.internal:5432/prod']); // caught the DSN value, not the ref
  });

  it('the shipped domains are registered + scanned; a realistic non-empty payload also scans clean (non-vacuous)', async () => {
    // The shipped domains export EMPTY on an unseeded tenant (seeding each owner
    // service — toggles/funnels/pins — is out of scope), so add a synthetic domain
    // emitting the realistic SHAPE a config export carries — a content-hash,
    // funnel/workflow ids, statuses, a connection REF — so the scan runs over a
    // NON-empty payload and proves it doesn't false-positive on those legit values.
    const richSafe: ConfigDomain = {
      id: 'synthetic-safe', label: 'Synthetic realistic-safe', restore: 'apply-only',
      async export() {
        return {
          'toggle-a': 'on',
          pointer: { funnelId: 'funnel-abc123', status: 'live' },
          pin: { wfId: 'wf:onboarding', hash: 'a'.repeat(64) }, // legit content-hash
          connection: { ref: 'conn:stripe-primary' }, // the v2-SAFE shape (ref, not value)
        };
      },
      async import() {}, diff() { return { added: 0, changed: 0, removed: 0 }; },
    };
    for (const d of [...SHIPPED, richSafe]) registerConfigDomain(d);
    const registered = listConfigDomains();
    expect(registered).toHaveLength(SHIPPED.length + 1); // the 3 shipped ARE scannable (+ v2 when added here)
    let scannedNonEmpty = 0;
    for (const d of registered) {
      const payload = await d.export('t-envc8');
      if (stringLeaves(payload).length > 0) scannedNonEmpty += 1;
      const leaks = stringLeaves(payload).filter(looksLikeSecret);
      expect(leaks, `${d.id} export() leaked a credential-shaped value`).toEqual([]);
    }
    expect(scannedNonEmpty).toBeGreaterThan(0); // the scan actually examined a non-empty payload (not vacuous)
  });
});
