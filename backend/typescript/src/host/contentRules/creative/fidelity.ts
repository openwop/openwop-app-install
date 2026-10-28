/**
 * ADR 0946 D5 — `fidelity`: folds the ADR 0945 product-fidelity verdict.
 * `fail` → block, `needs_review` → needs_review. A visual member bound to a
 * product with no verdict is needs_review: it was never checked.
 */
import { toFinding, type ContentFinding } from '../findings.js';
import type { CreativeMemberInput } from './types.js';

export function checkFidelity(m: CreativeMemberInput): ContentFinding[] {
  const base = { ruleSet: 'fidelity' as const, assetId: m.memberId, field: 'media', introduced: true };
  if (m.fidelity?.status === 'fail') {
    return [toFinding({ ...base, ruleId: 'fidelity.fail', severity: 'critical', action: 'block', message: `The product does not match its catalog record${m.fidelity.reason ? `: ${m.fidelity.reason}` : ''}.` })];
  }
  if (m.fidelity?.status === 'needs_review') {
    return [toFinding({ ...base, ruleId: 'fidelity.needs_review', severity: 'medium', action: 'needs_review', message: `Product fidelity needs a person to check${m.fidelity.reason ? `: ${m.fidelity.reason}` : ''}.` })];
  }
  if (!m.fidelity && m.productRef && (m.kind === 'image' || m.kind === 'video')) {
    return [toFinding({ ...base, ruleId: 'fidelity.unverified', severity: 'medium', action: 'needs_review', message: 'This member depicts a product but has no fidelity verdict.' })];
  }
  return [];
}
