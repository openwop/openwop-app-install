/**
 * `npm run kb:eval` — ADR 0904 P0. Runs the retrieval eval (`harness.ts`) in-process on
 * in-memory surfaces and prints recall@5 / MRR / nDCG@10 per mode, kind and locale.
 *
 *   npm run kb:eval                      # print, and compare to baseline.json (local-hash only)
 *   npm run kb:eval -- --json            # the full report as JSON
 *   npm run kb:eval -- --write-baseline  # re-pin baseline.json (local-hash only)
 *   KB_EVAL_PROVIDER=google GOOGLE_API_KEY=… npm run kb:eval
 *                                        # the same eval on gemini-embedding-001 (real spend:
 *                                        # ~45k tokens for the corpus + 180 query embeds)
 *   KB_EVAL_QUERY_AS_DOCUMENT=1          # …embedding queries as documents (pre-ADR-0904-D2)
 *
 * With no embedder configured the numbers are the deterministic local-hash ones that
 * `baseline.json` pins (the vitest smoke asserts them). Exit 1 on a baseline drift.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initInMemorySurfaces } from '../../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../../src/host/hostExtPersistence.js';
import { openStorage } from '../../src/storage/index.js';
import { formatReport, loadCorpus, runKbEval } from './harness.js';
import { __setHeadlessEmbedderForTest } from '../../src/host/headlessAi.js';
import { dispatchEmbeddings } from '../../src/providers/dispatch.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, '../../test/fixtures/kb-eval/corpus.json');
const baselinePath = join(here, 'baseline.json');

initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbeval-')) });
initHostExtPersistence(await openStorage('memory://'));

const providerName = process.env.KB_EVAL_PROVIDER;
if (providerName) {
  if (providerName !== 'google') { console.error(`KB_EVAL_PROVIDER=${providerName}: only 'google' is wired`); process.exit(1); }
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) { console.error('KB_EVAL_PROVIDER=google needs GOOGLE_API_KEY'); process.exit(1); }
  const queryAsDocument = process.env.KB_EVAL_QUERY_AS_DOCUMENT === '1';
  const model = 'gemini-embedding-001';
  // A local vector cache keyed (model, width, input type, text) so a re-run costs nothing
  // and returns identical vectors — the provider numbers are then reproducible too.
  const cachePath = process.env.KB_EVAL_CACHE ?? join(tmpdir(), 'openwop-kb-eval-vectors.json');
  let cache: Record<string, number[]> = {};
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, number[]>; } catch { /* first run */ }
  let misses = 0;
  // A provider error makes kbService degrade that search to keyword-only — which is the
  // right product behaviour and the WRONG eval behaviour: the run would silently measure
  // BM25 and label it gemini (it did: a free-tier 429 mid-run). Count them; any ⇒ exit 1.
  let providerErrors = 0;
  __setHeadlessEmbedderForTest(async (_tenant, dimensions) => ({
    model,
    provider: 'google',
    embedVersion: 'q1',
    embed: async (texts, inputTypeIn = 'document') => {
      const inputType = queryAsDocument ? 'document' : inputTypeIn;
      const keyOf = (t: string) => createHash('sha256').update(`${model}|${dimensions}|${inputType}|${t}`).digest('hex');
      const todo = [...new Set(texts.filter((t) => !cache[keyOf(t)]))];
      for (let i = 0; i < todo.length; i += 64) {
        const batch = todo.slice(i, i + 64);
        let r: Awaited<ReturnType<typeof dispatchEmbeddings>>;
        try { r = await dispatchEmbeddings({ provider: 'google', model, apiKey, texts: batch, dimensions, inputType }); }
        catch (err) { providerErrors += 1; throw err; }
        batch.forEach((t, j) => { cache[keyOf(t)] = r.vectors[j]!; });
        misses += batch.length;
        writeFileSync(cachePath, JSON.stringify(cache)); // keep progress across a quota stop
      }
      return texts.map((t) => cache[keyOf(t)]!);
    },
  }));
  process.on('exit', (code) => {
    console.error(`(provider embeds this run: ${misses}; errors: ${providerErrors}; cache ${cachePath})`);
    if (providerErrors > 0 && code === 0) {
      console.error('CONTAMINATED: provider calls failed, so some searches ran keyword-only. Re-run (the cache keeps what succeeded).');
      process.exitCode = 1;
    }
  });
}
const report = await runKbEval(loadCorpus(corpusPath), { provider: !!providerName });
const args = new Set(process.argv.slice(2));
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(formatReport(report));

const isLocal = report.embedder.startsWith('local:');
if (args.has('--write-baseline')) {
  if (!isLocal) { console.error(`refusing to pin a baseline from a non-deterministic embedder (${report.embedder})`); process.exit(1); }
  writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nbaseline written: ${baselinePath}`);
} else if (isLocal) {
  const pinned = readFileSync(baselinePath, 'utf8');
  if (pinned !== `${JSON.stringify(report, null, 2)}\n`) {
    console.error('\nDRIFT: the local-hash numbers differ from baseline.json. If the change is intended, re-pin with --write-baseline and say why in the PR.');
    process.exit(1);
  }
  console.log('\nmatches baseline.json');
}
