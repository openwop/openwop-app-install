/**
 * ADR 0540 D4/P3 — "the guard tests ARE the phase."
 *
 * A fabricated number, employer or date must fail CLOSED. These are written as
 * attacks rather than examples: each one is a plausible model output that a
 * prompt instruction ("do not invent metrics") would not have stopped.
 */
import { describe, expect, it } from 'vitest';
import { guardRewrite, extractVerbatim } from '../src/features/job-search/domain/tailorGuard.js';

const ORIGINAL = 'Led the billing rewrite at Northwind Systems, cutting p99 latency 40% across 12 services.';

describe('ADR 0540 D4 — a rewrite may reword', () => {
  it('accepts a pure rewording that carries no new facts', () => {
    const v = guardRewrite(
      ORIGINAL,
      'Owned the billing rewrite at Northwind Systems; drove p99 latency down 40% across 12 services.',
    );
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('accepts dropping detail — compressing is not fabricating', () => {
    expect(guardRewrite(ORIGINAL, 'Led the billing rewrite at Northwind Systems.').ok).toBe(true);
  });

  it('is not evaded by REFORMATTING the same number', () => {
    // `1,200` and `1200` are the same claim. Without normalisation a model could
    // slip a number past the guard purely by changing its punctuation, which
    // would make the whole check theatre.
    const src = 'Processed 1,200 orders per minute.';
    expect(guardRewrite(src, 'Processed 1200 orders per minute.').ok).toBe(true);
    expect(guardRewrite(src, 'Processed 1,300 orders per minute.').ok).toBe(false);
  });
});

describe('ADR 0540 D4 — a rewrite may NEVER fabricate', () => {
  it('rejects an invented metric', () => {
    const v = guardRewrite(ORIGINAL, 'Led the billing rewrite at Northwind Systems, cutting p99 latency 40% across 12 services and saving $2M annually.');
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.kind)).toContain('fabricated-number');
  });

  it('rejects an inflated metric — the most tempting single-character lie', () => {
    const v = guardRewrite(ORIGINAL, 'Cut p99 latency 90% across 12 services at Northwind Systems.');
    expect(v.ok).toBe(false);
    expect(v.violations.find((x) => x.kind === 'fabricated-number')?.token).toBe('90%');
  });

  it('rejects an employer the applicant never worked for', () => {
    const v = guardRewrite(ORIGINAL, 'Led the billing rewrite at Northwind Systems and Goldman Sachs.');
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.kind)).toContain('fabricated-employer');
  });

  it('ALLOWS a whitelisted umbrella employer — a parent company is not a fabrication', () => {
    const v = guardRewrite(ORIGINAL, 'Led the billing rewrite at Northwind Systems, a Contoso Group company.', {
      allowedEmployers: ['Contoso Group'],
    });
    expect(v.ok, v.violations.map((x) => x.token).join(', ')).toBe(true);
  });

  it('rejects a date the source never stated — even if it is TRUE', () => {
    // Dates are server-derived (D4). A correct date arriving from a model is
    // still a defect, because the PIPELINE is wrong: next time it will be wrong
    // and nothing downstream can tell the difference.
    const v = guardRewrite(ORIGINAL, 'Led the billing rewrite at Northwind Systems in 2019.');
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.kind)).toContain('fabricated-year');
  });

  it('rejects an invented month', () => {
    const v = guardRewrite(ORIGINAL, 'Shipped the billing rewrite at Northwind Systems by March.');
    expect(v.violations.map((x) => x.kind)).toContain('fabricated-date');
  });

  it('fails CLOSED — one violation invalidates the WHOLE rewrite', () => {
    // A partial accept ("keep the honest half") would ship a bullet the
    // applicant never verified, which is the outcome the guard exists to stop.
    const v = guardRewrite(ORIGINAL, 'Cut latency 40% across 12 services at Northwind Systems, saving $5M in 2021.');
    expect(v.ok).toBe(false);
    expect(v.violations.length).toBeGreaterThan(1);
  });

  it('names the offending token, so a repair pass knows what to drop', () => {
    const v = guardRewrite('Managed 3 engineers.', 'Managed 30 engineers.');
    expect(v.violations[0]?.token).toBe('30');
  });
});

describe('ADR 0540 D4 — extraction is verbatim', () => {
  it('returns fields unchanged — parsing never "improves"', () => {
    const raw = { employer: 'northwind systems', title: 'Sr. SWE', bullet: 'did  the   thing' };
    expect(extractVerbatim(raw)).toEqual(raw);
  });
});
