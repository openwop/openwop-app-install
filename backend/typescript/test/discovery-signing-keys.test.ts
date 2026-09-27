/**
 * RFC 0168 §E.2 — `signingKeys[]` in the v2 discovery root.
 *
 * The negative cases are the point. An advertised key a verifier cannot resolve
 * makes every bundle signed under it FAIL the Front door, so a malformed value
 * MUST be withheld rather than guessed at or passed through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readBundleSigningKeys } from '../src/routes/discovery.js';

const VAR = 'OPENWOP_BUNDLE_SIGNING_KEYS';
const before = process.env[VAR];
afterEach(() => { if (before === undefined) delete process.env[VAR]; else process.env[VAR] = before; });
beforeEach(() => { delete process.env[VAR]; });

/** The published form: the 32 raw Ed25519 bytes, unpadded base64url. */
function rawB64u(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('signingKeys[] (RFC 0168 §E.2)', () => {
  it('is ABSENT when unconfigured — presence is the claim, so an empty array would be a different statement', () => {
    expect(readBundleSigningKeys()).toEqual([]);
  });

  it('publishes a well-formed key verbatim', () => {
    const pk = rawB64u();
    process.env[VAR] = JSON.stringify([{ keyId: 'openwop-app-self-2026-09-04', alg: 'ed25519', publicKey: pk, use: 'certification-bundle' }]);
    expect(readBundleSigningKeys()).toEqual([
      { keyId: 'openwop-app-self-2026-09-04', alg: 'ed25519', publicKey: pk, use: 'certification-bundle' },
    ]);
  });

  it('keeps a RETIRED key listed — dropping it invalidates every bundle it already signed', () => {
    const cur = rawB64u(); const old = rawB64u();
    process.env[VAR] = JSON.stringify([
      { keyId: 'cur', alg: 'ed25519', publicKey: cur },
      { keyId: 'old', alg: 'ed25519', publicKey: old, retiredAt: '2026-09-01T00:00:00Z' },
    ]);
    const out = readBundleSigningKeys();
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ keyId: 'old', retiredAt: '2026-09-01T00:00:00Z' });
  });

  it('WITHHOLDS a PEM pasted into publicKey — the commonest operator error, and it must not reach the wire', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    process.env[VAR] = JSON.stringify([{ keyId: 'k', alg: 'ed25519', publicKey: pem }]);
    expect(readBundleSigningKeys()).toEqual([]);
  });

  it('WITHHOLDS a padded/base64 (non-base64url) key', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    process.env[VAR] = JSON.stringify([{ keyId: 'k', alg: 'ed25519', publicKey: der.subarray(der.length - 32).toString('base64') }]);
    expect(readBundleSigningKeys()).toEqual([]);
  });

  it('WITHHOLDS a non-ed25519 alg, an unknown use, a bad keyId, and malformed JSON', () => {
    const pk = rawB64u();
    for (const bad of [
      JSON.stringify([{ keyId: 'k', alg: 'rsa', publicKey: pk }]),
      JSON.stringify([{ keyId: 'k', alg: 'ed25519', publicKey: pk, use: 'something-else' }]),
      JSON.stringify([{ keyId: 'has spaces', alg: 'ed25519', publicKey: pk }]),
      JSON.stringify({ keyId: 'k' }),
      '{not json',
    ]) {
      process.env[VAR] = bad;
      expect(readBundleSigningKeys(), bad.slice(0, 40)).toEqual([]);
    }
  });

  // EVERY key this deployment publishes, current and retired. Retired keys stay
  // listed on purpose (see the RETIRED case above): dropping one un-verifies the
  // bundles it already signed. `openwop-app-self-2026-09-04` was retired
  // 2026-09-19 because its PRIVATE half is not recoverable on any operator box,
  // so it can sign nothing further — but it signed the 2026-09-10 bundle, which
  // is why it must remain resolvable rather than be deleted.
  const PUBLISHED_KEYS = [
    'WVhUJ8jHoQf9g9b8VPsfMS6kiOjUSbGdjbIAiemOVq4', // openwop-app-bundle-2 (current — private half in Secret Manager `openwop-app-bundle-signing-key` v2)
    // openwop-app-bundle-1 — retired 2026-09-21. Its private half was never stored
    // durably and is LOST (32 key blocks searched, none matched). It stays listed
    // PERMANENTLY with `retiredAt` so the bundle it signed (openwop#1439) keeps
    // verifying — removing it would silently un-verify published evidence.
    'LScAhSRhmis61ScTN4wgwn8Ul19u01V148PkP7ok5ec',
    // openwop-app-self-2026-09-04 — retired 2026-09-19 on the belief it was lost;
    // its private half was in fact Secret Manager v1 all along (ADR 0735 swept
    // only the filesystem). Stays retired: un-retiring would re-open a key the
    // record says is gone.
    'SFBjFSjHaQSUbIb-FQudyk-DwOagmGyshJBwC-0zvZ4',
  ];

  it.each(PUBLISHED_KEYS)('the published key %s is a REAL curve point, not merely a 43-char string', (published) => {
    // A plausible-looking string that is not a valid Ed25519 point would verify
    // nothing and would fail only at a verifier, long after publication.
    const raw = Buffer.from(published.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(raw).toHaveLength(32);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    expect(() => createPublicKey({ key: spki, format: 'der', type: 'spki' })).not.toThrow();
  });
});

