/**
 * ADR 0453 P1 — creator profile → content-kernel projection. Pins the projection
 * SYNC (the P1 concern): an APPROVED profile is published as a live
 * `kicktodo.creator_profile` kernel entity (scalars mirrored); a non-approved
 * profile (draft / rejected / edited-after-approval) has NO kernel entity.
 * The public-read GATE over that entity (toggle + publicRead + status) is
 * covered by `entities-public-read.test.ts`; here we assert the record itself
 * via `getSystemEntity` (toggle-independent), keyed by the stable creatorSubject.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { resolveApproval } from '../src/host/approvalService.js';
import { upsertProfile, submitProfile, applyProfileDecision, reconcileCreatorProfileProjections, publicProfileByHandle } from '../src/features/kicktodo-community/communityService.js';
import { CREATOR_PROFILE_TYPE } from '../src/features/kicktodo-community/creatorProfileProjection.js';
import { getSystemEntity, deleteSystemEntity } from '../src/features/entities/entitiesService.js';

const T = 'tenant-cpk';
const CREATOR = 'user:creator-cpk';
const MOD = 'user:mod-cpk';

const projection = () => getSystemEntity(T, CREATOR_PROFILE_TYPE, CREATOR);

async function approve(): Promise<void> {
  const pending = await submitProfile(T, CREATOR);
  await resolveApproval(pending.approvalId!, { status: 'approved' });
  await applyProfileDecision(T, CREATOR, MOD, true);
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('creator profile → kernel projection (ADR 0453 P1)', () => {
  it('publishes a live kernel entity on approval; none while a draft', async () => {
    await upsertProfile(T, CREATOR, { handle: 'nova-codes', displayName: 'Nova', bio: 'I build challenges', links: ['https://example.com'] });
    expect(await projection()).toBeNull(); // draft ⇒ no projection

    await approve();
    const rec = await projection();
    expect(rec).not.toBeNull();
    expect(rec?.status).not.toBe('draft'); // live ⇒ public-read-eligible
    expect(rec?.values.handle).toBe('nova-codes');
    expect(rec?.values.display_name).toBe('Nova');
    expect(rec?.values.bio).toBe('I build challenges');
  });

  it('editing an approved profile pulls the projection down until re-approval', async () => {
    await upsertProfile(T, CREATOR, { handle: 'nova-codes', displayName: 'Nova', bio: 'b', links: [] });
    await approve();
    expect(await projection()).not.toBeNull();

    // An edit resets to draft ⇒ projection removed.
    await upsertProfile(T, CREATOR, { handle: 'nova-codes', displayName: 'Nova Prime', bio: 'b2', links: [] });
    expect(await projection()).toBeNull();

    // Re-approve ⇒ published again, with the updated display name.
    await approve();
    expect((await projection())?.values.display_name).toBe('Nova Prime');
  });

  it('a rejected decision leaves no projection', async () => {
    await upsertProfile(T, CREATOR, { handle: 'nova-codes', displayName: 'Nova', bio: 'b', links: [] });
    const pending = await submitProfile(T, CREATOR);
    await resolveApproval(pending.approvalId!, { status: 'rejected' });
    await applyProfileDecision(T, CREATOR, MOD, false);
    expect(await projection()).toBeNull();
  });

  it('ADR 0453 P2 — per-locale displayName/bio overlays reach the kernel projection', async () => {
    await upsertProfile(T, CREATOR, {
      handle: 'nova-codes', displayName: 'Nova', bio: 'I build challenges', links: [],
      localizations: { es: { displayName: 'Nova ES', bio: 'Construyo retos' }, 'fr-CA': { bio: 'Je crée des défis' } },
    });
    await approve();
    const rec = await projection();
    expect(rec?.values.display_name).toBe('Nova'); // base value = the fallback
    // The kernel overlay uses the FIELD KEYS (display_name/bio), not the write-model names.
    expect(rec?.localizations?.es).toEqual({ display_name: 'Nova ES', bio: 'Construyo retos' });
    expect(rec?.localizations?.['fr-CA']).toEqual({ bio: 'Je crée des défis' }); // sparse — bio only
  });

  it('ADR 0453 P3 read-switch — publicProfileByHandle serves the base values (toggle-safe fallback), never vanishing', async () => {
    await upsertProfile(T, CREATOR, {
      handle: 'nova-codes', displayName: 'Nova', bio: 'base bio', links: ['https://x.test'],
      localizations: { es: { displayName: 'Nova ES', bio: 'bio es' } },
    });
    // Not approved ⇒ not public.
    expect(await publicProfileByHandle(T, 'nova-codes')).toBeNull();
    await approve();
    // Approved: with the entities toggle OFF (test default), the kernel read fails
    // and the read-switch falls back to the write-model base values — the profile
    // is STILL served (never vanishes), just not localized.
    const pub = await publicProfileByHandle(T, 'nova-codes', { explicit: 'es' });
    expect(pub).not.toBeNull();
    expect(pub?.handle).toBe('nova-codes');
    expect(pub?.displayName).toBe('Nova'); // base (toggle off ⇒ no overlay)
    expect(pub?.bio).toBe('base bio');
    expect(pub?.links).toEqual(['https://x.test']); // links always from the write-model
  });

  it('ADR 0453 P4 — the crawler-visible projection carries ONLY intended-public fields (no opaque subject / PII)', async () => {
    // The profile is crawlable-by-construction: kicktodo.creator_profile is a
    // publicRead + published system type, so the anonymous /public-entities route
    // serves it. This pins the SEO/privacy invariant on what a crawler receives:
    // handle/display_name/bio in `values`, links in `ext` — the OPAQUE subject is
    // only the entityId (URL segment, ADR 0426 opaque), NEVER in the body.
    await upsertProfile(T, CREATOR, { handle: 'nova-codes', displayName: 'Nova', bio: 'public bio', links: ['https://x.test'] });
    await approve();
    const rec = await projection();
    expect(rec).not.toBeNull();
    expect(Object.keys(rec!.values).sort()).toEqual(['bio', 'display_name', 'handle']); // exactly the public scalars
    expect(JSON.stringify(rec!.values)).not.toContain(CREATOR); // the opaque subject is never in the body
    expect(rec!.values.handle).toBe('nova-codes'); // the PUBLIC identity is the handle
  });

  it('ADR 0453 P2 — an invalid overlay locale is rejected', async () => {
    await expect(upsertProfile(T, CREATOR, {
      handle: 'nova-codes', displayName: 'Nova', bio: 'b', links: [],
      localizations: { 'not a locale!': { bio: 'x' } },
    })).rejects.toThrow();
  });

  it('ADR 0453 P3 — reconcile re-derives a missing projection for an approved profile (backfill / DATA-LEV-3 heal)', async () => {
    await upsertProfile(T, CREATOR, { handle: 'nova-codes', displayName: 'Nova', bio: 'b', links: [] });
    await approve();
    expect(await projection()).not.toBeNull();

    // Simulate a straggler (approved before P1) or a swallowed un-publish/publish
    // failure by deleting the projection out from under an approved profile.
    await deleteSystemEntity({ tenantId: T, typeName: CREATOR_PROFILE_TYPE, entityId: CREATOR });
    expect(await projection()).toBeNull();

    // The reconcile sweep re-derives it from the write-model (idempotent).
    const n = await reconcileCreatorProfileProjections();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await projection())?.values.display_name).toBe('Nova');
  });
});
