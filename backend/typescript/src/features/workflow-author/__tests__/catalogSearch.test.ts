/**
 * ADR 0791 — the pure catalog search behind the Architect's `draft` tool.
 */
import { describe, expect, it } from 'vitest';
import { searchAuthoringCatalog, selectExcluded, tokenize, CATALOG_SEARCH_MAX_LIMIT, GENERAL_BLOCKS, NO_DEDICATED_MATCH_HINT } from '../catalogSearch.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import type { AuthorCatalogNode } from '../workflowAuthorService.js';

const node = (typeId: string, label: string, category: string, description = ''): AuthorCatalogNode =>
  ({ typeId, label, category, description, configSchema: { type: 'object' } });

const CATALOG: AuthorCatalogNode[] = [
  node('core.flow.if', 'If / else', 'flow', 'Two-branch conditional based on a predicate'),
  node('core.email.send', 'Send email', 'integration', 'Send an email through the workspace connection'),
  node('feature.crm.nodes.create-contact', 'Create contact', 'integration', 'Create a CRM contact'),
  node('feature.crm.nodes.create-deal', 'Create deal', 'integration', 'Create a CRM deal'),
  node('core.trigger.manual', 'Manual trigger', 'flow', 'Start a run by hand'),
  node('core.data.idempotency', 'Idempotency key', 'data', 'Deduplicates repeated deliveries'),
  node('core.noop', 'Pass-through', 'flow', 'Does nothing'),
];

