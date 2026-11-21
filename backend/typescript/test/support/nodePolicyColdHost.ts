/**
 * Owned native child entry. Same createApp/--import tsx convention as appProcess,
 * with local memory storage; not the production lib/index.js/main binary.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACK, TYPE, OPERATOR, childProfile, closedRegistry, fileHash, integer, layout,
  readCapsule, record, text,
} from './nodePolicyColdFixture.js';

function send(message: Record<string, unknown>): void {
  if (!process.send) throw new Error('Cold host needs its owned IPC parent');
  process.send(message);
}
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  const capsulePath = process.argv[2], expectedNonce = process.argv[3], phase = process.argv[4];
  assert(capsulePath && expectedNonce && (phase === 'old' || phase === 'fresh'));
  const capsule = readCapsule(capsulePath, expectedNonce), p = layout(capsule.root);
  assert.equal(capsule.phase, phase === 'old' ? 'prepared' : 'old-exited');
  // The parent refused its ORIGINAL deployment posture before allowlisting.
  // This restricted launch snapshot is a second local-seam check, not that proof.
  const launch = { ...process.env };
  const workingDirectory = phase === 'old' ? p.oldHost : p.freshHost;
  assert.equal(realpathSync(workingDirectory), workingDirectory);
  process.chdir(workingDirectory); // createApp's memory ./data is owned by this phase.
  const version = phase === 'old' ? '1.0.0' : '1.1.0';
  for (const [name, value] of Object.entries(childProfile(capsule.root, version))) process.env[name] = value;
  const transport = closedRegistry(capsule.root);
  const { testAuthSeamStartupError } = await import('../../src/routes/authTestSeam.js');
  assert.equal(testAuthSeamStartupError({ ...launch, OPENWOP_TEST_AUTH_ENABLED: 'true' }), null, 'Restricted launch posture must admit a local test seam');
  const { packContentDigest } = await import('../../src/packs/packContentDigest.js');
  const { verifyInstalledPack } = await import('../../src/packs/registryInstaller.js');
  const directory = join(p.packDir, PACK);
  function disk() {
    const manifest = record(JSON.parse(readFileSync(join(directory, 'pack.json'), 'utf8')));
    const files: Record<string, string> = {};
    for (const name of ['pack.json', 'index.mjs', 'schemas/value.mjs', '.openwop-installed.json']) files[name] = fileHash(join(directory, name));
    return {
      packDir: p.packDir, manifestVersion: text(manifest.version),
      digest: packContentDigest(directory),
      files,
      markerValid: verifyInstalledPack(directory) === null,
      control: existsSync(p.control) ? readFileSync(p.control, 'utf8') : '',
    };
  }
  let beforeStartup: ReturnType<typeof disk> | null = null;
  if (phase === 'old') {
    assert.equal(existsSync(directory), false); assert.equal(existsSync(p.control), false);
  } else {
    assert.equal(capsule.phase, 'old-exited');
    if (capsule.phase !== 'old-exited') throw new Error('No actual old-process exit receipt');
    beforeStartup = disk();
    assert.equal(beforeStartup.manifestVersion, '1.0.0');
    assert.equal(beforeStartup.digest, capsule.oldDigest);
    assert.equal(beforeStartup.control, capsule.oldControl);
    assert.equal(beforeStartup.markerValid, true);
  }
  const { createApp } = await import('../../src/index.js'); // PACK_DIR is captured after profile setup.
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'node-import-cold', serviceVersion: '0.0.0', enableConsoleTracer: false });
  const { enableTenantOverride } = await import('../../src/host/featureToggles/service.js');
  const toggled = await enableTenantOverride('marketplace', OPERATOR, 'node-import-cold');
  assert(['enabled', 'already-on'].includes(toggled));
  const { getNodeRegistry } = await import('../../src/executor/nodeRegistry.js');
  const registry = getNodeRegistry();
  function state() {
    const module = registry.get(TYPE); // Readback only: NEVER resolve/import here.
    return { ...disk(), pid: process.pid, moduleVersion: module?.version ?? null,
      moduleEntry: module?.packOrigin?.entryUrl ?? null, tier: module?.packOrigin?.tier ?? null,
      requests: [...transport.requests], unexpected: [...transport.unexpected] };
  }
  const initial = state();
  assert.equal(initial.manifestVersion, version);
  assert.equal(initial.markerValid, true);
  assert.equal(initial.moduleVersion, null, 'Startup must not import this native entry');
  assert.equal(initial.control, phase === 'old' ? '' : '1.0.0\n');
  assert.deepEqual(initial.unexpected, []);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  transport.allowOrigin('http://127.0.0.1:' + address.port);
  process.on('message', (value: unknown) => {
    try {
      const request = record(value), id = integer(request.id);
      assert.equal(request.nonce, capsule.nonce);
      if (request.cmd === 'state') { send({ id, ok: true, state: state() }); return; }
      assert.equal(request.cmd, 'exit');
      // The parent awaits the actual OS close event, not this command's receipt.
      server.close(error => { transport.restore(); process.exit(error ? 1 : 0); });
    } catch (error) { send({ id: isRecordId(value), ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });
  send({ ready: true, nonce: capsule.nonce, phase, pid: process.pid, port: address.port, state: initial, beforeStartup });
}
function isRecordId(value: unknown): number {
  if (value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'number') return value.id;
  return -1;
}
main().catch((error: unknown) => { console.error(error); process.exit(1); });
