/**
 * ADR 0556 P3 / RFC 0154 §A/§B — the resolver, the credentials, and the chain.
 *
 * ADR 0556's P3 gate names four things to prove: **audience, expiry,
 * confused-deputy and replay**. The first three live here; replay lives in
 * `workload-identity-surface.test.ts` beside the fork route it constrains.
 *
 * Every assertion below was SABOTAGE-VERIFIED — the corresponding check was
 * removed from `host/workloadIdentity.ts` and the test watched go red — because
 * a fail-closed path is the exact shape that passes for the wrong reason: almost
 * everything here asserts a REFUSAL, and a function that refused unconditionally
 * would satisfy all of them. The positive resolution tests are the fence on the
 * other side, and the two-fence pairing is deliberate: `resolves to a principal`
 * dies if the resolver over-refuses, each negative dies if it under-refuses.
 *
 * The confused-deputy test is non-vacuous by construction: two real tenants, two
 * real trust roots, and an assertion that the refusal DISCLOSES nothing —
 * because a refusal that named the other tenant would be the disclosure RFC 0132
 * §A.2 forbids while looking like a correct denial.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { configureSecretResolver, setSecret } from '../src/byok/secretResolver.js';
import {
  HOST_WORKER_SCOPES,
  MAX_CREDENTIAL_TTL_S,
  SUBJECT_SALT_REF,
  advertisedWorkloadSchemes,
  isWellFormedIdentity,
  isWorkloadIdentityEnabled,
  mintWorkloadCredential,
  readWorkloadIdentityConfigFromEnv,
  resolveWorkloadIdentity,
  verifyWorkloadCredential,
  type WorkloadIdentity,
} from '../src/host/workloadIdentity.js';

const HOST_AUDIENCE = 'openwop-host';
const HOST_ISSUER = 'urn:openwop:test-host';
const PEER_ISSUER = 'spiffe://example';
const PEER_KEY_REF = 'auth:workload-identity-peer-key';

/** The suite's canonical verified identity — the same shape the conformance
 *  witness presents, so a change that breaks the sibling suite breaks here too. */
const PEER_IDENTITY: WorkloadIdentity = {
  scheme: 'spiffe',
  subject: 'spiffe://example/dispatcher',
  issuer: PEER_ISSUER,
  audience: HOST_AUDIENCE,
};

function trust(extra: Record<string, unknown>[] = []): string {
  return JSON.stringify([
    {
      issuer: PEER_ISSUER,
      scheme: 'spiffe',
      issuerClass: 'spiffe',
      tenantId: 'tenant-a',
      scopes: ['manifest:read', 'runs:read'],
      keyRef: PEER_KEY_REF,
    },
    ...extra,
  ]);
}

beforeAll(async () => {
  // A real secret store, because the salt and the signing key come out of the
  // BYOK resolver and a stubbed one would prove nothing about either.
  const storage = await openStorage('memory://');
  configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'wid-')) });
  await setSecret(PEER_KEY_REF, 'peer-signing-key');
});

beforeEach(() => {
  process.env.OPENWOP_SESSION_SECRET = 'workload-identity-test-session-secret';
  process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = HOST_AUDIENCE;
  process.env.OPENWOP_WORKLOAD_IDENTITY_ISSUER = HOST_ISSUER;
  process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST = trust();
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  delete process.env.OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS;
  delete process.env.OPENWOP_WORKLOAD_IDENTITY_MAX_CHAIN_DEPTH;
});

afterEach(() => {
  for (const key of [
    'OPENWOP_WORKLOAD_IDENTITY_AUDIENCE',
    'OPENWOP_WORKLOAD_IDENTITY_ISSUER',
    'OPENWOP_WORKLOAD_IDENTITY_TRUST',
    'OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS',
    'OPENWOP_WORKLOAD_IDENTITY_MAX_CHAIN_DEPTH',
    'OPENWOP_TEST_SEAM_ENABLED',
  ]) delete process.env[key];
});

/** Narrowing helper — a resolution that was supposed to succeed. */
function expectResolved(r: Awaited<ReturnType<typeof resolveWorkloadIdentity>>) {
  if (!r.ok) throw new Error(`expected a resolution, got refusal ${r.reason}/${r.cause}`);
  return r.principal;
}

/** …and one that was supposed to fail. Returning the pair rather than asserting
 *  inline so a test can name BOTH the wire reason and the internal cause: the
 *  reason alone is satisfiable by four different bugs. */
