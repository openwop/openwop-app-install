/**
 * ADR 0855 D3 — the re-sync CHECKPOINT. When the team has fallen behind the
 * ledger — someone who has looked at it is `acceptedSinceSeen` or more accepted
 * changes behind, or `pending` proposals are waiting for the owner — the
 * project's conversations get ONE "what changed" summary asking the team to
 * confirm the current intent on the Ledger tab (confirming = "Mark as seen",
 * ADR 0831 D1). At most one per project per day. Deterministic: no model call.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { postProjectNotice } from '../../host/projectConversations.js';
import { getProject } from '../projects/projectsService.js';
import { listDeltas, seenRows } from './ledgerStore.js';
import type { TeamLedger } from './types.js';

export const RESYNC = { acceptedSinceSeen: 5, pending: 10, listed: 5 } as const;
const last = new DurableCollection<{ key: string; tenantId: string; day: string }>('team-ledger:resync', (r) => r.key, undefined, (r) => r.tenantId);
const today = (): string => new Date().toISOString().slice(0, 10);

export async function maybeResync(ledger: TeamLedger): Promise<boolean> {
  const all = await listDeltas(ledger.tenantId, ledger.ledgerId);
  const pending = all.filter((d) => d.status === 'proposed').length;
  const seen = await seenRows(ledger.tenantId, ledger.ledgerId);
  const lowest = seen.length > 0 ? Math.min(...seen.map((r) => r.version)) : 1;
  const behind = ledger.version - lowest;
  if (behind < RESYNC.acceptedSinceSeen && pending < RESYNC.pending) return false;
  const key = `${ledger.tenantId}:${ledger.ledgerId}`;
  const prev = await last.get(key);
  if (prev?.day === today()) return false;
  const project = await getProject(ledger.tenantId, ledger.scope.id);
  if (!project) return false;
  await last.put({ key, tenantId: ledger.tenantId, day: today() });
  const changed = all
    .filter((d) => d.status === 'accepted' && (d.resultVersion ?? 0) > lowest)
    .sort((a, b) => (b.resultVersion ?? 0) - (a.resultVersion ?? 0))
    .slice(0, RESYNC.listed)
    .map((d) => `• v${d.resultVersion}: ${d.why}`);
  const lines = [
    `The team ledger for “${project.name}” is at version ${ledger.version}: ${behind} accepted change${behind === 1 ? '' : 's'} since some of you last looked${pending ? `, and ${pending} waiting for the owner` : ''}.`,
    ...changed,
    'Please open the Ledger tab and confirm the current intent (Mark as seen).',
  ];
  await postProjectNotice(ledger.tenantId, project.id, lines.join('\n'), { source: 'ledger-resync', link: `/projects/${encodeURIComponent(project.id)}?tab=ledger` });
  return true;
}
