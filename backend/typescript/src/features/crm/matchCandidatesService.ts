/**
 * CRM probabilistic match candidates (ADR 0264 / CDP-B).
 *
 * A read-only candidate GENERATOR: it scores likely-duplicate contact pairs
 * (beyond the exact-email groups `crmMergeService.findDuplicateContacts` already
 * finds) and returns them for a steward to review. It NEVER merges — auto-merge
 * stays deterministic (ADR 0262 ruling #5). Pure + deterministic: the same
 * rolodex always yields the same scored candidates (replay-free, no wall-clock).
 *
 * Signals (deterministic, explainable):
 *   - a shared non-email identifier (phone/loyalty/device/…) — strong (0.95)
 *   - similar name + same company/domain — medium (0.75)
 *   - very similar name alone — weak (0.6)
 * Email exact-dupes are intentionally excluded (already covered deterministically).
 */
import { listContacts, type Contact } from './contactsService.js';
import { normalizeIdentifierValue } from './contactIdentityService.js';

export interface MatchCandidate {
  a: { contactId: string; name: string; email?: string };
  b: { contactId: string; name: string; email?: string };
  score: number; // 0..1
  reason: 'shared-identifier' | 'name+company' | 'name';
}

/** Cap the O(n²) scan — a candidate generator is advisory; a huge rolodex just
 *  surfaces the top matches within the window (logged by the caller if capped). */
const MAX_CONTACTS = 400;
const MAX_CANDIDATES = 200;
const THRESHOLD = 0.6;

function normName(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}
function normCompany(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Jaccard over name tokens (0..1). */
function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normName(a));
  const tb = new Set(normName(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** The set of non-email identifier keys a contact carries (type::normValue). */
function identifierKeys(c: Contact): Set<string> {
  const out = new Set<string>();
  for (const id of c.identifiers ?? []) {
    if (id.type === 'email') continue;
    out.add(`${id.type}::${normalizeIdentifierValue(id.type, id.value)}`);
  }
  return out;
}

function scorePair(a: Contact, b: Contact, aKeys: Set<string>, bKeys: Set<string>): MatchCandidate | null {
  // strongest: a shared non-email identifier
  for (const k of aKeys) {
    if (bKeys.has(k)) return mk(a, b, 0.95, 'shared-identifier');
  }
  const sim = nameSimilarity(a.name, b.name);
  if (sim <= 0) return null;
  const sameCompany = normCompany(a.company) !== '' && normCompany(a.company) === normCompany(b.company);
  if (sim >= 0.5 && sameCompany) return mk(a, b, Math.min(0.9, 0.6 + sim * 0.3), 'name+company');
  if (sim >= 0.8) return mk(a, b, 0.6, 'name');
  return null;
}

function mk(a: Contact, b: Contact, score: number, reason: MatchCandidate['reason']): MatchCandidate {
  const project = (c: Contact) => ({ contactId: c.contactId, name: c.name, ...(c.email ? { email: c.email } : {}) });
  return { a: project(a), b: project(b), score: Math.round(score * 100) / 100, reason };
}

/** Scored probable-duplicate pairs for a tenant (advisory; excludes exact-email
 *  dupes and same-contact pairs). Deterministically ordered: score desc, then by
 *  the pair's contactIds so the output is stable across runs. */
export async function matchCandidates(tenantId: string): Promise<{ candidates: MatchCandidate[]; scanned: number; capped: boolean }> {
  const all = (await listContacts(tenantId)).slice(0, MAX_CONTACTS);
  const keys = all.map(identifierKeys);
  const emailOf = (c: Contact) => c.email?.trim().toLowerCase() ?? '';
  const out: MatchCandidate[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      // skip exact-email dupes (deterministic path already owns them)
      if (emailOf(all[i]) && emailOf(all[i]) === emailOf(all[j])) continue;
      const c = scorePair(all[i], all[j], keys[i], keys[j]);
      if (c && c.score >= THRESHOLD) out.push(c);
    }
  }
  out.sort((x, y) => y.score - x.score || `${x.a.contactId}${x.b.contactId}`.localeCompare(`${y.a.contactId}${y.b.contactId}`));
  return { candidates: out.slice(0, MAX_CANDIDATES), scanned: all.length, capped: out.length > MAX_CANDIDATES };
}