function expectRefused(r: Awaited<ReturnType<typeof resolveWorkloadIdentity>>) {
  if (r.ok) throw new Error(`expected a refusal, got principal ${r.principal.principalId}`);
  return r;
}

describe('RFC 0154 §A — verify, bind, resolve, fail closed', () => {
  it('a verified identity resolves to an OPAQUE principal, never the subject verbatim', async () => {
    const p = expectResolved(await resolveWorkloadIdentity(PEER_IDENTITY, 'test-seam'));
    expect(p.principalId).toMatch(/^workload:spiffe:[A-Za-z0-9_-]{22}$/);
    // §A: "The resolved principal MUST NOT be the presented `subject` verbatim".
    // A SPIFFE ID names a deployment topology, and a principal id reaches every
    // event, span and audit record the principal touches.
    expect(p.principalId).not.toContain(PEER_IDENTITY.subject);
    expect(p.tenantId).toBe('tenant-a');
    expect(p.audienceDecision).toBe('match');
    expect(p.delegationDepth).toBe(0);
    // Bearer fallback is what this host takes, and §C requires it to be
    // DISTINGUISHABLE from a key-bound identity rather than merely unmentioned.
    expect(p.senderConstraint).toBe('none');
  });

  it('an identity minted for another host is refused (audience_mismatch)', async () => {
    // The load-bearing negative. Accepting one is how a credential valid
    // elsewhere becomes a credential valid here — the confused-deputy path.
    const r = expectRefused(
      await resolveWorkloadIdentity({ ...PEER_IDENTITY, audience: 'some-other-host' }, 'test-seam'),
    );
    expect(r.reason).toBe('audience_mismatch');
    expect(r.cause).toBe('audience_mismatch');
  });

  it('an identity with NO audience is refused', async () => {
    // A credential minted for no audience in particular is usable at every host
    // that will take it, which is the same failure with the check removed rather
    // than failed.
    const { audience: _dropped, ...noAudience } = PEER_IDENTITY;
    const r = expectRefused(await resolveWorkloadIdentity(noAudience, 'test-seam'));
    expect(r.reason).toBe('audience_mismatch');
    expect(r.cause).toBe('audience_absent');
  });

  it("a caller cannot talk the host into answering to a different name", async () => {
    // `expectedAudience` is the CALLER's opinion. It is checked against the
    // host's own rather than substituted for it.
    const r = expectRefused(
      await resolveWorkloadIdentity(PEER_IDENTITY, 'test-seam', { expectedAudience: 'attacker-host' }),
    );
    expect(r.reason).toBe('audience_mismatch');
  });

  it('an unknown issuer is refused, and so is a known issuer with the wrong scheme', async () => {
    const unknown = expectRefused(
      await resolveWorkloadIdentity({ scheme: 'spiffe', subject: 'spiffe://example/unknown' }, 'test-seam'),
    );
    expect(unknown.reason).toBe('identity_unverified');
    expect(unknown.cause).toBe('issuer_unknown');

    const wrongScheme = expectRefused(
      await resolveWorkloadIdentity({ ...PEER_IDENTITY, scheme: 'oauth-client' }, 'test-seam'),
    );
    expect(wrongScheme.cause).toBe('scheme_unadvertised');
  });

  it('a sender constraint the host requires and the caller omits is refused', async () => {
    process.env.OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS = 'mtls';
    const missing = expectRefused(await resolveWorkloadIdentity(PEER_IDENTITY, 'test-seam'));
    expect(missing.reason).toBe('sender_constraint_missing');
    // And the positive fence: presenting the constraint the host advertises
    // resolves, and the principal RECORDS which — §C forbids a bearer-verified
    // identity inheriting a sender-constrained assurance claim.
    const bound = expectResolved(
      await resolveWorkloadIdentity({ ...PEER_IDENTITY, keyBinding: { method: 'mtls' } }, 'test-seam'),
    );
    expect(bound.senderConstraint).toBe('mtls');
  });

  it('a projection whose provenance is not a verified source is refused outright', async () => {
    // The structural form of "forwarded identity headers are attacker-controlled
    // unless the terminator is configured-trusted". With the seam gate off there
    // is no admissible source for a bare projection at all.
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    const r = expectRefused(await resolveWorkloadIdentity(PEER_IDENTITY, 'test-seam'));
    expect(r.cause).toBe('projection_unverified');
  });

  it('an unconfigured profile resolves nothing and claims nothing', async () => {
    delete process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE;
    expect(isWorkloadIdentityEnabled()).toBe(false);
    expect(readWorkloadIdentityConfigFromEnv()).toBeNull();
    const r = expectRefused(await resolveWorkloadIdentity(PEER_IDENTITY, 'verified-credential'));
    expect(r.cause).toBe('profile_disabled');
  });
});

