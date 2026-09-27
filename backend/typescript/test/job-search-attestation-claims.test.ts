/**
 * ADR 0544 P1 — every claim traces to a record; a fabricated claim is
 * unrepresentable; counts are frozen at issuance.
 *
 * The last one is the subtle requirement. If counts were recomputed at read, an
 * application sent tomorrow would silently change a claim an employer relied on
 * today — which is not a stale number, it is a different statement made under
 * the same signature.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaimSet, claimsAreBacked, type Claim } from '../src/features/job-search/attestation/claims.js';
import { createApplyGrant, consumeSubmit } from '../src/host/applyGrant.js';
import { listChain } from '../src/host/auditChainService.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const TENANT = 'user:t-attest';
const CAMPAIGN = 'camp-1';

const mint = () =>
  createApplyGrant({
    tenantId: TENANT, orgId: 'org-1', subjectId: 'subj-1', grantedBy: 'user-authoriser',
    campaignId: CAMPAIGN, maxSubmits: 20, maxPrepared: 5, ratePerHour: 4,
    origins: ['boards.example.com'], resumePolicy: 'default',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

describe('ADR 0544 D1 — only facts the host can prove', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('attests WHO authorised the campaign, its policy and volume', async () => {
    const g = await mint();
    const set = await buildClaimSet(TENANT, CAMPAIGN, Date.now());
    const auth = set.claims.find((c) => c.type === 'authorised-by-person');
    expect(auth).toBeTruthy();
    expect((auth as Extract<Claim, { type: 'authorised-by-person' }>).grantedBy).toBe('user-authoriser');
    expect(auth?.source).toEqual({ kind: 'grant', grantId: g.grantId });
  });

  it('counts applications in the CAMPAIGN WINDOW, from the audit chain', async () => {
    const g = await mint();
    for (let i = 0; i < 3; i += 1) await consumeSubmit(TENANT, g.grantId, Date.now(), `deal:${i}`);
    const set = await buildClaimSet(TENANT, CAMPAIGN, Date.now());
    const count = set.claims.find((c) => c.type === 'applications-in-window');
    expect((count as Extract<Claim, { type: 'applications-in-window' }>).count).toBe(3);
    // Scoped to the campaign window, never a lifetime total (D2): a figure that
    // only grows is a countdown, not a signal.
    expect((count as Extract<Claim, { type: 'applications-in-window' }>).windowStart).toBeTruthy();
  });

  it('every claim carries a SOURCE that still resolves', async () => {
    const g = await mint();
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    const set = await buildClaimSet(TENANT, CAMPAIGN, Date.now());
    expect(set.claims.length).toBeGreaterThan(0);
    for (const c of set.claims) expect(c.source, `${c.type} has no source`).toBeTruthy();
    expect(await claimsAreBacked(TENANT, set)).toBe(true);
  });

  it('a claim whose audit row was TAMPERED no longer verifies', async () => {
    // The point of a hash chain: a source reference is checkable, not decorative.
    const g = await mint();
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    const set = await buildClaimSet(TENANT, CAMPAIGN, Date.now());
    const forged = {
      ...set,
      claims: set.claims.map((c) =>
        c.source.kind === 'audit' ? { ...c, source: { ...c.source, entryHash: 'deadbeef' } } : c,
      ),
    };
    expect(await claimsAreBacked(TENANT, forged), 'a mismatched hash must not verify').toBe(false);
  });

  it('another campaign’s applications are NOT counted', async () => {
    const g = await mint();
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    const other = await buildClaimSet(TENANT, 'camp-elsewhere', Date.now());
    expect(other.claims.find((c) => c.type === 'applications-in-window')).toBeUndefined();
  });
});

describe('ADR 0544 D1 — fabrication is unrepresentable', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('the builder takes NO claim, count or assertion from its caller', () => {
    // Structural: its inputs are a tenant, a campaign and a clock. Everything
    // else is READ. There is no argument through which a caller could ask for a
    // claim the records do not support.
    const src = readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'attestation', 'claims.ts'), 'utf8');
    expect(src).toMatch(/buildClaimSet\(\s*\n?\s*tenantId: string,\s*\n?\s*campaignId: string,\s*\n?\s*now: number,?\s*\n?\)/);
  });

  it('emits NOTHING when there are no records — silence, not an empty boast', async () => {
    // A campaign that never ran must attest nothing at all. Returning a
    // zero-count claim would still be a claim, and an employer would read it.
    const set = await buildClaimSet(TENANT, 'never-ran', Date.now());
    expect(set.claims).toEqual([]);
  });

  it('never emits `human-reviewed` for an autopilot submission', async () => {
    // The correction ADR 0544 records: asserting review unconditionally would
    // make the claim MOST likely to be checked the one MOST likely to be false.
    // Nothing in this path can produce it, because no human decided.
    const g = await mint();
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    const set = await buildClaimSet(TENANT, CAMPAIGN, Date.now());
    expect(set.claims.some((c) => c.type === 'human-reviewed')).toBe(false);
  });

  it('attests nothing SUBJECTIVE — the vocabulary has no room for it', () => {
    // Assert over the CLAIM TYPE UNION, not the file text. The header explains
    // what must not be attested and names those very words, so a text scan
    // flags the documentation written to prevent the mistake — the fourth time
    // this session I have made that exact error. Reading the type is also the
    // stronger check: it is what actually constrains what can be emitted.
    const src = readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'attestation', 'claims.ts'), 'utf8');
    const union = /export type Claim =([\s\S]*?);\n/.exec(src)?.[1] ?? '';
    expect(union.length, 'the Claim union was not found — this assertion would be vacuous').toBeGreaterThan(50);
    for (const word of ['strongMatch', 'motivated', 'qualityScore', 'trustScore', 'rating', 'score']) {
      expect(union, `${word} would be a judgement wearing a number's clothing`).not.toContain(word);
    }
    // …and every variant it DOES allow carries a source.
    expect((union.match(/source: SourceRef/g) ?? []).length).toBe((union.match(/\{ type:/g) ?? []).length);
  });
});

describe('ADR 0544 matrix row 9 — counts are FROZEN at issuance', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('a later application does not change an already-issued set', async () => {
    const g = await mint();
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    const issued = await buildClaimSet(TENANT, CAMPAIGN, Date.now());
    const before = (issued.claims.find((c) => c.type === 'applications-in-window') as { count: number }).count;

    // …time passes, more applications go out…
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:2');
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:3');

    const stillBefore = (issued.claims.find((c) => c.type === 'applications-in-window') as { count: number }).count;
    expect(stillBefore, 'an issued set must be a snapshot, not a live query').toBe(before);

    // A NEW set naturally sees the new total — the freeze is per issuance.
    const reissued = await buildClaimSet(TENANT, CAMPAIGN, Date.now());
    expect((reissued.claims.find((c) => c.type === 'applications-in-window') as { count: number }).count).toBe(3);
  });

  it('records its own issuedAt, so a reader can judge staleness', async () => {
    const set = await buildClaimSet(TENANT, CAMPAIGN, Date.parse('2026-03-01T00:00:00.000Z'));
    expect(set.issuedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('the audit chain it reads is append-only and hash-linked', async () => {
    const g = await mint();
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    const chain = await listChain(TENANT);
    expect(chain.length).toBeGreaterThan(1);
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]!.prevHash, 'the chain must link, or a source ref proves nothing').toBe(chain[i - 1]!.entryHash);
    }
  });
});
