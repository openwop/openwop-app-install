/** Disposable provider-free browser acceptance host, never a production entry. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/index.js';
import { saveConfig } from '../../src/host/featureToggles/service.js';
import { getToggleDefault } from '../../src/host/featureToggles/registry.js';

const ready = process.env.OPENWOP_FILM_ACCEPTANCE_READY;
const port = Number(process.env.OPENWOP_FILM_ACCEPTANCE_PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid acceptance port.');
const packs = await mkdtemp(join(tmpdir(), 'owp-film-acceptance-'));
process.env.OPENWOP_PACK_DIR = packs;
process.env.OPENWOP_INSTALL_PACKS = 'none';
process.env.OPENWOP_STORAGE_DSN = 'memory://';
process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
process.env.OPENWOP_SESSION_SECRET = 'disposable-film-acceptance-secret-32-characters';
const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'film-acceptance', serviceVersion: 'fixture', enableConsoleTracer: false });
for (const id of ['users', 'documents', 'films', 'media', 'brand', 'slides', 'decktalk']) {
  const config = getToggleDefault(id);
  if (config) await saveConfig({ ...config, status: 'on' }, 'film-acceptance');
}
const server = app.listen(port, '127.0.0.1', () => {
  if (ready) void writeFile(ready, JSON.stringify({ port: (server.address() as AddressInfo).port }));
});
process.once('SIGTERM', () => { server.close(() => { void rm(packs, { recursive: true, force: true }).then(() => process.exit(0)); }); });
