/**
 * ADR 0116 Phase 1 / ADR 0993 — prompt-library catalog service.
 * Dangling-ref rejection (the catalog must point at a real template, resolved for
 * the entry's own tenant, ADR 0993 D5), CRUD, tenant/org isolation, and the owner
 * lane: a private entry is its owner's on EVERY lane, read and write (ADR 0993 D2).
 * RBAC + toggle gating are enforced at the route via the shared `authorizeOrgScope`
 * (tested in the feature-route suites).
 *
 * Tenant/org isolation is a DOUBLE guard: the row key carries tenant + org AND each
 * read re-checks the row's fields. A probe on either half alone stays green, so each
 * read is witnessed by one edit that drops both (`w118g2-pl-get-both`,
 * `w118g2-pl-list-both`). The trailing-`@` rule is doubled too (`parsePromptRef`
 * strips it, and `resolveRef` treats an empty version as unpinned).
 *
 * Breaks if: dangling-ref validation (create, update), the name check, the `private`
 * default, the PLC-1 read predicate, the write lane's readable check, delete, the
 * tenant/org get and list filters, `{{var}}` substitution (bound and missing), the
 * PLC-2 `@version` pin, the surface's caller canonicalization or its tenant closure
 * regresses (probes w24g1-pl-*, re-probed at ADR 0993 as `w118g2-pl-*`).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createTenantTemplate } from '../src/host/tenantPromptTemplates.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { createEntry, listEntries, getEntry, updateEntry, deleteEntry, renderEntry } from '../src/features/prompts/promptLibraryService.js';
import { buildPromptSurface } from '../src/features/prompts/promptSurface.js';

const T = 'pl-tenant';

let orgN = 0;
let ORG = 'org-a'; // reassigned per test (a fresh org per case, beside the fresh store)

// ADR 0993 D5 — a user template belongs to ONE tenant (the entries' tenant).
async function seedTemplate(id: string): Promise<void> {
  const out = await createTenantTemplate(T, { templateId: id, version: '1.0.0', kind: 'user', text: 'Hello {{name}}', name: id });
  expect(out.ok, JSON.stringify(out)).toBe(true);
}

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-promptlib-')) });
});
// A fresh store per test: templates are durable now, so ids would collide across tests.
beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); ORG = `org-${orgN++}`; });

describe('prompt-library service', () => {
  it('creates an entry referencing a real template', async () => {
    await seedTemplate('tpl-greet');
    const e = await createEntry(T, ORG, 'u1', { name: 'Greeting', promptRef: 'tpl-greet', tags: ['intro', 'demo'], visibility: 'org' });
    expect(e.entryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.promptRef).toBe('tpl-greet');
    expect(e.visibility).toBe('org');
    expect(e.tags).toEqual(['intro', 'demo']);
    expect([e.createdBy, e.updatedBy]).toEqual(['u1', 'u1']);
    // Persisted, not only returned: a fresh read gives the same entry back.
    const read = await getEntry(T, ORG, e.entryId, 'u1');
    expect([read?.name, read?.promptRef, read?.available]).toEqual(['Greeting', 'tpl-greet', true]);
  });

  it('rejects a dangling promptRef', async () => {
    await expect(createEntry(T, ORG, 'u1', { name: 'Bad', promptRef: 'does-not-exist' }))
      .rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('does not resolve') });
  });

  it('requires a name', async () => {
    await seedTemplate('tpl-x');
    await expect(createEntry(T, ORG, 'u1', { promptRef: 'tpl-x' })).rejects.toMatchObject({ code: 'validation_error', message: 'Field `name` is required.' });
  });

  it('defaults visibility to private', async () => {
    await seedTemplate('tpl-p');
    const e = await createEntry(T, ORG, 'u1', { name: 'P', promptRef: 'tpl-p' });
    expect(e.visibility).toBe('private');
  });

  it('lists, gets, updates, and deletes', async () => {
    await seedTemplate('tpl-1'); await seedTemplate('tpl-2');
    const a = await createEntry(T, ORG, 'u1', { name: 'A', promptRef: 'tpl-1' });
    await createEntry(T, ORG, 'u1', { name: 'B', promptRef: 'tpl-2' });
    expect((await listEntries(T, ORG, 'u1')).length).toBe(2);

    // ADR 0993 D2 — a private entry is its owner's on EVERY lane (ADR 0694 leg 4,
    // which kept ordinary fields org-writable, is overturned): a non-owner gets the
    // read lane's uniform 404. Once the owner widens it, any org writer edits it.
    await expect(updateEntry(T, ORG, a.entryId, 'u2', { name: 'A2' })).rejects.toMatchObject({ code: 'not_found' });
    const updated = await updateEntry(T, ORG, a.entryId, 'u1', { visibility: 'shared' });
    expect(updated.visibility, 'the OWNER may widen it').toBe('shared');
    const renamed = await updateEntry(T, ORG, a.entryId, 'u2', { name: 'A2' }); // a non-owner may edit an org-visible entry's fields
    expect(renamed.name, 'an org-visible entry stays org-writable').toBe('A2');
    expect(renamed.updatedBy).toBe('u2');
    expect(renamed.visibility, 'and an edit that does not name visibility never changes it').toBe('shared');

    await deleteEntry(T, ORG, a.entryId, 'u1');
    expect(await getEntry(T, ORG, a.entryId, 'u1')).toBeNull();
    expect((await listEntries(T, ORG, 'u1')).length).toBe(1);
  });

  it('isolates by tenant + org (no cross-scope read)', async () => {
    await seedTemplate('tpl-iso');
    const e = await createEntry(T, ORG, 'u1', { name: 'Iso', promptRef: 'tpl-iso' });
    expect(await getEntry('other-tenant', ORG, e.entryId, 'u1')).toBeNull();
    expect(await getEntry(T, 'other-org', e.entryId, 'u1')).toBeNull();
    expect((await listEntries('other-tenant', ORG, 'u1')).length).toBe(0);
  });

  it('rejects updating to a dangling promptRef', async () => {
    await seedTemplate('tpl-u');
    const e = await createEntry(T, ORG, 'u1', { name: 'U', promptRef: 'tpl-u' });
    await expect(updateEntry(T, ORG, e.entryId, 'u1', { promptRef: 'gone' })).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('does not resolve') });
    expect((await getEntry(T, ORG, e.entryId, 'u1'))?.promptRef, 'the refused update left the binding').toBe('tpl-u');
  });
});

describe('prompt-library renderEntry + ctx.prompts surface (ADR 0116 Phase 4)', () => {
  it('renderEntry resolves the template + substitutes {{var}} (missing stays literal)', async () => {
    await seedTemplate('tpl-r');
    const e = await createEntry(T, ORG, 'u1', { name: 'R', promptRef: 'tpl-r' });
    expect((await renderEntry(T, ORG, e.entryId, { name: 'World' }, 'u1')).composed).toBe('Hello World');
    expect((await renderEntry(T, ORG, e.entryId, {}, 'u1')).composed).toBe('Hello {{name}}'); // missing binding literal
  });

  it('renderEntry 404s a missing entry', async () => {
    await expect(renderEntry(T, ORG, 'nope', {}, 'u1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('ctx.prompts surface lists + renders, tenant-scoped (closes over scope.tenantId)', async () => {
    await seedTemplate('tpl-s');
    // `createdBy` is the CANONICAL user id (`userIdFor`); the run's `actingUserId` is
    // the RAW principal. The surface canonicalizes it so the owner's run matches.
    const owner = userIdFor(T, 'principal-s');
    const e = await createEntry(T, ORG, owner, { name: 'S', promptRef: 'tpl-s' });
    // An ORG-visible entry for the tenant half: a private one would be hidden from a
    // userless scope by visibility alone, so the tenant closure would never be reached.
    const orgWide = await createEntry(T, ORG, owner, { name: 'S2', promptRef: 'tpl-s', visibility: 'org' });
    const surface = buildPromptSurface({ tenantId: T, actingUserId: 'principal-s' }); // owner's run (raw principal)
    const listed = await surface.listLibrary!({ orgId: ORG });
    expect((listed.entries as Array<{ entryId: string }>).map((x) => x.entryId).sort()).toEqual([e.entryId, orgWide.entryId].sort());
    const rendered = await surface.renderEntry!({ orgId: ORG, entryId: e.entryId, variables: { name: 'Surface' } });
    expect(rendered.composed).toBe('Hello Surface');
    // Positive control: a userless scope in the SAME tenant does see the org entry …
    expect((await buildPromptSurface({ tenantId: T }).getEntry!({ orgId: ORG, entryId: orgWide.entryId })).entry).not.toBeNull();
    // … and a different tenant's scope cannot see either entry (CTI-1).
    const otherTenant = buildPromptSurface({ tenantId: 'other-tenant' });
    expect((await otherTenant.getEntry!({ orgId: ORG, entryId: orgWide.entryId })).entry).toBeNull();
    expect((await otherTenant.getEntry!({ orgId: ORG, entryId: e.entryId })).entry).toBeNull();
    expect((await otherTenant.listLibrary!({ orgId: ORG })).entries).toEqual([]);
  });

  /**
   * PLC-1 review fold-in — the surface caller is CANONICALIZED to the `createEntry`
   * id space. An unbound-OIDC/bearer owner's run arrives as a raw `oidc:<sub>`
   * (`req.userId` undefined) while `createdBy` is `userIdFor(tenantId, 'oidc:<sub>')`;
   * without canonicalization the owner would be locked out of their OWN private prompt.
   */
  it('an unbound-OIDC owner reads their OWN private prompt via the surface; a different principal cannot', async () => {
    await seedTemplate('tpl-oidc');
    const owner = userIdFor(T, 'oidc:sub-1');           // what createEntry stamps for this caller
    const e = await createEntry(T, ORG, owner, { name: 'Priv', promptRef: 'tpl-oidc', visibility: 'private' });
    // The SAME human's workflow run (raw actingUserId) sees it — canonicalized match.
    const own = buildPromptSurface({ tenantId: T, actingUserId: 'oidc:sub-1' });
    expect((await own.getEntry!({ orgId: ORG, entryId: e.entryId })).entry).not.toBeNull();
    expect((await own.renderEntry!({ orgId: ORG, entryId: e.entryId, variables: {} })).composed).toBe('Hello {{name}}');
    // A DIFFERENT principal's run does not.
    const other = buildPromptSurface({ tenantId: T, actingUserId: 'oidc:sub-2' });
    expect((await other.getEntry!({ orgId: ORG, entryId: e.entryId })).entry).toBeNull();
  });
});