describe('RFC 0154 §A — the closed shape refuses credential material', () => {
  it('rejects the four smuggling shapes the schema rejects', () => {
    for (const extra of [
      { certificate: '-----BEGIN CERTIFICATE-----' },
      { token: 'eyJhbGciOiJIUzI1NiJ9.x.y' },
      { privateKey: 'secret' },
      { proof: 'raw-proof-bytes' },
    ]) {
      expect(
        isWellFormedIdentity({ ...PEER_IDENTITY, ...extra }),
        `raw credentials MUST NOT enter the identity object — accepted \`${Object.keys(extra)[0]}\``,
      ).toBe(false);
    }
  });

  it('rejects an unknown scheme, an empty subject, and a raw key pasted as a thumbprint', () => {
    expect(isWellFormedIdentity({ scheme: 'trust-me', subject: 'x' })).toBe(false);
    expect(isWellFormedIdentity({ scheme: 'spiffe', subject: '' })).toBe(false);
    expect(isWellFormedIdentity({ scheme: 'mtls-san', subject: 'x', keyBinding: { method: 'mtls', thumbprintRef: 'MIIBIjANBgkqh' } })).toBe(false);
    expect(isWellFormedIdentity({ scheme: 'mtls-san', subject: 'x', keyBinding: { method: 'mtls', thumbprintRef: `sha256:${'a'.repeat(64)}` } })).toBe(true);
  });

  it('rejects a proof pasted where a proofRef belongs, and an over-wide chain hop', () => {
    const del = { chain: [{ subject: 'a' }], audience: HOST_AUDIENCE };
    expect(isWellFormedIdentity({ ...PEER_IDENTITY, delegation: { ...del, proofRef: 'eyJhbGciOiJIUzI1NiJ9.a.b' } })).toBe(false);
    expect(isWellFormedIdentity({ ...PEER_IDENTITY, delegation: { ...del, proofRef: `sha256:${'b'.repeat(64)}` } })).toBe(true);
    expect(isWellFormedIdentity({ ...PEER_IDENTITY, delegation: { chain: [{ subject: 'a', token: 'y' }], audience: HOST_AUDIENCE } })).toBe(false);
    expect(isWellFormedIdentity({ ...PEER_IDENTITY, delegation: { chain: [], audience: HOST_AUDIENCE } })).toBe(false);
  });
});

