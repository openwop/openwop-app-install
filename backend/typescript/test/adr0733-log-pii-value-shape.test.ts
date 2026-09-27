/**
 * ADR 0733 — value-shaped PII at the log sink.
 *
 * The ADR 0077 P2 mask is KEY-aware: it masks the value of a field whose NAME looks like
 * PII. That leaves the case this file pins — an address embedded in the VALUE of an
 * operational field, which is where a driver/storage error actually puts it.
 *
 * These are the boundary tests the existing `pii-log-masking.test.ts` cannot be: that
 * file pins the `msg`-vs-fields boundary and stays green either way, so it would not
 * notice this invariant changing. (The trap named in the ADR 0077 correction note.)
 */
import { describe, expect, it } from 'vitest';
import { maskEmailsInText, maskPiiDeep, looksLikePiiName, EMAIL_SCANNER_SHAPE } from '../src/host/dataClassification.js';
import { sanitizeFreeText } from '../src/byok/textRedaction.js';

describe('ADR 0733 — the gap the key-aware mask cannot see', () => {
  it('the key pass alone leaves an email inside an operational field (the defect)', () => {
    expect(looksLikePiiName('error')).toBe(false);
    const out = maskPiiDeep({ error: 'unique violation: alice@example.com' }, { heuristic: true }) as Record<string, unknown>;
    expect(String(out.error)).toContain('alice@example.com');
  });

  it('the value pass masks it, and leaves the rest of the message intact', () => {
    const out = maskPiiDeep(
      { error: 'unique violation: alice@example.com' },
      { heuristic: true, values: true },
    ) as Record<string, unknown>;
    expect(String(out.error)).not.toContain('alice@example.com');
    expect(String(out.error)).toContain('unique violation:');
    expect(String(out.error)).toMatch(/pii_[0-9a-f]{10}/);
  });

  it('covers `stack`, `err` and `errorMessage` — the keys an allowlist would have missed', () => {
    const out = maskPiiDeep(
      {
        stack: 'Error: dup alice@example.com\n    at fn (x.ts:1:1)',
        err: 'bob@example.com rejected',
        errorMessage: 'carol@example.com not found',
      },
      { heuristic: true, values: true },
    ) as Record<string, string>;
    for (const v of Object.values(out)) expect(v).not.toMatch(/@example\.com/);
    expect(out.stack).toContain('at fn (x.ts:1:1)'); // substring-scoped, not whole-value
  });

  it('does NOT touch a string with no `@` (the guard that makes scanning every leaf affordable)', () => {
    const msg = 'run 42 completed in 13ms';
    expect(maskEmailsInText(msg)).toBe(msg);
  });

  it('leaves operational values alone', () => {
    const out = maskPiiDeep({ runId: 'r-1', count: 3, status: 'ok' }, { heuristic: true, values: true });
    expect(out).toEqual({ runId: 'r-1', count: 3, status: 'ok' });
  });
});

