/**
 * `PROBE-P0-1`, migrated from a prose census to an executable assertion.
 *
 * The probe read: "orphaned-public-episode census (expect 0 after any
 * `deleteShow`)". It was a `SELECT count(*)` against production — so it could
 * only ever be run by someone with prod DB access, and it measured a quantity
 * rather than asserting the invariant that produces it. **Nothing in the repo
 * referenced `deleteShow`**: the ADR 0390 cascade at `podcastsService.ts:452`
 * had zero executable coverage.
 *
 * The invariant is a public-surface leak guard. `deleteShow` orphans the show's
 * episodes back to draft — clearing `showId` AND forcing `published:false` — so
 * a deleted channel can never leave an episode reachable on the public surface.
 * A regression that dropped only the `showId` (or only the publish flag) would
 * leave exactly the orphan the probe was counting.
 *
 * THE PRECONDITION IS THE POINT. Asserting only "the episode is not published"
 * would pass against an episode that was never published in the first place —
 * the assertion would be true for a reason unrelated to the cascade. Each case
 * asserts the episode IS published and IS attached before the delete.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createShow, createEpisode, deleteShow, getEpisode, setEpisodePublish,
} from '../src/features/podcasts/podcastsService.js';

const ORG = 'org-1';
const showInput = (title: string) => ({
  title, author: 'A', description: 'd', languageCode: 'en', explicit: false,
});

/** Create a show + an episode ATTACHED and PUBLISHED to it. */
async function publishedEpisodeOn(tenantId: string, title: string) {
  const show = await createShow(tenantId, ORG, 'u1', showInput(title));
  const ep = await createEpisode(tenantId, ORG, { notebookId: 'nb', episodeProfileId: 'ep', title: `${title} ep` });
  const live = await setEpisodePublish(tenantId, ep.id, { published: true, showId: show.id });
  return { show, epId: ep.id, live };
}

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-p0-1-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('PROBE-P0-1 (executable) — deleteShow leaves no published episode behind', () => {
  it('unpublishes AND detaches the deleted show\'s episodes', async () => {
    const { show, epId, live } = await publishedEpisodeOn('acme', 'Show A');

    // PRECONDITION — without this the assertions below are vacuous.
    expect(live?.published, 'episode was not published — the cascade assertion would be vacuous').toBe(true);
    expect(live?.showId, 'episode was not attached to the show').toBe(show.id);

    await deleteShow('acme', show.id);

    const after = await getEpisode('acme', epId);
    expect(after, 'the episode row was deleted; ADR 0390 orphans to draft, it does not destroy work').toBeTruthy();
    expect(after?.published, 'episode stayed PUBLIC after its channel was deleted — public-surface leak').toBe(false);
    expect(after?.showId, 'episode still points at a deleted show — dangling public reference').toBeUndefined();
  });

  it('does NOT touch another show\'s episodes in the same tenant', async () => {
    // A cascade that unpublished everything would pass the test above while
    // silently taking unrelated channels off the air.
    const doomed = await publishedEpisodeOn('acme', 'Doomed');
    const keeper = await publishedEpisodeOn('acme', 'Keeper');
    expect(keeper.live?.published).toBe(true);

    await deleteShow('acme', doomed.show.id);

    const survivor = await getEpisode('acme', keeper.epId);
    expect(survivor?.published, 'an unrelated show\'s episode was unpublished — cascade over-reached').toBe(true);
    expect(survivor?.showId).toBe(keeper.show.id);
  });

  it('refuses a cross-tenant delete by id — the tenant-prefixed lookup is the IDOR guard', async () => {
    // The FIRST cross-tenant test I wrote here was vacuous: show ids are UUIDs, so a
    // sibling tenant's episode is excluded by the `showId` filter whether or not the
    // episode scan is tenant-scoped (sabotaging `listByPrefix` to scan all tenants did
    // NOT redden it). What actually protects a tenant is the PREFIXED SHOW LOOKUP —
    // `shows.get(`${tenantId}:${id}`)` — so that is what this asserts, and unlike the
    // version it replaces, it fails when that guard is removed.
    const theirs = await publishedEpisodeOn('globex', 'Theirs');
    expect(theirs.live?.published).toBe(true);

    const res = await deleteShow('acme', theirs.show.id); // acme naming globex's show id

    expect(res.deleted, 'a tenant deleted another tenant\'s show by id — IDOR').toBe(false);
    const survivor = await getEpisode('globex', theirs.epId);
    expect(survivor?.published, 'cross-tenant delete unpublished the victim\'s episode').toBe(true);
    expect(survivor?.showId).toBe(theirs.show.id);
  });
});
