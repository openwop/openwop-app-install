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
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptLocalContentForSubject } from '../localContentAdoption.js';
import { listSavedWorkflows, upsertSavedWorkflow } from '../../builder/persistence/localStore.js';
import { listUserPrompts, upsertUserPrompt } from '../../prompts/userPrompts.js';
import { __resetStorageSubjectForTest, STORAGE_KEYS, scopedKey } from '../../platform/storage.js';
import type { SavedWorkflow } from '../../builder/schema/workflow.js';

function wf(id: string): SavedWorkflow {
  const now = new Date().toISOString();
  return {
    id, name: `wf-${id}`, version: '1.0.0',
    nodes: [{ id: 'n1', kind: 'noop', name: 'n1', position: { x: 0, y: 0 }, config: {} }],
    edges: [], createdAt: now, updatedAt: now,
  } as unknown as SavedWorkflow;
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
  it('user B never sees user A\'s draft workflows', () => {
    adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('a-secret'));
    expect(listSavedWorkflows().map((w) => w.id)).toContain('a-secret');

    // A signs out, B signs in on the same browser.
    adoptLocalContentForSubject(null);
    adoptLocalContentForSubject('userB');
    expect(listSavedWorkflows().map((w) => w.id)).not.toContain('a-secret');
  });

  it('user B never sees user A\'s prompts', () => {
    adoptLocalContentForSubject('userA');
    upsertUserPrompt({ templateId: 'a-private', version: '1.0.0', kind: 'system', text: 'secret', name: 'A private prompt' });
    expect(listUserPrompts().length).toBeGreaterThan(0);

    adoptLocalContentForSubject(null);
    adoptLocalContentForSubject('userB');
    expect(listUserPrompts().map((p) => p.templateId)).not.toContain('a-private');
  });

  it('signing back in restores A\'s own content — isolation is not deletion', () => {
    adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('a-keep'));
    adoptLocalContentForSubject(null);
    adoptLocalContentForSubject('userB');
    adoptLocalContentForSubject(null);
    adoptLocalContentForSubject('userA');
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
    adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('user-owned'));
    adoptLocalContentForSubject(null);
    upsertSavedWorkflow(wf('anon-owned'));

    await adoptLocalContentForSubject('userA');
    const ids = listSavedWorkflows().map((w) => w.id);
    expect(ids).toContain('user-owned');
    expect(ids).toContain('anon-owned');
  });

  it('prefers the SIGNED-IN copy on an id collision', async () => {
    adoptLocalContentForSubject('userA');
    upsertSavedWorkflow({ ...wf('same-id'), name: 'the user version' } as SavedWorkflow);
    adoptLocalContentForSubject(null);
    upsertSavedWorkflow({ ...wf('same-id'), name: 'the anon version' } as SavedWorkflow);

    await adoptLocalContentForSubject('userA');
    expect(listSavedWorkflows().find((w) => w.id === 'same-id')?.name).toBe('the user version');
  });

  it('clears the anonymous key after adopting, so the next visitor sees nothing', async () => {
    upsertSavedWorkflow(wf('drafted-anon'));
    await adoptLocalContentForSubject('userA');
    expect(localStorage.getItem(STORAGE_KEYS.builderWorkflows.key)).toBeNull();
    expect(localStorage.getItem(scopedKey(STORAGE_KEYS.builderWorkflows, 'userA'))).toBeTruthy();
  });

  it('signing OUT does not drag user content back to the anonymous key', () => {
    adoptLocalContentForSubject('userA');
    upsertSavedWorkflow(wf('stays-with-a'));
    adoptLocalContentForSubject(null);
    expect(listSavedWorkflows().map((w) => w.id)).not.toContain('stays-with-a');
  });
});