describe('RFC 0154 §B — the delegated actor chain is bounded, acyclic and expiring', () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();

  function withChain(chain: { subject: string; issuer?: string; scopes?: readonly string[] }[], overrides: Record<string, unknown> = {}) {
    return {
      ...PEER_IDENTITY,
      delegation: { chain, audience: HOST_AUDIENCE, expiresAt: future(), ...overrides },
    } as WorkloadIdentity;
  }

  it('a live, bounded, acyclic chain resolves and reports its DEPTH (never the chain)', async () => {
    const p = expectResolved(
      await resolveWorkloadIdentity(withChain([{ subject: 'a', issuer: PEER_ISSUER }, { subject: 'b' }]), 'test-seam'),
    );
    expect(p.delegationDepth).toBe(2);
    // The chain is provenance, not authority: the resolved scopes are still the
    // trust root's, unwidened by anything the chain said.
    expect(p.scopes).toEqual(['manifest:read', 'runs:read']);
  });

  it('an expired delegation is refused (delegation_expired)', async () => {
    const r = expectRefused(
      await resolveWorkloadIdentity(withChain([{ subject: 'a' }], { expiresAt: '2020-01-01T00:00:00Z' }), 'test-seam'),
    );
    expect(r.reason).toBe('delegation_expired');
    expect(r.cause).toBe('delegation_expired');
  });

  it('a delegation with NO expiry is refused — a standing grant is not delegation', async () => {
    const r = expectRefused(
      await resolveWorkloadIdentity(
        { ...PEER_IDENTITY, delegation: { chain: [{ subject: 'a' }], audience: HOST_AUDIENCE } },
        'test-seam',
      ),
    );
    expect(r.reason).toBe('delegation_expired');
    expect(r.cause).toBe('delegation_no_expiry');
  });

  it('a chain longer than the advertised bound is refused', async () => {
    process.env.OPENWOP_WORKLOAD_IDENTITY_MAX_CHAIN_DEPTH = '2';
    const r = expectRefused(
      await resolveWorkloadIdentity(withChain([{ subject: 'a' }, { subject: 'b' }, { subject: 'c' }]), 'test-seam'),
    );
    expect(r.cause).toBe('chain_too_deep');
    // The WIRE reason is the closed §20 code, not the generic `identity_unverified`
    // it collapsed to before 2026-08-16 — the bound is the fact a peer needs.
    expect(r.reason).toBe('delegation_chain_too_long');
    // The bound the resolver enforces is the bound the host advertises — read
    // from one config object, so the two cannot drift.
    expect(readWorkloadIdentityConfigFromEnv()?.maxChainDepth).toBe(2);
  });

  it('RFC 0154 §B "Bounds" — hop scopes may narrow, never widen; absent scopes are unstated', async () => {
    // Amplified: hop 2 claims runs:write which hop 1 did not hold.
    const amplified = expectRefused(
      await resolveWorkloadIdentity(
        withChain([{ subject: 'a', scopes: ['runs:read'] }, { subject: 'b', scopes: ['runs:read', 'runs:write'] }]),
        'test-seam',
      ),
    );
    expect(amplified.cause).toBe('scope_amplification');
    expect(amplified.reason).toBe('delegation_scope_amplified');
    // Narrowing resolves.
    expect(
      (await resolveWorkloadIdentity(
        withChain([{ subject: 'a', scopes: ['runs:read', 'manifest:read'] }, { subject: 'b', scopes: ['runs:read'] }]),
        'test-seam',
      )).ok,
    ).toBe(true);
    // A hop WITHOUT scopes between two with scopes does not reset the bound to
    // "everything": unstated is unstated, and the next stated hop is compared
    // against the last STATED one.
    const viaUnstated = expectRefused(
      await resolveWorkloadIdentity(
        withChain([{ subject: 'a', scopes: ['runs:read'] }, { subject: 'b' }, { subject: 'c', scopes: ['runs:write'] }]),
        'test-seam',
      ),
    );
    expect(viaUnstated.cause).toBe('scope_amplification');
  });

  it('a cyclic chain is refused, and a one-hop chain naming the presenter is NOT a cycle', async () => {
    const cyclic = expectRefused(
      await resolveWorkloadIdentity(withChain([{ subject: 'a' }, { subject: 'b' }, { subject: 'a' }]), 'test-seam'),
    );
    expect(cyclic.cause).toBe('chain_cycle');
    expect(cyclic.reason).toBe('delegation_chain_cyclic');
    // The distinction the conformance witness depends on: its expired-delegation
    // leg presents a one-hop chain whose subject IS the presenting workload, and
    // it expects `delegation_expired`. A cycle check that folded the presenter
    // into the seen-set would answer `chain_cycle` and the leg would fail.
    expect(
      (await resolveWorkloadIdentity(withChain([{ subject: PEER_IDENTITY.subject }]), 'test-seam')).ok,
    ).toBe(true);
  });

  it('a chain whose audience is not this host is refused', async () => {
    const r = expectRefused(
      await resolveWorkloadIdentity(withChain([{ subject: 'a' }], { audience: 'elsewhere' }), 'test-seam'),
    );
    expect(r.reason).toBe('audience_mismatch');
    expect(r.cause).toBe('delegation_audience_mismatch');
  });

  it('a hop from an issuer this host does not trust is an unverified hop', async () => {
    const r = expectRefused(
      await resolveWorkloadIdentity(withChain([{ subject: 'a', issuer: 'spiffe://attacker' }]), 'test-seam'),
    );
    expect(r.cause).toBe('chain_issuer_unknown');
  });

  it('`onBehalfOf` cannot be self-asserted on a projection', async () => {
    const r = expectRefused(
      await resolveWorkloadIdentity(
        { ...PEER_IDENTITY, onBehalfOf: { principalId: 'user:victim', kind: 'user' } },
        'test-seam',
      ),
    );
    expect(r.cause).toBe('self_asserted_on_behalf_of');
  });
});

