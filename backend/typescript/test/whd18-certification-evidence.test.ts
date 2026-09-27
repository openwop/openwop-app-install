/**
 * WHD-18 / ADR 0735 decision 2 — the verifier and the out-of-image reader.
 *
 * Two halves, both unit-level (the HTTP boundary lives in
 * `whd18-certification-bundle-routes.test.ts`):
 *
 *  1. THE VERIFIER, against a REAL signed bundle. The fixture was cut by the
 *     suite CLI (2.34.0) against production commit `27315b41c…` at major 2 and
 *     signed by `openwop-app-bundle-2`. It is the only evidence that this host's
 *     mirror of the suite's canonicalisation, row reduction and attestation bytes
 *     agrees with the suite's — a synthetic bundle signed by our own helpers
 *     would only prove the mirror agrees with itself. Every tamper below must
 *     fail with the RIGHT reason: a verifier that rejects everything also turns
 *     the tamper cases green.
 *  2. THE READER, with an injected fetch and a fake clock: the metadata-token
 *     path, the bounded deadline, the caches, single-flight, and — the #3056
 *     property — that a hung fetch cannot wedge the next refresh.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CertificationEvidenceReader,
  METADATA_TOKEN_URL,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  bundleObjectKey,
  bundleObjectUrl,
  parseBundleOrigin,
  verifyServedBundle,
  type BundleOrigin,
  type FetchLike,
} from '../src/host/certificationEvidence.js';

const FIXTURE_PATH = join(__dirname, 'fixtures', 'certification-bundle-v3-27315b41c-major2.json');
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const COMMIT = '27315b41c8f43e76e99f2e0f413acff14ba026fb';
const KEY = { keyId: 'openwop-app-bundle-2', alg: 'ed25519', publicKey: 'WVhUJ8jHoQf9g9b8VPsfMS6kiOjUSbGdjbIAiemOVq4' };

type Json = Record<string, unknown>;
const fixture = (): Json => JSON.parse(FIXTURE_TEXT) as Json;
const obj = (v: unknown): Json => v as Json;
const rows = (b: Json): Json[] => obj(b['results'])['requirements'] as Json[];
const expectFor = (over: Partial<{ commit: string; major: 1 | 2; signingKeys: Json[] }> = {}) => ({
  commit: over.commit ?? COMMIT,
  major: over.major ?? 2,
  signingKeys: over.signingKeys ?? [KEY],
});
/** Flip one character of a string to a different character of the same class. */
const flip = (s: string, at = 0): string => {
  const c = s[at] ?? 'a';
  const r = c === '0' ? '1' : /[0-9]/.test(c) ? '0' : c === 'a' ? 'b' : c === 'A' ? 'B' : c === '-' ? '_' : 'a';
  return s.slice(0, at) + r + s.slice(at + 1);
};

