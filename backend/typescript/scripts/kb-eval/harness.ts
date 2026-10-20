/**
 * ADR 0904 P0 — the KB retrieval eval. Before this there was no way to say whether a
 * retrieval change helped: `features/evals` is the model arena and
 * `host/workflowEvalSets.ts` grades workflow runs. This measures RETRIEVAL on a checked-in,
 * labelled corpus (`test/fixtures/kb-eval/corpus.json` — 110 documents in the app's four
 * locales, 60 graded queries) through the REAL `kbService` path, so a number here is the
 * number a user gets, not a re-implementation's.
 *
 * Relevance is labelled per DOCUMENT (chunk ids are a chunker artefact and change with
 * it), so each ranked chunk list is collapsed to documents by first occurrence before
 * scoring. Metrics: recall@5 (any-grade relevant docs found in the top 5 / all relevant),
 * MRR (reciprocal rank of the first relevant doc), nDCG@10 with gain 2^grade − 1.
 *
 * Lanes:
 *  - `single`: the whole corpus in ONE collection, searched per mode (dense / hybrid /
 *    hybrid+rerank). This is the per-mode comparison the ADR 0904 D5 default flip is
 *    gated on.
 *  - `multi`: one collection PER LOCALE with DIFFERENT modes, searched through
 *    `tenantRetrieve` (what `ctx.knowledge` and the chat tool use). This is the lane the
 *    D4 cross-collection fairness defect lived in.
 *
 * The embedder is whatever `kbService` resolves. With no configuration that is the
 * deterministic `local-hash-v1`, so these numbers are byte-stable and pinned in
 * `baseline.json`. Lives under `scripts/`, not `src/`, because it boots in-memory surfaces.
 */
import { readFileSync } from 'node:fs';
import { formatFor, ingestInput, type EvalFormat } from './renderFormats.js';
import { createCollection, ingestDocument, searchDetailed, setRetrievalConfig, tenantRetrieve, KB_MAINTENANCE_CALLER, type RetrievalMode } from '../../src/features/kb/kbService.js';

export interface EvalDoc { id: string; locale: string; format: 'md' | 'text'; title: string; text: string }
export interface EvalQuery { id: string; locale: string; kind: 'exact-term' | 'keyword' | 'paraphrase'; query: string; relevant: Array<{ doc: string; grade: 1 | 2 }> }
export interface EvalCorpus { version: number; documents: EvalDoc[]; queries: EvalQuery[] }

export interface Metrics { n: number; recallAt5: number; mrr: number; ndcgAt10: number }
export interface LaneReport { overall: Metrics; byLocale: Record<string, Metrics>; byKind: Record<string, Metrics> }
export interface EvalReport { embedder: string; corpus: { documents: number; queries: number; formats: Record<string, number> }; single: Record<RetrievalMode, LaneReport>; multi: LaneReport }

export const MODES: readonly RetrievalMode[] = ['dense', 'hybrid', 'hybrid+rerank'];
/** The multi-collection lane's per-locale modes: deliberately MIXED, so a scale-unfair
 *  merge (a raw-score sort) shows up as a drop for the collections on the smaller scale. */
export const MULTI_MODES: Record<string, RetrievalMode> = { en: 'dense', es: 'hybrid+rerank', fr: 'hybrid', 'pt-BR': 'dense' };

export function loadCorpus(path: string): EvalCorpus {
  return JSON.parse(readFileSync(path, 'utf8')) as EvalCorpus;
}

/** Collapse a ranked chunk list to ranked document ids (first occurrence wins). */
export function docRanking(fixtureIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of fixtureIds) if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

