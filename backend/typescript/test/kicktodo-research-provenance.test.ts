/**
 * KTFULL-B7 (provenance half) — research metadata must be DERIVED, not trusted.
 *
 * The rights gate blocks by `domain` and the claim-support gate matches by
 * `hash`, but both fields arrived from the caller and were stored verbatim.
 * That made both gates decorative:
 *
 *  - declare `domain: "example.com"` for a `ted.com` URL and the blocked-domain
 *    policy never fires;
 *  - invent a `hash` and a claim can "cite" a source that does not exist.
 *
 * Both are now computed from the URL and title the source actually carries.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { evaluateGates } from '../src/features/kicktodo-creator/publishService.js';
import type { ResearchClaim } from '../src/features/kicktodo-creator/creatorService.js';
import {
  createCandidate, recordResearch, sourceHash, sourceDomain, UnparsableSourceUrlError,
} from '../src/features/kicktodo-creator/creatorService.js';
import { decideRights } from '../src/features/kicktodo-creator/publishService.js';

const T = 'tenant-provenance';

async function candidate(): Promise<string> {
  const c = await createCandidate({
    tenantId: T, topic: 'Focus', audience: 'devs', transformation: 'ship more',
    durationDaysTarget: 7, dailyMinutesTarget: 20, createdBy: 'user:author',
  });
  return c.id;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('research provenance (KTFULL-B7)', () => {
  it('ignores a spoofed domain, so the blocked-domain policy actually fires', async () => {
    const id = await candidate();
    const updated = await recordResearch(T, id, {
      questions: ['q'],
      // A blocked source wearing an innocent domain label.
      sources: [{ url: 'https://www.ted.com/talks/whatever', domain: 'example.com', title: 'T', hash: 'not-a-real-hash', engine: 'brave' }],
      claims: [],
    });

    const stored = updated!.dossier!.sources[0]!;
    expect(stored.domain).toBe('www.ted.com'); // derived from the URL, not the label

    // …and the rights gate now blocks it, which it could not do before.
    expect(decideRights(updated!.dossier!.sources)[0]!.disposition).toBe('blocked');
  });

  it('derives the citation hash, so a claim cannot cite a source that does not exist', async () => {
    const id = await candidate();
    const updated = await recordResearch(T, id, {
      questions: ['q'],
      sources: [{ url: 'https://example.org/a', domain: 'example.org', title: 'A', hash: 'claimed-hash', engine: 'brave' }],
      claims: [
        { claimId: 'c-real', text: 'supported', sourceHashes: ['claimed-hash'] },
        { claimId: 'c-fake', text: 'cites nothing', sourceHashes: ['sha256-of-nothing'] },
      ],
    });

    const stored = updated!.dossier!.sources[0]!;
    expect(stored.hash).toBe(sourceHash('https://example.org/a', 'A'));
    expect(stored.hash).not.toBe('claimed-hash');

    // The real claim is re-pointed at the derived hash and stays supported…
    expect(updated!.dossier!.claims.find((c) => c.claimId === 'c-real')!.sourceHashes).toEqual([stored.hash]);
    // …while the invented citation is reported as unsupported.
    expect(updated!.dossier!.unsupportedClaimIds).toEqual(['c-fake']);
  });

  it('rejects a URL it cannot parse rather than defaulting the domain', async () => {
    // A permissive fallback here would BE the bypass — an unparsable URL that
    // silently got domain "" would never match a blocked-domain entry.
    expect(() => sourceDomain('not a url')).toThrow(UnparsableSourceUrlError);
    expect(() => sourceDomain('javascript:alert(1)')).toThrow(UnparsableSourceUrlError);
    expect(sourceDomain('https://WWW.Ted.COM/x')).toBe('www.ted.com'); // case-normalized
  });

  it('has exactly ONE citation-hash derivation (ARCH-4)', async () => {
    // The B7 fix originally shipped a SECOND hash function beside the
    // pre-existing `sourceHash`, same input, different encoding. Two exported
    // functions that hash the same thing differently is the drift trap that
    // yields a bug the first time a stored key meets a computed one.
    const mod = await import('../src/features/kicktodo-creator/creatorService.js');
    const hashers = Object.keys(mod).filter((k) => /hash/i.test(k) && typeof (mod as Record<string, unknown>)[k] === 'function');
    expect(hashers).toEqual(['sourceHash']);
  });

  it('gives two callers citing the same source the same canonical key', async () => {
    expect(sourceHash('https://a.test/x', 'Title'))
      .toBe(sourceHash('https://a.test/x', 'Title'));
    expect(sourceHash('https://a.test/x', 'Title'))
      .not.toBe(sourceHash('https://a.test/y', 'Title'));
  });
});

/**
 * ADR 0101 Phase 4 — the dossier's refusal widened from "not a stub" to "may this
 * be STORED as evidence".
 *
 * A provider can return perfectly real search results that are nonetheless not
 * licensed to be harvested into a durable record: Google's Grounding terms
 * license the Links for display alongside the grounded answer they produced, and
 * return per-request redirect URIs rather than publisher URLs. The dossier keeps
 * refs + hashes that outlive the run and back a human's publication decision, so
 * it is exactly the wrong home for them.
 */
