/**
 * RFC 0012 — memory compaction (host-internal distill + SR-1 carry-forward).
 *
 * Exercises the helpers behind the /v1/test/memory/{seed,compact} seam:
 *   - compact collapses N seeded entries into 1 distilled entry
 *   - the distilled entry carries a well-formed `compacted-from:<id>` tag
 *   - SR-1 §D: source-side leak signatures are re-substituted with the
 *     canonical `[REDACTED:...]`, never echoed and never silently stripped
 *
 * @see RFCS/0012-memory-compaction-profile.md §B/§C/§D
 */

import { describe, expect, it, beforeAll } from 'vitest';
import {
  initInMemorySurfaces,
  seedMemoryEntry,
  compactMemory,
  listMemoryEntries,
} from '../src/host/inMemorySurfaces.js';
import { redactForCompaction } from '../src/byok/textRedaction.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TENANT = 'compaction-conformance';
const REF = 'mem_tenant:agent:rfc0012-test_longTerm';
const COMPACTED_FROM_RE = /^compacted-from:[^\s:][^\s]*$/;

beforeAll(() => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-compact-')) });
});

describe('RFC 0012 — compactMemory', () => {
  it('collapses seeded entries into one distilled, provenance-tagged entry', async () => {
    const ref = `${REF}-basic`;
    await seedMemoryEntry(TENANT, ref, { id: 'a', content: 'First.' });
    await seedMemoryEntry(TENANT, ref, { id: 'b', content: 'Second.' });
    await seedMemoryEntry(TENANT, ref, { id: 'c', content: 'Third.' });

    const result = await compactMemory(TENANT, ref);
    expect(result).not.toBeNull();
    expect(result!.sourceCount).toBe(3);
    expect(result!.sourceIds).toEqual(['a', 'b', 'c']);
    expect(result!.byteSize).toBeGreaterThan(0);
    expect(result!.outputId).toMatch(/^mem_/);

    // Sources collapsed into exactly the one archive.
    const remaining = await listMemoryEntries(TENANT, ref);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(result!.outputId);
    const provenance = remaining[0]!.tags.find((t) => t.startsWith('compacted-from:'));
    expect(provenance).toBeTruthy();
    expect(provenance!).toMatch(COMPACTED_FROM_RE);
  });

  it('returns null when there is nothing to compact', async () => {
    expect(await compactMemory(TENANT, `${REF}-empty`)).toBeNull();
  });

  it('SR-1 §D: derived content re-substitutes source leaks with [REDACTED:...]', async () => {
    const ref = `${REF}-sr1`;
    await seedMemoryEntry(TENANT, ref, { id: '1', content: 'User confirmed: [BYOK:hk_live_canary_42]' });
    await seedMemoryEntry(TENANT, ref, { id: '2', content: 'Resolved <REDACTED:db-prod-creds> outage.' });
    await seedMemoryEntry(TENANT, ref, { id: '3', content: 'Customer asked about pricing tiers.' });

    const result = (await compactMemory(TENANT, ref))!;
    expect(result.outputContent).not.toContain('[BYOK:hk_live_canary_42]');
    expect(result.outputContent).not.toContain('<REDACTED:db-prod-creds>');
    expect(result.outputContent).toMatch(/\[REDACTED:[^\]]+\]/);
  });
});

describe('RFC 0012 — redactForCompaction', () => {
  it('converts both source-leak forms + standard key shapes', () => {
    const out = redactForCompaction('a [BYOK:x] b <REDACTED:y> c sk-ant-api03-abcdefghijklmnop1234');
    expect(out).not.toContain('[BYOK:x]');
    expect(out).not.toContain('<REDACTED:y>');
    expect(out).toContain('[REDACTED:byok]');
    expect(out).toContain('[REDACTED:y]');
    expect(out).toContain('sk-***');
  });
});

/**
 * AGMEM-3 (ADR 0587 §6) — TRUST carry-forward, the symmetric half of SR-1
 * carry-forward.
 *
 * The suite above asserts the SR-1 half and the provenance tag, and the module
 * docblock named only the SR-1 half — which is exactly why the missing half read
 * as covered. The archive was built with `tags: ['compacted-from:<id>',
 * 'compacted']`, DISCARDING every source's `derived-from-untrusted` marker, so N
 * entries of which any were untrusted collapsed into ONE that `trustOf` reads as
 * TRUSTED. That re-opened, at the compaction layer, the second-order launder the
 * ADR 0038 §C review fix closed in dispatch.
 *
 * Fixing the write path (AGMEM-2) is pointless if compaction launders it — the
 * symmetric-pair rule, which is why this lands in the same change.
 */
