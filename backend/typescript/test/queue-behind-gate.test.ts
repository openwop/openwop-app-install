/**
 * ADR 0863 D8 — which backend vitest runs wait for a running gate's claim.
 * Only a FULL run outside a gate waits; everything an iterating session does
 * (a file, a `-t` pattern, watch mode) starts at once.
 */
import { describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';
import { skipReason } from './setup/queueBehindGate.js';

const full = { env: {}, filenamePattern: [], testNamePattern: undefined, watch: false, scriptExists: true };

describe('queueBehindGate — who waits', () => {
  it('a full run outside a gate waits (the only case that does)', () => {
    expect(skipReason(full)).toBeNull();
    expect(skipReason({ ...full, filenamePattern: undefined })).toBeNull();
  });

  it.each([
    ['a file filter', { filenamePattern: ['test/foo.test.ts'] }, 'targeted run (file filter)'],
    ['a -t pattern', { testNamePattern: /teardown/ }, 'targeted run (-t)'],
    ['watch mode', { watch: true }, 'watch mode'],
    ['the gate itself', { env: { OPENWOP_CI_PREFLIGHT_DONE: '1' } }, 'inside a gate'],
    ['the opt-out', { env: { OPENWOP_VITEST_NO_WAIT: '1' } }, 'OPENWOP_VITEST_NO_WAIT=1'],
    ['hosted CI', { env: { CI: 'true' } }, 'CI'],
    ['a checkout without the script', { scriptExists: false }, 'no scripts/preflight-suite.sh'],
    ['a vitest without the internal field', { filenamePatternKnown: false }, 'this vitest has no filenamePattern field (cannot tell a targeted run)'],
  ])('%s does not wait', (_label, over, reason) => {
    expect(skipReason({ ...full, ...over })).toBe(reason);
  });
});

// The setup reads vitest's INTERNAL `filenamePattern`. This goes red on the
// upgrade that drops or renames it, instead of the setup silently losing the
// ability to tell a targeted run from a full one.
describe('queueBehindGate — the vitest field it depends on', () => {
  it('a Vitest instance still declares filenamePattern', async () => {
    const v = await createVitest('test', { config: false, watch: false, include: ['no-such-file.never'] });
    try {
      expect('filenamePattern' in v).toBe(true);
    } finally {
      await v.close();
    }
  }, 60_000);
});