describe('RFC 0154 — host-minted worker credentials', () => {
  it('mint → verify → resolve round-trips through the SAME path a peer takes', async () => {
    const token = await mintWorkloadCredential({
      subject: 'worker/test',
      tenantId: 'tenant-w',
      scopes: ['runs:read'],
    });
    const verified = await verifyWorkloadCredential(token);
    if (!verified.ok) throw new Error(`expected verification, got ${verified.cause}`);
    expect(verified.identity.scheme).toBe('oauth-client');
    expect(verified.identity.audience).toBe(HOST_AUDIENCE);
    expect(verified.tenantId).toBe('tenant-w');
    const p = expectResolved(
      await resolveWorkloadIdentity(verified.identity, 'verified-credential', {
        verified: { tenantId: verified.tenantId, scopes: verified.scopes },
      }),
    );
    expect(p.scopes).toEqual(['runs:read']);
    expect(p.issuerClass).toBe('oauth');
  });

  it('the credential is SHORT-LIVED — a caller cannot ask for a long one', async () => {
    const token = await mintWorkloadCredential({
      subject: 'worker/test',
      tenantId: 'tenant-w',
      scopes: [],
      ttlSeconds: 86_400,
    });
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp: number; iat: number };
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(MAX_CREDENTIAL_TTL_S);
  });

  it('a tampered signature, a swapped `alg`, and an expired credential are all refused', async () => {
    const token = await mintWorkloadCredential({ subject: 'worker/test', tenantId: 'tenant-w', scopes: [] });
    const [h, b, s] = token.split('.');

    const tampered = await verifyWorkloadCredential(`${h}.${b}.${'A'.repeat(s.length)}`);
    expect(tampered.ok).toBe(false);

    // `alg` is PINNED, not read. Honouring the credential's own `alg` is the
    // classic JWS-confusion bug.
    //
    // The obvious version of this test — an `alg: "none"` header with an EMPTY
    // signature — passes even with the pin removed, because the empty signature
    // fails the HMAC comparison. It is a two-fence test that proves the wrong
    // fence (measured: sabotaging the pin left it green). So the credential
    // below carries `alg: "none"` AND a signature that is genuinely valid over
    // it, which only the pin can refuse.
    for (const alg of ['none', 'HS512']) {
      expect(
        (await verifyWorkloadCredential(await signAs(alg, claimsOf(b)))).ok,
        `\`alg: ${alg}\` was honoured — the host must decide the algorithm, not the credential`,
      ).toBe(false);
    }

    const claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) as Record<string, unknown>;
    const expired = await mintExpired({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 });
    const r = await verifyWorkloadCredential(expired);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('credential_expired');
  });

  it('a credential asking for MORE than the worker ceiling is refused, not trimmed', async () => {
    // A silent trim would hide the amplification attempt from the audit trail,
    // which is the half of the guard that matters after the fact.
    const token = await mintWorkloadCredential({
      subject: 'worker/greedy',
      tenantId: 'tenant-w',
      // `webhooks:manage` is a real protocol scope and deliberately NOT in
      // HOST_WORKER_SCOPES — a background worker administers nothing.
      scopes: ['runs:read', 'webhooks:manage'],
    });
    expect(HOST_WORKER_SCOPES).not.toContain('webhooks:manage');
    const verified = await verifyWorkloadCredential(token);
    if (!verified.ok) throw new Error('expected verification');
    const r = expectRefused(
      await resolveWorkloadIdentity(verified.identity, 'verified-credential', {
        verified: { tenantId: verified.tenantId, scopes: verified.scopes },
      }),
    );
    expect(r.cause).toBe('scope_amplification');
  });
});