/**
 * PLC-1 (ADR 0116 grade pass) — the `visibility` field is ENFORCED on read.
 * It used to be stored/validated/defaulted `private` but consulted on no read path,
 * so a `private` entry was listed + readable by every org member. Both directions
 * are asserted: a private entry hides from a non-owner, an org entry stays visible.
 */
describe('PLC-1 — private visibility is enforced on read', () => {
  it('a private entry hides from a non-owner; org entries stay org-visible', async () => {
    await seedTemplate('tpl-priv'); await seedTemplate('tpl-pub');
    const priv = await createEntry(T, ORG, 'alice', { name: 'Secret', promptRef: 'tpl-priv', visibility: 'private' });
    const org = await createEntry(T, ORG, 'alice', { name: 'Public', promptRef: 'tpl-pub', visibility: 'org' });
    // Owner sees both.
    expect((await listEntries(T, ORG, 'alice')).map((x) => x.entryId).sort()).toEqual([priv.entryId, org.entryId].sort());
    expect(await getEntry(T, ORG, priv.entryId, 'alice')).not.toBeNull();
    // A co-org member sees ONLY the org entry — the private one folds to absence.
    expect((await listEntries(T, ORG, 'bob')).map((x) => x.entryId)).toEqual([org.entryId]);
    expect(await getEntry(T, ORG, priv.entryId, 'bob')).toBeNull();          // masked (no existence leak)
    expect(await getEntry(T, ORG, org.entryId, 'bob')).not.toBeNull();       // org visible (NOT over-restricted)
    // Render of a private entry by a non-owner 404s; the owner renders it fine.
    await expect(renderEntry(T, ORG, priv.entryId, {}, 'bob')).rejects.toMatchObject({ code: 'not_found' });
    expect((await renderEntry(T, ORG, priv.entryId, { name: 'x' }, 'alice')).composed).toBe('Hello x');
  });
});

