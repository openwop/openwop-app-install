/**
 * RFC 0106 §B (ADR 0109 P2) — direct-adapter tests for `ctx.callTranscriber`'s
 * real-path routing, exercised below the agents.ts seam (which forces
 * provider:'mock'). Asserts the two deterministic, no-provider-key behaviours
 * P2 adds:
 *   - a non-mock `audio.streamRef` is an HONEST `transcription_unsupported`
 *     (true live streaming is host-internal per RFC 0106 §E — not wired on a
 *     stateless host), and
 *   - a non-mock `audio.url` that is not a host media-asset URL is
 *     `invalid_request` (no arbitrary external fetch).
 * The valid-asset → managed `callAI` transcription roundtrip needs a provider
 * key and is deploy-verified (like the RFC 0105 speech-synth live roundtrip).
 *
 * Protected (SSRF: no arbitrary external fetch). Wave 61: every refusal asserts
 * its exact code AND message, because three different refusals share the code
 * `invalid_request` (exactly-one, non-host url, asset not found) and a status
 * or code alone cannot tell which one fired. The exactly-one rule is asserted
 * for BOTH sides — neither and both (probe ta-exactly-one was vacuous on
 * "neither" alone).
 */

import { describe, expect, it } from 'vitest';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

function buildScope() {
  const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };
  return { runId: 'test-run', nodeId: 'test-node', tenantId: 'test-tenant', attempt: 1, secrets: {}, policyResolver };
}

describe('RFC 0106 §B — callTranscriber real-path routing (ADR 0109 P2)', () => {
  it('rejects a non-mock audio.streamRef with transcription_unsupported (live transport is host-internal, RFC 0106 §E)', async () => {
    const adapter = createAiProvidersAdapter(buildScope());
    await expect(adapter.callTranscriber({ audio: { streamRef: 'stream:run-7/mic' } }))
      .rejects.toMatchObject({ code: 'transcription_unsupported' });
  });

  it('rejects a non-host audio.url with invalid_request (no arbitrary external fetch)', async () => {
    const adapter = createAiProvidersAdapter(buildScope());
    await expect(adapter.callTranscriber({ audio: { url: 'https://evil.example.com/audio.wav' } }))
      .rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringMatching(/does not fetch arbitrary external URLs/),
      });
  });

  it('rejects when neither streamRef nor url is supplied (exactly-one rule)', async () => {
    const adapter = createAiProvidersAdapter(buildScope());
    const exactlyOne = { code: 'invalid_request', message: expect.stringMatching(/EXACTLY ONE/) };
    // Neither…
    await expect(adapter.callTranscriber({ audio: {} })).rejects.toMatchObject(exactlyOne);
    // …and both: a streamRef must not win silently over a url (or vice versa).
    await expect(adapter.callTranscriber({ audio: { streamRef: 'stream:x', url: 'https://h/x' } }))
      .rejects.toMatchObject(exactlyOne);
  });

  // (A host media-asset url whose token DOES resolve → managed callAI transcription
  // is deploy-verified: resolveMediaAsset + the provider call need the booted
  // persistence layer + a provider key, like the RFC 0105 speech-synth roundtrip.)
});
