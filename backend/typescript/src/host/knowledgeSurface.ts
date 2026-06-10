/**
 * `ctx.knowledge` host surface (`host.knowledge`, `spec/v1/host-capabilities.md`
 * §host.knowledge) — the `vendor.myndhyve.knowledge-tools` pack's RAG retrieval.
 *
 * BACKEND SEAM (ADR 0014 Phase 0): the surface resolves through an injectable
 * `KnowledgeBackend` (generalizing the `setNotificationBackend` precedent), so
 * the KB feature (ADR 0011) can back `ctx.knowledge` with the REAL tenant vector
 * store WITHOUT a host→feature import. When no backend is installed — or the
 * backend has nothing for the tenant (no collections) — the surface falls back to
 * a seeded LEXICAL demo corpus, so the demo works out of the box and the wire
 * shape is identical either way. This closes the ADR-0011 open question
 * ("back `host.knowledge` with the real store").
 */

import { createLogger } from '../observability/logger.js';
import type { BundleScope } from './inMemorySurfaces.js';

const log = createLogger('host.knowledge');

interface KnowledgeChunk {
  chunkId: string;
  content: string;
  headingPath: string[];
  pageNumber: number | null;
  documentTitle: string;
  assetId: string;
  collectionId: string;
}

/** Seeded demo corpus. A handful of chunks across two collections so the
 *  retrieve path returns real, differentiated results when no backend is wired. */
const CORPUS: KnowledgeChunk[] = [
  { chunkId: 'c1', assetId: 'doc-onboarding', collectionId: 'handbook', documentTitle: 'Employee Handbook', headingPath: ['Onboarding', 'First Week'], pageNumber: 3, content: 'New hires complete onboarding in the first week: account setup, security training, and a buddy assignment. Expense reimbursement is filed through the finance portal.' },
  { chunkId: 'c2', assetId: 'doc-pto', collectionId: 'handbook', documentTitle: 'Employee Handbook', headingPath: ['Time Off', 'Vacation Policy'], pageNumber: 7, content: 'Paid time off accrues monthly. Vacation requests should be submitted two weeks in advance through the time-off system and approved by a manager.' },
  { chunkId: 'c3', assetId: 'doc-security', collectionId: 'handbook', documentTitle: 'Employee Handbook', headingPath: ['Security', 'Credentials'], pageNumber: 12, content: 'Never share credentials. Rotate API keys quarterly. Report any suspected secret leakage to the security team immediately and revoke the affected key.' },
  { chunkId: 'c4', assetId: 'doc-arch', collectionId: 'engineering', documentTitle: 'Architecture Guide', headingPath: ['Runtime', 'Workflows'], pageNumber: 1, content: 'The workflow engine executes a DAG of nodes. Each node delegates to a host surface. Runs are durable and replayable from the event log.' },
  { chunkId: 'c5', assetId: 'doc-arch', collectionId: 'engineering', documentTitle: 'Architecture Guide', headingPath: ['Runtime', 'Triggers'], pageNumber: 2, content: 'Workflows start from triggers: webhooks, schedules, and queue messages. Trigger payloads are captured at run start and surfaced as trigger data.' },
  { chunkId: 'c6', assetId: 'doc-deploy', collectionId: 'engineering', documentTitle: 'Deployment Runbook', headingPath: ['Release', 'Rollout'], pageNumber: 4, content: 'Deploy the backend before the frontend. Verify the new revision serves traffic, then ship the static site. Roll back by routing traffic to the prior revision.' },
];

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'are', 'be', 'for', 'on', 'by', 'how', 'do', 'i', 'my', 'with']);
function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 1 && !STOP.has(t)) ?? [];
}

export interface KnowledgeRetrieveArgs {
  query: string;
  workspaceId?: string;
  collectionIds?: string[];
  category?: string;
  candidateLimit?: number;
  resultLimit?: number;
  scoreThreshold?: number;
}

export interface KnowledgeResultChunk {
  chunkId: string;
  content: string;
  headingPath: string[];
  pageNumber: number | null;
  documentTitle: string;
  assetId: string;
  collectionId: string;
  relevanceScore: number;
}
export interface KnowledgeSource { sourceId: string; assetId: string; title: string; headingPath: string[]; pageNumber: number | null }
export interface KnowledgeResult { chunks: KnowledgeResultChunk[]; sources: KnowledgeSource[]; latencyMs: number; hasResults: boolean }

