/**
 * A scheduled loop whose Google connection lacks a scope used to notify
 * "Workflow failed · Something went wrong. Check the server logs." on every
 * 30-minute tick, forever. Three defects, one test file, bottom to top:
 *
 *  1. the ingest node threw one `upstream_unavailable` for every status, with
 *     "the credential may have expired", although a 403 means the token is valid
 *     and lacks a scope (an expired Google token is a 401);
 *  2. `errorRecovery` did not know that code, so the notification degraded it to
 *     the generic "Something went wrong";
 *  3. an unattended run re-notified the same failure on every tick.
 */
import { describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { emitRunFailureNotification } from '../src/notifications/notify.js';
import { classifyDispatchError } from '../src/observability/errorRecovery.js';
import { AiProviderError, type AiProviderErrorCode } from '../src/aiProviders/aiProvidersHost.js';
import type { RunRecord } from '../src/types.js';

const { nodes } = await import('../../../packs/feature.assistant.nodes/index.mjs');
const ingest = nodes['feature.assistant.nodes.ingest-commitments']!;

/** Google's real error body shapes (Calendar/Drive v3). */
const google = (code: number, status: string, reason: string, detailReason?: string) => ({
  error: {
    code,
    status,
    message: 'Request had insufficient authentication scopes. SECRET-ish human text that must not leak',
    errors: [{ reason, domain: 'global', message: 'Insufficient Permission' }],
    ...(detailReason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: detailReason }] } : {}),
  },
});

async function rejection(status: number, body: unknown, sourceKind: 'calendar' | 'drive' = 'calendar'): Promise<{ code?: string; message: string }> {
  try {
    await ingest({ inputs: { status, headers: {}, body }, config: { sourceKind }, features: { assistant: { upsertCommitment: async () => ({}) } } } as never);
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
  throw new Error('the ingest node did not throw on a refused fetch');
}

describe('1 — the ingest node names WHY Google refused', () => {
  it('403 + insufficient scope → connection_scope_missing, naming the service', async () => {
    const r = await rejection(403, google(403, 'PERMISSION_DENIED', 'insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'));
    expect(r.code).toBe('connection_scope_missing');
    expect(r.message).toMatch(/without Calendar access/);
    expect(r.message).toMatch(/ACCESS_TOKEN_SCOPE_INSUFFICIENT/);
  });

  it('401 → connection_reauth_required (an expired token is a 401, not a 403)', async () => {
    const r = await rejection(401, google(401, 'UNAUTHENTICATED', 'authError'));
    expect(r.code).toBe('connection_reauth_required');
  });

  it('403 + API disabled → provider_api_disabled (an operator fix, not a reconnect)', async () => {
    const r = await rejection(403, google(403, 'PERMISSION_DENIED', 'accessNotConfigured', 'SERVICE_DISABLED'), 'drive');
    expect(r.code).toBe('provider_api_disabled');
    expect(r.message).toMatch(/Drive API is disabled/);
  });

  it('a 403 with no recognised reason → connection_forbidden; a 5xx → upstream_unavailable', async () => {
    expect((await rejection(403, { error: { code: 403 } })).code).toBe('connection_forbidden');
    expect((await rejection(503, 'Service Unavailable')).code).toBe('upstream_unavailable');
  });

  it("never echoes the provider's human text, only its machine reason identifier", async () => {
    const r = await rejection(403, google(403, 'PERMISSION_DENIED', 'insufficientPermissions'));
    expect(r.message).not.toMatch(/SECRET-ish|human text|Insufficient Permission/);
    // A "reason" that is not an identifier is dropped, not echoed.
    const junk = await rejection(403, { error: { errors: [{ reason: 'sk-ant-api-AAAA key=xyz' }] } });
    expect(junk.message).not.toMatch(/sk-ant|key=/);
  });
});

describe('2 — errorRecovery turns each code into an actionable message', () => {
  const classify = (code: string) => classifyDispatchError(new AiProviderError(code as AiProviderErrorCode, 'x'));

  it.each([
    ['connection_scope_missing', 'auth', 'reconfigure', /Reconnect it in Connections and grant/],
    ['connection_reauth_required', 'auth', 'reconfigure', /sign in again/],
    ['connection_forbidden', 'auth', 'reconfigure', /Connections/],
    ['provider_api_disabled', 'config', 'abort', /administrator/],
    ['upstream_unavailable', 'network', 'retry', /retried on the next run/],
  ])('%s → %s / %s', (code, category, action, message) => {
    const c = classify(code);
    expect(c.category).toBe(category);
    expect(c.action).toBe(action);
    expect(c.userMessage).toMatch(message);
    expect(c.userMessage).not.toMatch(/Something went wrong/);
  });
});

describe('3 — the notification is fixable, and an unattended repeat is not re-sent', () => {
  let seq = 0;
  async function failRun(
    storage: ReturnType<typeof openSqliteStorage>,
    tenantId: string,
    code: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const runId = `r-${++seq}`;
    const run: RunRecord = {
      runId, workflowId: 'assistant.loop.calendar-ingest', tenantId, status: 'failed',
      inputs: null, metadata: { workflowName: 'assistant.loop.calendar-ingest', ...metadata }, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    await emitRunFailureNotification(storage, runId, { code, userMessage: classifyDispatchError(new AiProviderError(code as AiProviderErrorCode, 'x')).userMessage });
  }
  const SCHEDULED = { schedule: { jobId: 'assistant:calendar-ingest:user:u1', source: 'schedule' } };

  it('a reconnect-class failure says so and links to Connections', async () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    await failRun(storage, 't-link', 'connection_scope_missing', SCHEDULED);
    const [n] = await storage.listNotifications({ tenantId: 't-link' });
    expect(n!.title).toBe('Connection needs attention');
    expect(n!.actionUrl).toBe('/connections');
    expect(n!.message).toMatch(/Reconnect it in Connections/);
    expect(n!.runId).toBeTruthy();
    await storage.close();
  });

  it('a scheduled run failing the SAME way again within 24 h does not notify again', async () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    for (let i = 0; i < 5; i++) await failRun(storage, 't-dedup', 'connection_scope_missing', SCHEDULED);
    expect(await storage.listNotifications({ tenantId: 't-dedup' })).toHaveLength(1);
    await storage.close();
  });

  it('a DIFFERENT error code on the same loop still notifies at once', async () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    await failRun(storage, 't-new', 'connection_scope_missing', SCHEDULED);
    await failRun(storage, 't-new', 'upstream_unavailable', SCHEDULED);
    expect(await storage.listNotifications({ tenantId: 't-new' })).toHaveLength(2);
    await storage.close();
  });

  it('a person-started run is never suppressed — they are watching it', async () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    await failRun(storage, 't-manual', 'connection_scope_missing', {});
    await failRun(storage, 't-manual', 'connection_scope_missing', {});
    expect(await storage.listNotifications({ tenantId: 't-manual' })).toHaveLength(2);
    await storage.close();
  });

  it('a non-connection failure keeps its title and its run link', async () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    await failRun(storage, 't-plain', 'upstream_unavailable', {});
    const [n] = await storage.listNotifications({ tenantId: 't-plain' });
    expect(n!.title).toBe('Workflow failed');
    expect(n!.actionUrl).toMatch(/^\/runs\//);
    await storage.close();
  });
});
