/**
 * ADR 0779 D6 — the chat BYOK-direct lane refuses a key named for another
 * provider BEFORE it is read, as the workflow lane does (ADR 0712 OQ4).
 *
 * The per-turn resolver can switch provider while the run keeps one
 * `credentialRef`; without this check a `byok:google` key was resolved and sent
 * to OpenAI. The refusal carries names only.
 *
 * Sabotage (committed code): drop the `explicitRefNamesOtherProvider` check in
 * `dispatchReply` → leg 1 red (the call reaches `resolveSecret` and fails with
 * the generic unavailable message, no `reason`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import { dispatchReply } from '../src/host/exchange/dispatchTurn.js';
import type { RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'openwop-b779-d6-')) });

function run(provider: string, credentialRef: string): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: `run-b779-d6-${Math.random().toString(36).slice(2)}`, workflowId: 'wf', tenantId: 'demo',
    status: 'running', inputs: { provider, model: 'm-1', credentialRef }, metadata: {}, configurable: {},
    createdAt: now, updatedAt: now,
  };
}

describe('ADR 0779 D6 — chat lane wrong-provider key', () => {
  it('leg 1: a google key on an openai turn is refused naming both providers, never read', async () => {
    const err = await dispatchReply(run('openai', 'byok:google'), [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'credential_unavailable', httpStatus: 422 });
    const details = (err as { details?: Record<string, unknown> }).details;
    expect(details).toMatchObject({ reason: 'explicit_ref_wrong_provider', provider: 'openai', refProvider: 'google' });
  });

  it('polarity: a key named for the SAME provider is not refused by this check', async () => {
    const err = await dispatchReply(run('openai', 'byok:openai'), [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    // No such key is stored, so it fails later — as unavailable, not as a mismatch.
    expect(err).toMatchObject({ code: 'credential_unavailable' });
    expect((err as { details?: Record<string, unknown> }).details?.reason).toBeUndefined();
  });
});
