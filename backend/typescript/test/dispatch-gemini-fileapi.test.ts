/**
 * dispatchGoogle long-form audio via the Gemini File API (ADR 0111 Phase 1). Mocks the
 * network only: asserts that audio OVER the inline limit is uploaded (start → finalize) and
 * referenced as `fileData` in the generateContent request, while small audio stays inline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchChat } from '../src/providers/dispatch.js';

interface GenPart { text?: string; inlineData?: { data?: string }; fileData?: { fileUri?: string; mimeType?: string } }
interface GenBody { contents: Array<{ parts: GenPart[] }> }

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function sse(text: string): Response {
  return new Response(`data: {"candidates":[{"content":{"parts":[{"text":${JSON.stringify(text)}}]}}]}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const urlOf = (input: Parameters<typeof fetch>[0]): string => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

describe('dispatchGoogle long-audio File API (ADR 0111)', () => {
  it('audio over the inline limit is uploaded + referenced as fileData (not inlined)', async () => {
    const big = Buffer.alloc(16 * 1024 * 1024).toString('base64'); // >15 MiB decoded → 2 × 8 MiB chunks
    let started = false; let uploadCalls = 0; let deleted = false; let genBody: GenBody | null = null;
    const offsets: string[] = [];
    const mock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = urlOf(input);
      if (url.endsWith('/upload/v1beta/files')) { started = true; return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://up.example/u1' } }); }
      if (url === 'https://up.example/u1') {
        uploadCalls += 1;
        const h = init?.headers as Record<string, string> | undefined;
        offsets.push(String(h?.['X-Goog-Upload-Offset']));
        return new Response(JSON.stringify({ file: { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', state: 'ACTIVE' } }), { status: 200 });
      }
      if (url.includes('streamGenerateContent')) { genBody = JSON.parse(String(init?.body)) as GenBody; return sse('the transcript'); }
      if (url.endsWith('/v1beta/files/abc') && init?.method === 'DELETE') { deleted = true; return new Response('{}', { status: 200 }); }
      return realFetch(input, init);
    });
    global.fetch = mock as typeof fetch;
    const r = await dispatchChat({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k', messages: [{ role: 'user', content: [{ type: 'audio', mimeType: 'audio/mpeg', dataBase64: big }] }], maxTokens: 64 });
    expect(started).toBe(true);
    expect(uploadCalls).toBe(2); // 16 MiB streamed in 2 × 8 MiB chunks (no full-body copy)
    expect(offsets).toEqual([String(0), String(8 * 1024 * 1024)]); // resumable offsets advance per chunk
    const parts = genBody!.contents[0]!.parts;
    expect(parts.find((p) => p.fileData)?.fileData?.fileUri).toBe('https://generativelanguage.googleapis.com/v1beta/files/abc');
    expect(parts.find((p) => p.inlineData)).toBeUndefined(); // NOT inlined
    expect(r.completion).toContain('the transcript');
    expect(deleted).toBe(true); // best-effort File-API cleanup after transcription (follow-on)
  });

  it('small audio stays inline — no File API upload', async () => {
    const small = Buffer.from('tiny audio bytes').toString('base64');
    let uploadCalled = false; let genBody: GenBody | null = null;
    const mock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = urlOf(input);
      if (url.includes('/upload/v1beta/files')) { uploadCalled = true; return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'x' } }); }
      if (url.includes('streamGenerateContent')) { genBody = JSON.parse(String(init?.body)) as GenBody; return sse('ok'); }
      return realFetch(input, init);
    });
    global.fetch = mock as typeof fetch;
    await dispatchChat({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k', messages: [{ role: 'user', content: [{ type: 'audio', mimeType: 'audio/mpeg', dataBase64: small }] }], maxTokens: 64 });
    expect(uploadCalled).toBe(false);
    expect(genBody!.contents[0]!.parts.find((p) => p.inlineData)).toBeTruthy();
  });
});
