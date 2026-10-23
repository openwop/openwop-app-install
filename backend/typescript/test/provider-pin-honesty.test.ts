/**
 * ADR 0505 — what the app TELLS you about a pinned AI provider must be true.
 *
 * Two untrue things met at one live failure (Challenge Factory, prod rev
 * 00581-2nl, 2026-07-29):
 *
 *   1. 27 chain packs described their `provider` param as "Defaults to the
 *      host's chat-class preference". They do not — they freeze the literal
 *      `anthropic`. The text was plausible because `MODEL_CLASS_DEFAULTS.chat`
 *      happens to hold the same value, so it read as a description of a
 *      mechanism that was never wired.
 *
 *   2. When that pin then found no credential, the failure explained the
 *      RESOLVER'S INTERNALS ("the host looks up secrets[provider] then any
 *      secret prefixed with …") to a person who cannot act on them, and named
 *      neither of the two real exits.
 *
 * ADR 0498 froze a concrete provider because `providerKey` hashes provider+model
 * into the invocation-log cache key, so resolving per-dispatch would silently
 * substitute a model on replay/fork. ADR 0903 (2026-10-17) removed the chains'
 * `anthropic` pin but keeps that property: an unset provider is resolved ONCE
 * per run and recorded on it, and a fork reads the recorded value. This file
 * guards the honesty of what we say about it.
 *
 * What turns it red (sabotage-witnessed, /grade-tests 8f wave 1):
 *   - a pack.json re-introducing "chat-class preference" (8fw1g3-pv-pin-ratchet);
 *   - the corpus globs finding fewer packs than the measured floor;
 *   - the byok_required message in `aiProvidersHost.ts` `resolveCredential`
 *     losing either exit, the no-fallback sentence, or the `availableRefs`
 *     names, or narrating the resolver again (8fw1g3-pv-pin-exits-r2,
 *     -fallback-r2, -refs-r2, -narrate-r2). Those cases drive the REAL adapter
 *     (`createAiProvidersAdapter(...).callAI`) — they read the thrown error,
 *     not the source text, so a comment carrying the copy cannot satisfy them.
 *
 * PIN-COPY-1 (grade-code row, round 1) asked every PINNING pack to carry the
 * copy. Since ADR 0903 D7 no pack pins a provider (measured 0 at 7321e3612),
 * so the case below stays SAMPLED on `commerce` — not universalised.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'node:fs';
import { AiProviderError, createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

let chainFiles: string[] = [];
let hostPackFiles: string[] = [];
let files: string[] = [];
beforeAll(() => {
  chainFiles = globSync('examples/workflow-chain-packs/*/pack.json', { cwd: REPO }).map((p) => join(REPO, p));
  hostPackFiles = globSync('packs/*/pack.json', { cwd: REPO }).map((p) => join(REPO, p));
  files = [...chainFiles, ...hostPackFiles];
});

describe('pack descriptions of the provider pin', () => {
  it('the pack corpus actually loaded — an empty sweep must not read as clean', () => {
    // Floors are the measured truth minus a small margin (measured at 7321e3612:
    // 69 chain packs + 213 host packs = 282). Each glob is floored on its own,
    // so one mis-rooted glob cannot hide behind the other's count.
    expect(chainFiles.length).toBeGreaterThanOrEqual(67);
    expect(hostPackFiles.length).toBeGreaterThanOrEqual(209);
  });

  it('no pack claims the provider defaults to a host preference it never consults', () => {
    // The claim was false for every pack that shipped `"default": "anthropic"`
    // (all of them, pre ADR 0903), and the host-preference wording never named
    // the real ladder. Kept as a text ratchet because the falsehood is in
    // PROSE — no type or schema can catch it.
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('chat-class preference'));
    expect(offenders.map((f) => f.replace(`${REPO}/`, ''))).toEqual([]);
  });

  // CORRECTED 2026-10-17 (ADR 0903) — the chains no longer pin `anthropic`. The
  // copy must now describe what DOES happen: an unset provider follows the run's
  // choice, then the workspace's AI setting, then the catalog default, recorded
  // on the run so a replay uses the same one.
  it('a chain\'s provider param describes the real fallback, and no pack still claims a pin', () => {
    const commerce = readFileSync(join(REPO, 'examples/workflow-chain-packs/commerce/pack.json'), 'utf8');
    expect(commerce, 'fixture guard: the param is still declared').toContain('"provider"');
    expect(commerce).not.toContain('"default": "anthropic"');
    expect(commerce).toContain("the workspace's AI setting");
    expect(commerce).toContain('recorded on the run');
    const stillClaimPin = files.filter((f) => readFileSync(f, 'utf8').includes('the workflow will not fall back to another provider on its own'));
    expect(stillClaimPin.map((f) => f.replace(`${REPO}/`, ''))).toEqual([]);
  });
});

describe('the byok_required failure names the exits', () => {
  // Driven through the real adapter: a workspace whose only key is for ANOTHER
  // vendor reaches `resolveCredential`'s `no_default_credential` branch. The
  // cases read the thrown error, so they fail if the message changes — not
  // merely if the source text does.
  let err: AiProviderError | undefined;
  beforeAll(async () => {
    const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };
    const adapter = createAiProvidersAdapter({
      runId: 'pin-honesty-run',
      nodeId: 'pin-honesty-node',
      tenantId: 'pin-honesty-tenant',
      attempt: 1,
      secrets: { openai: 'sk-not-sent' },
      policyResolver,
    });
    try {
      await adapter.callAI({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      if (e instanceof AiProviderError) err = e;
      else throw e;
    }
  });

  it('no longer narrates the resolver internals at the user', () => {
    expect(err?.code).toBe('byok_required');
    expect(err?.details.reason).toBe('no_default_credential');
    expect(err?.message).not.toContain('looks up secrets[');
    expect(err?.message).not.toContain('secret prefixed');
  });

  it('names both real exits — add a key, or re-create on a provider you have', () => {
    expect(err?.code).toBe('byok_required');
    expect(err?.message).toContain('This step needs a anthropic API key and this workspace has none.');
    expect(err?.message).toContain('Settings → Secrets Vault');
    expect(err?.message).toContain('re-create the workflow choosing a provider you already have a key for');
  });

  it('states plainly that there is no silent provider fallback', () => {
    // The property that makes the message actionable rather than merely polite:
    // the user must know waiting/retrying will not help.
    expect(err?.code).toBe('byok_required');
    expect(err?.message).toContain('will not fall back to a different one on its own');
  });

  it('still carries availableRefs in details for operators', () => {
    // Ref NAMES only — never values. Dropping this would trade one honesty
    // problem for a debuggability one.
    expect(err?.code).toBe('byok_required');
    expect(err?.details.availableRefs).toEqual(['openai']);
    expect(err?.details.provider).toBe('anthropic');
    expect(JSON.stringify(err?.details)).not.toContain('sk-not-sent');
    expect(err?.message).not.toContain('sk-not-sent');
  });
});
