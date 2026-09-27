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
 * The pin itself is CORRECT and deliberate — ADR 0498 froze a concrete provider
 * because `providerKey` hashes provider+model into the invocation-log cache key,
 * so resolving per-dispatch would silently substitute a model on replay/fork.
 * This file guards the honesty of what we say about it, not the pin.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'node:fs';

const REPO = join(import.meta.dirname, '..', '..', '..');

function packFiles(): string[] {
  return [
    ...globSync('examples/workflow-chain-packs/*/pack.json', { cwd: REPO }),
    ...globSync('packs/*/pack.json', { cwd: REPO }),
  ].map((p) => join(REPO, p));
}

let files: string[] = [];
beforeAll(() => { files = packFiles(); });

describe('pack descriptions of the provider pin', () => {
  it('the pack corpus actually loaded — an empty sweep must not read as clean', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('no pack claims the provider defaults to a host preference it never consults', () => {
    // The claim is false for every pack that also ships `"default": "anthropic"`,
    // which is all of them. Kept as a text ratchet because the falsehood is in
    // PROSE — no type or schema can catch it.
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('chat-class preference'));
    expect(offenders.map((f) => f.replace(`${REPO}/`, ''))).toEqual([]);
  });

  it('a pack that pins a provider says the workspace needs a key for it', () => {
    // The substantive claim the new copy makes. Sampled on a pack known to pin.
    const commerce = readFileSync(join(REPO, 'examples/workflow-chain-packs/commerce/pack.json'), 'utf8');
    expect(commerce, 'fixture guard: this pack must still pin a provider').toContain('"default": "anthropic"');
    expect(commerce).toContain('the workspace needs a key for it');
    expect(commerce).toContain('will not fall back to another provider on its own');
  });
});

describe('the byok_required failure names the exits', () => {
  const src = readFileSync(join(REPO, 'backend/typescript/src/aiProviders/aiProvidersHost.ts'), 'utf8');

  it('no longer narrates the resolver internals at the user', () => {
    expect(src).not.toContain('The host looks up secrets[provider] then any secret prefixed');
  });

  it('names both real exits — add a key, or re-create on a provider you have', () => {
    expect(src).toContain('Settings → Secrets Vault');
    expect(src).toContain('re-create the workflow choosing a provider you already have a key for');
  });

  it('states plainly that there is no silent provider fallback', () => {
    // The property that makes the message actionable rather than merely polite:
    // the user must know waiting/retrying will not help.
    expect(src).toContain('will not fall back to a different one on its own');
  });

  it('still carries availableRefs in details for operators', () => {
    // Ref NAMES only — never values. Dropping this would trade one honesty
    // problem for a debuggability one.
    expect(src).toContain('availableRefs: Object.keys(scope.secrets)');
  });
});