describe('dossier source suitability (ADR 0101 Phase 4)', () => {
  it('refuses an ANSWER-ONLY native engine even though its results are real', async () => {
    const id = await candidate();
    await expect(recordResearch(T, id, {
      questions: ['q'],
      sources: [{ url: 'https://example.org/a', domain: 'example.org', title: 'A', hash: 'h', engine: 'native:google' }],
      claims: [],
    })).rejects.toThrow(/stub\/demo|search adapter/i);
  });

  it('still refuses the stub/demo markers (the original guard is intact)', async () => {
    const id = await candidate();
    await expect(recordResearch(T, id, {
      questions: ['q'],
      sources: [{ url: 'https://example.org/a', domain: 'example.org', title: 'A', hash: 'h', engine: 'demo' }],
      claims: [],
    })).rejects.toThrow();
  });

  it('accepts a host-configured vendor and a DURABLE native engine', async () => {
    const id = await candidate();
    const updated = await recordResearch(T, id, {
      questions: ['q'],
      sources: [
        { url: 'https://example.org/a', domain: 'example.org', title: 'A', hash: 'h1', engine: 'brave' },
        { url: 'https://example.org/b', domain: 'example.org', title: 'B', hash: 'h2', engine: 'native:anthropic' },
      ],
      claims: [],
    });
    expect(updated!.dossier!.sources).toHaveLength(2);
  });
});

/**
 * ADR 0494 P2b — the claims gate now requires ENTAILMENT, not just structure.
 *
 * A claim citing a recorded, unblocked source used to pass. That is exactly the
 * "real sources applied incorrectly" case: the citation is genuine and the claim
 * still is not supported by it.
 */
