/**
 * #6242 — the default transcriber model came from a literal (`gemini-2.5-flash`)
 * that Google deprecated (re-routed from 2026-12-01) and the catalog removed, so a
 * preflight checking the model against `providers.json` refused the host's own
 * default. Three layers:
 *  1. UNIT: `defaultTranscriptionModel` is the provider's catalog `quick` class
 *     default, and the catalog lists it.
 *  2. BEHAVIOUR: `callTranscriber` with no `model` sends that catalog model to
 *     Google; an explicit `model` (DeckTalk pins one) still wins.
 *  3. RATCHET: every model-id-shaped string literal in `src/` (host and adopter
 *     code, comments excluded) is listed in `providers.json`, or is on the named
 *     allowlist below with its reason. A stale allowlist entry also fails.
 *
 * Sabotage witnesses (2026-11-24):
 * - restoring `req.model ?? 'gemini-2.5-flash'` in `transcribeManaged` reds
 *   layer 2's default case and layer 3 (an unlisted dispatch literal);
 * - pointing `defaultTranscriptionModel` at `getDefaultModel` alone reds layer 1.
 *
 * Ceiling: layer 3 matches the vendor id shapes below (gemini-, gpt-, o<n>-,
 * claude-<family>-). A model id of another shape is not seen.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import { defaultTranscriptionModel, getClassDefault, getProviderConfig } from '../src/providers/catalog.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { stripComments } from './helpers/stripComments.js';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(BACKEND, '../..');

interface CatalogFile { providers: Array<{ id: string; models?: Array<{ id: string }> }> }
const CATALOG = new Set(
  (JSON.parse(readFileSync(join(REPO, 'providers.json'), 'utf8')) as CatalogFile).providers.flatMap((p) => (p.models ?? []).map((m) => m.id)),
);

describe('layer 1 — the transcription default is the catalog quick model', () => {
  it('google resolves to its classDefaults.quick, which the catalog lists', () => {
    const quick = getClassDefault('google', 'quick');
    expect(quick, 'google declares a quick class default').toBeTruthy();
    expect(defaultTranscriptionModel('google')).toBe(quick);
    expect(CATALOG.has(defaultTranscriptionModel('google'))).toBe(true);
    expect(defaultTranscriptionModel('google')).not.toBe('gemini-2.5-flash');
  });
  it('every provider resolves to a catalog-listed model', () => {
    for (const id of ['google', 'anthropic', 'openai']) {
      if (!getProviderConfig(id)) continue;
      expect(CATALOG.has(defaultTranscriptionModel(id)), id).toBe(true);
    }
  });
});

describe('layer 2 — callTranscriber sends the resolved model', () => {
  beforeAll(async () => {
    const storage = await openStorage('memory://');
    setInvocationBackend(storage);
    initHostExtPersistence(storage);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function transcribe(model?: string): Promise<string[]> {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hello there' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const tenantId = `t6242-${Math.random().toString(36).slice(2, 8)}`;
    const asset = await storeMediaAsset(tenantId, { contentBase64: Buffer.from('audio-bytes').toString('base64'), contentType: 'audio/mpeg' });
    const adapter = createAiProvidersAdapter({
      runId: `run-6242-${Math.random().toString(36).slice(2, 8)}`,
      nodeId: 'n1',
      tenantId,
      attempt: 1,
      secrets: { 'byok:google': 'test-key' },
      runCredentialRef: 'byok:google',
      policyResolver: { async resolveForRun() { return []; } },
    });
    // The stub answers with a plain JSON body; the streaming dispatcher then refuses
    // it. The URL it requested is the evidence, so the refusal is caught.
    await adapter.callTranscriber({ audio: { url: asset.url }, ...(model ? { model } : {}) }).catch(() => undefined);
    return urls;
  }

  it('no model → the catalog quick model reaches the provider', async () => {
    const saved = process.env.OPENWOP_VOICE_MOCK;
    delete process.env.OPENWOP_VOICE_MOCK;
    try {
      const urls = await transcribe();
      expect(urls.length, 'the call must reach fetch, or the model check is vacuous').toBeGreaterThan(0);
      expect(urls.some((u) => u.includes(`models/${defaultTranscriptionModel('google')}:`)), urls.join('\n')).toBe(true);
      expect(urls.some((u) => u.includes('gemini-2.5-flash:'))).toBe(false);
    } finally {
      if (saved !== undefined) process.env.OPENWOP_VOICE_MOCK = saved;
    }
  });

  it('an explicit model still wins (an adopter pin is honoured)', async () => {
    const saved = process.env.OPENWOP_VOICE_MOCK;
    delete process.env.OPENWOP_VOICE_MOCK;
    try {
      const urls = await transcribe('gemini-2.5-flash-lite');
      expect(urls.some((u) => u.includes('models/gemini-2.5-flash-lite:')), urls.join('\n')).toBe(true);
    } finally {
      if (saved !== undefined) process.env.OPENWOP_VOICE_MOCK = saved;
    }
  });
});

describe('layer 3 — model-id literals in src/ exist in the catalog', () => {
  /** Ids that are deliberately not chat-catalog models, each with its reason. */
  const NOT_IN_CHAT_CATALOG: Record<string, string> = {
    'gemini-2.5-flash-preview-tts': 'speech model (dispatchSpeech), not a chat-catalog model',
    'gpt-4o-mini-tts': 'speech model (dispatchSpeech), not a chat-catalog model',
    'gemini-3.1-flash-live-preview': 'Gemini Live realtime model, configured per admin',
    'gpt-realtime': 'OpenAI realtime model, configured per admin',
    'gemini-live': 'a realtime PROVIDER id, not a model',
    'gemini-embedding-001': 'embedding model (vertexEmbedder / headless embed)',
    'gpt-image-2.6-sunburst': 'OpenAI image generation and editing model (dispatchImages), outside the chat catalog',
  };
  /** Files whose model ids are deliberately off-catalog. */
  const EXEMPT_FILES: Record<string, string> = {
    'src/providers/usageEmitter.ts': 'the price FALLBACK tables, for ids the catalog does not list (dated snapshots, explicit pins)',
  };
  const SHAPE = /['"`]((?:gemini|gpt|claude-(?:opus|sonnet|haiku|fable)|o[1-9])(?:[-.][a-z0-9]+)+)['"`]/g;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
  }
  const found: Array<{ file: string; id: string }> = [];
  for (const file of walk(join(BACKEND, 'src'))) {
    const rel = file.slice(BACKEND.length + 1);
    if (EXEMPT_FILES[rel]) continue;
    for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(SHAPE)) found.push({ file: rel, id: m[1] });
  }

  it('the scan is not vacuous', () => {
    // Floor, measured 2026-11-24: the managed defaults and class resolver alone
    // name several catalog models. A shape change that matches nothing reds here.
    expect(found.filter((f) => CATALOG.has(f.id)).length, JSON.stringify(found.slice(0, 5))).toBeGreaterThanOrEqual(5);
  });

  it('every model-id literal is in providers.json or on the named allowlist', () => {
    const unlisted = found.filter((f) => !CATALOG.has(f.id) && !NOT_IN_CHAT_CATALOG[f.id]);
    expect(unlisted, 'a model id the catalog does not list: use the catalog (getClassDefault / getDefaultModel), or allowlist it with a reason').toEqual([]);
  });

  it('every allowlist entry is still used (no stale exemptions)', () => {
    const used = new Set(found.map((f) => f.id));
    expect(Object.keys(NOT_IN_CHAT_CATALOG).filter((id) => !used.has(id))).toEqual([]);
  });
});
