/**
 * A9 / RFC 0091 — multimodal perception input on callAI. Advertised modalities
 * (text/image/document/audio) pass the guard; an unadvertised one (video) is
 * rejected with `unsupported_modality` rather than silently dropped. `audio` was
 * added in ADR 0085 Phase 1 (notebook audio/video source transcription).
 */

import { describe, expect, it } from 'vitest';
import { assertModalitiesAdvertised, INPUT_MODALITIES } from '../src/aiProviders/aiProvidersHost.js';
import type { AiCallRequest } from '../src/executor/types.js';

function req(content: AiCallRequest['messages'][number]['content']): AiCallRequest {
  return { provider: 'anthropic', model: 'm', messages: [{ role: 'user', content }] };
}

describe('callAI input modalities (A9)', () => {
  it('advertises text, image, document, audio', () => {
    expect([...INPUT_MODALITIES].sort()).toEqual(['audio', 'document', 'image', 'text']);
  });

  it('accepts string and advertised parts (incl. audio)', () => {
    expect(() => assertModalitiesAdvertised(req('plain text'))).not.toThrow();
    expect(() => assertModalitiesAdvertised(req([{ type: 'text', text: 'hi' }]))).not.toThrow();
    expect(() => assertModalitiesAdvertised(req([{ type: 'image', mimeType: 'image/png', dataBase64: 'AAA' }]))).not.toThrow();
    expect(() => assertModalitiesAdvertised(req([{ type: 'file', mimeType: 'application/pdf', dataBase64: 'AAA' }]))).not.toThrow();
    expect(() => assertModalitiesAdvertised(req([{ type: 'audio', mimeType: 'audio/mpeg', dataBase64: 'AAA' }]))).not.toThrow();
  });

  it('rejects an unadvertised modality (video) with unsupported_modality', () => {
    try {
      // `video` parts are not mapped in PART_TO_MODALITY → modality 'video', unadvertised.
      assertModalitiesAdvertised(req([{ type: 'video', mimeType: 'video/mp4', dataBase64: 'AAA' } as never]));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('unsupported_modality');
    }
  });
});
