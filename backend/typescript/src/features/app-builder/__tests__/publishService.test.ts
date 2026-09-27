/**
 * Grade pass 2026-07-07 (code F8 test gap) — the publish push loop, unit-tested
 * over a mocked `brokeredFetch`: repo create/reuse (incl. the raced 409),
 * per-file 422 → warning, auth/rate-limit ABORT (no 200-warning cascade), and
 * `filesPushed`/`partial` accounting. The route-level authz/toggle/424 trio
 * lives in test/app-builder-publish.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: { method: string; url: string }[] = [];
let responder: (method: string, url: string) => { status: number; json: Record<string, unknown> };

vi.mock('../../../host/brokeredEgress.js', () => ({
  brokeredFetch: vi.fn(async (_deps: unknown, opts: { method?: string; url: string }) => {
    const method = opts.method ?? 'GET';
    calls.push({ method, url: opts.url });
    const r = responder(method, opts.url);
    return { outcome: 'sent', res: { status: r.status, json: async () => r.json } };
  }),
}));

const { publishToGitHub } = await import('../publishService.js');

const DEPS = { storage: {} as never, tenantId: 't1', runId: 'publish:test', actingUserId: 'u1' };
const APP = { name: 'Pub', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'text', props: { text: 'x' } }] }] };

beforeEach(() => { calls.length = 0; });

describe('publishToGitHub loop semantics', () => {
  it('creates the repo and pushes every file (partial=false)', async () => {
    responder = (m, url) => {
      if (m === 'GET' && url.endsWith('/user')) return { status: 200, json: { login: 'octo' } };
      if (m === 'POST' && url.endsWith('/user/repos')) return { status: 201, json: {} };
      return { status: 201, json: {} };
    };
    const res = await publishToGitHub(DEPS, { state: APP, target: 'html-css', repo: 'my-app', isPrivate: true });
    expect(res.repo).toBe('created');
    expect(res.partial).toBe(false);
    expect(res.filesPushed).toBeGreaterThan(0);
    expect(res.repoUrl).toBe('https://github.com/octo/my-app');
  });

  it('tolerates a raced 409 repo create as reused', async () => {
    responder = (m, url) => {
      if (m === 'GET' && url.endsWith('/user')) return { status: 200, json: { login: 'octo' } };
      if (m === 'POST' && url.endsWith('/user/repos')) return { status: 409, json: {} };
      return { status: 201, json: {} };
    };
    const res = await publishToGitHub(DEPS, { state: APP, target: 'html-css', repo: 'my-app', isPrivate: true });
    expect(res.repo).toBe('reused');
  });

  it('per-file 422 becomes a no-overwrite warning (partial=true), the loop continues', async () => {
    let put = 0;
    responder = (m, url) => {
      if (m === 'GET' && url.endsWith('/user')) return { status: 200, json: { login: 'octo' } };
      if (m === 'POST' && url.endsWith('/user/repos')) return { status: 422, json: {} };
      put += 1;
      return put === 1 ? { status: 422, json: {} } : { status: 201, json: {} };
    };
    const res = await publishToGitHub(DEPS, { state: APP, target: 'html-css', repo: 'my-app', isPrivate: true });
    expect(res.repo).toBe('reused');
    expect(res.partial).toBe(true);
    expect(res.warnings.some((w) => w.includes('left untouched'))).toBe(true);
    expect(res.filesPushed).toBeGreaterThan(0); // later files still pushed
  });

  it('ABORTS the loop on an auth/rate-limit class status (grade pass F8)', async () => {
    responder = (m, url) => {
      if (m === 'GET' && url.endsWith('/user')) return { status: 200, json: { login: 'octo' } };
      if (m === 'POST' && url.endsWith('/user/repos')) return { status: 201, json: {} };
      return { status: 403, json: {} };
    };
    const res = await publishToGitHub(DEPS, { state: APP, target: 'html-css', repo: 'my-app', isPrivate: true });
    expect(res.partial).toBe(true);
    expect(res.filesPushed).toBe(0);
    expect(res.warnings.length).toBe(1); // ONE abort warning, not one per file
    const puts = calls.filter((c) => c.method === 'PUT').length;
    expect(puts).toBe(1); // stopped at the first failure
  });

  it('rejects an invalid repo name before any network call', async () => {
    responder = () => { throw new Error('should not be called'); };
    await expect(publishToGitHub(DEPS, { state: APP, target: 'html-css', repo: 'bad repo!', isPrivate: true })).rejects.toMatchObject({ httpStatus: 400 });
    expect(calls.length).toBe(0);
  });
});