describe('WHD-18 verifier — the REAL signed fixture', () => {
  it('the fixture is what it claims to be (a precondition, so the tamper cases are CHANGES)', () => {
    const b = fixture();
    expect(b['bundleVersion']).toBe('3');
    expect(obj(obj(b['host'])['build'])).toEqual({ kind: 'commit', id: COMMIT });
    expect(obj(b['suite'])['targetMajor']).toBe(2);
    expect(obj(b['signature'])['keyId']).toBe(KEY.keyId);
    expect(rows(b).length).toBeGreaterThan(200);
  });

  it('VERIFIES under this host\'s published key, commit and major', () => {
    expect(verifyServedBundle(fixture(), expectFor())).toEqual({ ok: true, keyId: KEY.keyId });
  });

  it('one byte of a row flipped → witness-digest', () => {
    const b = fixture();
    const row = rows(b).find((r) => typeof r['detail'] === 'string');
    if (row === undefined) throw new Error('fixture has no row with a detail to tamper');
    row['detail'] = flip(String(row['detail']), 3);
    expect(verifyServedBundle(b, expectFor())).toMatchObject({ ok: false, reason: 'witness-digest' });
  });

  it('a row\'s SCENARIO flipped → witness-digest (every digested field, not just detail)', () => {
    const b = fixture();
    const r0 = rows(b)[0]!;
    r0['scenario'] = flip(String(r0['scenario']), 0);
    expect(verifyServedBundle(b, expectFor())).toMatchObject({ ok: false, reason: 'witness-digest' });
  });

  it('one byte of host.build.id flipped → build-mismatch against the real commit', () => {
    const b = fixture();
    const build = obj(obj(b['host'])['build']);
    build['id'] = flip(String(build['id']), 5);
    expect(verifyServedBundle(b, expectFor())).toMatchObject({ ok: false, reason: 'build-mismatch' });
  });

  it('…and the SIGNATURE covers host.build: a host whose commit IS the tampered id still refuses it', () => {
    // Without this leg, "build-mismatch" above could be the only thing standing
    // between a re-labelled bundle and a pointer — an operator who uploads a
    // bundle to the key of the commit it now claims would get past the first
    // check. The attestation is what makes that impossible.
    const b = fixture();
    const build = obj(obj(b['host'])['build']);
    const forged = flip(String(build['id']), 5);
    build['id'] = forged;
    expect(verifyServedBundle(b, expectFor({ commit: forged }))).toMatchObject({ ok: false, reason: 'signature-invalid' });
  });

  it('one byte of the signature flipped → signature-invalid', () => {
    const b = fixture();
    const sig = obj(b['signature']);
    sig['sig'] = flip(String(sig['sig']), 10);
    expect(verifyServedBundle(b, expectFor())).toMatchObject({ ok: false, reason: 'signature-invalid' });
  });

  it('suite.version / discovery.sha256 flipped → signature-invalid (both are signed)', () => {
    for (const mutate of [
      (b: Json) => { obj(b['suite'])['version'] = '2.34.1'; },
      (b: Json) => { const d = obj(b['discovery']); d['sha256'] = flip(String(d['sha256']), 0); },
    ]) {
      const b = fixture();
      mutate(b);
      expect(verifyServedBundle(b, expectFor())).toMatchObject({ ok: false, reason: 'signature-invalid' });
    }
  });

  it.each([
    ['not-v3', (b: Json) => { b['bundleVersion'] = '2'; }],
    ['build-kind', (b: Json) => { obj(obj(b['host'])['build'])['kind'] = 'image-digest'; }],
    ['target-major', (b: Json) => { obj(b['suite'])['targetMajor'] = 1; }],
    ['totals-mismatch', (b: Json) => { const t = obj(obj(b['results'])['totals']); t['executedPass'] = Number(t['executedPass']) + 1; }],
    ['assertion-count', (b: Json) => { b['assertionCount'] = Number(b['assertionCount']) + 1; }],
    ['rows-malformed', (b: Json) => { rows(b).push({ ...rows(b)[0]! }); }],
    ['signature-missing', (b: Json) => { delete b['signature']; }],
    ['signature-over', (b: Json) => { obj(b['signature'])['over'] = ['witnessSha256']; }],
    ['generated-at-invalid', (b: Json) => { b['generatedAt'] = 'yesterday'; }],
  ] as const)('%s', (reason, mutate) => {
    const b = fixture();
    mutate(b);
    expect(verifyServedBundle(b, expectFor())).toMatchObject({ ok: false, reason });
  });

  it('serving the major-2 bundle as MAJOR 1 is refused (target-major)', () => {
    expect(verifyServedBundle(fixture(), expectFor({ major: 1 }))).toMatchObject({ ok: false, reason: 'target-major' });
  });

  it('a keyId the host does not publish → signature-key-unknown (no key list, no trust)', () => {
    expect(verifyServedBundle(fixture(), expectFor({ signingKeys: [] }))).toMatchObject({ ok: false, reason: 'signature-key-unknown' });
    expect(verifyServedBundle(fixture(), expectFor({ signingKeys: [{ ...KEY, keyId: 'openwop-app-bundle-1' }] })))
      .toMatchObject({ ok: false, reason: 'signature-key-unknown' });
  });

  it('the right keyId with the WRONG public key → signature-invalid', () => {
    const wrong = { ...KEY, publicKey: 'LScAhSRhmis61ScTN4wgwn8Ul19u01V148PkP7ok5ec' };
    expect(verifyServedBundle(fixture(), expectFor({ signingKeys: [wrong] }))).toMatchObject({ ok: false, reason: 'signature-invalid' });
  });

  describe('the retired-key rule', () => {
    it('a key retired BEFORE generatedAt refuses the bundle', () => {
      const retired = { ...KEY, retiredAt: '2026-09-21T00:00:00Z' }; // bundle is 14:30Z that day
      expect(verifyServedBundle(fixture(), expectFor({ signingKeys: [retired] }))).toMatchObject({ ok: false, reason: 'signature-key-retired' });
    });

    it('a key retired AFTER generatedAt still verifies it — retiring a key must not un-verify what it signed', () => {
      // `discovery-signing-keys.test.ts` states the same rule for the advert; this
      // is the reader honouring it.
      const later = { ...KEY, retiredAt: '2026-09-22T00:00:00Z' };
      expect(verifyServedBundle(fixture(), expectFor({ signingKeys: [later] }))).toEqual({ ok: true, keyId: KEY.keyId });
    });

    it('an unparseable retiredAt reads as retired (fail closed)', () => {
      const junk = { ...KEY, retiredAt: 'soon' };
      expect(verifyServedBundle(fixture(), expectFor({ signingKeys: [junk] }))).toMatchObject({ ok: false, reason: 'signature-key-retired' });
    });
  });
});

