/**
 * ADR 1043 RELAY-LOG-RETENTION-1 — every durable store declared under
 * `src/messaging` is CLASSIFIED for subject erasure.
 *
 * Why this file exists: the ADR 0464 coverage ratchet
 * (`subject-erasure-coverage.test.ts`) walks only `src/host`, and the feature
 * ratchet (`subject-erasure-feature-stores.test.ts`) walks only `src/features`.
 * The relay's stores live in `src/messaging`, so neither saw them, which is how
 * `messaging:inbound-claim` (a conversation id in every key) shipped with no eraser.
 * The SQL tables are classified next door, in `sql-table-erasure-classification.test.ts`.
 *
 * Population: every `new DurableCollection<…>('ns'` literal under `src/messaging`.
 * Each store lands in exactly one list:
 *  - ERASED   — the named eraser is in `EXPECTED_SUBJECT_ERASERS`, and the file
 *               that defines it calls the store-level function named here;
 *  - EXEMPT   — no subject data; carries its reason (each verified on the row type);
 *  - UNCLASSIFIED_PRE_EXISTING — not audited here; shrink-only.
 *
 * Red when: a store is in no list or two, a list names a store that is gone, the
 * pre-existing list grows, or an ERASED eraser leaves the manifest or stops
 * calling its store function.
 * Sabotage-witnessed 2026-11-04: renaming the `messaging:inbound-claim` ERASED
 * key turned the classification and stale-entry cases red. Re-witnessed
 * 2026-11-05 (/grade-tests w89) from the product side: renaming the
 * `messaging:inbound-claim` store reds the population, one-list and stale cases;
 * dropping `deleteRelayInboundClaims(` or `owners.delete(` from
 * `eraseRelayOwnerSubject`, or the eraser's manifest entry, reds the ERASED case.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_SUBJECT_ERASERS } from '../src/host/subjectEraserManifest.js';

const ROOT = join(__dirname, '..', 'src', 'messaging');

interface Erased { eraser: string; eraserFile: string; calls: string }

const ERASED = new Map<string, Erased>([
  ['messaging:relay-owner', { eraser: 'eraseRelayOwnerSubject', eraserFile: 'relayOwner.ts', calls: 'owners.delete(' }],
  ['messaging:relay-activation', { eraser: 'eraseRelayOwnerSubject', eraserFile: 'relayOwner.ts', calls: 'eraseRelayRegistrationSubject(' }],
  ['messaging:inbound-claim', { eraser: 'eraseRelayOwnerSubject', eraserFile: 'relayOwner.ts', calls: 'deleteRelayInboundClaims(' }],
]);

const EXEMPT = new Map<string, string>([
  ['messaging:relay-token-grace', 'tokenHash, relayId, tenantId, validUntil: a token digest and ids, no person'],
  ['messaging:relay-presence', 'relayId, tenantId, channel and heartbeat times: no person'],
]);

/** `lastError` is device-reported free text, not audited for contact ids. Shrink-only. */
const UNCLASSIFIED_PRE_EXISTING = new Set(['messaging:relay-egress-attempts']);
const UNCLASSIFIED_CEILING = 1;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}
const STORE_RE = /new DurableCollection(?:<[\s\S]*?>)?\s*\(\s*['"]([^'"]+)['"]/g;
const stores = new Set(walk(ROOT).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(STORE_RE)].map((m) => m[1]!)));
const lists: Array<[string, readonly string[]]> = [
  ['ERASED', [...ERASED.keys()]], ['EXEMPT', [...EXEMPT.keys()]], ['UNCLASSIFIED_PRE_EXISTING', [...UNCLASSIFIED_PRE_EXISTING]],
];

describe('src/messaging durable stores are classified for subject erasure (RELAY-LOG-RETENTION-1)', () => {
  it('scans a real population', () => {
    expect(stores.size).toBeGreaterThanOrEqual(6);
    expect(stores.has('messaging:inbound-claim')).toBe(true);
  });

  it('every store is in exactly one list', () => {
    const where = new Map<string, string[]>();
    for (const [name, list] of lists) for (const s of list) where.set(s, [...(where.get(s) ?? []), name]);
    expect([...stores].filter((s) => !where.has(s)).sort(), 'Unclassified src/messaging store(s): register a SubjectEraser, or EXEMPT with a verified reason.').toEqual([]);
    expect([...where].filter(([, ls]) => ls.length > 1).map(([s]) => s)).toEqual([]);
  });

  it('no list names a store that no longer exists', () => {
    expect(lists.flatMap(([n, l]) => l.filter((s) => !stores.has(s)).map((s) => `${n}: ${s}`))).toEqual([]);
  });

  it('the pre-existing list only shrinks', () => {
    expect(UNCLASSIFIED_PRE_EXISTING.size).toBeLessThanOrEqual(UNCLASSIFIED_CEILING);
  });

  it('an ERASED store names a manifest eraser whose file calls its store function', () => {
    const broken: string[] = [];
    for (const [ns, e] of ERASED) {
      if (!EXPECTED_SUBJECT_ERASERS.has(e.eraser)) broken.push(`${ns}: ${e.eraser} not in the manifest`);
      const src = readFileSync(join(ROOT, e.eraserFile), 'utf8');
      const at = src.indexOf(`function ${e.eraser}(`);
      const body = at < 0 ? '' : src.slice(at, src.indexOf('\n}\n', at));
      if (!body.includes(e.calls)) broken.push(`${ns}: ${e.eraser} does not call ${e.calls}`);
    }
    expect(broken).toEqual([]);
  });
});
