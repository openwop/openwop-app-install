/**
 * ADR 0605 Tier 1 — the destructive-diff class (`KSC-1` / `KSC-3` / `KSC-5` /
 * `KSWF-3`), which the feature-31 assessment measured as **1200 known files →
 * 200 KB documents deleted**.
 *
 * ONE wound, three routes in: a `200 OK` whose body is not JSON, the
 * `MAX_LIST_FILES` cap truncating mid-folder, and a page-token chain that breaks
 * partway. All three used to produce a listing that was SHORTER than the folder
 * with no way for the caller to know, and `diffFolder` correctly reads an absent
 * file as a deleted one.
 *
 * WHERE THE CURE IS, and where it deliberately is NOT. `diffFolder` is pure and
 * its semantics are RIGHT — pruning a genuinely empty folder is the product
 * rule, and `knowledge-sync.test.ts`'s *"an empty folder prunes all known files"*
 * is a CORRECT test that must stay green. So nothing here changes the diff. The
 * cure is at the FETCH BOUNDARY: a listing now carries, explicitly, whether it
 * is the whole folder, and `diffFolderListing` — the one composition owner —
 * refuses to emit `toPrune` unless it is.
 *
 * Each test below is a WITNESS: it fails against the pre-ADR-0605 code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

vi.mock('../src/host/brokeredEgress.js', () => ({ brokeredFetch: vi.fn() }));
import { brokeredFetch } from '../src/host/brokeredEgress.js';
import { listFolder, boxDrained, MAX_LIST_FILES } from '../src/host/knowledgeSourceFetch.js';
import {
  diffFolder, diffFolderListing, syncDocumentId,
  type RemoteFile, type SyncFileState,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';
import type { Storage } from '../src/storage/storage.js';

const mFetch = vi.mocked(brokeredFetch);
const deps = { storage: {} as Storage, tenantId: 't1', actingUserId: 'user:a', orgId: 'org1' };

/** A transport-SUCCESS whose body is arbitrary text. */
const sentRaw = (body: string) =>
  ({ outcome: 'sent' as const, res: { ok: true, status: 200, text: async () => body } as unknown as Response });
const sent = (body: unknown) => sentRaw(JSON.stringify(body));

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(() => mFetch.mockReset());
afterEach(() => vi.clearAllMocks());

const rf = (fileId: string): RemoteFile => ({ fileId, name: `${fileId}.txt`, mimeType: 'text/plain', revision: 'r1' });
const st = (fileId: string): SyncFileState =>
  ({ sourceId: 'S', externalFileId: fileId, documentId: syncDocumentId('S', fileId), revision: 'r1' });

// ── route 1: a 200 with a body that is not JSON ──────────────────────────────

describe('KSC-1 — a success status with an unparseable body must THROW, never degrade to []', () => {
  // Before: `readJson` returned `undefined` → `files = []` → every prior state
  // classified DELETED. The four providers below are the four independent listers.
  for (const [provider, folder] of [
    ['google', 'FOLDER1'],
    ['microsoft-graph', 'root'],
    ['dropbox', '/Reports'],
    ['box', 'root'],
  ] as const) {
    it(`${provider}: an HTML error page behind a 200 is a typed failure, not an empty folder`, async () => {
      mFetch.mockResolvedValue(sentRaw('<html><body>Gateway timeout</body></html>') as never);
      await expect(listFolder(deps, provider, folder)).rejects.toMatchObject({ httpStatus: 502 });
    });
  }

  it('the thrown error names the cause rather than reporting success-with-empty', async () => {
    mFetch.mockResolvedValue(sentRaw('not json at all') as never);
    await expect(listFolder(deps, 'google', 'F')).rejects.toThrow(/not JSON/i);
  });

  it('a well-formed EMPTY folder is still reported COMPLETE (the honest empty case survives)', async () => {
    // The fix must not turn "the folder really is empty" into a failure — that
    // case is legitimate and MUST still prune. This is the discrimination the
    // whole finding is about.
    mFetch.mockResolvedValue(sent({ files: [] }) as never);
    const out = await listFolder(deps, 'google', 'F');
    expect(out).toEqual({ files: [], complete: true });
  });
});

// ── route 2: the MAX_LIST_FILES cap ─────────────────────────────────────────

