/**
 * ADR 0393 Lane A — outbound sync unit tests over a mocked `brokeredFetch`:
 * the atomic tree→commit→ref flow, the content-addressed no-op, stale-file
 * deletion via the generated manifest, the fast-forward-only ref-conflict
 * retry, marker parse round-trip, and `app.model.json` canonical round-trip
 * (the ADR's Phase 1 gate).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Call { method: string; url: string; body?: Record<string, unknown> }
const calls: Call[] = [];
let responder: (method: string, url: string, body?: Record<string, unknown>) => { status: number; json: Record<string, unknown> };

vi.mock('../../../host/brokeredEgress.js', () => ({
  brokeredFetch: vi.fn(async (_deps: unknown, opts: { method?: string; url: string; body?: string }) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url: opts.url, ...(body ? { body } : {}) });
    const r = responder(method, opts.url, body);
    return { outcome: 'sent', res: { status: r.status, json: async () => r.json } };
  }),
}));

const { syncPushToGitHub, canonicalModelJson, parseSyncMarker, SYNC_ACTOR_MARKER, MODEL_FILE, GENERATED_MANIFEST } = await import('../githubSync.js');
const { validateAppDoc } = await import('../validateAppDoc.js');
const { registerAppBuilderComponents } = await import('../componentCatalog.js');
registerAppBuilderComponents(); // validateAppDoc reads the closed catalog

const DEPS = { storage: {} as never, tenantId: 't1', runId: 'sync:test', actingUserId: 'u1' };
const BINDING = {
  id: 't1:c1', tenantId: 't1', canvasId: 'c1', owner: 'octo', repo: 'my-app', branch: 'main',
  target: 'html-css' as const, webhookId: 'wh1', sealedWebhookSecret: 's', boundBy: 'u1', boundAt: 'now',
};
const APP = { name: 'Sync', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'text', props: { text: 'x' } }] }] };

beforeEach(() => { calls.length = 0; });

/** A responder for the happy atomic-commit path against an existing branch. */
function happyResponder(overrides?: Partial<Record<string, (body?: Record<string, unknown>) => { status: number; json: Record<string, unknown> }>>) {
  responder = (m, url, body) => {
    if (m === 'GET' && url.includes('/git/ref/')) return overrides?.ref?.(body) ?? { status: 200, json: { object: { sha: 'headsha' } } };
    if (m === 'GET' && url.includes('/git/commits/')) return { status: 200, json: { tree: { sha: 'basetree' } } };
    if (m === 'GET' && url.includes('/contents/')) return overrides?.manifest?.(body) ?? { status: 404, json: {} };
    if (m === 'POST' && url.endsWith('/git/trees')) return overrides?.tree?.(body) ?? { status: 201, json: { sha: 'newtree' } };
    if (m === 'POST' && url.endsWith('/git/commits')) return { status: 201, json: { sha: 'newcommit' } };
    if (m === 'PATCH' && url.includes('/git/refs/')) return overrides?.refUpdate?.(body) ?? { status: 200, json: {} };
    if (m === 'POST' && url.endsWith('/git/refs')) return { status: 201, json: {} };
    return { status: 500, json: {} };
  };
}

describe('syncPushToGitHub — atomic commit flow', () => {
  it('pushes ONE commit (model + manifest + generated source) and fast-forwards the ref', async () => {
    happyResponder();
    const res = await syncPushToGitHub(DEPS, BINDING, { app: APP, modelVersion: 7 });
    expect(res.outcome).toBe('pushed');
    expect(res.commitSha).toBe('newcommit');
    const commits = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/git/commits'));
    expect(commits.length).toBe(1); // atomic: one commit, never per-file
    const message = commits[0]!.body!.message as string;
    expect(message).toContain(SYNC_ACTOR_MARKER);
    expect(parseSyncMarker(message)).toBe(7);
    const tree = calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/trees'))!.body!.tree as { path: string }[];
    const paths = tree.map((t) => t.path);
    expect(paths).toContain(MODEL_FILE);
    expect(paths).toContain(GENERATED_MANIFEST);
    expect(paths.length).toBeGreaterThan(2); // generated source rode along
    expect(res.filesPushed).toBe(paths.length);
  });

  it('creates the branch ref on first sync (404 ref → POST /git/refs, parentless commit)', async () => {
    happyResponder({ ref: () => ({ status: 404, json: {} }) });
    const res = await syncPushToGitHub(DEPS, BINDING, { app: APP, modelVersion: 1 });
    expect(res.outcome).toBe('pushed');
    const commit = calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))!;
    expect(commit.body!.parents).toEqual([]);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))).toBe(true);
  });

  it('is a content-addressed NO-OP when the tree is unchanged', async () => {
    happyResponder({ tree: () => ({ status: 201, json: { sha: 'basetree' } }) }); // tree sha == base tree
    const res = await syncPushToGitHub(DEPS, BINDING, { app: APP, modelVersion: 7 });
    expect(res.outcome).toBe('noop');
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))).toBe(false);
  });

  it('deletes ONLY our own stale generated files (manifest diff), never developer files', async () => {
    // MODEL_FILE is still in the snapshot; gone-screen is stale build output.
    const prevManifest = { modelVersion: 6, paths: ['src/gone-screen.html', MODEL_FILE] };
    happyResponder({
      manifest: () => ({ status: 200, json: { content: Buffer.from(JSON.stringify(prevManifest), 'utf8').toString('base64') } }),
    });
    const res = await syncPushToGitHub(DEPS, BINDING, { app: APP, modelVersion: 7 });
    expect(res.outcome).toBe('pushed');
    const tree = calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/trees'))!.body!.tree as { path: string; sha?: string | null }[];
    const deletions = tree.filter((t) => t.sha === null).map((t) => t.path);
    expect(deletions).toEqual(['src/gone-screen.html']); // stale generated file removed,
    // a path still present in the snapshot (the model) is UPDATED, not deleted
    expect(res.deletedStale).toBe(1);
  });

  it('retries a non-fast-forward 422 once, then surfaces ref_conflict (never force)', async () => {
    let attempts = 0;
    happyResponder({ refUpdate: () => { attempts += 1; return { status: 422, json: {} }; } });
    const res = await syncPushToGitHub(DEPS, BINDING, { app: APP, modelVersion: 7 });
    expect(res.outcome).toBe('ref_conflict');
    expect(attempts).toBe(2); // one retry
    for (const c of calls.filter((x) => x.method === 'PATCH')) expect(c.body!.force).toBe(false);
    expect(res.warnings.some((w) => w.includes('branch moved'))).toBe(true);
  });
});

describe('app.model.json round-trip (the Phase 1 gate)', () => {
  it('serializes deterministically (key order invariant) and round-trips through the validator', () => {
    const a = canonicalModelJson({ name: 'A', screens: APP.screens });
    const b = canonicalModelJson({ screens: APP.screens, name: 'A' });
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as Record<string, unknown>;
    expect(validateAppDoc(parsed).errors).toEqual([]);
    expect(parsed).toEqual({ name: 'A', screens: APP.screens });
  });
});

describe('parseSyncMarker', () => {
  it('reads the version from our marker, null otherwise', () => {
    expect(parseSyncMarker(`Sync\n\n${SYNC_ACTOR_MARKER} model-version=42`)).toBe(42);
    expect(parseSyncMarker('feat: a human commit')).toBeNull();
    expect(parseSyncMarker(`${SYNC_ACTOR_MARKER} but no version`)).toBeNull();
  });
});
