/**
 * ADR 1039 D2 — the briefs client keeps the host error envelope's CODE
 * (`{ error: <code>, message }`) on the thrown error, which is how the page tells
 * "no Replicate key" (a designed state) from any other failure.
 *
 * Red when the client reads the code from the wrong field (the first cut read
 * `body.code`, which the envelope does not have) or drops it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateReel } from '../creativeBriefsClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('creativeBriefsClient — error code from the host envelope', () => {
  it('a 422 credential_required rejects with that code and the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'credential_required', message: 'Reels need a Replicate key.' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )));
    await expect(generateReel('org-1', 'cb-1', { aspectRatio: '9:16' })).rejects.toMatchObject({ code: 'credential_required', message: 'Reels need a Replicate key.' });
  });

  it('a non-JSON failure still rejects, with no code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    const err = await generateReel('org-1', 'cb-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: unknown }).code).toBeUndefined();
  });
});
