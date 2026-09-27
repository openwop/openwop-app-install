/**
 * UX_UPGRADE-projects ROUND 3 — the two residuals R2 recorded as open, now closed.
 *
 *  - R3-A: `cleanString` SCRUBS as well as truncates — a 40+ char unbroken token
 *    (a long hash, a URL slug) in a goal/brief became `[REDACTED:secret-shaped]`
 *    on a 200: a silent server mutation, same class as PRJ2-M5's truncation.
 *    A secret-shaped charter field is now a TYPED REFUSAL naming the field, and
 *    the stored charter is untouched. Both polarities: prose saves verbatim.
 *  - R3-B: `deleteNotebook` trusted `collectionIds[0]` as "the notebook's own
 *    collection" — but position 0 is bind-order, not ownership, and the Knowledge
 *    tab can put a SHARED collection there. The surface-provisioned collection is
 *    now STAMPED on the project row (`notebookCollectionId`) and ONLY it is
 *    deleted.
 *
 *    CORRECTED by ADR 0601 § Corrections (HIGH-1): R3's original fallback —
 *    "legacy rows fall back to position 0 when its name carries the provisioning
 *    prefix" — is GONE. A prefix match on a user-chosen name is not evidence of
 *    ownership, and it destroyed shared corpora named `Sources: <topic>`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createProject, updateProject, getProject, projectSubject } from '../src/features/projects/projectsService.js';
import { createNotebook, deleteNotebook, ensureNotebookForProject } from '../src/features/notebooks/notebooksService.js';
import { createCollection, getCollection } from '../src/features/kb/kbService.js';
import { setSubjectKnowledge } from '../src/host/subjectKnowledge.js';

const T = 'tenant-r3-residuals';
const ORG = 'org-1';

beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('R3-A — a secret-shaped charter field refuses typed instead of mutating on a 200', () => {
  it('a goal carrying an API-key shape is refused naming the field, and nothing is rewritten', async () => {
    const { id } = await createProject(T, ORG, { name: 'Scrub' });
    await updateProject(T, id, { charter: { goal: 'Ship it' } });
    const key = `deploy with AKIA${'A1B2C3D4E5F6'.repeat(2)} today`;
    await expect(updateProject(T, id, { charter: { goal: key } })).rejects.toMatchObject({ code: 'validation_error', details: { field: 'charter.goal' } });
    // The refusal left the stored charter exactly as it was — no [REDACTED:…] rewrite.
    expect((await getProject(T, id))!.charter?.goal).toBe('Ship it');
  });

  it('a brief with a 40+ char unbroken blob is refused; ordinary prose saves verbatim', async () => {
    const { id } = await createProject(T, ORG, { name: 'Scrub2' });
    const blob = `see ${'a'.repeat(48)} for context`;
    await expect(updateProject(T, id, { charter: { brief: blob } })).rejects.toMatchObject({ code: 'validation_error', details: { field: 'charter.brief' } });
    const prose = 'A perfectly ordinary brief with normal words and no long tokens.';
    const saved = await updateProject(T, id, { charter: { brief: prose } });
    expect(saved.charter?.brief).toBe(prose);
  });
});

describe('R3-B — deleteNotebook deletes only the surface-provisioned collection', () => {
  it('a SHARED collection sitting at position 0 survives the delete; the stamped one goes', async () => {
    const nb = await createNotebook(T, ORG, 'actor', { name: 'Research' });
    expect((await getProject(T, nb.id))!.notebookCollectionId).toBe(nb.collectionId); // the stamp
    const shared = await createCollection(T, ORG, 'actor', { name: 'Team KB', description: 'shared corpus' });
    // The Knowledge-tab state the R2 note warned about: the shared collection is bound FIRST.
    await setSubjectKnowledge(T, projectSubject(nb.id), { collectionIds: [shared.collectionId, nb.collectionId] });
    const out = await deleteNotebook(T, nb.id);
    expect(out.deleted).toBe(true);
    expect(out.collectionDeleted).toBe(true);
    expect(await getCollection(T, ORG, shared.collectionId)).not.toBeNull();  // the shared corpus LIVES
    expect(await getCollection(T, ORG, nb.collectionId)).toBeNull();          // the notebook's own is gone
  });

  it('a legacy row (no stamp) deletes NOTHING — the name is not evidence of ownership', async () => {
    // REWRITTEN (ADR 0601 § Corrections / HIGH-1). This test used to assert that
    // a legacy row's position-0 collection IS deleted when its name starts
    // `Notebook: ` / `Sources: `. That was a test pinning a defect: the fallback
    // it defended is a prefix match on a name the USER chooses, so a shared
    // research corpus a team called `Sources: Q3 research` was destroyed for
    // every project bound to it. The two cases below are byte-identical to the
    // delete — same absent stamp, same position 0 — and differ only in a string,
    // which is exactly why a string cannot be the discriminator.
    //
    // The cost is stated rather than hidden: a legacy notebook loses AUTO-CLEANUP
    // and leaves an orphaned collection. An orphan is listed, readable and
    // deletable by hand; a destroyed shared corpus is none of those. `deleted` is
    // still true and `collectionDeleted` still reports the truth, so nothing lies
    // about what happened.
    const legacy = await createProject(T, ORG, { name: 'Old notes', facet: 'notebook' });
    const own = await createCollection(T, ORG, 'actor', { name: 'Notebook: Old notes', description: 'sources' });
    await setSubjectKnowledge(T, projectSubject(legacy.id), { collectionIds: [own.collectionId] });
    const out = await deleteNotebook(T, legacy.id);
    expect(out.deleted).toBe(true);
    expect(out.collectionDeleted, 'an unstamped collection is never erased, however it is named').toBe(false);
    expect(await getCollection(T, ORG, own.collectionId)).not.toBeNull();

    // The same shape with an ordinary name — identical outcome, which is the point.
    const risky = await createProject(T, ORG, { name: 'Risky', facet: 'notebook' });
    const shared = await createCollection(T, ORG, 'actor', { name: 'Marketing corpus', description: 'shared' });
    await setSubjectKnowledge(T, projectSubject(risky.id), { collectionIds: [shared.collectionId] });
    const spared = await deleteNotebook(T, risky.id);
    expect(spared.deleted).toBe(true);
    expect(spared.collectionDeleted).toBe(false);
    expect(await getCollection(T, ORG, shared.collectionId)).not.toBeNull();
  });

  it('and BOTH lanes that provision a corpus DO stamp it, so nothing live is stranded', async () => {
    // The load-bearing precondition for dropping the name fallback. If a live
    // provisioning path did not stamp, "only legacy rows lose auto-cleanup"
    // would be false and the trade above would be a different, worse one.
    const created = await createNotebook(T, ORG, 'actor', { name: 'Via POST /notebooks' });
    expect((await getProject(T, created.id))!.notebookCollectionId).toBe(created.collectionId);

    const plain = await createProject(T, ORG, { name: 'Via the Sources tab' });
    const ensured = await ensureNotebookForProject(T, plain.id, 'actor');
    expect((await getProject(T, plain.id))!.notebookCollectionId).toBe(ensured.collectionId);
  });
});

describe('PRJC-6 — `name` joins the typed-refusal discipline (no silent scrub on a 200)', () => {
  it('a secret-shaped CREATE name is refused naming the field; ordinary names save verbatim', async () => {
    // The residual R3-A left open: `cleanString(input.name, 120)` scrubbed a
    // secret-shaped name to `[REDACTED:secret-shaped]` on a 200 while every
    // charter field already refused typed.
    await expect(createProject(T, ORG, { name: `k-${'a'.repeat(48)}` }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'name' } });
    const ok = await createProject(T, ORG, { name: 'A perfectly ordinary project' });
    expect(ok.name).toBe('A perfectly ordinary project');
  });

  it('a secret-shaped RENAME is refused and the stored name is untouched', async () => {
    const { id } = await createProject(T, ORG, { name: 'Before' });
    await expect(updateProject(T, id, { name: `AKIA${'A1B2C3D4E5F6'.repeat(2)}` }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'name' } });
    expect((await getProject(T, id))!.name).toBe('Before');
  });
});

describe('PRJC-7 — `workflows` is bounded and element-validated (typed refusal, never silent mutation)', () => {
  it('refuses a portfolio over the count cap, naming the cap', async () => {
    const { id } = await createProject(T, ORG, { name: 'Portfolio' });
    const many = Array.from({ length: 51 }, (_, i) => `wf-${i}`);
    await expect(updateProject(T, id, { workflows: many }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'workflows', cap: 50 } });
    expect((await getProject(T, id))!.workflows).toEqual([]); // untouched
  });

  it('refuses an id the server cannot store faithfully (empty / over-length / not id-shaped)', async () => {
    const { id } = await createProject(T, ORG, { name: 'Portfolio2' });
    await expect(updateProject(T, id, { workflows: ['wf-ok', ''] }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'workflows', index: 1 } });
    await expect(updateProject(T, id, { workflows: [`wf-${'x'.repeat(220)}`] }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'workflows', index: 0 } });
    // Not id-shaped: interior whitespace / non-token characters.
    await expect(updateProject(T, id, { workflows: ['wf ok'] }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'workflows', index: 0 } });
    expect((await getProject(T, id))!.workflows).toEqual([]);
  });

  it('a valid portfolio at the cap still saves — including the platform’s own `agent-wf-<uuid>` shape (negative control)', async () => {
    const { id } = await createProject(T, ORG, { name: 'Portfolio3' });
    // REGRESSION PIN (adversarial-review F1): `agent-wf-${uuid}` is 45 chars of
    // [A-Za-z0-9-] — hyphens do NOT break the token for `scrubSecretShaped`'s
    // `[A-Za-z0-9_-]{40,}` blob arm, so validating ids through the free-TEXT
    // scrub oracle (`cleanString`) rejected the platform's OWN minted workflow
    // ids (`workflowComposeTool.ts`), making any portfolio containing one
    // permanently un-PATCHable. Ids must ride an id-shaped rule instead.
    const atCap = Array.from({ length: 49 }, (_, i) => `wf-${i}`);
    atCap.push('agent-wf-1b671a64-40d5-491e-99b0-da01ff1f3341');
    const saved = await updateProject(T, id, { workflows: atCap });
    expect(saved.workflows).toEqual(atCap);
  });
});
