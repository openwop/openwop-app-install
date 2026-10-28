/**
 * The content-rules finding frame (ADR 0933 D1/D4), shared by every rule set
 * in this library. ADR 0946 P2 builds it first, for the creative rule sets;
 * ADR 0933's page and email rule sets add their `ruleSet` values here.
 *
 * - A finding's `id` is `sha256(ruleId, assetId, field, normalized span text)`,
 *   so it is stable across rescans (0933 D4).
 * - A report's `digest` is `sha256(canonical {rulesetVersion, findings})` with
 *   findings sorted by id, so a recompute at decision time can tell whether
 *   the rules changed under a review (0933 D5).
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../canonicalJson.js';

export type ContentRuleSet =
  // ADR 0933 (pages and emails)
  | 'trust' | 'regulated' | 'link' | 'policy' | 'brand' | 'consistency' | 'claims'
  // ADR 0946 D5 (creative)
  | 'channel-policy' | 'accessibility' | 'diversity' | 'fidelity' | 'brand-lock';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type FindingAction = 'block' | 'needs_review' | 'info';

export interface ContentFinding {
  id: string;
  ruleSet: ContentRuleSet;
  ruleId: string;
  severity: FindingSeverity;
  action: FindingAction;
  /** The asset (or variant member) the finding is about. */
  assetId: string;
  field: string;
  span?: { start: number; end: number; text: string };
  /** Present in the new content and absent before it. */
  introduced: boolean;
  message: string;
  recommendation?: string;
  regulatoryRef?: string;
}

export type FindingDraft = Omit<ContentFinding, 'id'>;

const normalizeSpan = (text: string | undefined): string => (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function findingId(ruleId: string, assetId: string, field: string, spanText?: string): string {
  return createHash('sha256').update(canonicalize([ruleId, assetId, field, normalizeSpan(spanText)]), 'utf8').digest('hex');
}

export function toFinding(d: FindingDraft): ContentFinding {
  return { id: findingId(d.ruleId, d.assetId, d.field, d.span?.text), ...d };
}

const ACTION_RANK: Record<FindingAction, number> = { block: 0, needs_review: 1, info: 2 };
const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** A total order on findings that share an id: strictest action, then
 *  strictest severity, then the earliest span, then the message. */
function stricterFirst(a: ContentFinding, b: ContentFinding): number {
  return ACTION_RANK[a.action] - ACTION_RANK[b.action]
    || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (a.span?.start ?? Number.MAX_SAFE_INTEGER) - (b.span?.start ?? Number.MAX_SAFE_INTEGER)
    || a.message.localeCompare(b.message);
}

/**
 * Findings sorted by id, with same-id findings MERGED deterministically
 * (a0's review of #5092): the id leaves out `introduced`, `action` and the span
 * offsets, so keeping "the first" would let the caller's order decide whether a
 * blocking finding survives. The merge keeps the strictest finding's text,
 * the strictest action and severity, the earliest span, and `introduced` if
 * any copy was introduced. The result does not depend on input order.
 */
export function normalizeFindings(findings: ContentFinding[]): ContentFinding[] {
  const byId = new Map<string, ContentFinding[]>();
  for (const f of findings) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
  const merged: ContentFinding[] = [];
  for (const group of byId.values()) {
    const ranked = [...group].sort(stricterFirst);
    const spans = group.map((f) => f.span).filter((x): x is NonNullable<ContentFinding['span']> => x !== undefined).sort((x, y) => x.start - y.start || x.end - y.end);
    merged.push({ ...ranked[0], introduced: group.some((f) => f.introduced), ...(spans[0] ? { span: spans[0] } : {}) });
  }
  return merged.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A report's `rulesetVersion` names only the rule families that ran, each
 * with its own version (a0's review of #5092, item d): `creative@…` for ADR
 * 0946's creative rules, and ADR 0933's families under their own names. A
 * change to one family never re-versions another's reports.
 */
export function rulesetVersionOf(families: Record<string, string>): string {
  return Object.keys(families).sort().map((f) => `${f}@${families[f]}`).join('+');
}

export function reportDigest(rulesetVersion: string, findings: ContentFinding[]): string {
  return createHash('sha256').update(canonicalize({ rulesetVersion, findings: normalizeFindings(findings) }), 'utf8').digest('hex');
}
