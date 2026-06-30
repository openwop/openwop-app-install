/**
 * ADR 0116 Phase 2b — shareable prompt (sharing `prompt` resolver).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { sharingFeature } from '../src/features/sharing/feature.js';
import { createLink, resolveShared, resolveSharedCard } from '../src/features/sharing/sharingService.js';
import { createEntry } from '../src/features/prompts/promptLibraryService.js';
import { createUserTemplate } from '../src/host/promptStore.js';

const T = 'shp-tenant';
const ORG = 'org-shp';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-shareprompt-')) });
  initHostExtPersistence(await openStorage('memory://'));
  if (sharingFeature.toggleDefault) {
    registerToggleDefault(sharingFeature.toggleDefault);
    await saveConfig({ ...sharingFeature.toggleDefault, status: 'on' }, 'test');
  }
  await createOrg({ tenantId: T, createdBy: 'u1', name: 'Org', orgId: ORG });
  createUserTemplate({ templateId: 'tpl-shared', version: '1.0.0', kind: 'user', text: 'Summarize {{topic}} crisply', name: 'tpl-shared' });
});

describe('prompt share resolver', () => {
  it('mints + resolves a read-only prompt (name + body)', async () => {
    const entry = await createEntry(T, ORG, 'u1', { name: 'Summarizer', description: 'a crisp summarizer', promptRef: 'tpl-shared' });
    const link = await createLink(T, ORG, 'u1', { resourceType: 'prompt', resourceId: entry.entryId });
    const { resource, resourceType } = await resolveShared(link.token);
    expect(resourceType).toBe('prompt');
    expect(resource.kind).toBe('prompt');
    expect(resource.name).toBe('Summarizer');
    expect(String(resource.body)).toContain('Summarize {{topic}} crisply');
    const card = await resolveSharedCard(link.token, 'https://x');
    expect(card.title).toBe('Summarizer');
  });

  it('404s minting a non-existent prompt', async () => {
    await expect(createLink(T, ORG, 'u1', { resourceType: 'prompt', resourceId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
