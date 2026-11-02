/**
 * AI-GATE-1 — the RFC 0031 capability gate evaluates against the NODE's pinned
 * provider, not a host-wide default.
 *
 * Found by /grade-code on the ADR 0505 delta. `executor.ts` built its gate input as
 * `activeProvider: gateConfig.defaultProvider` — one host-wide value from
 * `OPENWOP_DEFAULT_AI_PROVIDER` (else `supportedProviders[0]`). So a node declaring
 * `requiredModelCapabilities` was checked against a provider it does not use.
 *
 * That made the declaration DECORATIVE: pinning a node to a provider advertising no
 * capabilities (e.g. the managed tier, absent from `PROVIDER_CAPABILITIES`) still
 * passed, because the gate looked at Anthropic instead. ADR 0505 dropped a planned
 * `requiredModelCapabilities` declaration for exactly this reason — it would have
 * looked like a guard and protected nothing.
 *
 * `nodeRef.config` was already in scope at the call site; it was simply never read.
 *
 * WHAT IS AND IS NOT PROVEN HERE (grade-tests w72, TST-DNH-P1). The first describe
 * drives the REAL gate, but its input comes from `gateInputFor`, a copy of the
 * executor's expression — so those cases prove the gate refuses by the ACTIVE
 * provider's capabilities, not that the executor picks the node's pin. The second
 * describe ties the copy to the executor by pinning the EXACT ternary in
 * `executor.ts` (both branches; a looser regex stayed green when the true branch
 * was swapped to the host default). A behavioural proof needs the gate-input
 * builder exported from the executor — BLOCKED-ON-PRODUCT, recorded as TST-DNH-P1.
 */

import { describe, expect, it } from 'vitest';
import { evaluateModelCapabilityGate } from '../src/executor/modelCapabilityGate.js';

/** The shape `executor.ts` now builds — node pin first, host default as fallback. */
const gateInputFor = (nodeConfig: Record<string, unknown> | undefined, hostDefault: string) => ({
  module: { requiredModelCapabilities: ['structured-output'] },
  activeProvider: typeof nodeConfig?.provider === 'string' && nodeConfig.provider
    ? (nodeConfig.provider as string)
    : hostDefault,
  activeModel: 'default',
  substitutionSupported: false,
  supportedProviders: ['anthropic', 'openai', 'google', 'minimax', 'openwop-free'],
});

describe('the capability gate refuses by the ACTIVE provider (input built as the executor builds it)', () => {
  it('REFUSES a node pinned to a provider that advertises no capabilities', () => {
    // The case the old code could not see: host default is Anthropic (which HAS
    // structured-output), but the node runs on the managed tier (which advertises
    // nothing). Before AI-GATE-1 this passed.
    const outcome = evaluateModelCapabilityGate(gateInputFor({ provider: 'openwop-free' }, 'anthropic'));
    expect(outcome.route, 'a node pinned to a capability-less provider must refuse').toBe('refuse');
  });

  it('ALLOWS a node pinned to a provider that does advertise the capability', () => {
    const outcome = evaluateModelCapabilityGate(gateInputFor({ provider: 'anthropic' }, 'anthropic'));
    expect(outcome.route).toBe('dispatch');
  });

  it('is not fooled by a capable HOST default when the node pin is incapable', () => {
    // The precise inversion the bug produced — restated so a regression is obvious.
    const viaNode = evaluateModelCapabilityGate(gateInputFor({ provider: 'minimax' }, 'anthropic'));
    const viaHostOnly = evaluateModelCapabilityGate(gateInputFor(undefined, 'anthropic'));
    expect(viaNode.route).toBe('refuse');
    expect(viaHostOnly.route, 'with no node pin the host default still governs').toBe('dispatch');
  });

  it('falls back to the host default when the node pins nothing', () => {
    // Non-chain nodes carry no provider in config and must be unaffected.
    expect(evaluateModelCapabilityGate(gateInputFor({}, 'anthropic')).route).toBe('dispatch');
    expect(evaluateModelCapabilityGate(gateInputFor(undefined, 'openwop-free')).route).toBe('refuse');
  });

  it('ignores a non-string provider rather than coercing it', () => {
    // Defensive: pack config is JSON and could carry anything.
    expect(evaluateModelCapabilityGate(gateInputFor({ provider: 42 }, 'anthropic')).route).toBe('dispatch');
  });
});

describe('the EXECUTOR actually feeds the node config to the gate', () => {
  it('reads nodeRef.config.provider/model at the gate call site', async () => {
    // Without this the suite above is VACUOUS in the REV-VIS-1 way: `gateInputFor`
    // re-implements the executor's expression, so every assertion would still pass
    // against an executor that kept using only the host default. A full executor
    // integration test is expensive; pinning the call site is the cheap honest
    // guard, and it fails loudly if someone reverts to `gateConfig.defaultProvider`.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/executor/executor.ts', import.meta.url), 'utf8');
    // The WHOLE ternary, both branches — the node pin when it is a non-empty
    // string, the host default otherwise. (`[\s\S]{0,200}` matched a swapped
    // true branch too: probe w72g4-mcg-exec-host-only stayed green.)
    expect(src, 'the gate input must derive activeProvider from the NODE').toMatch(
      /activeProvider: typeof nodeRef\.config\?\.provider === 'string' && nodeRef\.config\.provider\s*\?\s*nodeRef\.config\.provider\s*:\s*gateConfig\.defaultProvider,/,
    );
    expect(src, 'and activeModel likewise').toMatch(
      /activeModel: typeof nodeRef\.config\?\.model === 'string' && nodeRef\.config\.model\s*\?\s*nodeRef\.config\.model\s*:\s*gateConfig\.defaultModel,/,
    );
  });
});
