/**
 * ADR 0116 Phase 1 — prompt-library catalog service.
 * Dangling-ref rejection (the catalog must point at a real template), CRUD,
 * tenant/org isolation. RBAC + toggle gating are enforced at the route via the
 * shared `authorizeOrgScope` (tested in the feature-route suites).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createUserTemplate, clearUserTemplatesForTest } from '../src/host/promptStore.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { createEntry, listEntries, getEntry, updateEntry, deleteEntry, renderEntry } from '../src/features/prompts/promptLibraryService.js';
import { buildPromptSurface } from '../src/features/prompts/promptSurface.js';

import { getTemplate } from '../src/host/promptStore.js';

const T = 'pl-tenant';

/** Mirror the render route's self-contained `{{var}}` substitution. */
function renderTemplate(text: string, bindings: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(bindings, name) ? String(bindings[name]) : m);
}
let orgN = 0;
let ORG = 'org-a'; // reassigned per test (the entries collection persists across tests)

function seedTemplate(id: string): void {
  const out = createUserTemplate({ templateId: id, version: '1.0.0', kind: 'user', text: 'Hello {{name}}', name: id });
  expect(out.ok, JSON.stringify(out)).toBe(true);
}

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-promptlib-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(() => { clearUserTemplatesForTest(); ORG = `org-${orgN++}`; });