describe('KSC-3 — the file cap truncates the listing, so it is NOT complete', () => {
  it('google: a folder over the cap returns complete:false with the cap as the reason', async () => {
    const files = Array.from({ length: MAX_LIST_FILES + 200 }, (_v, i) => ({
      id: `f${i}`, name: `f${i}.txt`, mimeType: 'text/plain', modifiedTime: 'r1',
    }));
    mFetch.mockResolvedValue(sent({ files }) as never);
    const out = await listFolder(deps, 'google', 'F');
    expect(out.files).toHaveLength(MAX_LIST_FILES);
    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toBe('file_cap');
  });

  it('THE MEASURED SCENARIO: 1200 known files vs a listing capped at 1000 prunes ZERO', async () => {
    // The assessment measured 200 deletions here. `diffFolder` on the raw arrays
    // still reports them — its contract is unchanged and correct — but the
    // composition owner refuses to act on a listing it cannot vouch for.
    const known = Array.from({ length: 1200 }, (_v, i) => st(`f${i}`));
    const truncated = known.slice(0, MAX_LIST_FILES).map((s) => rf(s.externalFileId));

    // The pure diff is unchanged: given ONLY the array, 200 files look deleted.
    expect(diffFolder('S', truncated, known).toPrune).toHaveLength(200);

    // The composition owner, told the listing is incomplete, prunes nothing.
    const guarded = diffFolderListing('S', { files: truncated, complete: false }, known);
    expect(guarded.toPrune).toEqual([]);
    // …while still making progress on what it DID see.
    expect(guarded.unchanged).toBe(MAX_LIST_FILES);
  });
});

// ── route 3: a broken page chain ────────────────────────────────────────────

describe('KSC-5 — a page chain that cannot be followed leaves the listing incomplete', () => {
  it('google: exhausting the page budget with a token still pending is NOT complete', async () => {
    // Every page hands back another token, so the loop runs out of budget while
    // the provider still has files to give.
    mFetch.mockResolvedValue(sent({ files: [{ id: 'f', name: 'f', mimeType: 'text/plain', modifiedTime: 'r' }], nextPageToken: 'MORE' }) as never);
    const out = await listFolder(deps, 'google', 'F');
    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toBe('page_budget');
  });

  it('dropbox: has_more=true with an unusable cursor is a short listing, not the folder end', async () => {
    mFetch.mockResolvedValueOnce(sent({ entries: [{ '.tag': 'file', id: 'id:1', name: 'a.txt', rev: 'r1' }], has_more: true, cursor: 42 }) as never);
    const out = await listFolder(deps, 'dropbox', 'root');
    expect(out.files).toHaveLength(1);
    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toBe('bad_page_token');
  });

  it('onedrive: a nextLink the open-redirect guard refuses leaves the listing incomplete', async () => {
    // Refusing an off-Graph nextLink is CORRECT. Treating the listing as
    // complete afterwards was not — the folder demonstrably has more files.
    mFetch.mockResolvedValueOnce(sent({
      value: [{ id: 'i1', name: 'A', file: { mimeType: 'text/plain' }, lastModifiedDateTime: 'r1' }],
      '@odata.nextLink': 'https://evil.example.com/next',
    }) as never);
    const out = await listFolder(deps, 'microsoft-graph', 'root');
    expect(out.files.map((f) => f.fileId)).toEqual(['i1']);
    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toBe('bad_page_token');
    expect(mFetch).toHaveBeenCalledTimes(1); // the off-Graph URL was never fetched
  });

  it('mid-pagination: page 1 parses, page 2 is a 200 of garbage ⇒ the WHOLE listing throws', async () => {
    // The partial-prune route. Before, page 2 lost its token and the loop broke,
    // handing the runner page 1 as if it were the folder.
    mFetch
      .mockResolvedValueOnce(sent({ files: [{ id: 'f1', name: 'A', mimeType: 'text/plain', modifiedTime: 'r1' }], nextPageToken: 'P2' }) as never)
      .mockResolvedValueOnce(sentRaw('<html>502</html>') as never);
    await expect(listFolder(deps, 'google', 'F')).rejects.toMatchObject({ httpStatus: 502 });
  });
});

// ── the guard itself: fail-closed on UNKNOWN completeness ───────────────────

describe('diffFolderListing — the one composition owner, fail-closed by construction', () => {
  it('prunes ONLY when completeness is literally true', () => {
    const states = [st('gone')];
    expect(diffFolderListing('S', { files: [], complete: true }, states).toPrune).toHaveLength(1);
    expect(diffFolderListing('S', { files: [], complete: false }, states).toPrune).toEqual([]);
  });

  it('UNKNOWN completeness never prunes — a missing/garbage flag fails CLOSED', () => {
    const states = [st('gone')];
    // A caller from JS, an older mock, or a future provider whose lister forgot
    // to say. The test is `=== true`, not `!complete`, precisely so these cases
    // land on the safe side rather than deleting the customer's documents.
    for (const bogus of [undefined, null, 'true', 1, {}]) {
      const listing = { files: [], complete: bogus } as unknown as { files: RemoteFile[]; complete: boolean };
      expect(diffFolderListing('S', listing, states).toPrune).toEqual([]);
    }
  });

  it('an incomplete listing still INGESTS what it saw — the guard suppresses deletion only', () => {
    const d = diffFolderListing('S', { files: [rf('new1'), rf('new2')], complete: false }, [st('gone')]);
    expect(d.toIngest.map((i) => i.fileId)).toEqual(['new1', 'new2']);
    expect(d.toPrune).toEqual([]);
  });

  it('does not change diffFolder: a COMPLETE empty listing prunes all known files', () => {
    // The product rule `knowledge-sync.test.ts:46` pins. It must survive the fix,
    // or the fix has traded a destructive bug for a sync that never converges.
    const states = [st('x'), st('y')];
    expect(diffFolderListing('S', { files: [], complete: true }, states).toPrune.map((p) => p.fileId))
      .toEqual(['x', 'y']);
  });
});

