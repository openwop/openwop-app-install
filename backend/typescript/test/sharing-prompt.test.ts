/**
 * ADR 0116 Phase 2b — shareable prompt (sharing `prompt` resolver), plus the
 * SHWF-1 / ADR 0644 D1 mint-entitlement witness.
 *
 * Guards: the resolver serves the prompt's NAME and its `resolvePromptRef` BODY
 * (and the card title); the resolver's `entitlement` (ADR 0887 D1 — it was
 * `validate` until then) refuses to mint another member's PRIVATE prompt via
 * `promptReadableBy`, with the MINTER threaded in as the subject;
 * a missing prompt is a 404 at mint.
 *
 * Sabotage-witnessed (w7 /grade-tests): body forced to '' · card title replaced
 * · the `promptReadableBy` refusal removed · `createLink` passing a different
 * subject than the actor to `validate`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createLink, resolveShared, resolveSharedCard } from '../src/features/sharing/sharingService.js';
import { createEntry } from '../src/features/prompts/promptLibraryService.js';
import { createTenantTemplate } from '../src/host/tenantPromptTemplates.js';

const T = 'shp-tenant';
const ORG = 'org-shp';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-shareprompt-')) });
  initHostExtPersistence(await openStorage('memory://'));
  // No toggle setup: `sharing` is always-on (ADR 0434) and `prompts` declares no
  // toggle, so the prompt resolver's `toggleId` is null (SHARE-1).
  // ADR 0887 D1 — a link is re-checked against its publisher on every read, so the
  // actors that mint here hold REAL memberships (a bare actor's link is dark).
  await createOrg({ tenantId: T, createdBy: 'u1', name: 'Org', orgId: ORG, ownerSubject: 'u1' });
  for (const subject of ['owner-a', 'intruder-b']) await createMember({ tenantId: T, orgId: ORG, subject, displayName: subject, roles: ['editor'] });
  await createTenantTemplate(T, { templateId: 'tpl-shared', version: '1.0.0', kind: 'user', text: 'Summarize {{topic}} crisply', name: 'tpl-shared' });
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
    // ADR 0993 D2 — refused with the uniform 404 a read gives (a 403 confirmed the
    // entry exists to someone who cannot read it).
    await expect(
      createLink(T, ORG, 'intruder-b', { resourceType: 'prompt', resourceId: mine.entryId }),
    ).rejects.toMatchObject({ code: 'not_found' });

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