describe('WHD-18 origin configuration', () => {
  it('unset → image mode (today\'s behaviour)', () => {
    expect(parseBundleOrigin(undefined)).toEqual({ mode: 'image' });
    expect(parseBundleOrigin('  ')).toEqual({ mode: 'image' });
  });

  it('gs://bucket/prefix parses; the key is <prefix>/<commit>/major-<m>.json', () => {
    const cfg = parseBundleOrigin('gs://openwop-dev-certification-bundles/evidence/');
    expect(cfg).toMatchObject({ mode: 'origin', origin: { bucket: 'openwop-dev-certification-bundles', prefix: 'evidence' } });
    if (cfg.mode !== 'origin') throw new Error('unreachable');
    expect(bundleObjectKey(cfg.origin, COMMIT, 2)).toBe(`evidence/${COMMIT}/major-2.json`);
    expect(bundleObjectUrl(cfg.origin, COMMIT, 1)).toBe(
      `https://storage.googleapis.com/storage/v1/b/openwop-dev-certification-bundles/o/evidence%2F${COMMIT}%2Fmajor-1.json?alt=media`,
    );
  });

  it.each(['https://bucket/x', 'gs://Bad_Bucket', 'gs://ok-bucket/../etc', 'gs://ok-bucket/a//b'])(
    '%s → misconfigured (withhold, never fall back to the image)',
    (raw) => { expect(parseBundleOrigin(raw).mode).toBe('misconfigured'); },
  );
});

// ── the reader ──────────────────────────────────────────────────────────────

const ORIGIN: BundleOrigin = { bucket: 'openwop-dev-certification-bundles', prefix: 'evidence', raw: 'gs://openwop-dev-certification-bundles/evidence' };
const REQ = { origin: ORIGIN, commit: COMMIT, major: 2 as const, signingKeys: [KEY] };
const OBJECT_URL = bundleObjectUrl(ORIGIN, COMMIT, 2);

interface Call { url: string; headers: Record<string, string> }