describe('RFC 0154 — confused deputy: two tenants, two roots, one refusal that says nothing', () => {
  const SECOND_ROOT = {
    issuer: 'spiffe://partner',
    scheme: 'spiffe',
    issuerClass: 'spiffe',
    tenantId: 'tenant-b',
    scopes: ['runs:read'],
    keyRef: PEER_KEY_REF,
  };

  beforeEach(() => {
    process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST = trust([SECOND_ROOT]);
  });

  it('the same subject under two roots resolves to two DIFFERENT principals', async () => {
    // Non-vacuity: both resolutions succeed, so this cannot pass by refusing.
    // The salt is per-tenant, so tenant A's audit reader cannot correlate its
    // hashes with tenant B's even for a workload with an identical subject.
    const a = expectResolved(await resolveWorkloadIdentity(PEER_IDENTITY, 'test-seam'));
    const b = expectResolved(
      await resolveWorkloadIdentity({ ...PEER_IDENTITY, issuer: 'spiffe://partner' }, 'test-seam'),
    );
    expect(a.tenantId).toBe('tenant-a');
    expect(b.tenantId).toBe('tenant-b');
    expect(a.principalId).not.toBe(b.principalId);
  });

  it("a verified credential cannot act in a tenant its root does not bind, and the refusal does not say which", async () => {
    // The deputy: a credential that verified fine, presenting a tenant its
    // ROOT-bound issuer has no authority over.
    const r = expectRefused(
      await resolveWorkloadIdentity(PEER_IDENTITY, 'verified-credential', {
        verified: { tenantId: 'tenant-b', scopes: [] },
      }),
    );
    expect(r.cause).toBe('tenant_mismatch');
    // Neutralization WITHOUT disclosure (RFC 0132 §A.2): the WIRE reason is the
    // same one an unmapped subject produces, so a prober cannot use the refusal
    // to learn that `tenant-b` exists.
    expect(r.reason).toBe('identity_unresolvable');
    const unmapped = expectRefused(
      await resolveWorkloadIdentity({ ...PEER_IDENTITY, issuer: 'spiffe://nobody' }, 'test-seam'),
    );
    expect(r.reason).not.toBe('tenant_mismatch');
    expect(JSON.stringify(r)).not.toContain('tenant-b');
    expect(unmapped.reason).toBe('identity_unverified'); // the other arm, for contrast
  });

  it('the advertised schemes are DERIVED from the roots — drop a root, lose the claim', async () => {
    process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST = JSON.stringify([
      { ...SECOND_ROOT, scheme: 'cloud-subject', issuerClass: 'cloud' },
    ]);
    const cfg = readWorkloadIdentityConfigFromEnv();
    expect(cfg).not.toBeNull();
    // `oauth-client` is always present — the host's OWN issuer is always a root,
    // and it is genuinely verifiable.
    expect(advertisedWorkloadSchemes(cfg!)).toEqual(['cloud-subject', 'oauth-client']);
    // And with no external root at all, the host claims only what it mints.
    delete process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST;
    expect(advertisedWorkloadSchemes(readWorkloadIdentityConfigFromEnv()!)).toEqual(['oauth-client']);
  });

  it('an external root may not shadow the host issuer, and a root without a tenant is rejected', () => {
    process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST = JSON.stringify([
      { issuer: HOST_ISSUER, scheme: 'spiffe', tenantId: 'attacker', scopes: ['runs:create'] },
      { issuer: 'spiffe://untenanted', scheme: 'spiffe', scopes: ['runs:read'] },
    ]);
    const cfg = readWorkloadIdentityConfigFromEnv();
    // Shadowing the host issuer would let an operator-config typo mint host
    // worker authority; a root with no tenant binds its workloads to nothing,
    // which is the same as binding them to everything.
    expect(cfg?.roots.get(HOST_ISSUER)?.tenantBinding).toBe('credential');
    expect(cfg?.roots.has('spiffe://untenanted')).toBe(false);
  });
});

describe('RFC 0154 §D / gap G5 — hashed subjects under a rotatable per-tenant salt', () => {
  it('the principal id is stable, and rotating the tenant salt makes prior hashes unlinkable', async () => {
    const before = expectResolved(await resolveWorkloadIdentity(PEER_IDENTITY, 'test-seam')).principalId;
    expect(expectResolved(await resolveWorkloadIdentity(PEER_IDENTITY, 'test-seam')).principalId).toBe(before);

    // The deletion mechanism §D specifies: rotate the salt, do not edit the
    // append-only log. The prior hash still exists in old records and now
    // correlates with nothing.
    await setSecret(SUBJECT_SALT_REF, 'rotated-salt-value', { tenantId: 'tenant-a' });
    const after = expectResolved(await resolveWorkloadIdentity(PEER_IDENTITY, 'test-seam')).principalId;
    expect(after).not.toBe(before);
  });
});

/**
 * Sign an arbitrary header `alg` + claim set with the host key, so a test can
 * construct credentials the minter would never produce: an expired one, and one
 * whose header LIES about the algorithm while carrying a signature that is
 * genuinely valid over that header.
 *
 * Derives the key the same way the module does rather than reaching into it, so
 * a change to the derivation breaks these tests rather than silently making
 * them unfalsifiable.
 */
async function signAs(alg: string, claims: Record<string, unknown>): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const key = createHmac('sha256', process.env.OPENWOP_SESSION_SECRET as string)
    .update('openwop:workload-identity:signing:v1')
    .digest();
  const header = Buffer.from(JSON.stringify({ alg, typ: 'openwop-wid+jwt' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** The claim set inside a compact credential's payload segment. */
function claimsOf(payloadSegment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** An otherwise-valid credential whose `exp` is in the past. */
function mintExpired(claims: Record<string, unknown>): Promise<string> {
  return signAs('HS256', claims);
}
