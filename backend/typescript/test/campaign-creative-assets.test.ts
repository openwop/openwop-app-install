/**
 * ADR 0229 — campaign creative asset operations (gap plan §5D D3).
 *
 * Covers:
 *  - media asset LINEAGE: sanitize (bounds, closed generatedBy vocabulary,
 *    unknown keys dropped) + persist on create + surface in reads + clear on update;
 *  - the narrow `ctx.features.media.createAssetFromServeUrl` surface: registers a
 *    host-stored byte asset (RFC 0055 serve token) as a durable library asset with
 *    lineage; tenant-checked (a foreign token reads as not-found); MIME-guarded;
 *  - the `feature.campaign-channels.nodes.render-concepts` node: honest-off
 *    (`host_capability_missing`) without the image delegate / media surface,
 *    renders via a stubbed delegate → assets created WITH lineage + outputs carry
 *    refs, maxImages clamp, and a mid-run budget-style failure keeps partial
 *    renders (`truncatedBy`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import {
  __resetMedia,
  cleanLineage,
  createAsset,
  getAsset,
  updateAsset,
  viewAsset,
} from '../src/features/media/mediaService.js';
import { buildMediaSurface } from '../src/features/media/surface.js';
import { nodes as channelNodes } from '../../../packs/feature.campaign-channels.nodes/index.mjs';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAQDWUFLAAAAAAElFTkSuQmCC';

const RENDER = 'feature.campaign-channels.nodes.render-concepts';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetMedia();
});

/** A stored library asset for tenant/org with optional lineage input. */
async function mkAsset(lineage?: unknown) {
  return createAsset({
    tenantId: 'tA',
    orgId: 'o1',
    name: 'test asset',
    contentType: 'image/png',
    sizeBytes: 10,
    storageRef: 'ref-1',
    serveToken: 'tok-1',
    uploadedBy: 'u1',
    ...(lineage !== undefined ? { lineage } : {}),
  });
}

describe('media asset lineage (ADR 0229)', () => {
  it('cleanLineage bounds every field, drops unknown keys, closes generatedBy', () => {
    // Spaced text — an unbroken 40+ char run would (correctly) trip the
    // secret-shape scrub, which is not what this bound assertion targets.
    const cleaned = cleanLineage({
      derivedFrom: 'masset:abc',
      generatedBy: 'ai',
      prompt: 'a scene '.repeat(400).trim(),
      model: ('model-x '.repeat(40)).trim(),
      rightsNote: ('note ok '.repeat(200)).trim(),
      injected: 'nope',
    });
    expect(cleaned).toBeDefined();
    expect(cleaned?.derivedFrom).toBe('masset:abc');
    expect(cleaned?.generatedBy).toBe('ai');
    expect(cleaned?.prompt?.length).toBe(2000);
    expect(cleaned?.model?.length).toBe(120);
    expect(cleaned?.rightsNote?.length).toBe(400);
    expect(Object.keys(cleaned ?? {}).sort()).toEqual(['derivedFrom', 'generatedBy', 'model', 'prompt', 'rightsNote']);
  });

  it('cleanLineage rejects a non-"ai" generatedBy and returns undefined for junk', () => {
    expect(cleanLineage({ generatedBy: 'human' })).toBeUndefined();
    expect(cleanLineage('not-an-object')).toBeUndefined();
    expect(cleanLineage([])).toBeUndefined();
    expect(cleanLineage({})).toBeUndefined();
  });

  it('persists lineage on create and surfaces it in reads (view + getAsset)', async () => {
    const a = await mkAsset({ generatedBy: 'ai', prompt: 'a scene', model: 'gpt-image-1', rightsNote: 'internal use' });
    expect(a.lineage).toEqual({ generatedBy: 'ai', prompt: 'a scene', model: 'gpt-image-1', rightsNote: 'internal use' });
    const read = await getAsset('tA', 'o1', a.assetId);
    expect(read?.lineage?.prompt).toBe('a scene');
    expect(viewAsset(read!).lineage?.model).toBe('gpt-image-1');
  });

  it('an asset created WITHOUT lineage has none; update sets and null clears it', async () => {
    const a = await mkAsset();
    expect(a.lineage).toBeUndefined();
    const set = await updateAsset('tA', 'o1', a.assetId, { lineage: { generatedBy: 'ai', prompt: 'later' } });
    expect(set?.lineage).toEqual({ generatedBy: 'ai', prompt: 'later' });
    const cleared = await updateAsset('tA', 'o1', a.assetId, { lineage: null });
    expect(cleared?.lineage).toBeUndefined();
  });
});

