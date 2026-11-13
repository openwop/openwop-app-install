/**
 * CC-CHAIN-2 — `core.openwop.http.fetch` with no URL is a typed INVALID_URL, not a crash.
 *
 * Observed on 373d4863a (run e0776a91, content.feed-watch): the chain's fetch node
 * binds `url: "{{params.feedUrl}}"`; with neither the param nor a run input the URL
 * resolved to undefined and `substituteUrl` threw a raw TypeError ("Cannot read
 * properties of undefined (reading 'replace')"), surfaced as an opaque
 * `pack_node_error`. A missing URL now fails with the same typed INVALID_URL code the
 * node already uses for a bad template or scheme. Red before: the error has no code
 * and the message is the TypeError text.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type FetchNode = (ctx: unknown) => Promise<unknown>;
const packUrl = new URL('../../../packs/core.openwop.http/index.mjs', import.meta.url);
const { fetchNode } = (await import(path.resolve(fileURLToPath(packUrl)))) as { fetchNode: FetchNode };

const ctxWith = (config: Record<string, unknown>) => ({
  config, inputs: {}, runId: 'r', nodeId: 'n',
  fetch: async () => { throw new Error('must not fetch'); },
});

describe('CC-CHAIN-2 — http fetch with a missing URL', () => {
  for (const [label, config] of [['absent', {}], ['empty string', { url: '' }], ['non-string', { url: 42 }]] as const) {
    it(`url ${label} → typed INVALID_URL naming config.url`, async () => {
      const err = await fetchNode(ctxWith(config as Record<string, unknown>)).then(() => null, (e: unknown) => e as { code?: string; message?: string });
      expect(err).not.toBeNull();
      expect(err!.code).toBe('INVALID_URL');
      expect(err!.message).toContain('config.url');
    });
  }
});
