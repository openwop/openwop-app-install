/**
 * ADR 0544 P2/D3/D4 — the attestation token.
 *
 * The ADR is explicit that "INDISTINGUISHABILITY is the test, not the 404". So
 * the headline assertions compare failure cases AGAINST EACH OTHER rather than
 * checking each returns something falsy: three different reasons must produce
 * one identical answer, or an employer learns something about the applicant they
 * were never given.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  issueAttestation, previewAttestation, resolveAttestation, revokeAttestation, listAttestations,
  eraseSubjectAttestations, type IssueResult,
} from '../src/features/job-search/attestation/token.js';
import { createApplyGrant, consumeSubmit } from '../src/host/applyGrant.js';
import { hashToken } from '../src/host/capabilityToken.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const TENANT = 'user:t-tok';
const OTHER = 'user:t-tok-other';
const CAMPAIGN = 'camp-1';

/** The SUBJECT is the only person who can attest their own conduct (matrix 8). */
const SUBJECT = 'subj-1';

/** Unwraps an issuance, failing loudly on a refusal rather than reading through it. */
function issued(r: IssueResult | { refused: string }): IssueResult {
  if ('refused' in r) throw new Error(`expected an issuance, got refusal: ${r.refused}`);
  return r;
}

async function seed(tenantId = TENANT, dealId = 'deal:1') {
  const g = await createApplyGrant({
    tenantId, orgId: 'org-1', subjectId: SUBJECT, grantedBy: 'user-authoriser',
    campaignId: CAMPAIGN, maxSubmits: 20, maxPrepared: 5, ratePerHour: 4,
    origins: ['boards.example.com'], resumePolicy: 'default',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await consumeSubmit(tenantId, g.grantId, Date.now(), dealId);
  return issued(await issueAttestation({ tenantId, dealId, issuedBy: SUBJECT, now: Date.now() }));
}

describe('ADR 0544 P2 — hash at rest, resolve by point lookup', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('issues a token that resolves to its frozen claims', async () => {
    const { token } = await seed();
    const view = await resolveAttestation(token);
    expect(view).toBeTruthy();
    expect(view!.claims.length).toBeGreaterThan(0);
  });

  it('does NOT return the campaign string — it correlates and nobody reads it', async () => {
    // This assertion replaces one that REQUIRED the leak (`expect(view.campaignId)
    // .toBe(CAMPAIGN)`), which is why P2's review could not see it: the test had
    // already ruled the disclosure intentional. The campaign is free text the
    // APPLICANT types, so it both ties two attestations to one person and can
    // carry whatever they happened to write into a form field.
    const { token } = await seed();
    const view = await resolveAttestation(token);
    expect(Object.keys(view!)).not.toContain('campaignId');
    expect(JSON.stringify(view)).not.toContain(CAMPAIGN);
  });

  it('gives issuedAt at DAY precision, not to the millisecond', async () => {
    // Enough to judge staleness; too coarse to fingerprint an issuance moment.
    const { token } = await seed();
    expect((await resolveAttestation(token))!.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('stores only the HASH — a database read yields no working token', async () => {
    const { token, attestationId } = await seed();
    const rows = await listAttestations(TENANT);
    const rec = rows.find((r) => r.attestationId === attestationId)!;
    // The projection has no hash field at all, and the raw token appears nowhere.
    expect(JSON.stringify(rec)).not.toContain(token);
    expect(Object.keys(rec)).not.toContain('tokenHash');
    // …and the stored hash is genuinely the hash of the token.
    expect(hashToken(token)).toBeTruthy();
  });

  it('the verifier view leaks NOTHING about the applicant’s workspace', async () => {
    // This test PASSED FOR THE WRONG REASON in its first form: it checked
    // `issuedBy`/`user-1`/`deal:1` and never `grantedBy`, which was being
    // returned verbatim. `/code-review` caught the real leak. Now every
    // identifier that exists anywhere in the record is checked.
    const { token } = await seed();
    const view = await resolveAttestation(token);
    const json = JSON.stringify(view);
    for (const leak of [TENANT, 'deal:1', 'tokenHash', 'issuedBy', 'user-authoriser', SUBJECT, 'grant:', 'entryHash', 'seq', CAMPAIGN]) {
      expect(json, `the verifier view leaked ${leak}`).not.toContain(leak);
    }
  });

  it('states the authorisation as a FACT, never as an identifier', async () => {
    // "A named person authorised this under a bounded policy" is the signal an
    // employer can act on. WHICH person is not theirs, and handing it over lets
    // anyone holding two attestations correlate them to the same authoriser.
    const { token } = await seed();
    const view = await resolveAttestation(token);
    const auth = view!.claims.find((c) => c.type === 'authorised-by-person')!;
    expect(auth.facts.authorisedByNamedPerson).toBe(true);
    expect(auth.facts.maxSubmits, 'the BOUND is the checkable part').toBeGreaterThan(0);
    expect(Object.values(auth.facts).some((v) => typeof v === 'string' && v.includes('user'))).toBe(false);
  });

  it('replaces the source ref with an opaque DIGEST', async () => {
    // The issuer can recompute it to prove correspondence; a correlator gets an
    // opaque string instead of a grant id and an audit sequence number — the
    // latter being a side channel on how much governance activity the workspace has.
    const { token } = await seed();
    const view = await resolveAttestation(token);
    for (const c of view!.claims) {
      expect(c.sourceDigest).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('projects by WHITELIST, so a future claim field cannot leak by default', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'attestation', 'token.ts'), 'utf8');
    // A "strip these fields" projection silently leaks whatever a new variant
    // adds; a switch over the union forces each new claim to declare what a
    // stranger may see.
    expect(src).toContain('function toVerifierClaim');
    expect(src).toMatch(/switch \(c\.type\)/);
  });

  it('resolves without any tenant parameter — tenant comes from the RESOURCE', () => {
    // A tenantId parameter here is what would make cross-tenant probing possible
    // at all, so its absence is the property (D3).
    const src = readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'attestation', 'token.ts'), 'utf8');
    expect(src).toMatch(/resolveAttestation\(rawToken: string\)/);
  });
});

describe('ADR 0544 D4 — indistinguishability, compared against each other', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('unknown, revoked and cross-tenant all produce the IDENTICAL answer', async () => {
    const mine = await seed(TENANT);
    const theirs = await seed(OTHER);
    await revokeAttestation(TENANT, mine.attestationId, Date.now());

    const unknown = await resolveAttestation('owatt_totally-made-up-token-value');
    const revoked = await resolveAttestation(mine.token);
    // A cross-tenant probe: a real token from another workspace, resolved by a
    // verifier who should learn nothing about which workspace it belongs to.
    const crossTenantView = await resolveAttestation(theirs.token);

    // The first two must be byte-identical — not merely both falsy.
    expect(revoked).toStrictEqual(unknown);
    expect(JSON.stringify(revoked)).toBe(JSON.stringify(unknown));
    // The valid one resolves, and reveals no tenant either way.
    expect(crossTenantView).toBeTruthy();
    expect(JSON.stringify(crossTenantView)).not.toContain(OTHER);
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['well-formed but unissued', 'owatt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['a hash rather than a token', hashToken('owatt_whatever')],
  ])('a %s token is the same null as any other failure', async (_l, candidate) => {
    await seed();
    expect(await resolveAttestation(candidate)).toBeNull();
  });

  it('revocation does not DELETE the record', async () => {
    // Keeping it is what makes revoked and unknown indistinguishable through the
    // same path — and it preserves the applicant's own record of what they
    // attested.
    const { attestationId } = await seed();
    await revokeAttestation(TENANT, attestationId, Date.now());
    const rows = await listAttestations(TENANT);
    expect(rows.find((r) => r.attestationId === attestationId)?.revokedAt).toBeTruthy();
  });

  it('a second revoke is false, not an error', async () => {
    const { attestationId } = await seed();
    expect(await revokeAttestation(TENANT, attestationId, Date.now())).toBe(true);
    expect(await revokeAttestation(TENANT, attestationId, Date.now())).toBe(false);
  });

  it('cross-tenant revoke does nothing', async () => {
    const mine = await seed(TENANT);
    expect(await revokeAttestation(OTHER, mine.attestationId, Date.now())).toBe(false);
    expect(await resolveAttestation(mine.token), 'a neighbour must not be able to revoke mine').toBeTruthy();
  });
});

describe('ADR 0544 matrix row 9 — the claims are FROZEN in the token', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('later applications do not change what an issued token says', async () => {
    const g = await createApplyGrant({
      tenantId: TENANT, orgId: 'org-1', subjectId: SUBJECT, grantedBy: 'user-authoriser',
      campaignId: CAMPAIGN, maxSubmits: 20, maxPrepared: 5, ratePerHour: 4,
      origins: ['boards.example.com'], resumePolicy: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    const { token } = issued(await issueAttestation({ tenantId: TENANT, dealId: 'deal:1', issuedBy: SUBJECT, now: Date.now() }));
    const before = JSON.stringify((await resolveAttestation(token))!.claims);

    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:2');
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:3');

    const after = JSON.stringify((await resolveAttestation(token))!.claims);
    expect(after, 'a token that changes its own claims is a different statement under the same signature').toBe(before);
  });

  it('the ONLY writer besides issue/revoke is the ERASURE path', () => {
    // This test caught the eraser when it was added, which is the behaviour I
    // wanted: a new export here must be justified, not absorbed.
    //
    // `eraseSubjectAttestations` genuinely edits a frozen claim set, and that is
    // the one sanctioned exception — an erasure obligation outranks an
    // immutability convention, and the alternative is a permanent public record
    // of a person who asked to be forgotten. Anything ELSE appearing in this
    // list is a mutation path that should not exist.
    const src = readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'attestation', 'token.ts'), 'utf8');
    const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    //
    // P4 added `previewAttestation`, and this ratchet made me justify it rather
    // than absorb it — which is the whole point of the list. It is a READ: it
    // runs the same derivation and the same projection as issuance and then
    // returns them WITHOUT persisting anything (pinned by "previewing issues
    // NOTHING" above). A preview that wrote would defeat its own purpose.
    expect(exported.sort()).toEqual([
      // `__hashIndexCountForTest` joined with the JS-DATA-3 erasure work: a
      // READ-ONLY test peek at the hash index — erasure deletes index rows and
      // revocation keeps them, and `resolveAttestation` returns null for both,
      // so the index is the only place that difference is observable. It
      // mutates nothing; the ratchet made it justify itself here, as designed.
      '__hashIndexCountForTest',
      'eraseSubjectAttestations', 'issueAttestation', 'listAttestations', 'previewAttestation',
      'resolveAttestation', 'revokeAttestation',
    ]);
  });
});

describe('ADR 0464 — erasing the authoriser', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('revokes AND redacts, so the token stops resolving and the name is gone', async () => {
    const { token, attestationId } = await seed();
    expect(await resolveAttestation(token)).toBeTruthy();

    await eraseSubjectAttestations(TENANT, 'user-authoriser');

    // Revoked first: the public token stops working immediately.
    expect(await resolveAttestation(token)).toBeNull();
    // …and the person is gone from the frozen claim, which is the one place an
    // "immutable" record must yield to an erasure obligation.
    const rec = (await listAttestations(TENANT)).find((r) => r.attestationId === attestationId)!;
    expect(JSON.stringify(rec)).not.toContain('user-authoriser');
    expect(rec.revokedAt).toBeTruthy();
  });

  it('does NOT delete the applicant’s own record of what they attested', async () => {
    // An erasure that silently destroys someone's evidence of their own conduct
    // is not a privacy win.
    const { attestationId } = await seed();
    await eraseSubjectAttestations(TENANT, 'user-authoriser');
    expect((await listAttestations(TENANT)).some((r) => r.attestationId === attestationId)).toBe(true);
  });

  it('leaves attestations naming someone else alone', async () => {
    const { token } = await seed();
    await eraseSubjectAttestations(TENANT, 'user-unrelated');
    expect(await resolveAttestation(token)).toBeTruthy();
  });
});