describe('prompt-library service', () => {
  it('creates an entry referencing a real template', async () => {
    seedTemplate('tpl-greet');
    const e = await createEntry(T, ORG, 'u1', { name: 'Greeting', promptRef: 'tpl-greet', tags: ['intro', 'demo'], visibility: 'org' });
    expect(e.entryId).toBeTruthy();
    expect(e.promptRef).toBe('tpl-greet');
    expect(e.visibility).toBe('org');
    expect(e.tags).toEqual(['intro', 'demo']);
  });

  it('rejects a dangling promptRef', async () => {
    await expect(createEntry(T, ORG, 'u1', { name: 'Bad', promptRef: 'does-not-exist' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('requires a name', async () => {
    seedTemplate('tpl-x');
    await expect(createEntry(T, ORG, 'u1', { promptRef: 'tpl-x' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('defaults visibility to private', async () => {
    seedTemplate('tpl-p');
    const e = await createEntry(T, ORG, 'u1', { name: 'P', promptRef: 'tpl-p' });
    expect(e.visibility).toBe('private');
  });

  it('lists, gets, updates, and deletes', async () => {
    seedTemplate('tpl-1'); seedTemplate('tpl-2');
    const a = await createEntry(T, ORG, 'u1', { name: 'A', promptRef: 'tpl-1' });
    await createEntry(T, ORG, 'u1', { name: 'B', promptRef: 'tpl-2' });
    expect((await listEntries(T, ORG, 'u1')).length).toBe(2);

    // ADR 0694 D1 — this used to be ONE call in which a NON-owner ('u2') both renamed
    // 'u1's default-private entry AND widened it to 'shared'. The widening half is
    // now refused (`PLC-6`: visibility is the read ACL, so letting any org writer
    // flip it makes PLC-1's guarantee only as strong as `workspace:write`).
    // Split rather than softened, so this test still pins BOTH halves of the rule:
    // ordinary fields stay org-writable, visibility is owner-only.
    const renamed = await updateEntry(T, ORG, a.entryId, 'u2', { name: 'A2' });
    expect(renamed.name, 'a non-owner may still edit ordinary fields').toBe('A2');
    expect(renamed.updatedBy).toBe('u2');
    expect(renamed.visibility, 'and an edit that does not name visibility never changes it').toBe('private');

    const updated = await updateEntry(T, ORG, a.entryId, 'u1', { visibility: 'shared' });
    expect(updated.visibility, 'the OWNER may widen it').toBe('shared');
    expect(updated.name).toBe('A2');

    await deleteEntry(T, ORG, a.entryId);
    expect(await getEntry(T, ORG, a.entryId, 'u1')).toBeNull();
    expect((await listEntries(T, ORG, 'u1')).length).toBe(1);
  });

  it('isolates by tenant + org (no cross-scope read)', async () => {
    seedTemplate('tpl-iso');
    const e = await createEntry(T, ORG, 'u1', { name: 'Iso', promptRef: 'tpl-iso' });
    expect(await getEntry('other-tenant', ORG, e.entryId, 'u1')).toBeNull();
    expect(await getEntry(T, 'other-org', e.entryId, 'u1')).toBeNull();
    expect((await listEntries('other-tenant', ORG, 'u1')).length).toBe(0);
  });

  it('renders an entry by resolving its promptRef + substituting variables (ADR 0116 Phase 2)', async () => {
    seedTemplate('tpl-render'); // text: "Hello {{name}}"
    const e = await createEntry(T, ORG, 'u1', { name: 'Greet', promptRef: 'tpl-render' });
    // The render route resolves the SAME store the entry validated against.
    const resolved = getTemplate(e.promptRef);
    expect(resolved && resolved !== 'ambiguous').toBe(true);
    const text = (resolved as { template: { text: string } }).template.text;
    expect(renderTemplate(text, { name: 'World' })).toBe('Hello World'); // substituted
    expect(renderTemplate(text, {})).toBe('Hello {{name}}'); // missing binding stays literal
  });

  it('rejects updating to a dangling promptRef', async () => {
    seedTemplate('tpl-u');
    const e = await createEntry(T, ORG, 'u1', { name: 'U', promptRef: 'tpl-u' });
    await expect(updateEntry(T, ORG, e.entryId, 'u1', { promptRef: 'gone' })).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('prompt-library renderEntry + ctx.prompts surface (ADR 0116 Phase 4)', () => {
  it('renderEntry resolves the template + substitutes {{var}} (missing stays literal)', async () => {
    seedTemplate('tpl-r');
    const e = await createEntry(T, ORG, 'u1', { name: 'R', promptRef: 'tpl-r' });
    expect((await renderEntry(T, ORG, e.entryId, { name: 'World' }, 'u1')).composed).toBe('Hello World');
    expect((await renderEntry(T, ORG, e.entryId, {}, 'u1')).composed).toBe('Hello {{name}}'); // missing binding literal
  });

  it('renderEntry 404s a missing entry', async () => {
    await expect(renderEntry(T, ORG, 'nope', {}, 'u1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('ctx.prompts surface lists + renders, tenant-scoped (closes over scope.tenantId)', async () => {
    seedTemplate('tpl-s');
    // `createdBy` is the CANONICAL user id (`userIdFor`); the run's `actingUserId` is
    // the RAW principal. The surface canonicalizes it so the owner's run matches.
    const owner = userIdFor(T, 'principal-s');
    const e = await createEntry(T, ORG, owner, { name: 'S', promptRef: 'tpl-s' });
    const surface = buildPromptSurface({ tenantId: T, actingUserId: 'principal-s' }); // owner's run (raw principal)
    const listed = await surface.listLibrary!({ orgId: ORG });
    expect((listed.entries as unknown[]).length).toBeGreaterThanOrEqual(1);
    const rendered = await surface.renderEntry!({ orgId: ORG, entryId: e.entryId, variables: { name: 'Surface' } });
    expect(rendered.composed).toBe('Hello Surface');
    // A different tenant's scope can't see this org's entry (CTI-1).
    const otherTenant = buildPromptSurface({ tenantId: 'other-tenant' });
    expect((await otherTenant.getEntry!({ orgId: ORG, entryId: e.entryId })).entry).toBeNull();
  });

  /**
   * PLC-1 review fold-in — the surface caller is CANONICALIZED to the `createEntry`
   * id space. An unbound-OIDC/bearer owner's run arrives as a raw `oidc:<sub>`
   * (`req.userId` undefined) while `createdBy` is `userIdFor(tenantId, 'oidc:<sub>')`;
   * without canonicalization the owner would be locked out of their OWN private prompt.
   */
  it('an unbound-OIDC owner reads their OWN private prompt via the surface; a different principal cannot', async () => {
    seedTemplate('tpl-oidc');
    const owner = userIdFor(T, 'oidc:sub-1');           // what createEntry stamps for this caller
    const e = await createEntry(T, ORG, owner, { name: 'Priv', promptRef: 'tpl-oidc', visibility: 'private' });
    // The SAME human's workflow run (raw actingUserId) sees it — canonicalized match.
    const own = buildPromptSurface({ tenantId: T, actingUserId: 'oidc:sub-1' });
    expect((await own.getEntry!({ orgId: ORG, entryId: e.entryId })).entry).not.toBeNull();
    expect((await own.renderEntry!({ orgId: ORG, entryId: e.entryId, variables: {} })).composed).toBeTruthy();
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
    seedTemplate('tpl-priv'); seedTemplate('tpl-pub');
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
    expect((await renderEntry(T, ORG, priv.entryId, { name: 'x' }, 'alice')).composed).toBeTruthy();
  });
});

/**
 * PLC-2 (ADR 0116 grade pass) — a `promptRef` `@version` pin is honored. It used to
 * be dropped (the whole ref went to getTemplate as a bare id), so a pinned ref read
 * as dangling and an unpinned one always rendered LATEST.
 */
describe('PLC-2 — a promptRef @version pin is honored', () => {
  it('a pinned ref renders that version; unpinned renders latest; trailing @ is unpinned', async () => {
    expect(createUserTemplate({ templateId: 'tpl-v', version: '1.0.0', kind: 'user', text: 'ONE {{x}}', name: 'tpl-v' }).ok).toBe(true);
    expect(createUserTemplate({ templateId: 'tpl-v', version: '2.0.0', kind: 'user', text: 'TWO {{x}}', name: 'tpl-v' }).ok).toBe(true);
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
