/**
 * R3 (the R2 deferral) — the approval card's proposal text carried a raw
 * `subjectId` and an unformatted total, reintroducing COM-G3 on the reviewer's
 * screen after the statements table had already fixed it. The proposal is the
 * ONE line a second manager reads before releasing money, so it gets the same
 * fidelity as the table: the rep's display name and a currency-formatted total.
 *
 * Both mint sites (routes approve + the ctx surface) call this ONE helper —
 * a third copy of the string is the drift this file exists to prevent.
 */
import { listMembers } from '../../host/accessControlService.js';

/** Currency-format `total`, falling back to the raw pair when the stored code
 *  is not ISO-4217-shaped (the productionService RangeError precedent). */
export function formatStatementTotal(total: number, currency: string): string {
  if (!/^[A-Za-z]{3}$/.test(currency)) return `${total} ${currency}`;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(total);
  } catch {
    return `${total} ${currency}`;
  }
}

export async function commissionProposalText(input: {
  tenantId: string;
  orgId: string;
  subjectId: string;
  period: string;
  total: number;
  currency: string;
}): Promise<string> {
  // The rep may have left or been erased — fall back to the id honestly rather
  // than failing the mint or printing an empty name.
  let who = input.subjectId;
  try {
    const member = (await listMembers(input.tenantId, input.orgId)).find((m) => m.subject === input.subjectId);
    if (member?.displayName) who = member.displayName;
  } catch { /* name resolution is best-effort; the id is still true */ }
  return `Approve commission statement for ${who} — ${input.period} (${formatStatementTotal(input.total, input.currency)})`;
}