/** Score one ranked document list against one query's labels. Pure. */
export function scoreQuery(ranked: readonly string[], relevant: EvalQuery['relevant']): { recallAt5: number; rr: number; ndcgAt10: number } {
  const grade = new Map(relevant.map((r) => [r.doc, r.grade]));
  const top5 = ranked.slice(0, 5);
  const recallAt5 = relevant.length === 0 ? 0 : top5.filter((d) => grade.has(d)).length / relevant.length;
  const first = ranked.findIndex((d) => grade.has(d));
  const rr = first < 0 ? 0 : 1 / (first + 1);
  const dcg = (gains: number[]) => gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const actual = dcg(ranked.slice(0, 10).map((d) => grade.get(d) ?? 0));
  const ideal = dcg([...relevant.map((r) => r.grade)].sort((a, b) => b - a).slice(0, 10));
  return { recallAt5, rr, ndcgAt10: ideal > 0 ? actual / ideal : 0 };
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

function aggregate(rows: Array<{ q: EvalQuery; s: ReturnType<typeof scoreQuery> }>): Metrics {
  const n = rows.length;
  if (n === 0) return { n: 0, recallAt5: 0, mrr: 0, ndcgAt10: 0 };
  const sum = (f: (s: ReturnType<typeof scoreQuery>) => number) => rows.reduce((a, r) => a + f(r.s), 0) / n;
  return { n, recallAt5: round(sum((s) => s.recallAt5)), mrr: round(sum((s) => s.rr)), ndcgAt10: round(sum((s) => s.ndcgAt10)) };
}

function laneReport(rows: Array<{ q: EvalQuery; s: ReturnType<typeof scoreQuery> }>): LaneReport {
  const group = (key: (q: EvalQuery) => string) => {
    const out: Record<string, Metrics> = {};
    for (const k of [...new Set(rows.map((r) => key(r.q)))].sort()) out[k] = aggregate(rows.filter((r) => key(r.q) === k));
    return out;
  };
  return { overall: aggregate(rows), byLocale: group((q) => q.locale), byKind: group((q) => q.kind) };
}

/** Run the eval in an ALREADY-INITIALISED host (the caller owns surface/storage setup,
 *  so the vitest smoke and the CLI share this function). `tenantPrefix` keeps repeated
 *  runs in one process apart. */
export async function runKbEval(corpus: EvalCorpus, opts: { tenantPrefix?: string; provider?: boolean } = {}): Promise<EvalReport> {
  const prefix = opts.tenantPrefix ?? 'kb-eval';
  // `provider`: every collection is pinned to the tenant's provider embedder (the caller
  // installs it through `__setHeadlessEmbedderForTest`), so the SAME corpus and queries
  // measure a learned embedder against the local hash.
  const embedderCfg = opts.provider ? { embedder: 'provider' as const } : {};
  const orgId = 'org-eval';
  const actor = 'eval';
  let embedderLabel = 'unknown';

  // ── single-collection lane ──
  const tenantA = `${prefix}-single`;
  // STABLE ids, not the random defaults: every ranking tie (BM25, RRF, rerank) breaks on
  // chunk id, and chunk ids derive from document ids, so random ids made the numbers
  // move between runs (measured: hybrid MRR 0.773 vs 0.781 on identical code).
  const col = await createCollection(tenantA, orgId, actor, { name: 'eval-corpus' }, { collectionId: 'eval-corpus' });
  const fixtureIdOf = new Map<string, string>();
  // ADR 0904 P2 — a share of the corpus goes in as rendered DOCX / PDF (see renderFormats).
  const formatOf = new Map<string, EvalFormat>(corpus.documents.map((d, i) => [d.id, formatFor(d, i)]));
  for (const d of corpus.documents) {
    const doc = await ingestDocument(tenantA, orgId, actor, col.collectionId, await ingestInput(d, formatOf.get(d.id)!), { documentId: d.id, silent: true });
    fixtureIdOf.set(doc.documentId, d.id);
  }
  const single = {} as Record<RetrievalMode, LaneReport>;
  for (const mode of MODES) {
    await setRetrievalConfig(tenantA, orgId, col.collectionId, actor, { mode, ...embedderCfg });
    const rows: Array<{ q: EvalQuery; s: ReturnType<typeof scoreQuery> }> = [];
    for (const q of corpus.queries) {
      const r = await searchDetailed(tenantA, orgId, col.collectionId, q.query, 50, mode);
      embedderLabel = `${r.embedding.mode}${r.embedding.model ? `:${r.embedding.model}` : ''}`;
      rows.push({ q, s: scoreQuery(docRanking(r.hits.map((h) => fixtureIdOf.get(h.documentId) ?? '')), q.relevant) });
    }
    single[mode] = laneReport(rows);
  }

  // ── multi-collection lane (tenantRetrieve) ──
  const tenantB = `${prefix}-multi`;
  const fixtureIdOfB = new Map<string, string>();
  for (const [locale, mode] of Object.entries(MULTI_MODES)) {
    const c = await createCollection(tenantB, orgId, actor, { name: `eval-${locale}` }, { collectionId: `eval-${locale}` });
    await setRetrievalConfig(tenantB, orgId, c.collectionId, actor, { mode, ...embedderCfg });
    for (const d of corpus.documents.filter((x) => x.locale === locale)) {
      const doc = await ingestDocument(tenantB, orgId, actor, c.collectionId, await ingestInput(d, formatOf.get(d.id)!), { documentId: d.id, silent: true });
      fixtureIdOfB.set(doc.documentId, d.id);
    }
  }
  const multiRows: Array<{ q: EvalQuery; s: ReturnType<typeof scoreQuery> }> = [];
  const debugLocale = process.env.KB_EVAL_DEBUG_LOCALE;
  for (const q of corpus.queries) {
    const r = await tenantRetrieve(tenantB, { query: q.query, resultLimit: 50 }, KB_MAINTENANCE_CALLER);
    if (debugLocale && q.locale === debugLocale) {
      console.error(`${q.id} [${q.relevant.map((x) => x.doc).join(',')}] ${q.query}`);
      for (const c of (r?.chunks ?? []).slice(0, 6)) console.error(`   #${c.fusedRank} ${c.collectionId} ${fixtureIdOfB.get(c.assetId)} rel=${c.relevanceScore.toFixed(3)} native=${c.nativeScore?.toFixed(3)}`);
    }
    multiRows.push({ q, s: scoreQuery(docRanking((r?.chunks ?? []).map((c) => fixtureIdOfB.get(c.assetId) ?? '')), q.relevant) });
  }

  return {
    embedder: embedderLabel,
    corpus: { documents: corpus.documents.length, queries: corpus.queries.length, formats: Object.fromEntries(['text', 'docx', 'pdf'].map((f) => [f, [...formatOf.values()].filter((x) => x === f).length])) },
    single,
    multi: laneReport(multiRows),
  };
}

/** A compact fixed-width table for the CLI. */
export function formatReport(r: EvalReport): string {
  const line = (label: string, m: Metrics) => `${label.padEnd(28)} n=${String(m.n).padStart(2)}  recall@5=${m.recallAt5.toFixed(3)}  MRR=${m.mrr.toFixed(3)}  nDCG@10=${m.ndcgAt10.toFixed(3)}`;
  const out = [`KB retrieval eval — embedder ${r.embedder}, ${r.corpus.documents} docs, ${r.corpus.queries} queries`];
  for (const mode of MODES) {
    const lane = r.single[mode];
    out.push('', line(`single / ${mode}`, lane.overall));
    for (const [k, m] of Object.entries(lane.byKind)) out.push(line(`  kind ${k}`, m));
    for (const [k, m] of Object.entries(lane.byLocale)) out.push(line(`  locale ${k}`, m));
  }
  out.push('', line(`multi (${Object.entries(MULTI_MODES).map(([l, m]) => `${l}=${m}`).join(' ')})`, r.multi.overall));
  for (const [k, m] of Object.entries(r.multi.byLocale)) out.push(line(`  locale ${k}`, m));
  return out.join('\n');
}