describe('ADR 0544 P4 — the caller supplies a dealId and nothing else', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  async function grant(campaignId: string, subjectId = SUBJECT) {
    return createApplyGrant({
      tenantId: TENANT, orgId: 'org-1', subjectId, grantedBy: 'user-authoriser',
      campaignId, maxSubmits: 20, maxPrepared: 5, ratePerHour: 4,
      origins: ['boards.example.com'], resumePolicy: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  }

  it('refuses an application this host has no record of sending', async () => {
    // P2 would mint one for any `deal:` string a caller typed. An attestation
    // for an application that never went out is a fabricated claim with a
    // hash-linked source ref beside it — the worst possible combination.
    const r = await issueAttestation({ tenantId: TENANT, dealId: 'deal:never-sent', issuedBy: SUBJECT, now: Date.now() });
    expect(r).toEqual({ refused: 'not-attestable' });
  });

  it('cannot borrow ANOTHER campaign’s numbers for this application', async () => {
    // The hole D1 did not actually close. Two campaigns, wildly different
    // volumes; the caller used to name the campaign in the request body, so it
    // could cite the flattering one on an application from the other.
    const quiet = await grant('camp-quiet');
    const busy = await grant('camp-busy');
    await consumeSubmit(TENANT, quiet.grantId, Date.now(), 'deal:quiet');
    for (let i = 0; i < 9; i += 1) await consumeSubmit(TENANT, busy.grantId, Date.now(), `deal:busy-${i}`);

    const view = await resolveAttestation(
      issued(await issueAttestation({ tenantId: TENANT, dealId: 'deal:quiet', issuedBy: SUBJECT, now: Date.now() })).token,
    );
    const count = view!.claims.find((c) => c.type === 'applications-in-window');
    expect(count?.facts.count, 'the QUIET campaign sent one; the busy one is not this application’s').toBe(1);
  });

  it('refuses when the acting user is not the person whose conduct it states', async () => {
    // An org-admin minting this on a colleague's behalf would be signing a
    // statement about someone else's job search.
    const g = await grant(CAMPAIGN);
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    expect(await issueAttestation({ tenantId: TENANT, dealId: 'deal:1', issuedBy: 'user-org-admin', now: Date.now() }))
      .toEqual({ refused: 'not-the-subject' });
  });

  it('previews EXACTLY what issuing would disclose — same projection, no drift', async () => {
    // The consent screen's whole claim is "this is what they will see". A
    // separately-written summary would drift, and the drift would land on the
    // one screen whose purpose is telling someone what they are revealing.
    const g = await grant(CAMPAIGN);
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    const pre = await previewAttestation({ tenantId: TENANT, dealId: 'deal:1', actingUser: SUBJECT, now: Date.now() });
    const view = await resolveAttestation(
      issued(await issueAttestation({ tenantId: TENANT, dealId: 'deal:1', issuedBy: SUBJECT, now: Date.now() })).token,
    );
    expect('refused' in pre).toBe(false);
    expect((pre as { claims: unknown }).claims).toStrictEqual(view!.claims);
  });

  it('preview is not a read-around — it refuses on the same terms', async () => {
    const g = await grant(CAMPAIGN);
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    expect(await previewAttestation({ tenantId: TENANT, dealId: 'deal:1', actingUser: 'someone-else', now: Date.now() }))
      .toEqual({ refused: 'not-the-subject' });
    expect(await previewAttestation({ tenantId: TENANT, dealId: 'deal:nope', actingUser: SUBJECT, now: Date.now() }))
      .toEqual({ refused: 'not-attestable' });
  });

  it('previewing issues NOTHING', async () => {
    const g = await grant(CAMPAIGN);
    await consumeSubmit(TENANT, g.grantId, Date.now(), 'deal:1');
    await previewAttestation({ tenantId: TENANT, dealId: 'deal:1', actingUser: SUBJECT, now: Date.now() });
    expect(await listAttestations(TENANT), 'a preview that wrote would defeat its own purpose').toHaveLength(0);
  });
});
