/**
 * ADR 0900 D2 — `reasonCode` is a closed-vocabulary log field that the PII mask cannot
 * hash, and that cannot carry free text.
 *
 * Why it exists: `jsonPayload.reason` reaches Cloud Logging as `pii_<10hex>`, so a
 * post-deploy probe cannot count refusal reasons. The hash is this host's own
 * (`team-intent-ledger/suggestions.ts` declares `reason` PII in the global union),
 * and that masking is right for the sites that put user text in `reason`.
 *
 * Driven through the REAL sink (`createLogger` → `process.stdout.write`), with
 * `reasonCode` itself declared PII first, so the pass-through is shown to be
 * structural rather than an accident of the current declarations.
 *
 * RED on 65346ee0f: the module does not exist, and without the lift in `emit()` a
 * PII-declared `reasonCode` is hashed and a free-text one is written verbatim.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/observability/logger.js';
import { LOG_REASON_CODES, isLogReasonCode } from '../src/observability/logReasonCodes.js';
import { declarePiiFields } from '../src/host/dataClassification.js';

beforeAll(() => {
  // The worst case: someone declares the field (and `reason`) PII globally.
  declarePiiFields('adr0900.probe', ['reasonCode', 'reason']);
});
afterEach(() => { vi.restoreAllMocks(); });

function capture(emitLine: () => void): Record<string, unknown> {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write);
  emitLine();
  vi.restoreAllMocks();
  const mine = lines.filter((l) => l.includes('"component":"adr0900.probe"'));
  expect(mine).toHaveLength(1);
  return JSON.parse(mine[0]!) as Record<string, unknown>;
}
const log = createLogger('adr0900.probe');

describe('ADR 0900 D2 — reasonCode survives redaction', () => {
  it('a vocabulary member is written verbatim while `reason` beside it is still hashed', () => {
    const line = capture(() => log.info('speech_seam_refused', { reasonCode: 'speech_seam_not_admitted', reason: 'speech_seam_not_admitted' }));
    expect(line.reasonCode).toBe('speech_seam_not_admitted');
    expect(String(line.reason)).toMatch(/^pii_[0-9a-f]{10}$/);
    expect(line.reasonCodeRejected).toBeUndefined();
  });
  it('every vocabulary member survives (the whole set, not one sample)', () => {
    for (const code of LOG_REASON_CODES) {
      expect(capture(() => log.info('m', { reasonCode: code })).reasonCode).toBe(code);
    }
  });
  it('absent reasonCode adds no key and no rejection flag', () => {
    const line = capture(() => log.info('m', { other: 1 }));
    expect('reasonCode' in line).toBe(false);
    expect('reasonCodeRejected' in line).toBe(false);
  });
});

describe('ADR 0900 D2 — reasonCode cannot become a PII leak', () => {
  // An untyped bag is how a value outside the vocabulary gets past `tsc`.
  const untyped = (reasonCode: unknown): Record<string, unknown> => ({ reasonCode });
  it.each([
    ['free text with an address', 'alice@example.com asked to be removed'],
    ['a person name', 'Alice Smith'],
    ['an id', 'user:7f3a9c'],
    ['a code-SHAPED value outside the set', 'keys_disabled_for_alice_smith'],
    ['a number', 42],
    ['an object', { nested: 'Alice Smith' }],
    ['an array', ['speech_seam_not_admitted']],
  ])('%s is dropped and flagged, and its value never reaches the line', (_l, value) => {
    const raw = capture(() => log.warn('m', untyped(value)));
    expect('reasonCode' in raw).toBe(false);
    expect(raw.reasonCodeRejected).toBe(true);
    const text = JSON.stringify(raw);
    expect(text).not.toContain('Alice');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('7f3a9c');
  });
  it('the vocabulary is closed, fixed snake_case literals (no id or free-text shape)', () => {
    expect(LOG_REASON_CODES.length).toBeGreaterThan(0);
    for (const code of LOG_REASON_CODES) expect(code).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
    expect(new Set(LOG_REASON_CODES).size).toBe(LOG_REASON_CODES.length);
    expect(isLogReasonCode('speech_seam_not_admitted')).toBe(true);
    expect(isLogReasonCode('Speech_Seam_Not_Admitted')).toBe(false);
    expect(isLogReasonCode(undefined)).toBe(false);
  });
  it('a NESTED reasonCode is an ordinary field: it keeps the normal passes (hashed here, being PII-declared)', () => {
    const line = capture(() => log.info('m', { details: { reasonCode: 'speech_seam_not_admitted' } }));
    expect(String((line.details as { reasonCode?: unknown }).reasonCode)).toMatch(/^pii_/);
  });
});