export interface KnowledgeSurface {
  retrieve(args: KnowledgeRetrieveArgs): Promise<unknown>;
}

/**
 * A pluggable retrieval backend behind `ctx.knowledge`. Returns `null` to mean
 * "I have nothing for this tenant — use the seeded demo corpus" (so the demo
 * keeps working for tenants with no real knowledge). A non-null result REPLACES
 * the demo for that call.
 */
export interface KnowledgeBackend {
  retrieve(tenantId: string, args: KnowledgeRetrieveArgs): Promise<KnowledgeResult | null>;
}

let backend: KnowledgeBackend | null = null;

/** Install (or clear, with `null`) the knowledge backend. Idempotent; the KB
 *  feature calls this at boot (ADR 0014 Phase 0), mirroring setNotificationBackend. */
export function setKnowledgeBackend(b: KnowledgeBackend | null): void {
  backend = b;
}

const QUERY_MAX = 4000;

export function createKnowledgeSurface(scope: BundleScope): KnowledgeSurface {
  return {
    async retrieve(args: KnowledgeRetrieveArgs) {
      if (typeof args.query !== 'string' || args.query.length === 0) {
        throw Object.assign(new Error('knowledge query is required'), { code: 'knowledge_query_too_long' });
      }
      if (args.query.length > QUERY_MAX) {
        throw Object.assign(new Error('knowledge query too long'), { code: 'knowledge_query_too_long' });
      }
      // Real backend first (the KB feature, tenant-scoped via the run scope); it
      // returns null when the tenant has no real knowledge → seeded demo fallback.
      if (backend) {
        const real = await backend.retrieve(scope.tenantId, args);
        if (real !== null) return real;
      }
      return demoRetrieve(args);
    },
  };
}

/** The seeded LEXICAL demo retrieval (token-frequency over CORPUS) — the default
 *  + the fallback when no real backend has data for the tenant. */
function demoRetrieve(args: KnowledgeRetrieveArgs): KnowledgeResult {
  const { query, collectionIds, candidateLimit = 20, resultLimit = 8, scoreThreshold = 0 } = args;
  const started = Date.now();
  const qTokens = tokenize(query);
  const pool = CORPUS.filter((c) => !collectionIds || collectionIds.length === 0 || collectionIds.includes(c.collectionId));

  const scored = pool.map((c) => {
    const docTokens = tokenize(c.content + ' ' + c.headingPath.join(' ') + ' ' + c.documentTitle);
    let raw = 0;
    for (const qt of qTokens) {
      const tf = docTokens.filter((t) => t === qt).length;
      if (tf > 0) raw += 1 + Math.log(1 + tf);
    }
    return { c, raw };
  }).filter((x) => x.raw > 0);

  scored.sort((a, b) => b.raw - a.raw);
  const top = scored.slice(0, Math.max(1, candidateLimit));
  const maxRaw = top.length ? top[0]!.raw : 1;

  const chunks: KnowledgeResultChunk[] = top
    .map(({ c, raw }) => ({
      chunkId: c.chunkId,
      content: c.content,
      headingPath: c.headingPath,
      pageNumber: c.pageNumber,
      documentTitle: c.documentTitle,
      assetId: c.assetId,
      collectionId: c.collectionId,
      relevanceScore: Math.min(1, raw / maxRaw),
    }))
    .filter((c) => c.relevanceScore >= scoreThreshold)
    .slice(0, Math.max(1, resultLimit));

  const sources: KnowledgeSource[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    if (seen.has(c.assetId)) continue;
    seen.add(c.assetId);
    sources.push({ sourceId: c.assetId, assetId: c.assetId, title: c.documentTitle, headingPath: c.headingPath, pageNumber: c.pageNumber });
  }

  log.info('knowledge retrieve (lexical demo)', { chunks: chunks.length, sources: sources.length });
  return { chunks, sources, latencyMs: Date.now() - started, hasResults: chunks.length > 0 };
}