// ── route 4: a 200 that PARSES but carries no listing ────────────────────────

/**
 * ADR 0605 R1 (review HIGH 2) — THE CURE'S OWN FAMILY, ONE LAYER UP.
 *
 * Tier 1 made `readJson` throw on an unparseable `2xx`. One line later every
 * lister did `Array.isArray(body?.files) ? body.files : []` and then declared the
 * folder DRAINED — so the substitution Tier 1 exists to eliminate ("the layer
 * returned `[]` for two different facts") survived intact for all five providers.
 * MEASURED by the review: `{}` and `{"error":{"code":403,…}}` both produced
 * `{ files: [], complete: true }`.
 *
 * And these are ADR 0605's OWN motivating scenarios: an interposing proxy
 * answering `200 {"status":"ok"}`, a captive portal, an OAuth interstitial. All
 * are valid JSON, so none of them ever reached `readJson`'s throw.
 *
 * EVERY PROVIDER GETS ITS OWN WITNESS — a fix for one lister is not a fix for the
 * class, and `microsoft-sharepoint` is listed separately from `microsoft-graph`
 * because it is a distinct entry point into the same lister.
 */
describe('KSC-1 (R1) — a 200 carrying no listing is NOT an empty folder', () => {
  const PROVIDERS = [
    ['google', 'FOLDER1'],
    ['microsoft-graph', 'root'],
    ['microsoft-sharepoint', 'DRIVEID'],
    ['dropbox', '/Reports'],
    ['box', 'root'],
  ] as const;

  for (const [provider, folder] of PROVIDERS) {
    it(`${provider}: an empty JSON object is refused, not read as a drained folder`, async () => {
      mFetch.mockResolvedValue(sent({}) as never);
      await expect(listFolder(deps, provider, folder)).rejects.toMatchObject({ httpStatus: 502 });
    });

    it(`${provider}: a 200 carrying an ERROR envelope is refused`, async () => {
      mFetch.mockResolvedValue(sent({ error: { code: 403, message: 'insufficient scope' } }) as never);
      await expect(listFolder(deps, provider, folder)).rejects.toMatchObject({ httpStatus: 502 });
    });

    it(`${provider}: an interposing proxy's {"status":"ok"} is refused`, async () => {
      mFetch.mockResolvedValue(sent({ status: 'ok' }) as never);
      await expect(listFolder(deps, provider, folder)).rejects.toMatchObject({ httpStatus: 502 });
    });
  }

  it('a listing whose array field is present but NOT an array is refused', async () => {
    mFetch.mockResolvedValue(sent({ entries: 'nope' }) as never);
    await expect(listFolder(deps, 'dropbox', 'root')).rejects.toMatchObject({ httpStatus: 502 });
  });

  /**
   * THE OTHER ARM, and the reason Google does not simply require the array.
   *
   * A Drive partial response (`fields=…`) omits a field whose value is empty, so
   * an empty folder can legitimately come back as `{"kind":"drive#fileList"}`.
   * Requiring `files` unconditionally would have turned the CORRECT empty-folder
   * prune into a permanent 502 — trading a data-loss bug for a sync that never
   * converges, which is precisely the mistake ADR 0605 § "Why the fetch
   * boundary" rejected once already.
   */
  it('google: a Drive file list that OMITS an empty `files` is an honest empty folder', async () => {
    mFetch.mockResolvedValue(sent({ kind: 'drive#fileList' }) as never);
    expect(await listFolder(deps, 'google', 'F')).toEqual({ files: [], complete: true });
  });

  it('google: the `kind` discriminator is actually REQUESTED, or it can never arrive', async () => {
    mFetch.mockResolvedValue(sent({ files: [] }) as never);
    await listFolder(deps, 'google', 'F');
    expect(decodeURIComponent(String(mFetch.mock.calls[0]![1].url))).toContain('kind,nextPageToken,files(');
  });

  it('the refusal survives the DIFF: an unreadable listing deletes nothing', async () => {
    // The consequence, end to end. Before, this exact body pruned every known file.
    mFetch.mockResolvedValue(sent({ status: 'ok' }) as never);
    await expect(listFolder(deps, 'google', 'F')).rejects.toMatchObject({ httpStatus: 502 });
    // …and had it somehow yielded a listing, the composition owner still refuses
    // to act on one that cannot vouch for itself.
    expect(diffFolderListing('S', { files: [], complete: false }, [st('keepme')]).toPrune).toEqual([]);
  });
});