describe('AGMEM-3 — trust is MONOTONE under compaction', () => {
  const UNTRUSTED = 'derived-from-untrusted';

  it('ONE untrusted source makes the whole archive untrusted', async () => {
    const ref = `${REF}-trust-mixed`;
    await seedMemoryEntry(TENANT, ref, { id: 't1', content: 'A trusted note.' });
    await seedMemoryEntry(TENANT, ref, { id: 't2', content: 'From a fetched page.', tags: [UNTRUSTED] });
    await seedMemoryEntry(TENANT, ref, { id: 't3', content: 'Another trusted note.' });

    const result = await compactMemory(TENANT, ref);
    expect(result).not.toBeNull();
    const rows = await listMemoryEntries(TENANT, ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags).toContain(UNTRUSTED);
    // The provenance tag is not sacrificed for it.
    expect(rows[0]!.tags.some((t) => COMPACTED_FROM_RE.test(t))).toBe(true);
  });

  it('ANTI-ROT: an all-trusted compaction stays TRUSTED (not "always untrusted")', async () => {
    const ref = `${REF}-trust-clean`;
    await seedMemoryEntry(TENANT, ref, { id: 'c1', content: 'A trusted note.' });
    await seedMemoryEntry(TENANT, ref, { id: 'c2', content: 'Another trusted note.' });

    await compactMemory(TENANT, ref);
    const rows = await listMemoryEntries(TENANT, ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags).not.toContain(UNTRUSTED);
  });

  it('the marker survives a compaction OF a compaction (no laundering by iteration)', async () => {
    const ref = `${REF}-trust-iterated`;
    await seedMemoryEntry(TENANT, ref, { id: 'i1', content: 'From a webhook.', tags: [UNTRUSTED] });
    await compactMemory(TENANT, ref);
    await seedMemoryEntry(TENANT, ref, { id: 'i2', content: 'A later trusted note.' });
    await compactMemory(TENANT, ref);

    const rows = await listMemoryEntries(TENANT, ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags).toContain(UNTRUSTED);
  });
});

/**
 * F2 (review of ADR 0587) — the OTHER half of "untrusted", on the ONE path that
 * can destroy it.
 *
 * A pre-0587 auto-extracted row carries NO tag. Its only fence is the
 * `[auto-extracted] ` content prefix, which `subjectMemory` calls "the only
 * signal they will ever have". The AGMEM-3 fix above taught compaction to carry
 * the TAG forward and stopped there, so compaction read half the question.
 *
 * That asymmetry is not merely incomplete, it is DESTRUCTIVE and irreversible:
 * `compactMemory` joins source contents, so unless the legacy row happens to be
 * first the archive no longer STARTS with the prefix — and with no tag written
 * either, the row emerges permanently TRUSTED. Every other read path in ADR 0587
 * (`trustOf`, the vector-metadata projection, `projectNote`) was taught both
 * halves; this one was not.
 *
 * The ordering pair below is the discriminator. A test that only seeded the
 * legacy row FIRST would pass against the broken code, because the prefix
 * survives the join by accident — it would assert nothing.
 */
describe('F2 — the legacy `[auto-extracted] ` prefix is honoured, and never destroyed, by compaction', () => {
  const UNTRUSTED = 'derived-from-untrusted';
  const LEGACY = '[auto-extracted] alice banks with Acme';

  it('legacy row NOT first: the join destroys the prefix, so the TAG must carry the fence', async () => {
    const ref = `${REF}-legacy-not-first`;
    // Order matters: the trusted note is seeded first, so the joined archive does
    // NOT start with the prefix. This is the case the shipped code got wrong.
    await seedMemoryEntry(TENANT, ref, { id: 'l1', content: 'A note the user typed.' });
    await seedMemoryEntry(TENANT, ref, { id: 'l2', content: LEGACY });

    const result = await compactMemory(TENANT, ref);
    expect(result).not.toBeNull();
    // Precondition of the finding, asserted rather than assumed: the prefix really
    // is gone from the derived content, so the tag is the ONLY remaining signal.
    expect(result!.outputContent.startsWith('[auto-extracted] ')).toBe(false);

    const rows = await listMemoryEntries(TENANT, ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags, 'a fenced row must not emerge from compaction trusted').toContain(UNTRUSTED);
  });

  // Deliberately a STRONGER assertion than the live defect. Under the shipped
  // tag-only code this case left the row still fenced — by accident, because the
  // prefix happened to survive the join — so it was not itself a leak. It is
  // asserted anyway because a fence that holds only for one row ordering is a
  // latent one, and the next content transform (a re-order, a summary, a
  // re-redaction) removes it silently. Both tests redden under the sabotage; only
  // the first one corresponds to data actually going wrong today.
  it('legacy row FIRST: same outcome — the fence does not depend on row order', async () => {
    const ref = `${REF}-legacy-first`;
    await seedMemoryEntry(TENANT, ref, { id: 'f1', content: LEGACY });
    await seedMemoryEntry(TENANT, ref, { id: 'f2', content: 'A note the user typed.' });

    await compactMemory(TENANT, ref);
    const rows = await listMemoryEntries(TENANT, ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags).toContain(UNTRUSTED);
  });

  it('ANTI-ROT: the prefix must be a PREFIX — a note merely mentioning it stays trusted', async () => {
    const ref = `${REF}-legacy-antirot`;
    await seedMemoryEntry(TENANT, ref, { id: 'a1', content: 'I dislike the [auto-extracted] label.' });
    await seedMemoryEntry(TENANT, ref, { id: 'a2', content: 'Another note the user typed.' });

    await compactMemory(TENANT, ref);
    const rows = await listMemoryEntries(TENANT, ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags, 'a substring match would over-fence every user note quoting the label').not.toContain(
      UNTRUSTED,
    );
  });
});