describe('searchAuthoringCatalog', () => {
  it('ranks the best match first, with schemas intact', () => {
    const r = searchAuthoringCatalog(CATALOG, { query: 'create a CRM contact' });
    expect(r.nodes[0]!.typeId).toBe('feature.crm.nodes.create-contact');
    expect(r.nodes[0]!.configSchema).toEqual({ type: 'object' });
  });

  it('drops stopwords, so a sentence and its keywords rank alike', () => {
    expect(tokenize('Send an email to the lead')).toEqual(['send', 'email', 'lead']);
    expect(searchAuthoringCatalog(CATALOG, { query: 'send an email to the lead' }).nodes[0]!.typeId).toBe('core.email.send');
  });

  it('stems longer words ("deduplicate" finds "Deduplicates")', () => {
    expect(searchAuthoringCatalog(CATALOG, { query: 'deduplicate' }).nodes.map((n) => n.typeId)).toContain('core.data.idempotency');
  });

  it('an exact typeId query returns that type first', () => {
    expect(searchAuthoringCatalog(CATALOG, { query: 'core.noop' }).nodes[0]!.typeId).toBe('core.noop');
  });

  it('caps the limit, and never repeats a type fetched by id', () => {
    const r = searchAuthoringCatalog(CATALOG, { query: 'create', typeIds: ['feature.crm.nodes.create-deal'], limit: 999 });
    const ids = r.nodes.map((n) => n.typeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('feature.crm.nodes.create-deal');
    expect(searchAuthoringCatalog(CATALOG, { query: 'e', limit: 999 }).nodes.length).toBeLessThanOrEqual(CATALOG_SEARCH_MAX_LIMIT);
  });

  it('an empty read and a no-match search both say what exists', () => {
    const empty = searchAuthoringCatalog(CATALOG, {});
    expect(empty.nodes).toEqual([]);
    expect(empty.categories).toEqual({ flow: 3, integration: 3, data: 1 });
    expect(searchAuthoringCatalog(CATALOG, { query: 'zzzqqq' }).categories).toBeDefined();
  });

  it('is deterministic', () => {
    const a = searchAuthoringCatalog(CATALOG, { query: 'create' }).nodes.map((n) => n.typeId);
    const b = searchAuthoringCatalog([...CATALOG].reverse(), { query: 'create' }).nodes.map((n) => n.typeId);
    expect(a).toEqual(b);
  });
});

describe('selectExcluded (ADR 0791 correction, ADR 0773 B.2)', () => {
  const EXCLUDED = [
    { typeId: 'feature.gmail.nodes.send-email', reason: 'missing host surface(s): gmail' },
    { typeId: 'feature.slack.nodes.post-message', reason: 'pack disabled in this workspace' },
    { typeId: 'core.media.transcode', reason: 'schema too large to inline (>8KB)' },
  ];
  const pick = (input: { query?: string; typeIds?: string[] }) =>
    selectExcluded(EXCLUDED, input, searchAuthoringCatalog(CATALOG, input));

  it('carries only the withheld nodes a search matches, and always the total', () => {
    const r = pick({ query: 'send an email' });
    expect(r.excluded.map((e) => e.typeId)).toEqual(['feature.gmail.nodes.send-email']);
    expect(r.excludedTotal).toBe(3);
  });

  it('carries none when the search matches no withheld node', () => {
    expect(pick({ query: 'create a CRM contact' }).excluded).toEqual([]);
  });

  it('carries a withheld node the ask names by typeId, with its reason', () => {
    expect(pick({ typeIds: ['core.noop', 'feature.slack.nodes.post-message'] }).excluded)
      .toEqual([{ typeId: 'feature.slack.nodes.post-message', reason: 'pack disabled in this workspace' }]);
  });

  it('carries ALL of them on an empty read and on a search that matched nothing', () => {
    expect(pick({}).excluded).toHaveLength(3);
    expect(pick({ query: 'zzzz qqqq' }).excluded).toHaveLength(3);
  });

  it('stems longer words, as the node search does ("transcoding" finds transcode)', () => {
    // "manual" matches a catalog node, so this is a search WITH matches.
    expect(pick({ query: 'manual transcoding' }).excluded.map((e) => e.typeId)).toEqual(['core.media.transcode']);
  });
});

describe('noDedicatedMatch — a stopping point for the search (ADR 0773 G-10b, ADR 0791 correction)', () => {
  // The measured failure: "score the lead" found other features' scorers, the
  // model rejected them, and searched again until the turn ran out.
  const WITH_BLOCKS: AuthorCatalogNode[] = [
    ...CATALOG,
    node('feature.job-search.nodes.score-fit', 'Job Search: Score Fit', 'integration', 'Score how well a job fits'),
    node('feature.priority-matrix.nodes.score-idea', 'Priority Matrix: Score Idea', 'integration', 'Score an idea'),
    node('core.openwop.ai.classify', 'AI Classify', 'ai', 'Classify input with a model'),
    node('core.flow.if', 'If', 'flow', 'Branch on a predicate'),
  ];

  it('near-misses only ("score a lead" vs other features\' scorers) ⇒ noDedicatedMatch with the general blocks', () => {
    const r = searchAuthoringCatalog(WITH_BLOCKS, { query: 'score a lead' });
    expect(r.nodes.length).toBeGreaterThan(0); // the near-misses are still returned
    expect(r.noDedicatedMatch).toBe(true);
    expect(r.generalBlocks?.map((b) => b.typeId)).toEqual(['core.openwop.ai.classify', 'core.flow.if']);
    expect(r.generalBlocks?.[0]?.label).toBe('AI Classify'); // the catalog's label, not ours
    // Full entries, schemas included: nothing left to fetch (B.6 — "fetch with
    // typeIds" was read as the schema.lookup tool and cost the turn).
    expect(r.generalBlocks?.[0]?.configSchema).toEqual({ type: 'object' });
    expect(r.hint).toBe(NO_DEDICATED_MATCH_HINT);
  });

  it('no match at all ("tag duplicate leads") ⇒ noDedicatedMatch too', () => {
    expect(searchAuthoringCatalog(WITH_BLOCKS, { query: 'tag duplicate leads' }).noDedicatedMatch).toBe(true);
  });

  it('a node MADE for the ask carries no hint (create CRM contact, send email, one-word and exact-id queries)', () => {
    for (const query of ['create a CRM contact', 'send an email', 'noop', 'core.flow.if']) {
      const r = searchAuthoringCatalog(WITH_BLOCKS, { query });
      expect(r.noDedicatedMatch, query).toBeUndefined();
      expect(r.generalBlocks, query).toBeUndefined();
    }
  });

  it('lists only blocks this workspace\'s catalog has, and stays silent when it has none', () => {
    const bare = CATALOG.filter((n) => !GENERAL_BLOCKS.some((b) => b.typeId === n.typeId));
    expect(bare.length).toBeLessThan(CATALOG.length); // the fixture did contain one
    expect(searchAuthoringCatalog(bare, { query: 'score a lead' }).noDedicatedMatch).toBeUndefined();
  });

  it('a typeIds-only fetch is not a search and carries no hint', () => {
    expect(searchAuthoringCatalog(WITH_BLOCKS, { typeIds: ['core.flow.if'] }).noDedicatedMatch).toBeUndefined();
  });

  it('every GENERAL_BLOCKS typeId is a node in a vendored pack (the list cannot drift from the catalog)', () => {
    const packsDir = new URL('../../../../../../packs/', import.meta.url);
    const vendored = new Set<string>();
    for (const dir of readdirSync(packsDir)) {
      const f = new URL(`${dir}/pack.json`, packsDir);
      if (!existsSync(f)) continue;
      const nodes = (JSON.parse(readFileSync(f, 'utf8')) as { nodes?: Array<{ typeId?: string }> }).nodes ?? [];
      for (const n of nodes) if (n.typeId) vendored.add(n.typeId);
    }
    expect(vendored.size).toBeGreaterThan(100); // the scan reached the packs
    for (const b of GENERAL_BLOCKS) expect(vendored.has(b.typeId), b.typeId).toBe(true);
  });
});