/**
 * The integration check that actually matters: the v2 root is a CLOSED schema
 * (`additionalProperties: false`), so publishing a key the corpus has not
 * defined would make this host's own discovery document invalid. This is the
 * check that refused when the pin was rc.8 — `signingKeys` lands in rc.9.
 */
describe('the v2 root still validates with signingKeys published', () => {
  it('validates against the vendored (closed) v2 capabilities schema', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { default: Ajv } = await import('ajv/dist/2020.js');
    const { buildV2Advertisement } = await import('../src/routes/discovery.js');
    const { loadConfigFromEnv } = await import('../src/index.js');

    process.env[VAR] = JSON.stringify([{
      keyId: 'openwop-app-self-2026-09-04', alg: 'ed25519',
      publicKey: 'SFBjFSjHaQSUbIb-FQudyk-DwOagmGyshJBwC-0zvZ4', use: 'certification-bundle',
    }]);

    const root = join(process.cwd(), '..', '..', 'schemas', 'v2');
    const schema = JSON.parse(readFileSync(join(root, 'capabilities.schema.json'), 'utf8'));
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    // Register every sibling v2 schema so the root's $refs resolve. Loading a
    // hand-picked subset silently fails to compile the moment the corpus adds a
    // ref, which is how a schema check quietly stops checking.
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(root).filter((x) => x.endsWith('.schema.json') && x !== 'capabilities.schema.json')) {
      try { ajv.addSchema(JSON.parse(readFileSync(join(root, f), 'utf8'))); } catch { /* duplicate $id */ }
    }
    const doc = buildV2Advertisement(loadConfigFromEnv());
    expect(Array.isArray(doc['signingKeys'])).toBe(true);

    const validate = ajv.compile(schema);
    const ok = validate(doc);
    if (!ok) console.error(JSON.stringify(validate.errors, null, 1));
    expect(ok).toBe(true);
  });
});

/**
 * BOTH roots, and this is the assertion that matters most.
 *
 * A certification bundle is v3 REGARDLESS of major (RFC 0168 §D.3): a host
 * measured at `--target-major 1` still emits a v3 bundle, and the Front door
 * resolves that bundle's `signature.keyId` in whatever discovery document the
 * host serves. Publishing the key on only ONE root leaves every bundle from the
 * other major permanently unattributable — which is precisely the gap the key
 * exists to close, reintroduced one major down. The corpus shipped exactly that
 * mistake in rc.9 and corrected it in rc.11 (P4-SPEC-11); this test is what
 * stops this host from making it again.
 */
describe('the key is published on BOTH roots', () => {
  it('appears in the v1 advertisement and the v2 advertisement, identically', async () => {
    const { buildAdvertisement, buildV2Advertisement } = await import('../src/routes/discovery.js');
    const { loadConfigFromEnv } = await import('../src/index.js');
    const entry = {
      keyId: 'openwop-app-self-2026-09-04', alg: 'ed25519',
      publicKey: 'SFBjFSjHaQSUbIb-FQudyk-DwOagmGyshJBwC-0zvZ4', use: 'certification-bundle',
    };
    process.env[VAR] = JSON.stringify([entry]);
    const cfg = loadConfigFromEnv();
    expect(buildAdvertisement(cfg)['signingKeys'], 'v1 root').toEqual([entry]);
    expect(buildV2Advertisement(cfg)['signingKeys'], 'v2 root').toEqual([entry]);
  });

  it('is absent from BOTH roots when unconfigured — neither over-claims', async () => {
    const { buildAdvertisement, buildV2Advertisement } = await import('../src/routes/discovery.js');
    const { loadConfigFromEnv } = await import('../src/index.js');
    delete process.env[VAR];
    const cfg = loadConfigFromEnv();
    expect(buildAdvertisement(cfg)['signingKeys']).toBeUndefined();
    expect(buildV2Advertisement(cfg)['signingKeys']).toBeUndefined();
  });
});
