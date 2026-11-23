/**
 * CHAN-F19 follow-up D (ADR 0464 §9, user decision 2026-11-22) — a decision suggestion an
 * AGENT filed from a person's chat message keeps the model's title and summary of their
 * words. `suggestedBy` is the agent, so the eraser never matched it, while the message
 * itself is tombstoned on erasure (ADR 0879 D6).
 *
 * What is pinned here:
 *  - the suggester records the message's author on the suggestion (`sourceAuthorUserId`);
 *  - erasing that author blanks the title and text at every status, keeps the row, its
 *    status and another person's `decidedBy`, and leaves another author's suggestion alone;
 *  - a suggestion from before the field is matched through its source message: by the
 *    message's author, or by the message already being an erasure tombstone.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the `sourceAuthorUserId` spread in processSuggesterQueue removed → "records the author"
 *  - the `authored` arm dropped from eraseSuggestionSubject           → "every status"
 *  - the author match in legacySourceIsSubjects inverted              → "legacy, by author"
 *  - the `erased === true` check removed                               → "legacy, tombstoned"
 *  - the getChatMessage read wrapped in a catch-all again               → "fails the erasure"
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { userRef } from '../src/host/conversationStore.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import {
  createSuggestion, getSuggestion, listSuggestions, dismissSuggestion, markSuggestionRecorded, eraseSuggestionSubject,
} from '../src/features/team-intent-ledger/suggestions.js';
import { processSuggesterQueue } from '../src/features/team-intent-ledger/decisionSuggester.js';

const T = 'org:f19d';
const P = 'proj-1';
const SUBJECT = 'u-subject-f19d';
const OTHER = 'u-other-f19d';
const AGENT = { kind: 'agent' as const, id: 'decision-capture' };

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

const fromMessage = (ref: string, author?: string, conversation = 'chan-1') => createSuggestion({
  tenantId: T, projectId: P, title: `We agreed to ship ${ref}`, text: `Summary of ${ref}`,
  source: { kind: 'message', ref, link: `/chat?conversation=${conversation}` }, suggestedBy: AGENT,
  ...(author ? { sourceAuthorUserId: author } : {}),
});

describe('an agent suggestion from a person’s message follows that person’s erasure', () => {
  it('records the author, and blanks title and text at every status; status and the other decider stay', async () => {
    const open = (await fromMessage('m-open', SUBJECT))!;
    expect(open.sourceAuthorUserId).toBe(SUBJECT);
    const dismissed = (await fromMessage('m-dismissed', SUBJECT))!;
    await dismissSuggestion(T, P, dismissed.suggestionId, OTHER, 'not a decision');
    const recorded = (await fromMessage('m-recorded', SUBJECT))!;
    await markSuggestionRecorded(T, P, recorded.suggestionId, OTHER, 'doc-1');
    const others = (await fromMessage('m-others', OTHER))!;

    await eraseSuggestionSubject(T, SUBJECT);

    for (const [id, status] of [[open.suggestionId, 'open'], [dismissed.suggestionId, 'dismissed'], [recorded.suggestionId, 'recorded']] as const) {
      const s = await getSuggestion(T, id);
      expect(s, id).toMatchObject({ title: ERASED, text: ERASED, status, sourceAuthorUserId: ERASED });
    }
    expect(await getSuggestion(T, dismissed.suggestionId)).toMatchObject({ decidedBy: OTHER, reason: 'not a decision' });
    expect(await getSuggestion(T, recorded.suggestionId)).toMatchObject({ decidedBy: OTHER, documentId: 'doc-1' });
    expect(await getSuggestion(T, others.suggestionId)).toMatchObject({ title: 'We agreed to ship m-others', sourceAuthorUserId: OTHER });
  });
});

describe('the suggester records the author', () => {
  it('records the author: a queued message from a person yields a suggestion that names them', async () => {
    const queue = new DurableCollection<{ key: string; tenantId: string; projectId: string; conversationId: string; messageRef: string; text: string; createdAt: string; authorUserId?: string }>(
      'team-ledger:suggester-queue', (p) => p.key, undefined, (p) => p.tenantId);
    await queue.put({ key: `${T}:chan-1:m-q`, tenantId: T, projectId: P, conversationId: 'chan-1', messageRef: 'm-q', text: 'Let us ship on Friday', createdAt: new Date().toISOString(), authorUserId: SUBJECT });
    const n = await processSuggesterQueue(async () => ({ isDecision: true, title: 'Ship on Friday', summary: 'The team agreed to ship on Friday.' }));
    expect(n).toBe(1);
    const [s] = await listSuggestions(T, P);
    expect(s).toMatchObject({ suggestedBy: AGENT, source: { kind: 'message', ref: 'm-q' }, sourceAuthorUserId: SUBJECT });
  });
});

describe('a suggestion from before the author field is matched through its source message', () => {
  // A message row's session must exist first (a foreign key on the SQL adapters).
  beforeEach(async () => {
    const now = new Date().toISOString();
    await storage.createChatSession({ sessionId: 'chan-1', tenantId: T, title: 'Channel 1', createdAt: now, updatedAt: now, messageCount: 0 });
  });
  const post = (messageId: string, author: string, meta: string | null = null) => storage.appendChatMessage({
    messageId, sessionId: 'chan-1', role: 'user', content: JSON.stringify({ text: 'ship it' }), meta, authorSubject: userRef(author), createdAt: new Date().toISOString(),
  } as Parameters<Storage['appendChatMessage']>[0]);

  it('legacy, by author: the source message was written by the subject', async () => {
    await post('msg-1', SUBJECT);
    await post('msg-2', OTHER);
    const mine = (await fromMessage('msg-1'))!;
    const theirs = (await fromMessage('msg-2'))!;
    await eraseSuggestionSubject(T, SUBJECT);
    expect(await getSuggestion(T, mine.suggestionId)).toMatchObject({ title: ERASED, text: ERASED });
    expect(await getSuggestion(T, theirs.suggestionId)).toMatchObject({ title: 'We agreed to ship msg-2' });
  });

  it('legacy, tombstoned: the chat-post eraser already ran, so the message is an erasure tombstone', async () => {
    await post('msg-3', SUBJECT);
    await storage.redactChatMessagesByAuthor(T, [userRef(SUBJECT)], 'user:[erased]', new Date().toISOString());
    const s = (await fromMessage('msg-3'))!;
    await eraseSuggestionSubject(T, SUBJECT);
    expect(await getSuggestion(T, s.suggestionId)).toMatchObject({ title: ERASED, text: ERASED });
  });

  it('a failed message read fails the erasure (retryable), never a silent "done"', async () => {
    await post('msg-4', SUBJECT);
    const s = (await fromMessage('msg-4'))!;
    const failing = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'getChatMessage') return async () => { throw new Error('storage down'); };
        return Reflect.get(target, prop, receiver);
      },
    });
    initHostExtPersistence(failing);
    await expect(eraseSuggestionSubject(T, SUBJECT)).rejects.toThrow('storage down');
    initHostExtPersistence(storage);
    expect(await getSuggestion(T, s.suggestionId)).toMatchObject({ title: 'We agreed to ship msg-4' }); // untouched, so a retry still finds it
    await eraseSuggestionSubject(T, SUBJECT);
    expect(await getSuggestion(T, s.suggestionId)).toMatchObject({ title: ERASED, text: ERASED });
  });

  it('an unresolvable ref (a chat turn `<session>:<index>`) is left: the stated residual', async () => {
    const s = (await fromMessage('chat-9:4', undefined, 'chat-9'))!;
    await eraseSuggestionSubject(T, SUBJECT);
    expect(await getSuggestion(T, s.suggestionId)).toMatchObject({ title: 'We agreed to ship chat-9:4' });
  });
});
