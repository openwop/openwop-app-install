/**
 * ADR 0721 — every managed dispatch made FOR a person must carry that person,
 * or the free-tier allowance is pooled across a whole shared workspace.
 *
 * WHY THIS EXISTS, AND WHY ADR 0693's OWN WITNESS DID NOT CATCH IT.
 * ADR 0693 split the managed usage bucket per subject, and
 * `test/managed-usage-per-subject.test.ts` proves the SPLIT works: two subjects in
 * one workspace get different buckets, one subject is stable, the subject is not
 * recoverable. Every one of those assertions is about `managedUsageBucket` — the
 * COMPOSER. None is about whether anybody CALLS it with a subject.
 *
 * They did not. `managedUsageScope.ts` returns the bare `tenantId` — the POOLED
 * bucket — on its `!subject` branch, and at the time this file was written exactly
 * ONE call site in the whole backend passed `actingSubject`. The conversation-reply
 * path that serves `EmbeddedChatPanel`, `/guide` and every group room passed none,
 * so `host-kicktodo`'s entire population drew one 50 000-token day. ADR 0693's
 * defect, still live, under a green test.
 *
 * ── THE INSTRUMENT, and what each leg can and cannot see ──
 *
 *  1. BEHAVIOURAL (the proof). Drives a REAL call site and asserts the value that
 *     reaches `dispatchManagedChat`. A source grep cannot distinguish "the file
 *     mentions actingSubject" from "the site passes it on this path".
 *  2. EXHAUSTIVE CLASSIFICATION (the population). Every `dispatchManagedChat(`
 *     site in `src/**` either passes the subject or is EXEMPT with a measured
 *     reason. This is the leg that catches the NEXT call site somebody adds —
 *     the instance fix without it would rot the moment a seventh site appears.
 *  3. ANTI-VACUITY + ANTI-ROT. The walker must really find sites, and an EXEMPT
 *     row that no longer applies must be deleted rather than left as a permanent
 *     excuse (the lesson `scripts/check-adr-refs.mjs:152` already encodes).
 *
 * Leg 2 is a spelling and says so; it is never the only leg. Leg 1 is the oracle.
 *
 * Leg 6 drives the REAL `dispatchManagedChat` (via `vi.importActual`, since legs
 * 1–2 mock it), with only the upstream provider call (`providers/dispatch.ts`
 * `dispatchChat`) stubbed, so the subject is followed through
 * `prepareManagedDispatch` and `recordManagedUsage` into the stored bucket.
 *
 * Tracker TST-BGF-21. Red when: `headlessAi` or `memoryExtractor` drops the subject
 * (leg 1), a placeholder subject is invented (leg 2), any managed dispatch site
 * omits it without an EXEMPT row (population), or `recordManagedUsage` meters to the
 * pooled tenant bucket (leg 6).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return { ...actual, dispatchManagedChat: vi.fn() };
});
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  // Leg 6's upstream provider call: no network, a fixed usage the meter must record.
  return {
    ...actual,
    dispatchChat: vi.fn(async (): Promise<import('../src/providers/dispatch.js').DispatchResult> => ({
      provider: 'minimax', model: 'MiniMax-M3', completion: 'ok', usage: { inputTokens: 100, outputTokens: 50 },
    })),
  };
});
import { dispatchManagedChat } from '../src/providers/managedProvider.js';
import { llmExtractFacts } from '../src/features/memory-auto-extract/memoryExtractor.js';

/**
 * file → why a managed dispatch there legitimately carries no subject.
 * SHRINK-ONLY. Each is a measured claim about that lane, not a convenience.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  ['features/chat-widget/publicGateway.ts',
    'the public chat widget is ANONYMOUS by design (ADR 0693 OQ1) — there is no subject, and a '
    + 'design that required one would break the widget. The pooled tenant bucket is the correct '
    + 'meter here: the operator is paying for visitors they cannot identify. Covers BOTH doors in '
    + 'this file (chat round and tools round) — EXEMPT is keyed by file, not by call site.'],
  // 2026-10-05 (ADR 0821 D5 follow-up): two rows DELETED, not relaxed.
  //  - `host/headlessAi.ts` now forwards `options.actingSubject` into its managed
  //    dispatch, so the walker sees it pass (the anti-rot leg below demanded removal).
  //  - `features/chat-autotitle/titleGenerator.ts` no longer calls the managed door
  //    at all — it routes through `resolveHeadlessAi`. The gap that row RECORDED is
  //    still real and now invisible to this walker: auto-title passes no subject
  //    (its injected `generate?` seam carries none), so its managed draw stays on
  //    the pooled bucket. Bounded (one short title per conversation); closing it is
  //    still the small seam change the old row described.
]);

/**
 * Blank out comments while preserving line structure.
 *
 * Needed in BOTH directions, and I introduced one of them: widening the matcher to the
 * sibling entry point immediately produced a false POSITIVE on
 * `conversationToolLoop.ts:324`, a prose line reading "dispatchManagedToolsRound (daily
 * caps …)" — the word followed by a paren. The mirror hazard is a false NEGATIVE from a
 * comment like `// TODO: thread actingSubject`. Matching against code only removes both,
 * which a wider window or a cleverer regex would not.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') out.push(...walk(p)); }
    // In-src tests may legitimately call the dispatch with no subject; they are not the
    // production population this ratchet governs.
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * The call's OWN argument object, by brace balance rather than a fixed line count.
 *
 * A fixed window had two false-negative shapes, neither live but both cheap to close:
 * a second dispatch inside the window (one passing, one not) made the omitting site read
 * as passing — and `aiProvidersHost` 971/1025 plus `publicGateway` 149/226 are exactly
 * that clustered shape, 54 and 77 lines apart today; and any COMMENT containing the word
 * (`// TODO: thread actingSubject`) satisfied it. Balance stops at the call's own closing
 * paren, so neither can occur.
 */