/** A fake metadata server + GCS. `objectBody` null ⇒ 404; a function ⇒ custom behaviour. */
function fakeGcs(opts: { objectBody?: string | null; object?: (signal: AbortSignal) => Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url === METADATA_TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3599, token_type: 'Bearer' }), { status: 200 });
    }
    if (url === OBJECT_URL) {
      if (opts.object) return opts.object(init.signal);
      if (opts.objectBody === null) return new Response('{"error":{"code":404}}', { status: 404 });
      return new Response(opts.objectBody ?? FIXTURE_TEXT, { status: 200 });
    }
    return new Response('unexpected url', { status: 500 });
  };
  return { calls, fetchImpl };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('WHD-18 reader — token path, caching, single-flight', () => {
  it('reads the token from the metadata server, then the object with it — and serves the EXACT bytes', async () => {
    const gcs = fakeGcs();
    const c = clock();
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: c.now });
    await reader.ensure(REQ);
    expect(gcs.calls.map((x) => x.url)).toEqual([METADATA_TOKEN_URL, OBJECT_URL]);
    expect(gcs.calls[0]!.headers).toEqual({ 'Metadata-Flavor': 'Google' });
    expect(gcs.calls[1]!.headers).toEqual({ Authorization: 'Bearer tok-1' });
    // Byte-for-byte, not deep-equal: the served file's own sha256 is what a
    // third party compares against the upload.
    expect(reader.snapshot(REQ)).toBe(FIXTURE_TEXT);
  });

  it('positive cache: no refetch inside the TTL; after it, the object is re-read with the CACHED token', async () => {
    const gcs = fakeGcs();
    const c = clock();
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: c.now });
    await reader.ensure(REQ);
    c.advance(POSITIVE_TTL_MS - 1);
    await reader.ensure(REQ);
    expect(gcs.calls).toHaveLength(2);
    c.advance(2);
    await reader.ensure(REQ);
    expect(gcs.calls.map((x) => x.url)).toEqual([METADATA_TOKEN_URL, OBJECT_URL, OBJECT_URL]);
  });

  it('not published (404) → withheld, and NEGATIVE-cached for 60 s, then retried', async () => {
    const gcs = fakeGcs({ objectBody: null });
    const c = clock();
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: c.now });
    await reader.ensure(REQ);
    expect(reader.snapshot(REQ)).toBeUndefined();
    const before = gcs.calls.length;
    c.advance(NEGATIVE_TTL_MS - 1);
    await reader.ensure(REQ);
    expect(gcs.calls.length, 'a withheld answer must not cost a GCS read per discovery request').toBe(before);
    c.advance(2);
    await reader.ensure(REQ);
    expect(gcs.calls.length).toBe(before + 1);
  });

  it('a bundle that fails verification is withheld, not served with a warning', async () => {
    const tampered = fixture();
    obj(tampered['signature'])['sig'] = flip(String(obj(tampered['signature'])['sig']), 10);
    const gcs = fakeGcs({ objectBody: JSON.stringify(tampered) });
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: clock().now });
    await reader.ensure(REQ);
    expect(reader.snapshot(REQ)).toBeUndefined();
  });

  it('SINGLE-FLIGHT: concurrent ensures share one read', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const gcs = fakeGcs({ object: async () => { await gate; return new Response(FIXTURE_TEXT, { status: 200 }); } });
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: clock().now });
    const all = Promise.all([reader.ensure(REQ), reader.ensure(REQ), reader.ensure(REQ)]);
    await new Promise((r) => setTimeout(r, 5));
    expect(reader.inflightCount()).toBe(1);
    release();
    await all;
    expect(gcs.calls.filter((x) => x.url === OBJECT_URL)).toHaveLength(1);
    expect(reader.inflightCount()).toBe(0);
  });

  it('NO DETACHED WORK: when ensure() resolves, the read has already happened and landed', async () => {
    // The #3056 shape is "the request returned and the refresh finished later
    // (or never)". Here the snapshot must be populated by the time the awaited
    // call returns — nothing is left running for a throttled CPU to not finish.
    const gcs = fakeGcs({ object: async () => { await new Promise((r) => setTimeout(r, 20)); return new Response(FIXTURE_TEXT, { status: 200 }); } });
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: clock().now });
    await reader.ensure(REQ);
    expect(reader.snapshot(REQ)).toBe(FIXTURE_TEXT);
    expect(reader.inflightCount()).toBe(0);
  });
});

