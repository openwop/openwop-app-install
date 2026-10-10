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

  it('PDFs need vision AND a provider whose dispatcher sends documents', () => {
    const anthropic = PROVIDERS.find((p) => p.id === 'anthropic');
    const openai = PROVIDERS.find((p) => p.id === 'openai');
    if (anthropic) expect(attachmentCaps('anthropic', anthropic.models[0]!.id, null).supportsPdfInput).toBe(true);
    if (openai) expect(attachmentCaps('openai', openai.models[0]!.id, null).supportsPdfInput).toBe(false);
  });
});
