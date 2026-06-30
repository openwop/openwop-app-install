/**
 * RFC 0114 — the a2ui delta transport gate is a DEDICATED, default-off production
 * lever (`OPENWOP_A2UI_DELTA_TRANSPORT`), no longer welded to the test seam. The
 * advert (`discovery.ts`) and the serving (`streams.ts`) share ONE predicate
 * (`a2uiDeltaTransportEnabled()`) so they can never drift.
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