/**
 * PLC-2 (ADR 0116 grade pass) — a `promptRef` `@version` pin is honored. It used to
 * be dropped (the whole ref went to getTemplate as a bare id), so a pinned ref read
 * as dangling and an unpinned one always rendered LATEST.
 */
describe('PLC-2 — a promptRef @version pin is honored', () => {
  it('a pinned ref renders that version; unpinned renders latest; trailing @ is unpinned', async () => {
    expect((await createTenantTemplate(T, { templateId: 'tpl-v', version: '1.0.0', kind: 'user', text: 'ONE {{x}}', name: 'tpl-v' })).ok).toBe(true);
    expect((await createTenantTemplate(T, { templateId: 'tpl-v', version: '2.0.0', kind: 'user', text: 'TWO {{x}}', name: 'tpl-v' })).ok).toBe(true);
    // A pinned ref is ACCEPTED (was rejected as dangling) and renders v1.0.0.
    const pinned = await createEntry(T, ORG, 'u1', { name: 'Pinned', promptRef: 'tpl-v@1.0.0' });
    expect((await renderEntry(T, ORG, pinned.entryId, { x: 'A' }, 'u1')).composed).toBe('ONE A');
    // An unpinned ref renders LATEST (v2.0.0).
    const latest = await createEntry(T, ORG, 'u1', { name: 'Latest', promptRef: 'tpl-v' });
    expect((await renderEntry(T, ORG, latest.entryId, { x: 'B' }, 'u1')).composed).toBe('TWO B');
    // A trailing '@' is treated as unpinned (latest), not dangling.
    const trailing = await createEntry(T, ORG, 'u1', { name: 'Trailing', promptRef: 'tpl-v@' });
    expect((await renderEntry(T, ORG, trailing.entryId, { x: 'C' }, 'u1')).composed).toBe('TWO C');
  });
});
