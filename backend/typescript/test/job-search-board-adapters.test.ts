/**
 * ADR 0542 P2 — the board-adapter registry.
 *
 * The phase's claim is "the no-code path": adding a board must be a DATA change.
 * So the tests assert the properties that make that true, and the honesty
 * properties the architecture review put in place — a descriptor must not
 * advertise a credential model nothing exercises, and the coverage story must
 * not quietly claim Workday.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TIER_1_BOARDS, TIER_3_BOARDS, listBoardAdapters, getBoardAdapter, registerBoardAdapter,
  searchUrlFor, originsForBoards, type BoardAdapter,
} from '../src/features/job-search/boards/adapters.js';

describe('ADR 0542 D1 (corrected) — adding a board is DATA, not code', () => {
  it('ships the four Tier-1 boards', () => {
    expect(TIER_1_BOARDS.map((b) => b.id).sort()).toEqual(['ashby', 'greenhouse', 'lever', 'workable']);
  });

  it('a new board needs no code — registering a descriptor is enough', () => {
    const custom: BoardAdapter = {
      id: 'acme-jobs', displayName: 'Acme Jobs', origin: 'jobs.acme.test',
      auth: { kind: 'public' }, tier: 'A',
      searchUrlTemplate: 'https://jobs.acme.test/api/{company}',
      postingsPath: 'items', map: { title: 'name' }, docsUrl: 'https://acme.test/docs',
    };
    registerBoardAdapter(custom);
    expect(getBoardAdapter('acme-jobs')?.displayName).toBe('Acme Jobs');
    expect(listBoardAdapters().some((b) => b.id === 'acme-jobs')).toBe(true);
  });

  it('encodes the company token — it reaches a URL from tenant config', () => {
    const url = searchUrlFor('greenhouse', 'evil co/../../x');
    expect(url).not.toContain('../');
    expect(url).toContain('evil%20co');
  });

  it('an unknown board yields null rather than a malformed URL', () => {
    expect(searchUrlFor('not-a-board', 'acme')).toBeNull();
  });
});

describe('ADR 0542 P2 — the honesty properties the review installed', () => {
  it('NO Tier-1 board declares a credential it does not use', () => {
    // The reason these are not connection packs: the pack schema's `auth.kind`
    // enum has no credential-free option, so a pack for a PUBLIC board would
    // advertise an auth model nothing exercises.
    for (const b of TIER_1_BOARDS) {
      expect(b.auth.kind, `${b.id} is a public job board`).toBe('public');
    }
  });

  it('a credentialed board REFERENCES a connection provider — never its own secret', () => {
    // The one credential model rule: a descriptor may name a provider whose
    // credential the existing broker holds; it may not carry one.
    const authed: BoardAdapter = {
      id: 'authed-board', displayName: 'Authed', origin: 'authed.test',
      auth: { kind: 'connection', providerId: 'some-provider' }, tier: 'B',
      searchUrlTemplate: 'https://authed.test/{company}', postingsPath: 'jobs',
      map: { title: 'title' }, docsUrl: 'https://authed.test',
    };
    registerBoardAdapter(authed);
    const got = getBoardAdapter('authed-board')!;
    expect(got.auth.kind).toBe('connection');
    // Structural: the type has no field for a secret, so one cannot be smuggled.
    expect(Object.keys(got.auth)).toEqual(['kind', 'providerId']);
  });

  it('does NOT claim Workday — the biggest ATS is deliberately absent', () => {
    // ADR 0545 D5a: Workday is ~32% of enterprise postings and publishes no
    // public candidate submission API. Listing it Tier A here would be the
    // coverage overclaim the ADR explicitly corrected.
    expect(TIER_1_BOARDS.map((b) => b.id)).not.toContain('workday');
  });

  it('every Tier-1 origin is a real host a grant can be scoped to', () => {
    // The grant scopes by ORIGIN (ADR 0541), so a descriptor whose origin does
    // not match the URL it actually calls would make auto-apply fail closed for
    // a reason nobody could see.
    for (const b of TIER_1_BOARDS) {
      expect(b.searchUrlTemplate, `${b.id} origin/URL mismatch`).toContain(b.origin);
    }
    expect(originsForBoards(['greenhouse', 'lever'])).toEqual(['boards-api.greenhouse.io', 'api.lever.co']);
  });

  it('ships NO connection pack for a Tier-1 board', () => {
    // The review's finding, pinned: if someone later adds one, the pack would
    // declare an auth kind the board never uses.
    const root = join(process.cwd(), '..', '..', 'examples', 'connection-packs');
    for (const b of TIER_1_BOARDS) {
      let exists = true;
      try { readFileSync(join(root, b.id, 'pack.json')); } catch { exists = false; }
      expect(exists, `a connection pack for the public board ${b.id} would advertise unused auth`).toBe(false);
    }
  });

  it('Tier 3 ships EMPTY — terms cannot be respected for a licence nobody entered', () => {
    // Shipping an aggregator here would either hard-code someone else's
    // contractual relationship or assert an acceptance the operator never gave.
    expect(TIER_3_BOARDS).toEqual([]);
  });

  it('a licensed adapter without a RECORDED acceptance is refused, loudly', () => {
    const incomplete = {
      id: 'agg', displayName: 'Aggregator', origin: 'api.agg.test',
      auth: { kind: 'licensed' as const, providerId: 'agg', termsUrl: '', acceptedBy: '', acceptedAt: '' },
      tier: 'A' as const, searchUrlTemplate: 'https://api.agg.test/{company}',
      postingsPath: 'jobs', map: { title: 'title' }, docsUrl: 'https://agg.test',
    };
    // Loud, not inert: registering it silently would look identical to a working
    // board right up until every listing from it was skipped.
    expect(() => registerBoardAdapter(incomplete)).toThrow(/termsUrl|acceptedBy|respected/);
    expect(getBoardAdapter('agg')).toBeUndefined();
  });

  it('a licensed adapter WITH an attributable acceptance registers', () => {
    registerBoardAdapter({
      id: 'agg-ok', displayName: 'Aggregator', origin: 'api.agg.test',
      auth: { kind: 'licensed', providerId: 'agg', termsUrl: 'https://agg.test/terms', acceptedBy: 'user-1', acceptedAt: '2026-02-01T00:00:00.000Z' },
      tier: 'A', searchUrlTemplate: 'https://api.agg.test/{company}',
      postingsPath: 'jobs', map: { title: 'title' }, docsUrl: 'https://agg.test',
    });
    expect(getBoardAdapter('agg-ok')?.auth.kind).toBe('licensed');
  });
});
