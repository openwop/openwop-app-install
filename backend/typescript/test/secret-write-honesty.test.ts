/**
 * A secret write that FAILS must say so accurately.
 *
 * `loadSecretsFromEnv` wrapped JSON.parse AND the write loop in ONE catch, so a
 * write failure surfaced as "OPENWOP_BOOT_SECRETS parse failed" — an operator with
 * perfectly valid JSON told their JSON was broken. The same catch discarded
 * `count`, so a failure on secret 3 of 5 returned 0 and hid the two that landed.
 *
 * Found 2026-08-02 while tracing how an operator sets the host-global `web-search`
 * key. Reachable only under `OPENWOP_BYOK_EPHEMERAL=true`, which is why it has not
 * bitten prod (live sets it `false`) — latent, not theoretical: the throw that
 * fires is ephemeral mode's own `setSecret … requires scope.tenantId`, and these
 * writes are scopeless by design, so under ephemeral EVERY boot secret fails while
 * the log blames the one thing that is fine.
 *
 * NO MOCK OF `setSecret`. An earlier draft used `vi.spyOn(mod, 'setSecret')`, which
 * cannot intercept a module-local call — the spy was never invoked and two tests
 * were probing nothing. Its fixture guard is what caught that. These drive the real
 * failures instead: ephemeral mode for the total case, an injected `Storage` that
 * throws for one ref for the partial case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Storage } from '../src/storage/storage.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const warn = vi.hoisted(() => vi.fn());
const error = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());

vi.mock('../src/observability/logger.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, createLogger: () => ({ warn, error, info, debug: vi.fn() }) };
});

/** A Storage stub that fails `upsertEncryptedSecret` for the named refs only. */
function storageFailingFor(failRefs: string[]): Storage {
  return {
    upsertEncryptedSecret: vi.fn(async (key: string) => {
      // The flat key embeds the credentialRef, so match on containment.
      if (failRefs.some((r) => key.includes(r))) throw new Error(`disk full writing ${key}`);
    }),
  } as unknown as Storage;
}

const logText = () =>
  [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls].map((c) => String(c[0])).join(' | ');

beforeEach(() => {
  vi.resetModules();
  warn.mockReset(); error.mockReset(); info.mockReset();
  delete process.env.OPENWOP_BOOT_SECRETS;
  delete process.env.OPENWOP_SAMPLE_SECRETS;
  delete process.env.OPENWOP_BYOK_EPHEMERAL;
});
afterEach(() => {
  delete process.env.OPENWOP_BOOT_SECRETS;
  delete process.env.OPENWOP_SAMPLE_SECRETS;
  delete process.env.OPENWOP_BYOK_EPHEMERAL;
});

describe('loadSecretsFromEnv — a WRITE failure is not a PARSE failure', () => {
  it('does not blame the JSON when the JSON is valid and every write throws', async () => {
    // The REAL production trigger, not a mock of it.
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    process.env.OPENWOP_BOOT_SECRETS = JSON.stringify({ 'web-search': 'k1' });

    const mod = await import('../src/byok/secretResolver.js');
    mod.configureSecretResolver({ storage: storageFailingFor([]), dataDir: mkdtempSync(join(tmpdir(), 'byok-')) });
    const n = await mod.loadSecretsFromEnv();

    expect(n).toBe(0);
    // Fixture guard: prove the write really was attempted and really threw, so
    // this is not passing because nothing happened.
    expect(logText(), 'fixture guard: the write must have been attempted and failed')
      .toMatch(/could not store secret|were NOT stored/i);
    // The load-bearing assertion.
    expect(logText(), 'valid JSON reported as a parse failure IS the defect')
      .not.toMatch(/parse failed/i);
  });

  it('still blames the JSON when the JSON really is malformed', async () => {
    // The other arm — the original message must survive the case it was written for.
    process.env.OPENWOP_BOOT_SECRETS = '{not json';
    const mod = await import('../src/byok/secretResolver.js');
    const store = storageFailingFor([]);
    mod.configureSecretResolver({ storage: store, dataDir: mkdtempSync(join(tmpdir(), 'byok-')) });

    expect(await mod.loadSecretsFromEnv()).toBe(0);
    expect(logText()).toMatch(/parse failed/i);
    expect(store.upsertEncryptedSecret, 'a malformed blob must attempt no write').not.toHaveBeenCalled();
  });

  it('reports the secrets that DID land when only some fail', async () => {
    process.env.OPENWOP_BOOT_SECRETS = JSON.stringify({ alpha: '1', bravo: '2', charlie: '3' });
    const mod = await import('../src/byok/secretResolver.js');
    const store = storageFailingFor(['bravo']);
    mod.configureSecretResolver({ storage: store, dataDir: mkdtempSync(join(tmpdir(), 'byok-')) });

    const n = await mod.loadSecretsFromEnv();

    expect(store.upsertEncryptedSecret, 'one failure must not abort the loop').toHaveBeenCalledTimes(3);
    // The under-report: the shared catch returned 0 here, hiding alpha and charlie.
    expect(n, 'two secrets landed — reporting 0 is a false negative').toBe(2);
    expect(logText()).toMatch(/were NOT stored/i);
  });

  it('never logs a secret VALUE, only its ref', async () => {
    process.env.OPENWOP_BOOT_SECRETS = JSON.stringify({ 'web-search': 'sk-super-secret-probe' });
    const mod = await import('../src/byok/secretResolver.js');
    mod.configureSecretResolver({ storage: storageFailingFor(['web-search']), dataDir: mkdtempSync(join(tmpdir(), 'byok-')) });
    await mod.loadSecretsFromEnv();

    const everything = JSON.stringify([warn.mock.calls, error.mock.calls, info.mock.calls]);
    expect(everything).not.toContain('sk-super-secret-probe');
    expect(everything, 'the ref is safe and useful to log').toContain('web-search');
  });
});
