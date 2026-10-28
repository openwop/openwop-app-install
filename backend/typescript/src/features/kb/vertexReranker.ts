/**
 * ADR 0904 D8 / P7 (Track 2) — the Vertex AI ranking API as a third `rerank.kind`
 * (`'vertex'`), beside the local scorer and the Cohere connection. Built INERT:
 *
 *  - OFF unless the operator sets `OPENWOP_KB_VERTEX_RERANK=1` — `setRetrievalConfig`
 *    refuses `kind:'vertex'` (422) otherwise, so no collection can even select it;
 *  - the host REFUSES TO BOOT with it on and no `OPENWOP_KB_VERTEX_RERANK_DAILY_CAP`
 *    (per-tenant reranked queries per day): it is the operator's money;
 *  - FAILURE IS A SIGNAL: any miss (no metadata server, HTTP, timeout, cap reached,
 *    malformed body) returns `null` and the caller degrades to the local reranker,
 *    labelled `local-degraded` — exactly as the Cohere arm does.
 *
 * Auth is the runtime service account through the ONE metadata client (`gcpAdc.ts`);
 * the `discoveryengine.googleapis.com` call rides `guardedEgressFetch`. Model
 * `semantic-ranker-default-004`, 15 s timeout. Replay posture is the node boundary, as
 * for the Cohere arm (ADR 0113 P4): a `kb.search`/`kb.rag` node's recorded output is what
 * a fork reads.
 */
import { gcpMetadata, type GcpMetadataClient } from '../../host/gcpAdc.js';
import { guardedEgressFetch } from '../../host/webhookEgressGuard.js';
import { currentEffectContext, assertEffectAllowed } from '../../host/runEffectContext.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';

const MODEL = 'semantic-ranker-default-004';
const TIMEOUT_MS = 15_000;

export function vertexRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENWOP_KB_VERTEX_RERANK === '1';
}

export function vertexRerankDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OPENWOP_KB_VERTEX_RERANK_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Boot guard: on ⇒ a positive per-tenant daily cap is required. */
export function assertVertexRerankBootConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!vertexRerankEnabled(env)) return;
  if (vertexRerankDailyCap(env) <= 0) {
    throw new Error('OPENWOP_KB_VERTEX_RERANK=1 needs OPENWOP_KB_VERTEX_RERANK_DAILY_CAP (per-tenant reranked queries per day) — refusing to boot with operator-funded reranking uncapped (ADR 0904 D8).');
  }
}

interface RerankUsageRow { tenantId: string; dateUtc: string; queries: number }
const usage = new DurableCollection<RerankUsageRow>('kb:vertexrerankusage', (r) => `${r.tenantId}:${r.dateUtc}`);

/** Reserve the existing daily query counter before the paid request. A lost
 * acknowledgement refuses dispatch and retains any possibly committed slot. */
async function reserveQuery(tenantId: string, dateUtc: string, cap: number): Promise<boolean> {
  if (currentEffectContext()?.replaying) {
    try { assertEffectAllowed('network-egress', 'Vertex ranking paid attempt'); } catch { return false; }
  }
  const key = `${tenantId}:${dateUtc}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const prior = await usage.get(key); const used = prior?.queries ?? 0;
      if (!Number.isSafeInteger(used) || used < 0 || used >= cap) return false;
      if (await usage.compareAndSwap(prior, { tenantId, dateUtc, queries: used + 1 })) return true;
    } catch { return false; }
  }
  return false;
}


export interface VertexRerankDeps {
  metadata?: GcpMetadataClient;
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

let testDeps: VertexRerankDeps | null = null;
/** Test seam — no metadata server or Vertex in CI. */
export function __setVertexRerankDepsForTest(deps: VertexRerankDeps | null): void { testDeps = deps; }

/** Rerank `docs` for `query` → top `topN` `[{id, score}]` (score is Vertex's 0–1
 *  relevance), or null on ANY failure, including a reached daily cap. */
export async function vertexRerank(
  tenantId: string, query: string, docs: ReadonlyArray<{ id: string; text: string; title?: string }>, topN: number,
  depsIn: VertexRerankDeps = {},
): Promise<Array<{ id: string; score: number }> | null> {
  const deps = testDeps ? { ...testDeps, ...depsIn } : depsIn;
  const env = deps.env ?? process.env;
  if (!vertexRerankEnabled(env) || !tenantId || tenantId.startsWith('anon:')) return null;
  if (docs.length === 0) return [];
  const dateUtc = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  try {
    const md = deps.metadata ?? gcpMetadata();
    const project = env.OPENWOP_VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT || await md.metadataText('project/project-id');
    const token = await md.accessToken();
    if (!await reserveQuery(tenantId, dateUtc, vertexRerankDailyCap(env))) return null;
    const url = `https://discoveryengine.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/rankingConfigs/default_ranking_config:rank`;
    const fetchImpl = deps.fetchImpl ?? ((u, init) => guardedEgressFetch(u, init));
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: MODEL,
        query,
        topN: Math.max(1, Math.min(topN, docs.length)),
        records: docs.map((d) => ({ id: d.id, content: d.text, ...(d.title ? { title: d.title } : {}) })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.text().catch(() => ''); // drain; never log provider-echoed query/document text
      if (res.status === 401 || res.status === 403) md.invalidate();
      return null;
    }
    const body = JSON.parse(await res.text()) as { records?: unknown };
    if (!Array.isArray(body.records) || body.records.length === 0 || body.records.length > Math.max(1, Math.min(topN, docs.length))) return null;
    const known = new Set(docs.map(d => d.id)); const seen = new Set<string>();
    const ranked: Array<{ id: string; score: number }> = [];
    for (const row of body.records) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !known.has(row.id) || seen.has(row.id)
        || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) return null;
      seen.add(row.id); ranked.push({ id: row.id, score: row.score });
    }
    return ranked;
  } catch {
    return null; // metadata absent (off GCP), timeout, malformed body — degrade, never throw into search
  }
}
