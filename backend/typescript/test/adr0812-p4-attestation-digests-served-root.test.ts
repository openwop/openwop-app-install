/**
 * ADR 0812 P4 — the deployment-attestation read digests the discovery
 * document this host SERVES.
 *
 * `scripts/sign-attestation.mjs` signs a digest of a header-less
 * `GET /.well-known/openwop`. Since v1 retired (2026-10-04) that is the v2
 * root. The verify route (`operations/attestation/summary`) re-digested the v1
 * document (`buildAdvertisement`) instead, so an attestation signed against a
 * retired host could only ever read `discovery_drift`. This test signs exactly
 * what the signer signs (the served bytes, through a real Ed25519 key in the
 * pinned keyring) and requires `valid`.
 *
 * Red when (wave 60 probe w60g4-attest-served): the route digests any other
 * representation than the served bytes. A second leg signs a DIFFERENT digest
 * and requires `discovery_drift`, so a route that answered `valid` without
 * comparing would be red too (w60g4-attest-compare-r2). Tracker: TST-BVC-8.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import {
  canonicalPayloadBytes,
  sha256Hex,
  type DeploymentAttestationPayload,
} from '../src/host/deploymentAttestation.js';

const COMMIT = 'a222fe76a4ec0e0f1d2c3b4a5968778899aabbcc';
const KEY_ID = 'adr0812-p4-attestation';
const ENV_KEYS = [
  'OPENWOP_FEATURE_TOGGLES_DEV_OPEN',
  'OPENWOP_ATTESTATION_PATH',
  'OPENWOP_TRUSTED_PACK_KEYS_DIR',
  'OPENWOP_BUILD_COMMIT',
  'OPENWOP_BUILD_META_DIR',
  'OPENWOP_AUTH_DISABLE_COOKIES',
] as const;
const saved = new Map<string, string | undefined>();

let server: Server;
let BASE: string;
let dir: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  dir = mkdtempSync(join(tmpdir(), 'adr0812-p4-attest-'));
  // An empty build-meta dir: no image stamp, so the env commit is the host's.
  process.env.OPENWOP_BUILD_META_DIR = join(dir, 'build-meta-empty');
  process.env.OPENWOP_BUILD_COMMIT = COMMIT;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
}, 120_000);

afterAll(async () => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
  rmSync(dir, { recursive: true, force: true });
});

describe('ADR 0812 P4 — attestation verify reads the served discovery root', () => {
  it('an attestation over the header-less discovery bytes verifies valid', async () => {
    // Exactly what `scripts/sign-attestation.mjs` digests: the text of a
    // header-less GET, which on this host is the v2 root.
    const served = await fetch(`${BASE}/.well-known/openwop`);
    expect(served.status).toBe(200);
    const text = await served.text();
    expect((JSON.parse(text) as { protocolVersion?: string }).protocolVersion, 'the served root is the v2 document').toMatch(/^2\./);

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keysDir = join(dir, 'keys');
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, 'k.pem'), publicKey.export({ type: 'spki', format: 'pem' }).toString());
    writeFileSync(join(keysDir, 'index.json'), JSON.stringify([{ keyId: KEY_ID, file: 'k.pem' }]));

    const payload: DeploymentAttestationPayload = {
      kind: 'openwop-app.deployment-attestation.v1',
      build: { commit: COMMIT, commitSource: 'image', containerDigest: 'sha256:deadbeef', deployRevision: 'local:probe' },
      environmentClass: 'local',
      versions: { conformanceSuite: '0.0.0', protocol: null, corpusStamp: null },
      profiles: [],
      discoveryDigest: sha256Hex(text),
      runtime: { storageAdapter: 'memory', queueAdapter: null },
      telemetry: { attests: 'declaration', objectives: 0, objectiveIds: [], declarationDigest: 'f'.repeat(64) },
      evidence: { collected: 0, passed: 0, failed: 0, skipped: 0, artifactDigest: sha256Hex('evidence') },
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      signerKeyId: KEY_ID,
    };
    const manifest = join(dir, 'attestation.json');
    const sign = (p: DeploymentAttestationPayload): void => {
      writeFileSync(manifest, JSON.stringify({ payload: p, signature: edSign(null, canonicalPayloadBytes(p), privateKey).toString('base64') }));
    };
    const summary = async (): Promise<{ state: string; verdict?: { ok: boolean; reason?: string } }> => {
      const res = await fetch(`${BASE}/host/openwop-app/operations/attestation/summary`, { headers: { authorization: 'Bearer dev-token' } });
      expect(res.status).toBe(200);
      return await res.json() as { state: string; verdict?: { ok: boolean; reason?: string } };
    };
    process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR = keysDir;
    process.env.OPENWOP_ATTESTATION_PATH = manifest;

    sign(payload);
    const body = await summary();
    expect(body.verdict, JSON.stringify(body)).toEqual({ ok: true });
    expect(body.state).toBe('valid');

    // Control: the same, validly signed attestation over DIFFERENT bytes is drift.
    sign({ ...payload, discoveryDigest: sha256Hex(`${text} `) });
    const drift = await summary();
    expect(drift.state).toBe('invalid');
    expect(drift.verdict).toMatchObject({ ok: false, reason: 'discovery_drift' });
  });
});
