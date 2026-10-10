/**
 * Subject-scoped `content` storage + anon adoption (ADR 0434 Phase 3).
 *
 * The defect: chat threads, prompts, and builder drafts lived under BARE
 * localStorage keys. Two consequences, both pinned here:
 *   1. per-device by construction — sign in on machine B and your work is gone;
 *   2. on a SHARED machine, the next person saw the previous user's content.
 *
 * The contract: signed in reads/writes `<key>:<uid>`, anonymous uses the bare
 * key (so nothing pre-Phase-3 needs migrating), and signing in ADOPTS the
 * anonymous content — union, never destroy, signed-in copy wins a collision.
 *
 * Every `adoptLocalContentForSubject` call is AWAITED: the anon→user merge is a
 * lazy import, so an un-awaited call let the assertion run before the merge (the
 * isolation cases then exercised only key scoping, never the adoption path a
 * real leak would ride) and let a dangling merge land in the NEXT test.
 *
 * Sabotage that turns it red: unscope `scopedKey` (`platform/storage.ts`) →
 * the cross-user cases; flip the merge spread in `adoptAnonContent.ts` → the
 * collision case; drop `removeRaw(spec)` in `adoptAnonScoped` → the clear case;
 * disable the `previous === null && subject !== null` branch → every adoption case.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptLocalContentForSubject } from '../localContentAdoption.js';
import { listSavedWorkflows, upsertSavedWorkflow } from '../../builder/persistence/localStore.js';
import { listUserPrompts, upsertUserPrompt } from '../../prompts/userPrompts.js';
import { __resetStorageSubjectForTest, STORAGE_KEYS, scopedKey } from '../../platform/storage.js';
import type { SavedWorkflow } from '../../builder/schema/workflow.js';

const STAMP = '2026-01-01T00:00:00.000Z';

function wf(id: string, name = `wf-${id}`): SavedWorkflow {
  return { id, name, version: '1.0.0', nodes: [], edges: [], createdAt: STAMP, updatedAt: STAMP };
}

beforeEach(() => {
  localStorage.clear();
  __resetStorageSubjectForTest();
});
afterEach(() => {
  localStorage.clear();
  __resetStorageSubjectForTest();
});

describe('cross-user isolation on a shared browser', () => {
  it('user B never sees user A\'s draft workflows', async () => {
    await adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('a-secret'));
    expect(listSavedWorkflows().map((w) => w.id)).toContain('a-secret');

    // A signs out, B signs in on the same browser.
    await adoptLocalContentForSubject(null);
    await adoptLocalContentForSubject('userB');
    expect(listSavedWorkflows().map((w) => w.id)).not.toContain('a-secret');
  });

  it('user B never sees user A\'s prompts', async () => {
    await adoptLocalContentForSubject('userA');
    upsertUserPrompt({ templateId: 'a-private', version: '1.0.0', kind: 'system', text: 'secret', name: 'A private prompt' });
    expect(listUserPrompts().map((p) => p.templateId)).toContain('a-private');

    await adoptLocalContentForSubject(null);
    await adoptLocalContentForSubject('userB');
    expect(listUserPrompts().map((p) => p.templateId)).not.toContain('a-private');
  });

  it('signing back in restores A\'s own content — isolation is not deletion', async () => {
    await adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('a-keep'));
    await adoptLocalContentForSubject(null);
    await adoptLocalContentForSubject('userB');
    await adoptLocalContentForSubject(null);
    await adoptLocalContentForSubject('userA');
    expect(listSavedWorkflows().map((w) => w.id)).toContain('a-keep');
  });
});

describe('prompts adoption (grade fix IDN-1 — the local-only key)', () => {
  it('carries anonymously-authored prompts into the user scope', async () => {
    upsertUserPrompt({ templateId: 'anon-p', version: '1.0.0', kind: 'system', text: 'drafted anonymously' });
    await adoptLocalContentForSubject('userA');
    expect(listUserPrompts().map((p) => p.templateId)).toContain('anon-p');
  });

  it('unions with the user\'s existing prompts, signed-in copy winning', async () => {
    await adoptLocalContentForSubject('userA');
    upsertUserPrompt({ templateId: 'shared-id', version: '1.0.0', kind: 'system', text: 'the user version' });
    upsertUserPrompt({ templateId: 'user-only', version: '1.0.0', kind: 'system', text: 'u' });
    await adoptLocalContentForSubject(null);
    upsertUserPrompt({ templateId: 'shared-id', version: '1.0.0', kind: 'system', text: 'the anon version' });
    upsertUserPrompt({ templateId: 'anon-only', version: '1.0.0', kind: 'system', text: 'a' });

    await adoptLocalContentForSubject('userA');
    const ids = listUserPrompts().map((p) => p.templateId);
    expect(ids).toContain('user-only');
    expect(ids).toContain('anon-only');
    expect(listUserPrompts().find((p) => p.templateId === 'shared-id')?.text).toBe('the user version');
  });
});

describe('anonymous → signed-in adoption', () => {
  it('carries anonymous drafts into the user scope', async () => {
    upsertSavedWorkflow(wf('drafted-anon')); // subject is null → bare key
    await adoptLocalContentForSubject('userA');
    expect(listSavedWorkflows().map((w) => w.id)).toContain('drafted-anon');
  });

  it('UNIONS with pre-existing user content instead of replacing it', async () => {
    await adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('user-owned'));
    await adoptLocalContentForSubject(null);
    upsertSavedWorkflow(wf('anon-owned'));

    await adoptLocalContentForSubject('userA');
    const ids = listSavedWorkflows().map((w) => w.id);
    expect(ids).toContain('user-owned');
    expect(ids).toContain('anon-owned');
  });

  it('prefers the SIGNED-IN copy on an id collision', async () => {
    await adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('same-id', 'the user version'));
    await adoptLocalContentForSubject(null);
    upsertSavedWorkflow(wf('same-id', 'the anon version'));

    await adoptLocalContentForSubject('userA');
    expect(listSavedWorkflows().find((w) => w.id === 'same-id')?.name).toBe('the user version');
  });

  it('clears the anonymous key after adopting, so the next visitor sees nothing', async () => {
    upsertSavedWorkflow(wf('drafted-anon'));
    await adoptLocalContentForSubject('userA');
    expect(localStorage.getItem(STORAGE_KEYS.builderWorkflows.key)).toBeNull();
    expect(localStorage.getItem(scopedKey(STORAGE_KEYS.builderWorkflows, 'userA'))).toBeTruthy();
  });

  it('signing OUT does not drag user content back to the anonymous key', async () => {
    await adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('stays-with-a'));
    await adoptLocalContentForSubject(null);
    expect(listSavedWorkflows().map((w) => w.id)).not.toContain('stays-with-a');
  });
});
