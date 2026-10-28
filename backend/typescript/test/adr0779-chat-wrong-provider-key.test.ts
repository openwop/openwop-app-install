/**
 * ADR 0779 D6 — the chat BYOK-direct lane refuses a key named for another
 * provider BEFORE it is read, as the workflow lane does (ADR 0712 OQ4).
 *
 * The per-turn resolver can switch provider while the run keeps one
 * `credentialRef`; without this check a `byok:google` key was resolved and sent
 * to OpenAI. The refusal carries names only.
 *
 * Tracker: TST-BBK-3 (/grade-tests wave 60). Probe-witnessed:
 *   - red when the `explicitRefNamesOtherProvider` check in `dispatchReply` is
 *     dropped → leg 1 (the call reaches `resolveSecret` and fails with the
 *     generic unavailable message, no `reason`);
 *   - red when `explicitRefNamesOtherProvider` also refuses a SAME-provider ref
 *     → polarity.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import { dispatchReply } from '../src/host/exchange/dispatchTurn.js';
import { OpenwopError, type RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'openwop-b779-d6-')) });

function asOpenwop(e: unknown): OpenwopError {
  if (e instanceof OpenwopError) return e;
  throw new Error(`expected an OpenwopError refusal, got ${String(e)}`);
}

function run(runId: string, provider: string, credentialRef: string): RunRecord {
  const now = new Date().toISOString();
  return {
    runId, workflowId: 'wf', tenantId: 'demo',
    status: 'running', inputs: { provider, model: 'm-1', credentialRef }, metadata: {}, configurable: {},
    createdAt: now, updatedAt: now,
  };
}

describe('ADR 0779 D6 — chat lane wrong-provider key', () => {
  it('leg 1: a google key on an openai turn is refused naming both providers, never read', async () => {
    const err = await dispatchReply(run('run-b779-d6-wrong', 'openai', 'byok:google'), [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    const refusal = asOpenwop(err);
    expect(refusal.code).toBe('credential_unavailable');
    expect(refusal.httpStatus).toBe(422);
    // Names only: exactly these four fields, no value.
    expect(refusal.details).toEqual({ reason: 'explicit_ref_wrong_provider', provider: 'openai', refProvider: 'google', credentialRef: 'byok:google' });
    expect(refusal.message).toBe('The key "byok:google" is a google key, but this turn calls openai, so it was not sent. Choose a openai key, or switch back to google.');
  });

  it('polarity: a key named for the SAME provider is not refused by this check', async () => {
    const err = await dispatchReply(run('run-b779-d6-same', 'openai', 'byok:openai'), [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    // No such key is stored, so it fails later — as unavailable, not as a mismatch.
    const refusal = asOpenwop(err);
    expect(refusal.code).toBe('credential_unavailable');
    expect(refusal.details).toEqual({ credentialRef: 'byok:openai' });
  });
});
