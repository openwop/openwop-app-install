/**
 * A9 / RFC 0091 — multimodal perception input on callAI. Advertised modalities
 * (text/image/document) pass the guard; an unadvertised one (audio) is rejected
 * with `unsupported_modality` rather than silently dropped.
 */

import { describe, expect, it } from 'vitest';
import { assertModalitiesAdvertised, INPUT_MODALITIES } from '../src/aiProviders/aiProvidersHost.js';
import type { AiCallRequest } from '../src/executor/types.js';

function req(content: AiCallRequest['messages'][number]['content']): AiCallRequest {
  return { provider: 'anthropic', model: 'm', messages: [{ role: 'user', content }] };
}

describe('callAI input modalities (A9)', () => {
  it('advertises text, image, document', () => {
    expect([...INPUT_MODALITIES].sort()).toEqual(['document', 'image', 'text']);
  });

  it('accepts string and advertised parts', () => {
    expect(() => assertModalitiesAdvertised(req('plain text'))).not.toThrow();
    expect(() => assertModalitiesAdvertised(req([{ type: 'text', text: 'hi' }]))).not.toThrow();
    expect(() => assertModalitiesAdvertised(req([{ type: 'image', mimeType: 'image/png', dataBase64: 'AAA' }]))).not.toThrow();
    expect(() => assertModalitiesAdvertised(req([{ type: 'file', mimeType: 'application/pdf', dataBase64: 'AAA' }]))).not.toThrow();
  });

  it('rejects an unadvertised modality (audio) with unsupported_modality', () => {
    try {
      assertModalitiesAdvertised(req([{ type: 'audio', mimeType: 'audio/mp3', dataBase64: 'AAA' }]));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('unsupported_modality');
    }
  });
});