describe('ADR 0733 — the scanner is bounded (no ReDoS on the error path)', () => {
  it('is structurally incapable of the super-quadratic blowup (the assertion that cannot flake)', () => {
    // The timing test below is the headline, but a timing test on a box this repo has
    // measured at load 144 is a flake waiting to happen — and it would flake in a file
    // named after a security ADR, which is the worst place to train someone to re-run.
    // This asserts the PROPERTY that makes the blowup impossible: every quantifier is
    // bounded, so there is no nested unbounded repetition to backtrack over.
    // Strip escapes, then character classes — what remains is only quantifiers and
    // grouping. A literal `+` inside `[…._%+'-]` is NOT a quantifier, and reading it as
    // one is exactly how this assertion failed the first time it was written.
    const skeleton = EMAIL_SCANNER_SHAPE.source.replace(/\\./g, '').replace(/\[[^\]]*\]/g, 'C');
    expect(skeleton).not.toMatch(/[+*]/); // no unbounded repetition
    expect(skeleton).not.toMatch(/\{\d+,\}/); // no open-ended {n,}
    expect(EMAIL_SCANNER_SHAPE.flags).toContain('u');
  });

  it('a pathological no-dot input returns fast', () => {
    // The six in-tree ANCHORED validators, used unanchored as a scanner, take ~465ms
    // here (measured, node v22.22.3). Measured worst-of-20 for THIS scanner at load 42:
    // 8.6ms. The ceiling is set at 250ms — 29x the measurement, still 1.9x under the
    // regression it guards — rather than the original 100ms, which was ~3x margin.
    const evil = `${'a'.repeat(8000)}@${'b'.repeat(8000)}`;
    const t0 = performance.now();
    maskEmailsInText(evil);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it('an address STRADDLING the scan cap is masked whole, not reassembled across the cut', () => {
    // Review finding 1 — this test previously asserted the OPPOSITE and so pinned the
    // leak as the contract. A fixed cut put `alice@exampl` (no dot, no match) in the
    // scanned head and `e.com` in the verbatim tail, and the two concatenated back into
    // a perfectly readable address. `stack` routinely exceeds 8KB, so this was reachable.
    const out = maskEmailsInText('x'.repeat(8180) + 'alice@example.com');
    expect(out).not.toContain('alice@example.com');
    expect(out).toMatch(/pii_[0-9a-f]{10}$/);
  });

  it('still stops scanning shortly past the cap — the cost bound survives the straddle fix', () => {
    // The straddle extension must be BOUNDED or the cap means nothing. An address-char
    // run longer than one maximal address is cut anyway, leaving the rest verbatim.
    const out = maskEmailsInText(`${'x'.repeat(8100)}@${'y'.repeat(4000)}.com`);
    expect(out).toContain('y'.repeat(200)); // the far tail was never scanned
  });
});

describe('ADR 0733 — what must NOT be masked (the over-mask a default-ON scanner invites)', () => {
  it('leaves package@semver alone — this repo logs that shape constantly', () => {
    // Review finding 2. With an all-numeric final label allowed, `pkg@1.2.3` was email-
    // shaped, so `manifest_identity_mismatch: requested …@1.4.0, got …@1.4.1` became two
    // identical-looking hashes and the pin-drift lane ENG-PACKS-1 exists to debug went
    // dark. Every real TLD starts with a letter, so requiring one costs no recall.
    for (const s of [
      "Cannot find module 'typescript@5.4.2'",
      'No matching version found for vitest@1.2.3',
      'go: example.com/mod@v1.2.3: invalid version',
      'manifest_identity_mismatch: requested core.openwop.workflows.crm@1.4.0, got core.openwop.workflows.crm@1.4.1',
      'pack vendor.myndhyve.nodes@2.0.11 pinned by kt-1 is missing',
    ]) expect(maskEmailsInText(s)).toBe(s);
  });

  it('leaves wildcard pins (`@1.0.x`) alone — a ONE-letter final label is not a TLD (CLNP-5)', () => {
    // "Starts with a letter" alone still hashed these; `@a2a-js/sdk@1.0.x` is a live pin
    // string in this repo. No delegated TLD is one character.
    for (const s of [
      'sdk@1.0.x',
      'pkg@1.2.x',
      'resolved @a2a-js/sdk@1.0.x from the lockfile',
    ]) expect(maskEmailsInText(s)).toBe(s);
    // …and the boundary is exactly two: a real two-letter TLD still masks.
    expect(maskEmailsInText('a@b.io')).not.toContain('a@b.io');
  });

  it('still masks real addresses, including non-ASCII and punycode', () => {
    for (const s of [
      'alice@example.com',
      'a+t@sub.example.co.uk',
      'alice@xn--bcher-kva.example',
      'jos\u00e9@example.com', // NFC — precomposed
      'jose\u0301@example.com', // NFD — `e` + COMBINING ACUTE, why the class needs \\p{M}
      'alice@m\u00fcnchen.de',
      "o'brien@x.com",
    ]) expect(maskEmailsInText(s)).toMatch(/pii_[0-9a-f]{10}/);
  });
});

describe('ADR 0733 — object KEYS are string leaves too', () => {
  it('masks an address used as a map key (review finding 4)', () => {
    const out = maskPiiDeep({ bounces: { 'alice@example.com': 3 } }, { values: true }) as Record<string, Record<string, number>>;
    expect(Object.keys(out.bounces!)[0]).toMatch(/^pii_[0-9a-f]{10}$/);
    expect(Object.values(out.bounces!)[0]).toBe(3); // the COUNT is operational — untouched
  });

  it('leaves operational keys alone', () => {
    const out = maskPiiDeep({ runId: 'r-1', byStatus: { ok: 2 } }, { values: true });
    expect(out).toEqual({ runId: 'r-1', byStatus: { ok: 2 } });
  });
});

describe('ADR 0733 — the wire is NOT touched', () => {
  it('sanitizeFreeText still returns an email byte-identical', () => {
    // sanitizeFreeText feeds run-event payloads, a public chat-widget response body and
    // — decisively — `computeArgsHash`, an RFC 0064 replay cache-key PREIMAGE. Changing
    // it would break determinism against already-persisted hashes. The redaction added
    // by ADR 0733 lives in the LOG sink only; this asserts that boundary.
    expect(sanitizeFreeText('a@b.com')).toBe('a@b.com');
  });
});
