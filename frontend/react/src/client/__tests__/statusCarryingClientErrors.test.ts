/**
 * ARUX-12 — viewer writes are now 403, and the workforce and
 * user-agent clients threw a plain `Error` that dropped the status, so
 * `loadErrorMessage` could not tell a 403 from anything else and viewers saw the
 * backend's raw "Missing required scope" text. Both now carry `.status`; their
 * message text is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateWorkforceStatus, listWorkforces } from '../workforcesClient.js';
import { updateUserAgent } from '../agentsClient.js';
import { loadErrorMessage } from '../loadErrorMessage.js';

const echo = (k: string): string => k;

function respond(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
}

async function thrown(p: Promise<unknown>): Promise<Error & { status?: number }> {
  try { await p; } catch (e) { return e as Error & { status?: number }; }
  throw new Error('expected the call to throw');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('client errors carry the HTTP status', () => {
  it('workforces: a 403 classifies as forbidden, keeping the server prose as the message', async () => {
    respond(403, { error: 'forbidden', message: 'Missing required scope: host:workforces:manage' });
    const e = await thrown(updateWorkforceStatus('wf-1', 'piloting'));
    expect(e.status).toBe(403);
    expect(e.message).toBe('Missing required scope: host:workforces:manage');
    expect(loadErrorMessage(echo, e)).toBe('common:error_forbidden');
  });

  it('workforces: a body-less failure keeps the `<ctx> returned <status>` message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 502 })));
    const e = await thrown(listWorkforces());
    expect(e.status).toBe(502);
    expect(e.message).toBe('listWorkforces returned 502');
  });

  it('updateUserAgent: a 403 classifies as forbidden, message format unchanged', async () => {
    respond(403, { error: 'forbidden', message: 'Missing required scope' });
    const e = await thrown(updateUserAgent('a-1', { label: 'x' }));
    expect(e.status).toBe(403);
    expect(e.message).toBe('updateUserAgent failed: Missing required scope');
    expect(loadErrorMessage(echo, e)).toBe('common:error_forbidden');
  });
});