function argumentObject(lines: readonly string[], start: number): string {
  let depth = 0;
  const out: string[] = [];
  for (let i = start; i < Math.min(lines.length, start + 60); i += 1) {
    const l = lines[i]!;
    out.push(l);
    for (const ch of l) {
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) return out.join('\n'); }
    }
  }
  return out.join('\n');
}

/** Every call site, with whether its argument object mentions the subject. */
function callSites(): { file: string; line: number; passes: boolean }[] {
  const out: { file: string; line: number; passes: boolean }[] = [];
  for (const abs of walk(SRC)) {
    const lines = stripComments(readFileSync(abs, 'utf8')).split('\n');
    lines.forEach((l, i) => {
      // BOTH entry points. `dispatchManagedToolsRound` meters through the SAME composer
      // (`managedProvider.ts:590,620`). The first version of this walked only
      // `dispatchManagedChat` — and the ADR's own Context paragraph then miscounted the
      // population for exactly that reason. A ratchet whose stated job is "catch the NEXT
      // call site" must cover every door into the meter, not the one the defect used.
      if (!/dispatchManaged(Chat|ToolsRound)\s*\(/.test(l)) return;
      if (/export async function dispatchManaged/.test(l)) return;
      const window = argumentObject(lines, i);
      out.push({ file: path.relative(SRC, abs), line: i + 1, passes: /actingSubject/.test(window) });
    });
  }
  return out;
}

describe('ADR 0721 — the acting subject reaches the managed meter', () => {
  beforeEach(() => {
    vi.mocked(dispatchManagedChat).mockReset();
    vi.mocked(dispatchManagedChat).mockResolvedValue({ provider: 'openwop-free', model: 'openwop-free', completion: '{"facts":[]}' });
  });

  it('BEHAVIOURAL: a real call site forwards the subject it was given', async () => {
    await llmExtractFacts('host-kicktodo', ['some conversation'], { actingSubject: 'user:alice' });
    expect(vi.mocked(dispatchManagedChat)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(dispatchManagedChat).mock.calls[0]![0]!.actingSubject,
      'llmExtractFacts received a subject and dropped it — the extraction would meter to the POOLED workspace bucket',
    ).toBe('user:alice');
  });

  it('BEHAVIOURAL: no subject means no field — the anonymous lane must stay byte-identical', async () => {
    // A fix that invented a placeholder subject would silently create per-caller
    // rows for the anonymous widget and a DSAR surface for a person who does not exist.
    await llmExtractFacts('host-kicktodo', ['some conversation']);
    // Guarded: without this a regression that stopped dispatching at all would red with a
    // TypeError instead of the assertion message, i.e. the right colour for the wrong reason.
    expect(vi.mocked(dispatchManagedChat)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchManagedChat).mock.calls[0]![0]!.actingSubject).toBeUndefined();
  });

  it('POPULATION: every managed dispatch passes the subject or is EXEMPT with a reason', () => {
    const offenders = callSites()
      .filter((s) => !s.passes && !EXEMPT.has(s.file))
      .map((s) => `${s.file}:${s.line}`);
    expect(
      offenders,
      'This managed dispatch does not pass `actingSubject`, so `managedUsageBucket` will charge the '
      + 'POOLED tenant bucket and one allowance will serve the whole workspace. Pass the acting '
      + 'subject, or add the file to EXEMPT with a measured reason why no subject exists:\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the walker is non-vacuous — it really finds call sites, and really sees both kinds', () => {
    const sites = callSites();
    expect(sites.length, 'no call sites found — the walker or the matcher is broken').toBeGreaterThanOrEqual(EXEMPT.size + 1);
    expect(sites.some((s) => s.passes), 'no site passes the subject — the matcher never matches').toBe(true);
    expect(sites.some((s) => !s.passes), 'no site omits it — EXEMPT would then be unfalsifiable').toBe(true);
  });

  it('EXEMPT has not rotted — every row names a real file that still omits the subject', () => {
    const sites = callSites();
    const gone = [...EXEMPT.keys()].filter((f) => !existsSync(path.join(SRC, f)));
    expect(gone, `EXEMPT names files that no longer exist — delete the rows:\n${gone.join('\n')}`).toEqual([]);
    const fixed = [...EXEMPT.keys()].filter((f) => sites.some((s) => s.file === f && s.passes));
    expect(
      fixed,
      `these EXEMPT files now DO pass the subject — delete the excuse rather than leaving a permanent one:\n${fixed.join('\n')}`,
    ).toEqual([]);
  });

  it('leg 6: the subject reaches the METER, not just the dispatch call', async () => {
    // THE HOLE /grade-code FOUND: legs 1-2 mock `dispatchManagedChat` — the function
    // that OWNS the metering — so they assert what reaches the MOCK. This leg runs the
    // REAL one (only the upstream provider call is stubbed) and reads the stored rows:
    // the tokens land in the per-subject bucket and NOT in the pooled tenant row.
    const real = await vi.importActual<typeof import('../src/providers/managedProvider.js')>('../src/providers/managedProvider.js');
    const { openStorage } = await import('../src/storage/index.js');
    const { managedUsageBucket } = await import('../src/providers/managedUsageScope.js');
    const storage = await openStorage('memory://');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'adr0721-meter-'));
    const prevKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = 'sk-adr0721-meter';
    real.configureManagedProvider({ storage, dataDir });
    try {
      await real.bootstrapManagedProvider();
      real._clearManagedCacheForTests();
      const WS = 'ws:11111111-2222-3333-4444-555555555555';
      const SUBJ = 'user:meter-probe';
      await real.dispatchManagedChat({
        userFacingProvider: 'openwop-free', tenantId: WS, actingSubject: SUBJ,
        messages: [{ role: 'user', content: 'hi' }], maxTokens: 8,
      });
      const date = new Date().toISOString().slice(0, 10);
      const perSubject = managedUsageBucket(WS, SUBJ);
      expect(perSubject, 'a shared workspace with a subject must NOT compose the pooled bucket').not.toBe(WS);
      const mine = await storage.getManagedUsage(perSubject, 'openwop-free', date);
      const pooled = await storage.getManagedUsage(WS, 'openwop-free', date);
      expect(mine.inputTokens + mine.outputTokens, 'the charge must land in the per-subject bucket').toBe(150);
      expect(
        pooled.inputTokens + pooled.outputTokens,
        'the POOLED tenant row must stay empty — a charge there is one allowance for the whole workspace, the ADR 0693 defect',
      ).toBe(0);
    } finally {
      if (prevKey === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = prevKey;
      real._clearManagedCacheForTests();
      await storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
