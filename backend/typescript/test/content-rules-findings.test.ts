/**
 * The content-rules finding frame (ADR 0933 D1/D4, built by ADR 0946 P2), with
 * a0's review of #5092:
 *
 * - (b) the report digest is pinned by a GOLDEN vector. ADR 0924 D2 records a
 *   reviewer's acknowledgement against the digest, so an accidental change to
 *   canonicalization, sorting or the digest input would stale every in-review
 *   change set with `content_rules_changed`.
 * - (c) same-id findings merge order-independently, and a blocking finding is
 *   never dropped because of caller order.
 * - (d) `rulesetVersion` names only the families that ran, each with its own
 *   version.
 *
 * Sabotage: keep-first dedup reds the order case; dropping the sort from the
 * digest input reds the golden case.
 */
import { describe, expect, it } from 'vitest';
import { findingId, normalizeFindings, reportDigest, rulesetVersionOf, toFinding, type ContentFinding } from '../src/host/contentRules/findings.js';

const f = (over: Partial<ContentFinding> & Pick<ContentFinding, 'ruleId'>): ContentFinding => toFinding({
  ruleSet: 'trust', severity: 'medium', action: 'needs_review', assetId: 'asset-1', field: 'body', introduced: false,
  message: 'Limited time language.', ...over,
});

describe('content-rules finding frame', () => {
  it('ids are stable: rule, asset, field and normalized span text', () => {
    expect(findingId('trust.urgency', 'a', 'body', '  Limited   TIME ')).toBe(findingId('trust.urgency', 'a', 'body', 'limited time'));
    expect(findingId('trust.urgency', 'a', 'body', 'x')).not.toBe(findingId('trust.urgency', 'a', 'title', 'x'));
  });

  it('(b) golden digest vector', () => {
    const findings = [
      f({ ruleId: 'trust.urgency', span: { start: 4, end: 16, text: 'limited time' } }),
      f({ ruleId: 'link.https_required', ruleSet: 'link', action: 'block', severity: 'high', field: 'cta.href', message: 'Links must use https.' }),
    ];
    expect(findings.map((x) => x.id)).toEqual([
      findingId('trust.urgency', 'asset-1', 'body', 'limited time'),
      findingId('link.https_required', 'asset-1', 'cta.href'),
    ]);
    expect(reportDigest('trust@1+link@1', findings)).toBe(reportDigest('trust@1+link@1', [...findings].reverse()));
    expect(reportDigest('trust@1+link@1', findings)).toBe(GOLDEN_DIGEST);
  });

  it('(c) same-id findings merge order-independently; a block is never dropped', () => {
    const old = f({ ruleId: 'trust.urgency', introduced: false, action: 'info', severity: 'low', span: { start: 40, end: 52, text: 'limited time' }, message: 'Already on the page.' });
    const added = f({ ruleId: 'trust.urgency', introduced: true, action: 'block', severity: 'high', span: { start: 4, end: 16, text: 'Limited time' }, message: 'Introduced urgency.' });
    expect(old.id).toBe(added.id);
    const a = normalizeFindings([old, added]);
    const b = normalizeFindings([added, old]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'block', severity: 'high', introduced: true, span: { start: 4 }, message: 'Introduced urgency.' });
  });

  it('(d) rulesetVersion names only the families that ran, each versioned', () => {
    expect(rulesetVersionOf({ creative: '2026-10-20.1' })).toBe('creative@2026-10-20.1');
    expect(rulesetVersionOf({ trust: '3', creative: '2' })).toBe('creative@2+trust@3');
  });
});

// Computed independently of this module (a hand-written canonicalizer, 2026-10-20).
const GOLDEN_DIGEST = '588381e622b2120d18867f4fbb93fa2aaea8c625d5216504b0f1d287fdd90825';
