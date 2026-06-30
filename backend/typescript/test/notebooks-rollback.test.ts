/**
 * NB-5 — `createNotebook` is atomic: a failure AFTER the project is created (the KB collection
 * or its binding throwing) must ROLL BACK the project, not leave an orphaned `facet:'notebook'`
 * project that is invisible (toNotebook ⇒ null, 404 on get, filtered from the list) yet still
 * counts against the workspace cap. Found by the post-grade `/code-review` deep read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

// Make the SECOND provisioning step (the KB collection) fail, after createProject has succeeded.
vi.mock('../src/features/kb/kbService.js', async (orig) => {
  const actual = await orig<typeof import('../src/features/kb/kbService.js')>();
  return { ...actual, createCollection: vi.fn(async () => { throw new Error('kb collection unavailable'); }) };
});

import { createNotebook, listNotebooks } from '../src/features/notebooks/notebooksService.js';
import { listProjects } from '../src/features/projects/projectsService.js';

beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); });
afterEach(() => vi.restoreAllMocks());

describe('NB-5 — createNotebook rolls back a partial provision', () => {
  it('a createCollection failure leaves NO orphaned facet:notebook project (the create is atomic)', async () => {
    await expect(createNotebook('t', 't', 'actor', { name: 'Doomed' })).rejects.toThrow('kb collection unavailable');

    // The rollback deleted the just-minted project — no phantom consuming the workspace cap.
    expect((await listProjects('t')).filter((p) => p.facet === 'notebook')).toHaveLength(0);
    expect(await listNotebooks('t')).toHaveLength(0);
  });
});
