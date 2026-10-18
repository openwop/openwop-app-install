/**
 * ADR 0768 follow-up D2 — attachments are judged by the model that will
 * ACTUALLY answer: the per-message override, else the conversation default.
 * Reads the shipped providers.json (no fixture that could drift from it).
 */
import { describe, it, expect } from 'vitest';
import { PROVIDERS } from '../../../byok/lib/providers.js';
import { attachmentCaps } from '../attachmentCaps.js';

const visionProv = PROVIDERS.find((p) => p.models.length > 0 && p.models.every((m) => m.capabilities.includes('vision')))!;
const blindProv = PROVIDERS.find((p) => p.models.length > 0 && p.models.every((m) => !m.capabilities.includes('vision')))!;

describe('attachmentCaps (ADR 0768 D2)', () => {
  it('the catalog has an all-vision and a no-vision provider (else this proves nothing)', () => {
    expect(visionProv).toBeTruthy();
    expect(blindProv).toBeTruthy();
  });

  it('reads the default model when there is no override', () => {
    expect(attachmentCaps(visionProv.id, visionProv.models[0]!.id, null).supportsImageInput).toBe(true);
    expect(attachmentCaps(blindProv.id, blindProv.models[0]!.id, null).supportsImageInput).toBe(false);
  });

  it('the per-message override wins over the default, both ways', () => {
    expect(attachmentCaps(blindProv.id, blindProv.models[0]!.id, { provider: visionProv.id, model: visionProv.models[0]!.id }).supportsImageInput).toBe(true);
    expect(attachmentCaps(visionProv.id, visionProv.models[0]!.id, { provider: blindProv.id, model: blindProv.models[0]!.id }).supportsImageInput).toBe(false);
  });

  // Two honest ceilings, both caused by the shipped catalog (every provider is
  // all-vision or no-vision, and `resolveActiveModel` falls back to a provider's
  // recommended model for an unknown id):
  //  - the override's MODEL id (`override?.model ?? defaultModel`) cannot change
  //    the answer on its own: only the override's PROVIDER is witnessable here.
  //  - the `supportsImageInput &&` half of the PDF rule: no anthropic/google model
  //    lacks vision, so no fixture reaches it.
  it('PDFs need vision AND a provider whose dispatcher sends documents', () => {
    const anthropic = PROVIDERS.find((p) => p.id === 'anthropic');
    const google = PROVIDERS.find((p) => p.id === 'google');
    const openai = PROVIDERS.find((p) => p.id === 'openai');
    // Asserted, not `if`-guarded: a provider leaving the catalog must red this
    // case, not silently drop its assertion.
    expect(anthropic, 'catalog lost anthropic').toBeDefined();
    expect(google, 'catalog lost google').toBeDefined();
    expect(openai, 'catalog lost openai').toBeDefined();
    expect(attachmentCaps('anthropic', anthropic!.models[0]!.id, null).supportsPdfInput).toBe(true);
    expect(attachmentCaps('google', google!.models[0]!.id, null).supportsPdfInput).toBe(true);
    // openai reads images but its dispatcher does not send documents.
    expect(attachmentCaps('openai', openai!.models[0]!.id, null).supportsImageInput).toBe(true);
    expect(attachmentCaps('openai', openai!.models[0]!.id, null).supportsPdfInput).toBe(false);
  });
});