// ── MEDIUM 5: Box turned an unknown into an affirmative completeness claim ───

describe('ADR 0605 R1 — Box may not infer completeness from its own page size', () => {
  const boxItems = (n: number, prefix: string) =>
    Array.from({ length: n }, (_v, i) => ({ type: 'file', id: `${prefix}${i}`, name: `${prefix}${i}.txt`, etag: 'e' }));

  it('boxDrained: a FULL page with no total_count is NOT drained (the fallback that made it always true)', () => {
    // `total ?? entries.length` made `offset >= total` trivially true on ANY full
    // page. Pre-Tier-1 that was a silent `break`; Tier 1 made it an affirmative
    // `complete: true`, which the diff then acts on by DELETING.
    expect(boxDrained(1000, 1000, 1000, undefined)).toBe(false);
    expect(boxDrained(1000, 1000, 1000, 'many')).toBe(false); // a non-numeric total is still unknown
    // The signals that ARE proof of the end.
    expect(boxDrained(0, 1000, 1000, undefined)).toBe(true);
    expect(boxDrained(999, 1000, 1000, undefined)).toBe(true);
    expect(boxDrained(1000, 1000, 1000, 1000)).toBe(true);
    expect(boxDrained(1000, 1000, 1000, 2500)).toBe(false);
  });

  it('a full first page with no total_count KEEPS PAGING, so the tail is not silently dropped', async () => {
    // The review's measured shape: ONE full page of 1000 entries (500 folders +
    // 500 files, so the MAX_LIST_FILES cap does not fire first) and no
    // `total_count` ⇒ pre-fix, `500 files, complete: true` after a single call.
    const fullPage = [
      ...boxItems(500, 'f'),
      ...Array.from({ length: 500 }, (_v, i) => ({ type: 'folder', id: `d${i}`, name: `d${i}` })),
    ];
    mFetch
      .mockResolvedValueOnce(sent({ entries: fullPage }) as never)   // full page, no total_count
      .mockResolvedValueOnce(sent({ entries: [{ type: 'file', id: 'tail', name: 'tail.txt', etag: 'e' }] }) as never);
    const out = await listFolder(deps, 'box', 'root');
    expect(mFetch).toHaveBeenCalledTimes(2);                 // it did NOT stop at page 1
    expect(out.files.map((f) => f.fileId)).toContain('tail'); // and the tail file is present
    expect(out.complete).toBe(true);
  });
});

// ── LOW 8: the destructive guard has exactly one composition owner ───────────

/**
 * ADR 0605 R1 (review LOW 8) — the TRIPWIRE for the invariant this whole ADR
 * exists for.
 *
 * `diffFolder` is still exported (its purity is what makes it testable, and ADR
 * 0605 § "Why the fetch boundary" argues explicitly for leaving its contract
 * alone). But nothing stopped a future `src/` caller from using it directly and
 * re-opening the mass-deletion path, one composition owner away. Tier 5
 * broadened `idempotency-lane-tripwire.test.ts` on exactly this reasoning and
 * filed `KSWF-16` for the doctrine; the destructive-diff invariant had none.
 */
describe('ADR 0605 R1 — only `diffFolderListing` may call `diffFolder`', () => {
  /** Strip comments, preserving line counts — a ratchet that counts a mention
   *  inside a docblock polices a spelling rather than the invariant. */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
      .split('\n')
      .map((l) => (l.trimStart().startsWith('//') ? '' : l))
      .join('\n');

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });

  /** The ONE module allowed to call it: the composition owner's own file. */
  const OWNER = 'features/knowledge-sync/knowledgeSyncService.ts';

  it('no other src/ module calls the unguarded diff', () => {
    const src = join(__dirname, '..', 'src');
    const offenders = walk(src)
      .map((p) => ({ rel: relative(src, p).split(sep).join('/'), text: stripComments(readFileSync(p, 'utf8')) }))
      .filter((f) => f.rel !== OWNER && /\bdiffFolder\s*\(/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the tripwire is NOT vacuous: the owner itself DOES call it', () => {
    // A pattern that matches nothing reports green forever. Hand-check the one
    // file the rule exempts, so an `expect([]).toEqual([])` that could never fail
    // is impossible here.
    const owner = stripComments(readFileSync(join(__dirname, '..', 'src', OWNER), 'utf8'));
    expect(/\bdiffFolder\s*\(/.test(owner)).toBe(true);
  });
});
