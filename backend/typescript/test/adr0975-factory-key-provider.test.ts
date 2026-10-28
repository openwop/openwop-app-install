/**
 * ADR 0975 D2 — `features/kicktodoFactoryAi.ts`, the ONE answer to "which key
 * does the Challenge Factory run on", read by the run's pre-flight and by the
 * KickTodo readiness report.
 *
 * MEASURED on kicktodo.com (2026-10-25): readiness said `factory.ready: true`
 * because a `kicktodo-factory:google` key existed, while every run refused
 * (`ai_credential_missing`, provider `anthropic`). Pins:
 *  - the provider choice: the workspace default's provider when it has a Factory
 *    key, else the key card's order (google, anthropic, openai), else sorted;
 *    providers that cannot return structured JSON never qualify;
 *  - readiness names the problem the run would hit: no Factory key, a Factory
 *    key for an unusable provider, or a key that cannot be read.
 *
 * Red when (sabotage-witnessed): the default's provider is not preferred; the
 * order constant is ignored; the structured-output filter is dropped; readiness
 * stops resolving the chosen key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  refs: [] as string[],
  readable: new Set<string>(),
  def: null as { provider: string; model: string; credentialRef: string } | null,
}));
vi.mock('../src/byok/secretResolver.js', async (orig) => ({
  ...(await orig<typeof import('../src/byok/secretResolver.js')>()),
  listSecretRefs: async () => env.refs,
  resolveSecret: async (ref: string) => (env.readable.has(ref) ? 'value' : null),
}));
vi.mock('../src/host/headlessAi.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/headlessAi.js')>()),
  getHeadlessAiDefault: async () => env.def,
}));
vi.mock('../src/host/modelCapabilityProbe.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/modelCapabilityProbe.js')>()),
  // `openwop-free` (the managed tier) advertises nothing; the BYOK three do.
  probeProviderCapabilities: (p: string) => (['google', 'anthropic', 'openai', 'mistral'].includes(p) ? ['structured-output'] : []),
}));

import { dedicatedFactoryProvider, factoryKeyProblem } from '../src/features/kicktodoFactoryAi.js';

const T = 'host-kicktodo';
beforeEach(() => { env.refs = []; env.readable = new Set(); env.def = null; });

describe('ADR 0975 D2 — dedicatedFactoryProvider', () => {
  it('no Factory key ⇒ null (the run falls back to the workspace default / host default)', async () => {
    env.refs = ['google:chat', 'anthropic'];
    expect(await dedicatedFactoryProvider(T)).toBeNull();
  });

  it('the prod shape: a keyless anthropic default does not outrank the google Factory key', async () => {
    env.refs = ['kicktodo-factory:google'];
    env.def = { provider: 'anthropic', model: 'claude-x', credentialRef: 'anthropic' };
    expect(await dedicatedFactoryProvider(T)).toBe('google');
  });

  it('the default\'s provider wins when it has a Factory key of its own', async () => {
    env.refs = ['kicktodo-factory:google', 'kicktodo-factory:openai'];
    env.def = { provider: 'openai', model: 'gpt-x', credentialRef: 'openai:main' };
    expect(await dedicatedFactoryProvider(T)).toBe('openai');
  });

  it('otherwise the key card\'s order, then sorted', async () => {
    // google before anthropic by the card's order, though anthropic sorts first.
    env.refs = ['kicktodo-factory:anthropic', 'kicktodo-factory:google'];
    expect(await dedicatedFactoryProvider(T)).toBe('google');
    env.refs = ['kicktodo-factory:mistral'];
    expect(await dedicatedFactoryProvider(T)).toBe('mistral');
  });

  it('a Factory key for a provider without structured output never qualifies', async () => {
    env.refs = ['kicktodo-factory:openwop-free'];
    expect(await dedicatedFactoryProvider(T)).toBeNull();
  });
});

describe('ADR 0975 D2 — factoryKeyProblem (readiness)', () => {
  it('a readable Factory key ⇒ no problem', async () => {
    env.refs = ['kicktodo-factory:google'];
    env.readable.add('kicktodo-factory:google');
    expect(await factoryKeyProblem(T)).toBeNull();
  });

  it('no Factory key, an unusable-provider key, and an unreadable key are three different reasons', async () => {
    expect(await factoryKeyProblem(T)).toMatch(/no kicktodo-factory:<provider> key/);
    env.refs = ['kicktodo-factory:openwop-free'];
    expect(await factoryKeyProblem(T)).toMatch(/cannot return structured JSON/);
    env.refs = ['kicktodo-factory:google'];
    expect(await factoryKeyProblem(T)).toMatch(/kicktodo-factory:google key .* cannot be read/);
  });
});
