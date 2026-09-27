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

  // SHWF-1 / ADR 0644 D1 — `validate` is the ENTITLEMENT hook. A private prompt
  // belongs to its creator; any other member holding `workspace:write` could mint
  // it to the public internet because `prompt.validate` read the library through
  // `getEntryUnfiltered`, which skips `readableBy`. The read hooks KEEP the
  // unfiltered read on purpose (post-mint the link IS the grant, and there is no
  // caller at resolve time) — so this test must pin the mint hook specifically.
  it('refuses to mint another user\'s PRIVATE prompt, and still allows the owner', async () => {
    const mine = await createEntry(T, ORG, 'owner-a', { name: 'Private of A', promptRef: 'tpl-shared', visibility: 'private' });

    // The defect: a different member of the same org publishes A's private prompt.
    await expect(
      createLink(T, ORG, 'intruder-b', { resourceType: 'prompt', resourceId: mine.entryId }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // Non-vacuity, both directions: the OWNER may still share it...
    const own = await createLink(T, ORG, 'owner-a', { resourceType: 'prompt', resourceId: mine.entryId });
    expect((await resolveShared(own.token)).resource.name).toBe('Private of A');

    // ...and a SHARED-visibility prompt stays mintable by any member.
    const shared = await createEntry(T, ORG, 'owner-a', { name: 'Shared of A', promptRef: 'tpl-shared', visibility: 'shared' });
    const byOther = await createLink(T, ORG, 'intruder-b', { resourceType: 'prompt', resourceId: shared.entryId });
    expect((await resolveShared(byOther.token)).resource.name).toBe('Shared of A');
  });

  it('404s minting a non-existent prompt', async () => {
    await expect(createLink(T, ORG, 'u1', { resourceType: 'prompt', resourceId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
