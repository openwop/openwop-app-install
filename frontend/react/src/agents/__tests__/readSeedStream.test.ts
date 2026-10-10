/**
 * #4239 — the streamed demo seed resolves only on a `result` line. An `error`
 * line, or a stream that ends without a terminal line, is a thrown error, never
 * a success-shaped empty result.
 */
import { describe, expect, it } from 'vitest';
import { readSeedStream } from '../rosterClient.js';

function ndjson(lines: string[]): Response {
  return new Response(lines.map((l) => `${l}\n`).join(''), { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
}

describe('readSeedStream', () => {
  it('returns the result line, ignoring keepalives', async () => {
    const r = await readSeedStream(ndjson(['{"type":"keepalive"}', '{"type":"keepalive"}', '{"type":"result","result":{"seeded":true,"agents":10}}']));
    expect(r).toEqual({ seeded: true, agents: 10 });
  });

  it('throws on an error line with the server message', async () => {
    await expect(readSeedStream(ndjson(['{"type":"keepalive"}', '{"type":"error","code":"internal_error","message":"The seed failed."}']))).rejects.toThrow('The seed failed.');
  });

  it('throws when the stream ends without a terminal line', async () => {
    await expect(readSeedStream(ndjson(['{"type":"keepalive"}']))).rejects.toThrow(/without a result/);
  });

  it('reads a plain JSON 200 from a host without the stream mode', async () => {
    const r = await readSeedStream(new Response('{"seeded":false,"agents":10}', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(r).toEqual({ seeded: false, agents: 10 });
  });
});
