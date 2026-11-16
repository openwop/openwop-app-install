/**
 * CC-CHAIN-1 (ADR 1111 P1) — `core.openwop.http.openapi-call` names the real cause
 * when a step carries `config.connectionRef` but no OpenAPI document is wired.
 *
 * Observed on 373d4863a (Campaign Studio acceptance, 2026-11-11): the
 * `marketing.campaign-launch` launch step was an openapi-call with
 * `connectionRef: core.openwop.connections.google-ads` and no `inputs.openapi`. The
 * node never reads `connectionRef`, so it threw `CONFIG_INVALID: openapi doc missing
 * paths` on every run, connected or not, and the message did not say why. A
 * connection does not supply an API description (ADR 1111 decision 1), so the node
 * now fails with the named `openapi_document_missing`, whose message says the step
 * needs a wired document and that the connection does not provide one.
 *
 * Red before: the code is `CONFIG_INVALID` and the message is "openapi doc missing
 * paths". The last case pins that a step WITHOUT a connectionRef keeps the old code,
 * so the new name is not a blanket rename.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type OpenapiCall = (ctx: unknown) => Promise<unknown>;
const packUrl = new URL('../../../packs/core.openwop.http/index.mjs', import.meta.url);
const { openapiCall } = (await import(path.resolve(fileURLToPath(packUrl)))) as { openapiCall: OpenapiCall };

const REF = 'core.openwop.connections.google-ads';

const ctxWith = (config: Record<string, unknown>, inputs: Record<string, unknown>) => ({
  config, inputs, runId: 'r', nodeId: 'n',
  fetch: async () => { throw new Error('must not fetch'); },
});

const failure = async (ctx: unknown): Promise<{ code?: string; message?: string } | null> =>
  openapiCall(ctx).then(() => null, (e: unknown) => e as { code?: string; message?: string });

describe('CC-CHAIN-1 — openapi-call with a connectionRef and no wired document', () => {
  for (const [label, inputs] of [
    ['no inputs at all', {}],
    ['a document with no paths', { openapi: { openapi: '3.0.0' } }],
  ] as const) {
    it(`${label} → typed openapi_document_missing naming the connection`, async () => {
      const err = await failure(ctxWith({ connectionRef: REF, operationId: 'createCampaign' }, inputs as Record<string, unknown>));
      expect(err).not.toBeNull();
      expect(err!.code).toBe('openapi_document_missing');
      expect(err!.message).toContain('needs a wired OpenAPI document');
      expect(err!.message).toContain(REF);
      expect(err!.message).toContain('does not provide one');
    });
  }

  it('without a connectionRef the missing document stays CONFIG_INVALID', async () => {
    const err = await failure(ctxWith({ operationId: 'createCampaign' }, {}));
    expect(err).not.toBeNull();
    expect(err!.code).toBe('CONFIG_INVALID');
  });
});
