/**
 * Batch-grade remediation (GRADE-0401-1) — direct unit coverage for the three
 * edit/upscale dispatchers ADR 0401 P3 added (the route tests exercise them
 * only through the mock seam): OpenAI multipart /images/edits shape (image +
 * optional mask parts, key in the header only), Replicate per-op default
 * models + data-URI inputs, and the upscale scale threading.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchImageEditOpenAI, dispatchImageEditReplicate, dispatchImageUpscaleReplicate,
  REPLICATE_OP_DEFAULT_MODELS,
} from '../src/providers/dispatchImages.js';

const PNG_B64 = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const OUT_BYTES = Buffer.from('89504e47', 'hex');

type FetchCall = { url: string; init: RequestInit | undefined };
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return { calls };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('dispatchImageEditOpenAI', () => {
  it('POSTs multipart with image + prompt (+ mask when given); key only in the auth header', async () => {
    const { calls } = fakeFetch(() => json({ data: [{ b64_json: OUT_BYTES.toString('base64') }] }));
    const images = await dispatchImageEditOpenAI({
      apiKey: 'sk-edit-key', imageBase64: PNG_B64, mimeType: 'image/png', op: 'inpaint',
      prompt: 'replace the sky', maskBase64: PNG_B64,
    });
    expect(images).toEqual([{ base64: OUT_BYTES.toString('base64'), mimeType: 'image/png' }]);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/images/edits');
    expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-edit-key');
    const form = call.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('prompt')).toBe('replace the sky');
    expect(form.get('image')).toBeInstanceOf(Blob);
    expect(form.get('mask')).toBeInstanceOf(Blob);
    // The key never leaks into a form field.
    expect([...form.entries()].some(([, v]) => typeof v === 'string' && v.includes('sk-edit-key'))).toBe(false);
  });

  it('omits the mask part when none is given and surfaces provider errors typed', async () => {
    const { calls } = fakeFetch(() => json({ data: [{ b64_json: OUT_BYTES.toString('base64') }] }));
    await dispatchImageEditOpenAI({ apiKey: 'k', imageBase64: PNG_B64, mimeType: 'image/png', op: 'edit', prompt: 'p' });
    expect((calls[0]!.init?.body as FormData).get('mask')).toBeNull();

    fakeFetch(() => new Response('nope', { status: 400 }));
    await expect(dispatchImageEditOpenAI({ apiKey: 'k', imageBase64: PNG_B64, mimeType: 'image/png', op: 'edit', prompt: 'p' }))
      .rejects.toThrow(/openai_images_edit_400/);
  });
});

describe('dispatchImageEditReplicate', () => {
  it('routes each op to its curated default model with data-URI inputs', async () => {
    for (const [op, expectedModel] of [
      ['edit', REPLICATE_OP_DEFAULT_MODELS.edit],
      ['inpaint', REPLICATE_OP_DEFAULT_MODELS.inpaint],
      ['background-remove', REPLICATE_OP_DEFAULT_MODELS['background-remove']],
    ] as const) {
      const { calls } = fakeFetch((url) => {
        if (url.includes('/predictions')) return json({ status: 'succeeded', output: ['https://replicate.delivery/x/o.png'] });
        return new Response(OUT_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
      });
      await dispatchImageEditReplicate({
        apiKey: 'k', imageBase64: PNG_B64, mimeType: 'image/png', op,
        ...(op !== 'background-remove' ? { prompt: 'p' } : {}),
        ...(op === 'inpaint' ? { maskBase64: PNG_B64 } : {}),
      });
      const create = calls[0]!;
      expect(create.url, op).toContain(`/models/${expectedModel}/predictions`);
      const input = (JSON.parse(String(create.init?.body)) as { input: Record<string, unknown> }).input;
      expect(String(input.image)).toMatch(/^data:image\/png;base64,/);
      if (op === 'inpaint') expect(String(input.mask)).toMatch(/^data:image\/png;base64,/);
      if (op === 'background-remove') expect(input.prompt).toBeUndefined();
      vi.unstubAllGlobals();
    }
  });
});

describe('dispatchImageUpscaleReplicate', () => {
  it('threads the scale into the task input on the Real-ESRGAN-class default', async () => {
    const { calls } = fakeFetch((url) => {
      if (url.includes('/predictions')) return json({ status: 'succeeded', output: ['https://replicate.delivery/x/o.png'] });
      return new Response(OUT_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const images = await dispatchImageUpscaleReplicate({ apiKey: 'k', imageBase64: PNG_B64, mimeType: 'image/png', scale: 4 });
    expect(images.length).toBe(1);
    const create = calls[0]!;
    expect(create.url).toContain(`/models/${REPLICATE_OP_DEFAULT_MODELS.upscale}/predictions`);
    const input = (JSON.parse(String(create.init?.body)) as { input: Record<string, unknown> }).input;
    expect(input.scale).toBe(4);
  });
});
