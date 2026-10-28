/**
 * ADR 0904 D1 — the operator-funded Vertex AI embedder (`gemini-embedding-001`), the
 * transport half of the host embedder arm (`resolveHostEmbedder` in `headlessAi.ts` owns
 * WHEN it applies; this file only knows how to call Vertex).
 *
 * Auth is the runtime service account through the ONE metadata client (`gcpAdc.ts`):
 * no key is stored anywhere. Off GCP the token fetch throws, and the caller degrades the
 * search to lexical-only with its honesty label, never to a vector of another model.
 *
 * Vertex `:predict` for this model takes ONE input per request (architect A2), so a batch
 * fans out over a bounded pool (default 8, `OPENWOP_VERTEX_EMBED_CONCURRENCY`) with
 * `Retry-After`-honouring backoff on 429/503. The `*.googleapis.com` call rides
 * `guardedEgressFetch`; only the metadata fetch goes direct (inside `gcpAdc`).
 */
import { gcpMetadata, type GcpMetadataClient } from './gcpAdc.js';
import { guardedEgressFetch } from './webhookEgressGuard.js';

export const VERTEX_EMBEDDING_MODELS = new Set(['gemini-embedding-001']);
/** `gemini-embedding-001` serves Matryoshka widths up to 3072. */
export const VERTEX_EMBEDDING_MAX_DIMS = 3072;

const MAX_ATTEMPTS = 4;
const CALL_TIMEOUT_MS = 15_000;

export interface VertexEmbedderDeps {
  /** The existing budget owner must admit every actual attempt, including
   * retries. A transport caller cannot accidentally omit the spending seam. */
  beforeAttempt: (text: string) => Promise<void>;
  metadata?: GcpMetadataClient;
  /** Injectable for tests; production is the SSRF-guarded fetch. */
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface VertexEmbedCall { calls: number }

function concurrency(env: NodeJS.ProcessEnv): number {
  const n = Number(env.OPENWOP_VERTEX_EMBED_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 32) : 8;
}

function retryAfterMs(h: string | null, attempt: number): number {
  const secs = h !== null ? Number(h) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

function l2Normalize(v: number[]): number[] {
  const scale = Math.max(0, ...v.map(Math.abs));
  if (scale === 0) return v;
  const norm = Math.sqrt(v.reduce((sum, x) => sum + (x / scale) ** 2, 0));
  return v.map(x => (x / scale) / norm);
}

/** Resolve the project once per process: explicit env first, then the metadata server. */
let projectMemo: Promise<string> | null = null;
async function projectId(env: NodeJS.ProcessEnv, md: GcpMetadataClient): Promise<string> {
  const explicit = env.OPENWOP_VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  if (explicit) return explicit;
  projectMemo ??= md.metadataText('project/project-id').catch((err: unknown) => { projectMemo = null; throw err; });
  return projectMemo;
}

export function __resetVertexProjectForTests(): void { projectMemo = null; }

/** Build an embed function for `model` at `dims`. Every vector is L2-normalised (a
 *  truncated Matryoshka head is not unit-length). `stats.calls` counts provider calls. */
export function createVertexEmbed(model: string, dims: number, deps: VertexEmbedderDeps): {
  embed: (texts: readonly string[], inputType: 'query' | 'document') => Promise<number[][]>;
  stats: VertexEmbedCall;
} {
  const env = deps.env ?? process.env;
  const md = deps.metadata ?? gcpMetadata();
  const fetchImpl = deps.fetchImpl ?? ((url, init) => guardedEgressFetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const location = env.OPENWOP_VERTEX_LOCATION || 'us-central1';
  const stats: VertexEmbedCall = { calls: 0 };

  const one = async (url: string, text: string, inputType: 'query' | 'document'): Promise<number[]> => {
    const body = JSON.stringify({
      instances: [{ content: text, task_type: inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' }],
      parameters: { outputDimensionality: dims, autoTruncate: true },
    });
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await md.accessToken();
      await deps.beforeAttempt(text);
      stats.calls += 1;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.ok) {
        const parsed = JSON.parse(await res.text()) as { predictions?: Array<{ embeddings?: { values?: number[] } }> };
        const values = parsed.predictions?.[0]?.embeddings?.values;
        if (!Array.isArray(values) || values.length !== dims || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
          throw new Error(`vertex_embeddings_bad_response: expected a ${dims}-d vector of finite numbers, got ${Array.isArray(values) ? values.length : 'none'}`);
        }
        return l2Normalize(values);
      }
      await res.text().catch(() => ''); // drain the body; never log provider-echoed document bytes
      if (res.status === 401 || res.status === 403) {
        // A rotated/expired token: mint a fresh one and retry ONCE (a second 401/403 is a
        // real permission problem — the runtime SA lacks roles/aiplatform.user).
        md.invalidate();
        if (!refreshed) { refreshed = true; continue; }
      }
      if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(retryAfterMs(res.headers.get('retry-after'), attempt));
        continue;
      }
      throw new Error(`vertex_embeddings_http_${res.status}`);
    }
  };

  return {
    stats,
    embed: async (texts, inputType) => {
      if (texts.length === 0) return [];
      const project = await projectId(env, md);
      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
      const out = new Array<number[]>(texts.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < texts.length) {
          const i = next++;
          out[i] = await one(url, texts[i]!, inputType);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency(env), texts.length) }, worker));
      return out;
    },
  };
}
