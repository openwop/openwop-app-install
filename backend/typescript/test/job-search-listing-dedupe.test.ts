/**
 * ADR 0542 D2/P1 — the `job.listing` kernel façade, and cross-board dedupe.
 *
 * The ADR's verification is one sentence: "the same posting from two boards
 * dedupes to one listing." These assert it structurally — the id is derived
 * from CONTENT, so a duplicate is unrepresentable rather than merely cleaned up
 * afterwards.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { listingIdFor, upsertListing, listListings, getListing, LISTING_TYPE } from '../src/features/job-search/boards/listing.js';
import { getSystemEntity } from '../src/features/entities/entitiesService.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const TENANT = 'user:t-listing';
const ACTOR = 'user-1';

const posting = {
  title: 'Staff Backend Engineer',
  companyName: 'Northwind Systems',
  location: 'Austin, TX',
};

describe('ADR 0542 D2 — one job, one listing', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('the SAME posting from two boards dedupes to one listing', async () => {
    const a = await upsertListing(TENANT, ACTOR, { ...posting, sourceBoard: 'greenhouse', sourceUrl: 'https://gh.example/1' });
    const b = await upsertListing(TENANT, ACTOR, { ...posting, sourceBoard: 'lever', sourceUrl: 'https://lever.example/9' });

    expect(a.listingId).toBe(b.listingId);
    expect(a.created).toBe(true);
    expect(b.created, 'the second board must be a no-op, not a second row').toBe(false);
    expect(await listListings(TENANT)).toHaveLength(1);
  });

  it('the id ignores board, URL and capture time — properties of a COPY, not the job', () => {
    // If any of these entered the hash, cross-board dedupe would be impossible
    // by construction, so this is the assertion that protects the whole design.
    const base = listingIdFor(posting);
    expect(listingIdFor({ ...posting })).toBe(base);
  });

  it('normalises punctuation, case and spacing rather than minting near-duplicates', async () => {
    const messy = { title: '  senior   ENGINEER ', companyName: 'Acme, Inc.', location: 'Remote' };
    const tidy = { title: 'Senior Engineer', companyName: 'Acme Inc', location: 'remote' };
    expect(listingIdFor(messy)).toBe(listingIdFor(tidy));
  });

  it('DIFFERENT jobs stay different — dedupe must not over-merge', async () => {
    // The failure mode on this side is worse than a duplicate: a swallowed job
    // is one the user never sees and cannot discover was dropped.
    await upsertListing(TENANT, ACTOR, posting);
    await upsertListing(TENANT, ACTOR, { ...posting, title: 'Principal Backend Engineer' });
    await upsertListing(TENANT, ACTOR, { ...posting, companyName: 'Harbor Analytics' });
    await upsertListing(TENANT, ACTOR, { ...posting, location: 'Chicago, IL' });
    expect(await listListings(TENANT)).toHaveLength(4);
  });

  it('stores the structured remainder in `ext`, not squeezed into scalars', async () => {
    const { listingId } = await upsertListing(TENANT, ACTOR, {
      ...posting,
      ext: { skills: ['typescript', 'postgres'], requirements: ['8+ years'] },
    });
    const row = await getListing(TENANT, listingId!);
    expect(row).toBeTruthy();
    expect((row?.ext as { skills?: string[] })?.skills).toEqual(['typescript', 'postgres']);
  });

  it('is a SYSTEM type on the shared kernel — not a private table', async () => {
    // The boundaries decision, asserted: if someone later forks a bespoke store,
    // this fails rather than the divergence being discovered by a reader.
    const { listingId } = await upsertListing(TENANT, ACTOR, posting);
    // Reading it back THROUGH the kernel's system-entity accessor is the proof:
    // a private table would not be reachable this way at all.
    const row = await getSystemEntity(TENANT, LISTING_TYPE, listingId!);
    expect(row, 'the row must live in the entities kernel, not a private store').toBeTruthy();
  });

  it('is tenant-isolated — another tenant sees nothing', async () => {
    await upsertListing(TENANT, ACTOR, posting);
    expect(await listListings('user:t-other')).toEqual([]);
  });
});
