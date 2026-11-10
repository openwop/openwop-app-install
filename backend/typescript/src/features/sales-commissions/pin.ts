/**
 * The commission review card's pin and the ONE submit path (ADR 1034 D5).
 *
 * R2 COM2-B4 pinned `{ total, currency }`, so the reviewer approved a figure but not what
 * produced it. A rep who lowered their own quota split fired the top accelerator, the
 * total rose, and the card could not say why. The pin now also carries the attainment and
 * a digest of the lines (deal, exact deal amount, exact rate, exact commission), so a
 * change to any of them after the card was shown makes the approval stale.
 *
 * The re-pin rule used to live twice (`routes.ts` `repinOrKeep` and an inline copy in
 * `surface.ts`); both lanes now call `submitStatementForReview`.
 */

import { createHash } from 'node:crypto';
import {
  createCommissionStatementApproval,
  findPendingCommissionStatementApproval,
  resolveApproval,
  type PendingApproval,
} from '../../host/approvalService.js';
import { listStatements, recordStatementSubmitter, getStatementRaw, type CommissionStatement } from './entities/statement.js';
import { listPlans } from './entities/plan.js';
import { rateMicros } from './entities/money.js';
import { commissionProposalText } from './proposalText.js';

type Pin = NonNullable<PendingApproval['commissionStatement']>;

/** sha256 over the canonical lines: deal, exact deal minor units, exact rate micros,
 *  exact commission minor units. Rows from before D7 have no minor fields; `null` keeps
 *  them digestible (and such a statement's next recompute adds them). */
export function lineDigest(s: Pick<CommissionStatement, 'lines'>): string {
  const canonical = s.lines.map((l) => [l.dealId, l.dealAmountMinor ?? null, rateMicros(l.rate).toString(), l.commissionMinor ?? null]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Does a card's pin still describe this statement? A pin with no `lineDigest` was minted
 *  before D5 and cannot vouch for the lines, so it never matches (re-submit). */
export function pinMatches(pin: Pin | undefined, s: CommissionStatement): boolean {
  return pin !== undefined
    && pin.lineDigest !== undefined
    && pin.total === s.total
    && pin.currency === s.currency
    && pin.attainmentPct === s.attainmentPct
    && pin.lineDigest === lineDigest(s);
}

/** Other plans with an approved or paid statement over one of these deals (stacking),
 *  named by plan name and period ONLY: a statement id embeds its rep (architect H6). */
async function stackingNote(s: CommissionStatement): Promise<string> {
  const dealIds = new Set(s.lines.map((l) => l.dealId));
  const others = (await listStatements(s.tenantId, s.orgId, {}, true, undefined))
    .filter((o) => o.planId !== s.planId && o.status !== 'draft' && o.lines.some((l) => dealIds.has(l.dealId)));
  if (others.length === 0) return '';
  const names = new Map((await listPlans(s.tenantId, s.orgId)).map((p) => [p.planId, p.name]));
  const labels = [...new Set(others.map((o) => `${names.get(o.planId) ?? 'a deleted plan'} (${o.period})`))].slice(0, 5);
  return ` Some of these deals are also paid under: ${labels.join(', ')}.`;
}

/** What drives the money, said on the card: attainment and each distinct rate. */
function drivers(s: CommissionStatement): string {
  const rates = [...new Set(s.lines.map((l) => l.rate))];
  const att = s.attainmentPct === undefined ? 'no quota attainment' : `quota attainment ${Math.round(s.attainmentPct * 10) / 10}%`;
  return ` Based on ${att}${rates.length > 0 ? `; rate${rates.length > 1 ? 's' : ''} ${rates.join(', ')}` : ''}.`;
}

/**
 * Submit a DRAFT statement for review — the route and the workflow surface both call this.
 * Stamps the submitter (when there is a person), closes a card whose pin no longer matches,
 * reuses one that does, and otherwise mints a fresh card pinned to the whole statement.
 */
export async function submitStatementForReview(tenantId: string, orgId: string, statement: CommissionStatement, submitter: string | undefined): Promise<PendingApproval> {
  if (submitter) await recordStatementSubmitter(tenantId, orgId, statement.statementId, submitter);
  // Re-read after the stamp so the pin describes the row as it now stands.
  const s = (await getStatementRaw(tenantId, orgId, statement.statementId)) ?? statement;
  const existing = await findPendingCommissionStatementApproval(tenantId, s.statementId);
  if (existing && pinMatches(existing.commissionStatement, s)) return existing;
  if (existing) await resolveApproval(existing.approvalId, { status: 'rejected', note: 'Superseded: the statement was recomputed before it was approved.' });
  const base = await commissionProposalText({ tenantId, orgId, subjectId: s.subjectId, period: s.period, total: s.total, currency: s.currency });
  return createCommissionStatementApproval({
    tenantId, orgId, statementId: s.statementId,
    subjectId: s.subjectId, period: s.period, total: s.total, currency: s.currency,
    ...(s.attainmentPct !== undefined ? { attainmentPct: s.attainmentPct } : {}),
    lineDigest: lineDigest(s),
    proposal: `${base}.${drivers(s)}${await stackingNote(s)}`,
  });
}