describe('WHD-18 reader — the deadline (the #3056 property)', () => {
  it('a HUNG object read costs a bounded wait, not a hung request — and aborts the socket', async () => {
    let aborted = false;
    const gcs = fakeGcs({
      // Never resolves on its own, and IGNORES the abort for the promise's sake:
      // the worst case, a fetch whose promise outlives its signal.
      object: (signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise<Response>(() => {}); },
    });
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: clock().now, deadlineMs: 40 });
    const t0 = Date.now();
    await reader.ensure(REQ);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(1_000);
    expect(aborted, 'the deadline must abort the underlying request, not merely stop waiting for it').toBe(true);
    expect(reader.snapshot(REQ)).toBeUndefined();
  });

  it('a hung read does NOT wedge the next refresh: the in-flight entry is cleared, and a later ensure reads again', async () => {
    let hang = true;
    let objectReads = 0;
    const gcs = fakeGcs({
      object: async () => {
        objectReads += 1;
        if (hang) return new Promise<Response>(() => {});
        return new Response(FIXTURE_TEXT, { status: 200 });
      },
    });
    const c = clock();
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: c.now, deadlineMs: 30 });
    await reader.ensure(REQ);
    expect(reader.inflightCount(), 'a stuck attempt left its latch set — the #3056 wedge').toBe(0);
    hang = false;
    c.advance(NEGATIVE_TTL_MS + 1);
    await reader.ensure(REQ);
    expect(objectReads).toBe(2);
    expect(reader.snapshot(REQ)).toBe(FIXTURE_TEXT);
  });

  it('a hung METADATA server is bounded by the same single deadline', async () => {
    const fetchImpl: FetchLike = async (url) => (url === METADATA_TOKEN_URL ? new Promise<Response>(() => {}) : new Response(FIXTURE_TEXT));
    const reader = new CertificationEvidenceReader({ fetchImpl, now: clock().now, deadlineMs: 30 });
    const t0 = Date.now();
    await reader.ensure(REQ);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(reader.inflightCount()).toBe(0);
  });
});

describe('WHD-18 reader — stale-if-error is for TRANSPORT only', () => {
  it('a transport failure after a verified read keeps serving the verified bytes', async () => {
    let fail = false;
    const gcs = fakeGcs({ object: async () => (fail ? new Response('boom', { status: 503 }) : new Response(FIXTURE_TEXT, { status: 200 })) });
    const c = clock();
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: c.now });
    await reader.ensure(REQ);
    fail = true;
    c.advance(POSITIVE_TTL_MS + 1);
    await reader.ensure(REQ);
    expect(reader.snapshot(REQ)).toBe(FIXTURE_TEXT);
  });

  it('a 404 after a verified read WITHDRAWS it — the operator deleted it, and that is an answer', async () => {
    let gone = false;
    const gcs = fakeGcs({ object: async () => (gone ? new Response('', { status: 404 }) : new Response(FIXTURE_TEXT, { status: 200 })) });
    const c = clock();
    const reader = new CertificationEvidenceReader({ fetchImpl: gcs.fetchImpl, now: c.now });
    await reader.ensure(REQ);
    gone = true;
    c.advance(POSITIVE_TTL_MS + 1);
    await reader.ensure(REQ);
    expect(reader.snapshot(REQ)).toBeUndefined();
  });
});

describe('WHD-18 — every production caller AWAITS the refresh', () => {
  // A structural tripwire over real source, the same kind as
  // `detached-latch-tripwire.test.ts`: the reader is safe only because its
  // callers await it, which is a property of the CALLERS. A future call site
  // written as `void ensureCertificationEvidence(…)` would reintroduce #3056
  // with no change to the reader at all.
  const SRC = join(__dirname, '..', 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  const sites = walk(SRC).flatMap((f) => {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    return [...src.matchAll(/(\S+\s+)?ensureCertificationEvidence\(/g)]
      .filter((m) => !/function\s+$/.test(m[1] ?? '') && !/^(import|\{|,)/.test((m[1] ?? '').trim()))
      .map((m) => ({ file: f.slice(SRC.length + 1), before: (m[1] ?? '').trim() }));
  });

  it('finds the call sites (a broken scan would assert nothing)', () => {
    // Pinned to the LITERAL count: the discovery route, the bundle routes' one
    // shared helper, and the operations attestation route. A floor
    // (`>= 1`) would stay green if the scan silently stopped seeing two of them.
    // A new call site moves this number on purpose, and that is the review hook.
    expect(sites.map((s) => s.file).sort()).toEqual(['features/operations/routes.ts', 'routes/discovery.ts', 'routes/discovery.ts']);
  });

  it.each(sites.map((s) => [`${s.file}: ${s.before}`, s] as const))('%s is awaited', (_l, site) => {
    expect(site.before).toBe('await');
  });
});
