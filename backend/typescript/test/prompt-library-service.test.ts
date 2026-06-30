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
    expect((await listEntries(T, ORG)).length).toBe(2);

    const updated = await updateEntry(T, ORG, a.entryId, 'u2', { name: 'A2', visibility: 'shared' });
    expect(updated.name).toBe('A2');
    expect(updated.visibility).toBe('shared');
    expect(updated.updatedBy).toBe('u2');

    await deleteEntry(T, ORG, a.entryId);
    expect(await getEntry(T, ORG, a.entryId)).toBeNull();
    expect((await listEntries(T, ORG)).length).toBe(1);
  });

  it('isolates by tenant + org (no cross-scope read)', async () => {
    seedTemplate('tpl-iso');
    const e = await createEntry(T, ORG, 'u1', { name: 'Iso', promptRef: 'tpl-iso' });
    expect(await getEntry('other-tenant', ORG, e.entryId)).toBeNull();
    expect(await getEntry(T, 'other-org', e.entryId)).toBeNull();
    expect((await listEntries('other-tenant', ORG)).length).toBe(0);
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
    expect((await renderEntry(T, ORG, e.entryId, { name: 'World' })).composed).toBe('Hello World');
    expect((await renderEntry(T, ORG, e.entryId, {})).composed).toBe('Hello {{name}}'); // missing binding literal
  });

  it('renderEntry 404s a missing entry', async () => {
    await expect(renderEntry(T, ORG, 'nope', {})).rejects.toMatchObject({ code: 'not_found' });
  });

  it('ctx.prompts surface lists + renders, tenant-scoped (closes over scope.tenantId)', async () => {
    seedTemplate('tpl-s');
    const e = await createEntry(T, ORG, 'u1', { name: 'S', promptRef: 'tpl-s' });
    const surface = buildPromptSurface({ tenantId: T });
    const listed = await surface.listLibrary!({ orgId: ORG });
    expect((listed.entries as unknown[]).length).toBeGreaterThanOrEqual(1);
    const rendered = await surface.renderEntry!({ orgId: ORG, entryId: e.entryId, variables: { name: 'Surface' } });
    expect(rendered.composed).toBe('Hello Surface');
    // A different tenant's scope can't see this org's entry (CTI-1).
    const otherTenant = buildPromptSurface({ tenantId: 'other-tenant' });
    expect((await otherTenant.getEntry!({ orgId: ORG, entryId: e.entryId })).entry).toBeNull();
  });
});