describe('ctx.features.media.createAssetFromServeUrl (ADR 0229)', () => {
  it('registers a host-stored byte asset as a durable library asset with lineage', async () => {
    const stored = await storeMediaAsset('tA', { contentBase64: PNG_B64, contentType: 'image/png' });
    const surface = buildMediaSurface({ tenantId: 'tA', runId: 'run-1' });
    const out = await surface.createAssetFromServeUrl({
      orgId: 'o1',
      url: stored.url,
      name: 'Concept — square',
      lineage: { generatedBy: 'ai', prompt: 'a red square', model: 'mock-image-1' },
    });
    expect(String(out.assetId)).toMatch(/^masset:/);
    expect(out.contentType).toBe('image/png');
    // UX_UPGRADE-media R2 (MED2-R2) — this output is RECORDED in the run event
    // log, which is readable by the whole tenant with no org scoping. The serve
    // route is auth-exempt and the token's TTL is ~a century, so `serveUrl` is
    // not a convenience field: it IS the credential, in a path. It used to be
    // asserted here on the manifest's stated grounds that "the existing
    // artifact workbench renders variants side-by-side" from it — MEASURED at
    // the time of this change: ZERO references to `serveUrl` anywhere under
    // `frontend/react/src/chat/`. The consumer the credential was published for
    // does not exist, so the output now carries the handle and nothing more.
    expect(out.serveUrl, 'a recorded output must not carry a byte credential').toBeUndefined();
    expect(out.serveToken, 'nor the raw token').toBeUndefined();
    const read = await getAsset('tA', 'o1', String(out.assetId));
    // The durable copy still mints its OWN token rather than reusing the
    // scratch one — the property the old `serveToken` assertion existed to
    // check. It is now read from the asset row, where an authorized caller
    // legitimately sees it, instead of from a tenant-readable run output.
    expect(read?.serveToken).toBeTruthy();
    expect(read?.serveToken).not.toBe(stored.token);
    expect(read?.lineage).toEqual({ generatedBy: 'ai', prompt: 'a red square', model: 'mock-image-1' });
    expect(read?.uploadedBy).toBe('run-1');
  });

  it('a FOREIGN tenant token reads as not-found (RFC 0055 tenant scoping)', async () => {
    const stored = await storeMediaAsset('tB', { contentBase64: PNG_B64, contentType: 'image/png' });
    const surface = buildMediaSurface({ tenantId: 'tA' });
    await expect(surface.createAssetFromServeUrl({ orgId: 'o1', url: stored.url })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects an unknown token, a bad url, and a disallowed MIME fail-closed', async () => {
    const surface = buildMediaSurface({ tenantId: 'tA' });
    await expect(surface.createAssetFromServeUrl({ orgId: 'o1', url: '/v1/host/openwop-app/assets/does-not-exist' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(surface.createAssetFromServeUrl({ orgId: 'o1', url: 'http://evil.example/../../etc' })).rejects.toMatchObject({ code: 'validation_error' });
    const html = await storeMediaAsset('tA', { contentBase64: PNG_B64, contentType: 'text/html' });
    await expect(surface.createAssetFromServeUrl({ orgId: 'o1', url: html.url })).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('render-concepts node (ADR 0229 / D3)', () => {
  const draft = {
    briefId: 'b1',
    briefs: [
      { format: 'Social square', sceneDescription: 'A red square on white', composition: 'Centered', messagingContext: 'Bold minimalism' },
      { format: 'Banner', sceneDescription: 'A blue banner scene' },
      { format: 'Story', sceneDescription: 'A tall story frame' },
    ],
  };

  /** A run-shaped media surface stub recording created assets. */
  function mediaStub() {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      surface: {
        createAssetFromServeUrl: async (args: Record<string, unknown>) => {
          created.push(args);
          return { assetId: `masset:${created.length}`, serveToken: `tok-${created.length}`, serveUrl: `/v1/host/openwop-app/assets/tok-${created.length}`, contentType: 'image/png', name: String(args.name ?? ''), sizeBytes: 3 };
        },
      },
    };
  }

  it('is honest-off without the image delegate (host_capability_missing, like the seam)', async () => {
    const m = mediaStub();
    const out = await channelNodes[RENDER]({ features: { media: m.surface }, inputs: { draft, orgId: 'o1' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('host_capability_missing');
    expect(m.created).toHaveLength(0);
  });

  it('is honest-off without the media surface', async () => {
    const out = await channelNodes[RENDER]({
      callImageGenerator: async () => ({ images: [] }),
      features: {},
      inputs: { draft, orgId: 'o1' },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('host_capability_missing');
  });

  it('passes through the seam refusal when the provider is unconfigured (zero renders)', async () => {
    const m = mediaStub();
    const out = await channelNodes[RENDER]({
      callImageGenerator: async () => {
        throw Object.assign(new Error('Image generation provider "openai" is not yet wired on this host.'), { code: 'host_capability_missing' });
      },
      features: { media: m.surface },
      inputs: { draft, orgId: 'o1' },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('host_capability_missing');
    expect(m.created).toHaveLength(0);
  });

  it('renders via the stubbed delegate → assets created WITH lineage, outputs carry refs', async () => {
    const m = mediaStub();
    const genCalls: Array<Record<string, unknown>> = [];
    const out = await channelNodes[RENDER]({
      callImageGenerator: async (req: Record<string, unknown>) => {
        genCalls.push(req);
        return { images: [{ url: `/v1/host/openwop-app/assets/scratch-${genCalls.length}`, mimeType: 'image/png', metadata: { model: 'gpt-image-1', provider: 'openai' } }] };
      },
      features: { media: m.surface },
      inputs: { draft, orgId: 'o1', maxImages: 2 },
    });
    expect(out.status).toBe('success');
    const o = out.outputs as Record<string, any>;
    expect(o.count).toBe(2); // maxImages clamps below the 3 briefs
    expect(genCalls).toHaveLength(2);
    expect(genCalls[0].n).toBe(1);
    expect(String(genCalls[0].prompt)).toContain('A red square on white');
    // Media assets registered with lineage (generatedBy 'ai', prompt, model).
    expect(m.created).toHaveLength(2);
    const lin = m.created[0].lineage as Record<string, unknown>;
    expect(lin.generatedBy).toBe('ai');
    expect(String(lin.prompt)).toContain('Bold minimalism');
    expect(lin.model).toBe('gpt-image-1');
    // MED2-R2 — outputs carry the asset REF and no credential. `serveUrl` is
    // the auth-exempt serve token in a path, and this node's output is recorded
    // in the tenant-wide-readable run log; a member of another org, 403'd on
    // these very assets' media routes, could read the run and fetch the images
    // with no auth. The handle is enough: resolving it back to bytes goes
    // through the media route, which checks who is asking.
    expect(o.concepts[0].assetId).toBe('masset:1');
    expect(o.concepts[0].serveUrl, 'a recorded node output must not carry a byte credential').toBeUndefined();
    expect(o.concepts[0].format).toBe('Social square');
    expect(o.concepts[1].briefIndex).toBe(1);
  });

  it('clamps maxImages to 3 and defaults to 1', async () => {
    const m = mediaStub();
    const gen = async () => ({ images: [{ url: '/v1/host/openwop-app/assets/s', mimeType: 'image/png' }] });
    const one = await channelNodes[RENDER]({ callImageGenerator: gen, features: { media: m.surface }, inputs: { draft, orgId: 'o1' } });
    expect((one.outputs as Record<string, any>).count).toBe(1);
    const many = await channelNodes[RENDER]({ callImageGenerator: gen, features: { media: m.surface }, inputs: { draft, orgId: 'o1', maxImages: 99 } });
    expect((many.outputs as Record<string, any>).count).toBe(3); // 3 briefs, cap 3
  });

  it('a mid-run budget refusal keeps partial renders (truncatedBy, never discarded)', async () => {
    const m = mediaStub();
    let calls = 0;
    const out = await channelNodes[RENDER]({
      callImageGenerator: async () => {
        calls += 1;
        if (calls > 1) throw Object.assign(new Error('Daily image-generation budget reached (50/50).'), { code: 'provider_rate_limited' });
        return { images: [{ url: '/v1/host/openwop-app/assets/s1', mimeType: 'image/png' }] };
      },
      features: { media: m.surface },
      inputs: { draft, orgId: 'o1', maxImages: 3 },
    });
    expect(out.status).toBe('success');
    const o = out.outputs as Record<string, any>;
    expect(o.count).toBe(1);
    expect(o.truncatedBy).toBe('provider_rate_limited');
  });

  it('fails on an empty creative-briefs draft and on an unresolvable org', async () => {
    const m = mediaStub();
    const gen = async () => ({ images: [] });
    const empty = await channelNodes[RENDER]({ callImageGenerator: gen, features: { media: m.surface }, inputs: { draft: { briefs: [] }, orgId: 'o1' } });
    expect(empty.status).toBe('failed');
    expect(empty.error?.code).toBe('empty_draft');
    const noOrg = await channelNodes[RENDER]({ callImageGenerator: gen, features: { media: m.surface }, inputs: { draft: { briefs: [{ sceneDescription: 'x' }] } } });
    expect(noOrg.status).toBe('failed');
    expect(noOrg.error?.code).toBe('org_required');
  });
});