describe('claims gate — entailment (ADR 0494 P2b)', () => {
  const src = { url: 'https://example.org/a', domain: 'example.org', title: 'A', hash: 'h1', engine: 'brave' };

  async function candidateWith(claim: ResearchClaim) {
    const id = await candidate();
    return (await recordResearch(T, id, { questions: ['q'], sources: [src], claims: [claim] }))!;
  }

  it('a claim whose source is judged `unrelated` does NOT satisfy the gate', async () => {
    const c = await candidateWith({
      claimId: 'c-1', text: 'unsupported', sourceHashes: [sourceHash(src.url, src.title)],
      support: [{ sourceHash: sourceHash(src.url, src.title), verdict: 'unrelated' }],
    });
    const rows = evaluateGates(c, decideRights(c.dossier!.sources));
    expect(rows.find((r) => r.gate === 'claims')!.state).toBe('open');
  });

  it('a claim judged `supports` (and agreed) DOES satisfy it', async () => {
    const h = sourceHash(src.url, src.title);
    const c = await candidateWith({
      claimId: 'c-1', text: 'supported', sourceHashes: [h],
      support: [{ sourceHash: h, verdict: 'supports', span: 'the passage', secondOpinion: 'supports' }],
    });
    const rows = evaluateGates(c, decideRights(c.dossier!.sources));
    expect(rows.find((r) => r.gate === 'claims')!.state).toBe('pass');
  });

  it('a DISPUTED pair does not carry the claim, and surfaces informationally', async () => {
    const h = sourceHash(src.url, src.title);
    const c = await candidateWith({
      claimId: 'c-1', text: 'disputed', sourceHashes: [h],
      support: [{ sourceHash: h, verdict: 'supports', span: 'p', secondOpinion: 'contradicts' }],
    });
    const rows = evaluateGates(c, decideRights(c.dossier!.sources));
    expect(rows.find((r) => r.gate === 'claims')!.state).toBe('open');
    const disputed = rows.find((r) => r.gate === 'disputed')!;
    expect(disputed.state).toBe('open');
    expect(disputed.informational, 'disagreement FLAGS for a human; it never hard-fails on its own').toBe(true);
    expect(disputed.detail).toContain('c-1');
  });

  it('BACK-COMPAT — a dossier with NO verdicts keeps the structural meaning', async () => {
    // Candidates recorded before verification existed must not retroactively fail.
    const c = await candidateWith({ claimId: 'c-1', text: 'legacy', sourceHashes: [sourceHash(src.url, src.title)] });
    const rows = evaluateGates(c, decideRights(c.dossier!.sources));
    expect(rows.find((r) => r.gate === 'claims')!.state).toBe('pass');
  });

  it('a verdict citing an UNRECORDED source is dropped on record', async () => {
    // Otherwise a fabricated pairing could look like evidence.
    const c = await candidateWith({
      claimId: 'c-1', text: 'x', sourceHashes: [sourceHash(src.url, src.title)],
      support: [{ sourceHash: 'sha256:not-recorded', verdict: 'supports', span: 'p' }],
    });
    expect(c.dossier!.claims[0]!.support).toEqual([]);
  });
});

/**
 * ADR 0494 P2c — the dossier must not record sources it never read.
 *
 * Probing real search results found `mayoclinic.org` returns **HTTP 403** to a
 * server-side fetch — a major authoritative publisher that simply will not serve
 * one. Those sources were already excluded from what a model may cite, but the
 * dossier still RECORDED them, so a human approver saw six sources when two backed
 * anything. "Found" and "read" are different facts and must look different.
 */
describe('source retrieval marking (ADR 0494 P2c)', () => {
  const readable = { url: 'https://example.org/read', domain: 'example.org', title: 'Read', hash: 'x', engine: 'brave' };
  const blocked = { url: 'https://example.org/blocked', domain: 'example.org', title: 'Blocked', hash: 'y', engine: 'brave' };

  it('marks each source read / not-read from the supplied set', async () => {
    const id = await candidate();
    const c = (await recordResearch(T, id, {
      questions: ['q'], sources: [readable, blocked], claims: [],
      readSourceHashes: [sourceHash(readable.url, readable.title)],
    }))!;
    const byUrl = Object.fromEntries(c.dossier!.sources.map((s) => [s.url, s.retrieved]));
    expect(byUrl['https://example.org/read']).toBe(true);
    expect(byUrl['https://example.org/blocked'], 'a 403 source is FOUND, not read').toBe(false);
  });

  it('NO supplied set ⇒ `retrieved` stays undefined, not guessed', async () => {
    // "Unknown" and "not read" are different. Older dossiers must not be
    // retroactively relabelled as unread.
    const id = await candidate();
    const c = (await recordResearch(T, id, { questions: ['q'], sources: [readable], claims: [] }))!;
    expect(c.dossier!.sources[0]!.retrieved).toBeUndefined();
  });

  it('the read set is re-pointed through the SAME hash map as citations', async () => {
    // A caller-supplied hash is re-derived on record; a mark keyed to the stale
    // hash would silently land on nothing.
    const id = await candidate();
    const c = (await recordResearch(T, id, {
      questions: ['q'],
      sources: [{ ...readable, hash: 'caller-supplied-stale' }], claims: [],
      readSourceHashes: ['caller-supplied-stale'],
    }))!;
    expect(c.dossier!.sources[0]!.retrieved).toBe(true);
  });
});
