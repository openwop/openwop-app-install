/**
 * Phase 8 "employable agent depth" (app-seeding-strategy.md §4, ADR 0031).
 *
 * Seeds a persona's memories and a bound knowledge collection — keyed by the new
 * member's rosterId — from the additive `SeedAgent` fields. Called LAST in the
 * roster-member create path AND from the heal branch (both in
 * `exampleDataSeed.ts`), so it is idempotent on every path.
 *
 * NOTE: the demo NO LONGER seeds a "kickoff" AI-chat thread. Fabricated sample
 * chat exchanges polluted each agent's real chat history (and were never cleared
 * by the roster cascade); `clearExampleAgents` now sweeps any leftover
 * `demo-kickoff:*` threads (ADR 0321 addendum).
 *
 * This host helper owns the feature-service imports (agent-knowledge, memory) so
 * `exampleDataSeed.ts` itself stays free of feature imports (ADR 0001) — the same
 * host→feature pattern the sibling `demo*Seed.ts` use.
 */
import { createLogger } from '../observability/logger.js';
import { rosterSubject } from './subject.js';
import { addSubjectNote, countSubjectNotes } from './subjectMemory.js';
import { listOrgs } from './accessControlService.js';
import { PREAUTHORIZED_CALLER } from './subjectAccess.js'; // ADR 0643 R4 Blocker 2 — the one non-HTTP reader of getAgentKnowledge, by name
import { createBoundCollection, ingestDocToAgent, getAgentKnowledge } from '../features/agent-knowledge/service.js';

const log = createLogger('seed.demoAgentDepth');
const ACTOR = 'demo:agent-depth';

/** A persona's authored depth (mirrors the optional SeedAgent fields). */
export interface AgentDepthSpec {
  persona: string;
  memories?: string[];
  knowledge?: { collections: { name: string; description?: string; documents: { title: string; content: string }[] }[] };
}

/**
 * Idempotent + heal-aware. Memories seed only when the agent has none yet;
 * knowledge collections/docs seed only when absent (matched by name/title).
 * Returns what it created this call (0s on a no-op re-run — the heal invariant).
 */
export async function seedAgentDepth(
  tenantId: string,
  spec: AgentDepthSpec,
  rosterId: string,
): Promise<{ memories: number; knowledgeDocs: number }> {
  const subject = rosterSubject(rosterId);
  let memories = 0;
  let knowledgeDocs = 0;

  // 1) Memories — seed the whole set only when the agent has no notes yet, so a
  //    re-seed/heal never duplicates or resurrects a user's deletions.
  const firstTime = (await countSubjectNotes(tenantId, subject)) === 0;
  if (firstTime && spec.memories?.length) {
    for (const m of spec.memories.slice(0, 200)) {
      await addSubjectNote(tenantId, subject, m);
      memories += 1;
    }
  }

  // 2) Knowledge — one bound collection per persona; guard by name + doc title.
  if (spec.knowledge?.collections?.length) {
    const orgId = (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
    // ADR 0643 R4 (Blocker 2) — the ONE non-HTTP reader, and the bypass is spelled by
    // name: a demo seed has no principal and binds only collections it mints itself.
    const existing = await getAgentKnowledge(tenantId, rosterId, PREAUTHORIZED_CALLER).catch(() => null);
    const existingCols = new Map((existing?.collections ?? []).map((c) => [c.name, new Set((c.documents ?? []).map((d) => d.title))]));
    for (const col of spec.knowledge.collections) {
      let docTitles = existingCols.get(col.name);
      let collectionId: string | undefined;
      if (!docTitles) {
        const bound = await createBoundCollection(tenantId, orgId, ACTOR, rosterId, { name: col.name, description: col.description });
        collectionId = bound.collectionId;
        docTitles = new Set();
      } else {
        // Find the existing collection's id for further ingests.
        collectionId = (existing?.collections ?? []).find((c) => c.name === col.name)?.collectionId;
      }
      if (!collectionId) continue;
      for (const doc of col.documents) {
        if (docTitles.has(doc.title)) continue;
        // NB: the ingest field is `text`, not `content`.
        await ingestDocToAgent(tenantId, orgId, ACTOR, rosterId, collectionId, { title: doc.title, text: doc.content });
        knowledgeDocs += 1;
      }
    }
  }

  if (memories || knowledgeDocs) {
    log.info('demo_agent_depth_seeded', { tenantId, persona: spec.persona, memories, knowledgeDocs });
  }
  return { memories, knowledgeDocs };
}
