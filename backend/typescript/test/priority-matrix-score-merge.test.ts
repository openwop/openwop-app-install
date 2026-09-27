/**
 * ADR 0667 D4 (PMXWF-11) — a partial score map from a MODEL lane merges; it never
 * silently deletes the criteria it does not mention.
 *
 * Born red: with `setIdeaScore` a full replace on both paths, leg 1 lost
 * strategic-alignment/urgency/compliance-risk/cost entirely (5 scores → 1), and
 * leg 3's multi-voter merge had no prior-vote source to merge from.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createList, submitIdea, setIdeaScore, listRankedIdeas, getVoteBreakdown, updateList } from '../src/features/priority-matrix/priorityMatrixService.js';

// The SAME durable collection the service writes (priorityMatrixService.ts:44), read
// directly rather than through an invented test-only export.
interface ScoreRow { listId: string; cardId: string; scores: Record<string, number>; source?: string }
const scoreRows = new DurableCollection<ScoreRow>('priority-matrix:score', (s) => `${s.listId}::${s.cardId}`);

const T = 'tScoreMerge';
const ORG = 'org-1';
let listId = '';
let cardId = '';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  const list = await createList(T, ORG, 'u-creator', { name: 'Bets', presetId: 'weighted' });
  listId = list.id;
  const idea = await submitIdea(T, listId, 'u-creator', { title: 'An idea' });
  cardId = idea.id;
  // A human scores all five criteria of the `weighted` preset.
  await setIdeaScore(T, listId, cardId, 'u-human', {
    'strategic-alignment': 8, roi: 7, urgency: 6, 'compliance-risk': 5, cost: 4,
  });
});

describe('ADR 0667 D4 — partial maps from model lanes merge', () => {
  it('leg 1: an agent scoring 1 of 5 criteria leaves the other four STANDING', async () => {
    await setIdeaScore(T, listId, cardId, 'u-agent', { roi: 10 }, 'agent', 'merge');
    const [idea] = await listRankedIdeas(T, listId);
    expect(idea.scores.roi, 'the asserted criterion is updated').toBe(10);
    expect(idea.scores, 'and the four it never mentioned survive').toMatchObject({
      'strategic-alignment': 8, urgency: 6, 'compliance-risk': 5, cost: 4,
    });
    expect(idea.completeness.complete, 'so the idea stays fully scored').toBe(true);
  });

  it('leg 2: the HTTP/default lane still REPLACES — an omitted criterion is cleared', async () => {
    await setIdeaScore(T, listId, cardId, 'u-human', { roi: 9 });
    const [idea] = await listRankedIdeas(T, listId);
    expect(Object.keys(idea.scores)).toEqual(['roi']);
    expect(idea.completeness, 'a form submit that drops four criteria makes it 1 of 5').toMatchObject({ declared: 5, scored: 1, complete: false });
  });

  it('leg 3: multi-voter merges against the CALLER\'S OWN prior vote, never the aggregate', async () => {
    await updateList(T, listId, { votingMode: 'multi-voter' }, 'u-creator');
    await setIdeaScore(T, listId, cardId, 'voter-a', { 'strategic-alignment': 2, roi: 2, urgency: 2, 'compliance-risk': 2, cost: 2 });
    await setIdeaScore(T, listId, cardId, 'voter-b', { 'strategic-alignment': 10, roi: 10, urgency: 10, 'compliance-risk': 10, cost: 10 });
    // voter-a's agent asserts ONE criterion. It must merge onto voter-a's own row —
    // not onto the aggregate, which would credit voter-a with voter-b's 10s.
    await setIdeaScore(T, listId, cardId, 'voter-a', { roi: 6 }, 'agent', 'merge');
    const breakdown = await getVoteBreakdown(T, listId, cardId);
    const a = breakdown.find((v) => v.voterId === 'voter-a');
    expect(a?.scores.roi, 'the asserted value lands').toBe(6);
    expect(a?.scores['strategic-alignment'], 'voter-a keeps her OWN 2, not the aggregate 6').toBe(2);
    expect(a?.scores.cost).toBe(2);
    const b = breakdown.find((v) => v.voterId === 'voter-b');
    expect(b?.scores.roi, 'and voter-b is untouched').toBe(10);
  });

  it('leg 4: a merge that leaves human scores standing does NOT re-stamp them as agent-written', async () => {
    expect((await scoreRows.get(`${listId}::${cardId}`))?.source, 'the human wrote the row').toBe('human');
    await setIdeaScore(T, listId, cardId, 'u-agent', { roi: 10 }, 'agent', 'merge');
    const row = await scoreRows.get(`${listId}::${cardId}`);
    expect(row?.scores.roi).toBe(10);
    // PMXU-1 provenance: four of the five scores are still the human's, so the row must
    // not claim the whole set was agent-written. (Per-criterion provenance is out of
    // scope — ADR 0667 D4 records that as a known imprecision.)
    expect(row?.source, 'surviving human scores are not re-attributed to the agent').toBe('human');
  });

  it('leg 5: a merge that REPLACES every criterion DOES take the new actor class', async () => {
    // The complement of leg 4 — otherwise "keep the prior source" would be a blanket
    // rule that hides a genuinely agent-authored score set behind a stale human stamp.
    await setIdeaScore(T, listId, cardId, 'u-agent', {
      'strategic-alignment': 1, roi: 1, urgency: 1, 'compliance-risk': 1, cost: 1,
    }, 'agent', 'merge');
    expect((await scoreRows.get(`${listId}::${cardId}`))?.source).toBe('agent');
  });
});
