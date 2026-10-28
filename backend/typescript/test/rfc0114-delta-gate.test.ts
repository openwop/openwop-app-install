/**
 * RFC 0114 — the a2ui delta transport gate is a DEDICATED, default-off production
 * lever (`OPENWOP_A2UI_DELTA_TRANSPORT`), no longer welded to the test seam.
 *
 * Its ONE reader today is the serving path (`routes/streams.ts:187`, `?a2uiDelta=1`
 * is honoured only when this predicate is true). The advert half this header used
 * to name is RETIRED: the v1 discovery builder was deleted (ADR 0812 P4, 4d6d53851)
 * and v2 discovery never advertises `a2uiSurface.deltaTransport` (RFC 0209 §D.15,
 * `routes/discovery.ts`). So this file pins the predicate only.
 *
 * What breaks it: accepting any truthy value (`'1'`, `'on'`) as opt-in, dropping the
 * test-seam arm, or defaulting the gate ON (probes 8fw2g1-a2-truthy / -noseam /
 * -alwayson, all witnessed in round 1).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { a2uiDeltaTransportEnabled } from '../src/host/a2uiSurfaceDelta.js';

const DELTA = 'OPENWOP_A2UI_DELTA_TRANSPORT';
const SEAM = 'OPENWOP_TEST_SEAM_ENABLED';

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('RFC 0114 — a2uiDeltaTransportEnabled() gate', () => {
  const prevDelta = process.env[DELTA];
  const prevSeam = process.env[SEAM];
  afterEach(() => {
    setEnv(DELTA, prevDelta);
    setEnv(SEAM, prevSeam);
  });

  it('is OFF by default (both env unset) — dark in prod', () => {
    setEnv(DELTA, undefined);
    setEnv(SEAM, undefined);
    expect(a2uiDeltaTransportEnabled()).toBe(false);
  });

  it('is ON via the dedicated lever ALONE, without the test seam', () => {
    setEnv(DELTA, 'true');
    setEnv(SEAM, undefined);
    expect(a2uiDeltaTransportEnabled()).toBe(true);
  });

  it('is ON via the test seam alone (witness path stays working)', () => {
    setEnv(DELTA, undefined);
    setEnv(SEAM, 'true');
    expect(a2uiDeltaTransportEnabled()).toBe(true);
  });

  it('only "true" (not "1"/"on") flips the dedicated lever — explicit opt-in', () => {
    setEnv(SEAM, undefined);
    setEnv(DELTA, '1');
    expect(a2uiDeltaTransportEnabled()).toBe(false);
    setEnv(DELTA, 'on');
    expect(a2uiDeltaTransportEnabled()).toBe(false);
    setEnv(DELTA, 'true');
    expect(a2uiDeltaTransportEnabled()).toBe(true);
  });
});
