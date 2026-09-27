/**
 * The certify scrub must not eat harness CONFIG whose name merely contains
 * "SECRET" (MEASURED 2026-09-26).
 *
 * The suite's `evidenceSecretsFromEnv` treats every `OPENWOP_*` name matching
 * KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL as a credential and scrubs its VALUE
 * everywhere in the bundle. #4128 set `OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S=60`
 * in the conformance harness; "60" is a substring of most hex digests, so the
 * scrub rewrote `discovery.sha256`, the bundle failed the vendored schema
 * (`^[0-9a-f]{64}$`), and `deploy.sh` refused to ship main.
 *
 * The value here is "0", the most adversarial choice: nearly every 64-hex
 * digest contains a 0, so a regression cannot pass by luck.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleCertification,
  canonicalJson,
  certificationScrubSecrets,
  NON_SECRET_CONFIG_ENV,
  sha256,
} from '../conformance/certify.js';

const NAME = 'OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S';
const REAL = 'OPENWOP_CERTIFY_SCRUB_PROBE_API_KEY';
const saved: Record<string, string | undefined> = { [NAME]: process.env[NAME], [REAL]: process.env[REAL] };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const document = {
  protocolVersion: '1.0',
  supportedTransports: ['rest'],
  // A value the probe secret below must be scrubbed OUT of.
  note: 'probe-credential-sk-live-7f3a9c',
};

function assemble() {
  return assembleCertification({
    document,
    discoveryUrl: 'http://127.0.0.1:1/.well-known/openwop',
    states: new Map(),
    ledger: [],
    suiteVersion: '2.40.0',
    hostName: 'openwop-workflow-engine',
    hostVersion: '0.1.0',
    requireBehavior: true,
    optedOut: [],
    now: '2026-09-26T00:00:00.000Z',
  });
}

describe('certify scrub — non-secret harness config', () => {
  it('the rotation-overlap knob is on the non-secret list (its name trips the sweep)', () => {
    expect(NON_SECRET_CONFIG_ENV).toContain(NAME);
    expect(/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(NAME), 'still name-matched; the list is load-bearing').toBe(true);
  });

  it('a numeric config value is NOT scrubbed out of discovery.sha256', () => {
    process.env[NAME] = '0';
    const { bundle } = assemble();
    const digest = (bundle as unknown as { discovery: { sha256: string } }).discovery.sha256;
    const expected = sha256(canonicalJson(document));
    expect(expected, 'non-vacuity: the digest must contain the config value').toContain('0');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(expected);
  });

  it('a REAL secret-named variable is still scrubbed (the allowlist did not open the sweep)', () => {
    process.env[NAME] = '0';
    process.env[REAL] = 'probe-credential-sk-live-7f3a9c';
    expect(certificationScrubSecrets(process.env, [])).toContain('probe-credential-sk-live-7f3a9c');
    expect(certificationScrubSecrets(process.env, [])).not.toContain('0');
    const { bundle } = assemble();
    expect(JSON.stringify(bundle)).not.toContain('probe-credential-sk-live-7f3a9c');
  });
});
