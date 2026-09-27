/**
 * WHD-18 / ADR 0735 — the deploy-side tools' PURE parts, pinned.
 *
 * `scripts/publish-evidence.sh` is operator-run against production (Secret
 * Manager, a cloudflared tunnel, a ten-minute suite run, a bucket write) and is
 * not run end-to-end anywhere. What a test CAN hold is every parse whose silent
 * misreading produces a WRONG CUT without failing — the class the 2026-09-21
 * manual cut fell into when a hand-grep passed two path segments to the suite as
 * profile opt-outs:
 *
 *   - the opt-out derivation (`scripts/lib/conformance-opt-outs.mjs`);
 *   - the verifier twin (`scripts/lib/bundle-v3-verify.mjs`) against the host's
 *     own (`src/host/certificationEvidence.ts`) — same verdict, every case;
 *   - the helpers (`scripts/lib/publish-evidence-helpers.mjs`);
 *   - the script's argument + config parsing (`--print-config`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { MAJOR2_UNDECLARED_FAMILIES } from '../conformance/major2Ledger.js';
import { verifyServedBundle as hostVerify } from '../src/host/certificationEvidence.js';

const ROOT = join(__dirname, '..', '..', '..');
const lib = (f: string): string => pathToFileURL(join(ROOT, 'scripts', 'lib', f)).href;

interface OptOutsModule {
  optedOutProfiles(major: number, root?: string, discovery?: unknown): string[];
  checkPostureOptOuts(discovery: unknown): string[];
  PRODUCTION_POSTURE_OPT_OUTS: ReadonlyArray<{ profile: string; advertised(d: unknown): boolean; why: string }>;
  readConstArray(source: string, name: string, file?: string): string[];
  EXTERNAL_TARGET_EXTRA: string;
}
interface VerifyModule {
  verifyServedBundle(doc: unknown, expect: { commit: string; major: 1 | 2; signingKeys: Record<string, unknown>[] }): { ok: boolean; reason?: string; keyId?: string };
}
interface HelpersModule {
  clientKeysFromBinding(v: string): string[];
  tenantBKeyFromBinding(v: string): string | null;
  tunnelUrlFromLog(t: string): string | null;
  webhookIds(r: unknown): string[];
  keyMismatch(doc: unknown, keyId: string, pem: string): string | null;
}

// Dynamic import by computed URL: these are plain `.mjs` outside this package,
// so they carry no types — the interfaces above are the contract this test
// holds them to.
const optOuts = (await import(lib('conformance-opt-outs.mjs'))) as OptOutsModule;
const verifyMjs = (await import(lib('bundle-v3-verify.mjs'))) as VerifyModule;
const helpers = (await import(lib('publish-evidence-helpers.mjs'))) as HelpersModule;

describe('opt-out derivation — read from the ledgers, never typed', () => {
  const m2 = optOuts.optedOutProfiles(2);
  const m1 = optOuts.optedOutProfiles(1);

  it('OPTED_OUT_PROFILES is read in full — pinned to the literal count', () => {
    // A floor would stay green if a reformat made the parser skip half the
    // lines. 25 is the count at this commit; changing the ledger moves this on
    // purpose, and that is the review hook.
    const base = m1.filter((p) => p !== optOuts.EXTERNAL_TARGET_EXTRA);
    expect(base).toHaveLength(25);
    expect(base[0]).toBe('openwop-production');
    expect(base).toContain('openwop-speech-synthesis-unadvertised');
  });

  it('major 2 adds EXACTLY the major-2 ledger (checked against its own export) and the external-target extra', () => {
    for (const f of MAJOR2_UNDECLARED_FAMILIES) expect(m2).toContain(f);
    expect(m2).toHaveLength(m1.length + MAJOR2_UNDECLARED_FAMILIES.length);
    for (const f of MAJOR2_UNDECLARED_FAMILIES) expect(m1).not.toContain(f);
    expect(m1).toContain('workflowChainPacks.hostExpansionSeam');
  });

  it('does NOT pick up the path segments the manual cut passed as opt-outs', () => {
    // `run.ts` has `resolve(…, 'conformance-fixtures', 'form-content')` 400 lines
    // below the array. A grep for quoted strings found them; this must not.
    for (const bogus of ['conformance-fixtures', 'form-content']) {
      expect(m2).not.toContain(bogus);
      expect(m1).not.toContain(bogus);
    }
  });

  it('skips comment lines (with apostrophes) and refuses an empty or unterminated array', () => {
    const src = [
      'const OPTED_OUT_PROFILES = [',
      "    'a-profile', // it's fine",
      "    // (the corpus schema's ladder — 'not-an-entry')",
      "    'b-profile',",
      '] as const;',
    ].join('\n');
    expect(optOuts.readConstArray(src, 'OPTED_OUT_PROFILES')).toEqual(['a-profile', 'b-profile']);
    expect(() => optOuts.readConstArray('const X = [\n];', 'X')).toThrow(/EMPTY/);
    expect(() => optOuts.readConstArray("const X = [\n  'a',\n", 'X')).toThrow(/terminator/);
    expect(() => optOuts.readConstArray('nothing here', 'X')).toThrow(/no `const X/);
  });

  it('the CLI prints the same list, comma-joined', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'lib', 'conformance-opt-outs.mjs'), '--major', '2'], { encoding: 'utf8' }).trim();
    expect(out.split(',')).toEqual(m2);
  });
});

describe('WHD-23 — production-posture opt-outs, checked against the TARGET discovery', () => {
  // Trimmed from production's live v1 discovery at c0e277b58 (2026-09-21): it
  // advertises safeFetch and artifact types, and none of the six posture families.
  const PROD = {
    capabilities: {
      httpClient: { supported: true, safeFetch: { supported: true } },
      artifactTypes: { supported: true },
      aiProviders: { selfHosted: [] },
    },
  };
  const POSTURE = [
    'openwop-anonymous-actor', 'openwop-workload-identity', 'openwop-workload-identity-delegation',
    'openwop-safefetch-live-audit', 'openwop-selfhosted-providers', 'openwop-channel-presence',
  ];

  it('the posture list is exactly the six reviewed profiles, and never an advertised artifact-type profile', () => {
    expect(optOuts.PRODUCTION_POSTURE_OPT_OUTS.map((e) => e.profile)).toEqual(POSTURE);
    for (const e of optOuts.PRODUCTION_POSTURE_OPT_OUTS) expect(e.why.length, e.profile).toBeGreaterThan(10);
    expect(POSTURE.some((p) => p.startsWith('openwop-artifact-type'))).toBe(false);
  });

  it('major 1 with the target discovery = the ledgers + the six; major 2 and no-discovery are unchanged', () => {
    const m1 = optOuts.optedOutProfiles(1);
    expect(optOuts.optedOutProfiles(1, undefined, PROD)).toEqual([...m1, ...POSTURE]);
    expect(optOuts.optedOutProfiles(2, undefined, PROD)).toEqual(optOuts.optedOutProfiles(2));
  });

  it('REFUSES the cut when the target advertises any posture profile, naming each', () => {
    const contradicting = [
      [{ capabilities: { ...PROD.capabilities, anonymousActor: { supported: true } } }, 'openwop-anonymous-actor'],
      [{ capabilities: { ...PROD.capabilities, workloadIdentity: { supported: true, delegation: { supported: true } } } }, 'openwop-workload-identity-delegation'],
      [{ capabilities: { ...PROD.capabilities, toolHooks: { prePostEvents: true } } }, 'openwop-safefetch-live-audit'],
      [{ capabilities: { ...PROD.capabilities, aiProviders: { selfHosted: ['ollama'] } } }, 'openwop-selfhosted-providers'],
      [{ capabilities: { ...PROD.capabilities, channels: { presence: { supported: true } } } }, 'openwop-channel-presence'],
      [{ ...PROD.capabilities, anonymousActor: { supported: true } }, 'openwop-anonymous-actor'], // root-level family
    ] as const;
    for (const [doc, profile] of contradicting) {
      expect(() => optOuts.optedOutProfiles(1, undefined, doc), profile).toThrow(new RegExp(`ADVERTISES [^—]*${profile}`));
    }
  });

  it('refuses rather than guesses when the discovery document is missing', () => {
    expect(() => optOuts.checkPostureOptOuts(null)).toThrow(/no discovery document/);
  });
});

describe('verifier PARITY — the deploy-side twin agrees with the host, case by case', () => {
  const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'certification-bundle-v3-27315b41c-major2.json'), 'utf8');
  const COMMIT = '27315b41c8f43e76e99f2e0f413acff14ba026fb';
  const KEY = { keyId: 'openwop-app-bundle-2', alg: 'ed25519', publicKey: 'WVhUJ8jHoQf9g9b8VPsfMS6kiOjUSbGdjbIAiemOVq4' };
  type J = Record<string, unknown>;
  const o = (v: unknown): J => v as J;
  const cases: Array<[string, (b: J) => void, Partial<{ commit: string; major: 1 | 2; signingKeys: J[] }>]> = [
    ['untampered', () => {}, {}],
    ['row detail flipped', (b) => { const r = (o(b['results'])['requirements'] as J[]).find((x) => typeof x['detail'] === 'string')!; r['detail'] = `${String(r['detail'])}!`; }, {}],
    ['build id flipped', (b) => { o(o(b['host'])['build'])['id'] = `0${COMMIT.slice(1)}`; }, {}],
    ['build id flipped, host at that id', (b) => { o(o(b['host'])['build'])['id'] = `0${COMMIT.slice(1)}`; }, { commit: `0${COMMIT.slice(1)}` }],
    ['signature flipped', (b) => { const s = o(b['signature']); s['sig'] = `A${String(s['sig']).slice(1)}`; }, {}],
    ['wrong major', () => {}, { major: 1 }],
    ['not v3', (b) => { b['bundleVersion'] = '2'; }, {}],
    ['totals', (b) => { o(o(b['results'])['totals'])['blocked'] = 1; }, {}],
    ['assertionCount', (b) => { b['assertionCount'] = 0; }, {}],
    ['over', (b) => { o(b['signature'])['over'] = []; }, {}],
    ['unknown key', () => {}, { signingKeys: [] }],
    ['retired before', () => {}, { signingKeys: [{ ...KEY, retiredAt: '2026-01-01T00:00:00Z' }] }],
    ['retired after', () => {}, { signingKeys: [{ ...KEY, retiredAt: '2027-01-01T00:00:00Z' }] }],
    ['kind', (b) => { o(o(b['host'])['build'])['kind'] = 'artifact-sha256'; }, {}],
  ];

  it.each(cases)('%s → the same verdict from both', (_name, mutate, over) => {
    const doc = JSON.parse(FIXTURE) as J;
    mutate(doc);
    const expectation = { commit: over.commit ?? COMMIT, major: over.major ?? 2, signingKeys: over.signingKeys ?? [KEY] };
    const host = hostVerify(doc, expectation);
    const twin = verifyMjs.verifyServedBundle(doc, expectation);
    expect(twin.ok).toBe(host.ok);
    expect(twin.ok ? 'ok' : twin.reason).toBe(host.ok ? 'ok' : host.reason);
  });

  it('non-vacuity: the cases span BOTH verdicts and several reasons', () => {
    const reasons = new Set(cases.map(([, mutate, over]) => {
      const doc = JSON.parse(FIXTURE) as J; mutate(doc);
      const v = hostVerify(doc, { commit: over.commit ?? COMMIT, major: over.major ?? 2, signingKeys: over.signingKeys ?? [KEY] });
      return v.ok ? 'ok' : v.reason;
    }));
    expect(reasons.has('ok')).toBe(true);
    expect(reasons.size).toBeGreaterThanOrEqual(10);
  });
});

describe('publish-evidence helpers', () => {
  it('client keys are the part before the FIRST colon, in order', () => {
    expect(helpers.clientKeysFromBinding('k1:conformance-prod,k2:conformance-b\n')).toEqual(['k1', 'k2']);
    expect(helpers.clientKeysFromBinding(' k1:tenant:with:colons , ')).toEqual(['k1']);
    expect(() => helpers.clientKeysFromBinding('  ')).toThrow(/no key/);
  });

  // The suite's cross-tenant legs read OPENWOP_TEST_TENANT_B_API_KEY; every prod cut
  // before 2026-09-24 recorded them `blocked` because only SECONDARY was exported.
  it('tenant-B key: the second key ONLY when it is on a different tenant', () => {
    expect(helpers.tenantBKeyFromBinding('k1:conformance-prod,k2:conformance-verify')).toBe('k2');
    expect(helpers.tenantBKeyFromBinding('k1:t1,k2:t1'), 'same tenant is not tenant B').toBeNull();
    expect(helpers.tenantBKeyFromBinding('k1:t1'), 'one key').toBeNull();
    expect(helpers.tenantBKeyFromBinding('k1,k2'), 'tenants unknown — cannot prove they differ').toBeNull();
    expect(helpers.tenantBKeyFromBinding('k1:t1,k2:'), 'empty tenant').toBeNull();
  });

  it('finds the trycloudflare URL in cloudflared\'s log, or null', () => {
    const log = '2026-09-21T10:28:01Z INF |  https://amber-flying-fish-idea.trycloudflare.com  |\nINF Registered tunnel';
    expect(helpers.tunnelUrlFromLog(log)).toBe('https://amber-flying-fish-idea.trycloudflare.com');
    expect(helpers.tunnelUrlFromLog('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
  });

  it('webhook ids come back BARE (a projected tenant/uuid id would 404 as a path)', () => {
    expect(helpers.webhookIds({ subscriptions: [{ subscriptionId: 'a-1' }, { webhookId: 'conformance-prod/b-2' }] })).toEqual(['a-1', 'b-2']);
    expect(helpers.webhookIds('{"subscriptions":[]}')).toEqual([]);
    expect(() => helpers.webhookIds({ error: 'unauthorized' })).toThrow(/not a webhook list/);
  });

  it('refuses a signing key whose public half is not the published one, or is retired', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const raw = der.subarray(der.length - 32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const doc = (k: Record<string, unknown>) => ({ signingKeys: [{ keyId: 'k', alg: 'ed25519', ...k }] });
    expect(helpers.keyMismatch(doc({ publicKey: raw }), 'k', pem)).toBeNull();
    expect(helpers.keyMismatch(doc({ publicKey: 'WVhUJ8jHoQf9g9b8VPsfMS6kiOjUSbGdjbIAiemOVq4' }), 'k', pem)).toMatch(/does not match/);
    expect(helpers.keyMismatch(doc({ publicKey: raw, retiredAt: '2026-01-01T00:00:00Z' }), 'k', pem)).toMatch(/RETIRED/);
    expect(helpers.keyMismatch({ signingKeys: [] }, 'k', pem)).toMatch(/not in the live host/);
  });
});

describe('publish-evidence.sh — arguments and config, without touching anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owp-publish-evidence-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(ROOT, 'scripts', 'publish-evidence.sh');
  const env = (body: string): string => { const f = join(dir, `env-${Math.random().toString(36).slice(2)}`); writeFileSync(f, body); return f; };
  const GOOD = [
    'BASE=https://app.example/',
    'OPENWOP_DEPLOY_PROJECT=p',
    'OPENWOP_DEPLOY_ACCOUNT=deployer@example.invalid',
    'OPENWOP_CERT_BUNDLE_ORIGIN="gs://openwop-dev-certification-bundles/evidence/"',
    'OPENWOP_BUNDLE_SIGNING_KEY_ID=openwop-app-bundle-2',
    '# a comment',
    'export NOT_A_KEY=ignored',
  ].join('\n');
  const run = (args: string[], envFile: string) =>
    spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PUBLISH_EVIDENCE_ENV_FILE: envFile } });

  it('--print-config: defaults to majors 2 then 1, strips trailing slashes, keys each object by the serving commit', () => {
    const r = run(['--print-config'], env(GOOD));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('base=https://app.example\n');
    expect(r.stdout).toContain('origin=gs://openwop-dev-certification-bundles/evidence\n');
    expect(r.stdout).toContain('majors=2 1\n');
    expect(r.stdout).toContain('max_workers=1\n');
    expect(r.stdout).toContain('allow_any_commit=0\n');
    expect(r.stdout).toContain('signing_secret=openwop-app-bundle-signing-key\n');
    expect(r.stdout).toContain('conformance_secret=openwop-conformance-api-key\n');
    expect(r.stdout).toContain('object[2]=gs://openwop-dev-certification-bundles/evidence/<serving-commit>/major-2.json\n');
  });

  it('--major / --max-workers / --allow-any-commit are honoured', () => {
    const r = run(['--major', '1', '--max-workers', '3', '--allow-any-commit', '--print-config'], env(GOOD));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('majors=1\n');
    expect(r.stdout).toContain('max_workers=3\n');
    expect(r.stdout).toContain('allow_any_commit=1\n');
  });

  it.each([
    [['--major', '3'], /--major must be 1 or 2/],
    [['--major'], /--major needs/],
    [['--max-workers', '0'], /positive integer/],
    [['--bogus'], /unknown argument/],
  ])('refuses %j with exit 2', (args, message) => {
    // `--print-config` FIRST, so a flag whose value is missing is really the
    // last argument (otherwise `--major --print-config` reads the next flag as
    // the value, which is a different refusal).
    const r = run(['--print-config', ...args], env(GOOD));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
  });

  it('refuses missing config and a non-gs origin — before any network', () => {
    const missing = run(['--print-config'], env('BASE=https://app.example\n'));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/unset in .*OPENWOP_DEPLOY_PROJECT.*OPENWOP_CERT_BUNDLE_ORIGIN.*OPENWOP_BUNDLE_SIGNING_KEY_ID/);
    const https = run(['--print-config'], env(GOOD.replace('gs://openwop-dev-certification-bundles/evidence/', 'https://bucket/x')));
    expect(https.status).toBe(2);
    expect(https.stderr).toMatch(/must be gs:\/\//);
    expect(run(['--print-config'], join(dir, 'does-not-exist')).status).toBe(2);
  });
});
