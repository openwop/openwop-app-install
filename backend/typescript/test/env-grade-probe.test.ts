/**
 * GRADING PROBE — "Environments" (FEATURES.md ordinal 235, ADR 0387). Evidence
 * only. GREEN + CI-safe (pure `diff` — no boot, no store, no network).
 *
 * Witnesses Headline #3 (secret-safety) at the serialization boundary: a
 * ConfigDomain captures ONLY its ref/status shape, so a plaintext-secret-shaped
 * value can never survive into a snapshot / diff / content-hash. Each domain's
 * `asPayload` whitelist is exercised through the exported `diff()`:
 *   - workflowPins keeps ONLY revision HASHES (/^[0-9a-f]{16,128}$/) — a REF, never plaintext;
 *   - featureToggles keeps ONLY the status enum ('on'|'off'|'beta').
 * A non-conforming value (the shape a leaked BYOK/connection secret would take)
 * is dropped BEFORE it reaches the diff — proven by the change counts. This is
 * the born-red invariant the `/grade-code` pass flagged as untested (ENVC-8) for
 * the two shipped domains (the planned v2 connection-ref domain still needs its own).
 */
import { describe, it, expect } from 'vitest';
import { workflowPinsDomain } from '../src/features/environments/domains/workflowPinsDomain.js';
import { featureTogglesDomain } from '../src/features/environments/domains/featureTogglesDomain.js';

const VALID_HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6'; // 24 hex chars — matches HASH_RE
const SECRET = 'sk-live-PLAINTEXT-SECRET-should-never-be-captured';

describe('Environments — config-domain serialization drops non-ref values (by execution)', () => {
  it('ENVP-1: workflowPins drops a plaintext-secret-shaped value, keeps only the hash REF', () => {
    // from carries a rogue secret-shaped value alongside one valid hash; to is empty.
    const d = workflowPinsDomain.diff({ leaked: SECRET, real: VALID_HASH }, {});
    // asPayload keeps ONLY `real` (HASH_RE); `leaked` is dropped → removed === 1, not 2.
    expect(d.removed).toBe(1);
    expect(d.added).toBe(0);
    expect(d.changed).toBe(0);
  });

  it('ENVP-2: featureToggles drops a non-status (secret-shaped) value, keeps only the enum', () => {
    const d = featureTogglesDomain.diff({ leaked: SECRET, real: 'on' }, {});
    // asPayload keeps ONLY `real: 'on'`; `leaked` is dropped → removed === 1, not 2.
    expect(d.removed).toBe(1);
  });

  it('ENVP-3 (control): a valid ref/status IS captured — the whitelist admits conforming values', () => {
    expect(workflowPinsDomain.diff({}, { real: VALID_HASH }).added).toBe(1); // hash admitted
    expect(featureTogglesDomain.diff({}, { real: 'beta' }).added).toBe(1); // status admitted
  });
});
