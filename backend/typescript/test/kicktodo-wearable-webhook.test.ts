/**
 * ADR 0462 Phase 2 — the wearable provider webhook ingress. Mock-tested (a real
 * provider webhook + creds don't exist here — externally-blocked, gated-off). Pins
 * the fail-closed SECURITY pipeline: verify-signature-first, token→tenant resolution,
 * link resolution, consent, and the honesty gate.
 */
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { grantConsent, revokeConsent, putWearableRule } from '../src/features/kicktodo-integrations/integrationService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll } from '../src/features/kicktodo-core/enrollmentService.js';
import { listCheckIns } from '../src/features/kicktodo-core/todayService.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { linkWearableProvider, __resetWearableLinks } from '../src/features/kicktodo-integrations/wearableLinkService.js';
import { registerWearableAdapter, __resetWearableAdapters, type WearablePush } from '../src/features/kicktodo-integrations/wearableProviderAdapter.js';
import {
  registerWearableWebhook,
  revokeWearableWebhook,
  ingestWearableWebhook,
  WebhookDeniedError,
  WebhookUnauthorizedError,
  __resetWearableWebhooks,
} from '../src/features/kicktodo-integrations/wearableWebhookService.js';

let appServer: http.Server;
const T = 'default';
const SECRET = 'provider-signing-secret';

/** A fake provider adapter: HMAC-SHA256 over the raw body, `userId` from the payload,
 *  `readings[]` normalized to metric/value. */
const fakeAdapter = {
  verify: (secret: string, push: WearablePush): boolean => {
    const expected = createHmac('sha256', secret).update(push.rawBody).digest('hex');
    const got = String(push.headers['x-kt-sig'] ?? '');
    const a = Buffer.from(expected); const b = Buffer.from(got);
    return a.length === b.length && timingSafeEqual(a, b);
  },
  extractProviderUserId: (p: unknown): string | null => (p as { userId?: string })?.userId ?? null,
  normalize: (p: unknown): Array<{ metric: string; value: number }> =>
    ((p as { readings?: Array<{ metric: string; value: number }> })?.readings ?? []),
};
const sign = (body: unknown): WearablePush => {
  const rawBody = JSON.stringify(body);
  return { payload: body, rawBody, headers: { 'x-kt-sig': createHmac('sha256', SECRET).update(rawBody).digest('hex') } };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { appServer = app.listen(0, '127.0.0.1', () => r()); });
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  const d = getToggleDefault('kicktodo-integrations');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  // The tenant's provider signing secret rides a tenant-scoped Connection.
  await createSecretConnection({ tenantId: T, provider: 'google', kind: 'bearer', secret: SECRET, scope: 'workspace' });
});
afterAll(async () => { await new Promise<void>((r) => appServer.close(() => r())); });
afterEach(async () => {
  await __resetWearableWebhooks(); await __resetWearableLinks(); __resetWearableAdapters();
  delete process.env.OPENWOP_WEARABLE_PROVIDER_ENABLED;
});

/** Each case gets its OWN subject + provider account, so no case's enrollment,
 *  rule or consent leaks into another's ingest count (shuffle-safe). */
let seq = 0;
interface Live { token: string; subject: string; providerUserId: string; enrollmentId: string }

/** Live pipeline: adapter + webhook token, and a consented subject with an ACTIVE
 *  enrollment whose day-1 action carries a `steps ≥ 5000` wearable rule — so a valid
 *  push that reaches the kernel converts exactly ONE check-in (`ingested: 1`). */
async function setupLive(fixed?: { subject: string; providerUserId: string }): Promise<Live> {
  seq += 1;
  const subject = fixed?.subject ?? `user:ww-owner-${seq}`;
  const providerUserId = fixed?.providerUserId ?? `prov-user-${seq}`;
  process.env.OPENWOP_WEARABLE_PROVIDER_ENABLED = 'true';
  registerWearableAdapter('google', fakeAdapter); // 'google' is a built-in provider (for the Connection)
  const token = await registerWearableWebhook(T, 'google');
  await grantConsent(T, subject, 'wearable-evidence');
  await linkWearableProvider(T, subject, 'google', providerUserId);
  const draft = await createDraft({
    tenantId: T, title: `Walk ${seq}`, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Walk', instructions: 'i', evidencePolicy: 'measurement' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: subject, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  await putWearableRule(T, subject, { enrollmentId: enrollment.id, stableActivityId: 'a1', metric: 'steps', threshold: 5000 });
  return { token, subject, providerUserId, enrollmentId: enrollment.id };
}

describe('ADR 0462 P2 — wearable webhook (fail-closed pipeline)', () => {
  it('is honest-off: no registration when the provider adapter is unconfigured', async () => {
    await expect(registerWearableWebhook(T, 'google')).rejects.toThrow(WebhookDeniedError);
  });

  it('rejects a BAD signature with 401 (verify runs first) — never reaches ingest', async () => {
    const { token, providerUserId } = await setupLive();
    const bad: WearablePush = { payload: { userId: providerUserId, readings: [{ metric: 'steps', value: 9000 }] }, rawBody: '{}', headers: { 'x-kt-sig': 'deadbeef' } };
    await expect(ingestWearableWebhook(token, bad)).rejects.toThrow(WebhookUnauthorizedError);
  });

  it('404s an unknown token', async () => {
    await setupLive();
    await expect(ingestWearableWebhook('ktwear_nope', sign({ userId: 'x' }))).rejects.toThrow(WebhookDeniedError);
  });

  it('a VALID signed push for a linked+consented subject runs the pipeline to the kernel', async () => {
    const { token, providerUserId } = await setupLive();
    const out = await ingestWearableWebhook(token, sign({ userId: providerUserId, readings: [{ metric: 'steps', value: 9000 }] }));
    // Reached ingest: the rule converted today's walk into exactly one check-in.
    expect(out).toEqual({ ingested: 1 });
  });

  it('a valid push for an UNLINKED provider account is a silent 0 (no leak, no work)', async () => {
    // A linked, consented subject WITH a matching rule exists alongside the unknown
    // account (a fixed id, so a resolver that falls back to some subject would land
    // on one that converts) — the unlinked push must reach nobody.
    const { token, enrollmentId, providerUserId } = await setupLive({ subject: 'user:ww-ruled', providerUserId: 'prov-ruled' });
    const out = await ingestWearableWebhook(token, sign({ userId: 'unknown-account', readings: [{ metric: 'steps', value: 9000 }] }));
    expect(out).toEqual({ ingested: 0 });
    expect(await listCheckIns(T, enrollmentId)).toEqual([]); // the ruled subject got nothing
    // Positive control: the SAME push for the linked account converts, and lands.
    expect(await ingestWearableWebhook(token, sign({ userId: providerUserId, readings: [{ metric: 'steps', value: 9000 }] }))).toEqual({ ingested: 1 });
    expect(await listCheckIns(T, enrollmentId)).toHaveLength(1);
  });

  it('a valid push for a subject whose wearable-evidence consent was REVOKED is a silent 0', async () => {
    const { token, subject, providerUserId } = await setupLive();
    await revokeConsent(T, subject, 'wearable-evidence');
    const out = await ingestWearableWebhook(token, sign({ userId: providerUserId, readings: [{ metric: 'steps', value: 9000 }] }));
    expect(out).toEqual({ ingested: 0 });
    // Positive control: re-consent and the same push converts.
    await grantConsent(T, subject, 'wearable-evidence');
    expect(await ingestWearableWebhook(token, sign({ userId: providerUserId, readings: [{ metric: 'steps', value: 9000 }] }))).toEqual({ ingested: 1 });
  });

  it('grade-data 0462-D1 — revoke invalidates the token (404 thereafter)', async () => {
    const { token, providerUserId } = await setupLive();
    await revokeWearableWebhook(T, 'google');
    await expect(ingestWearableWebhook(token, sign({ userId: providerUserId, readings: [] }))).rejects.toThrow(WebhookDeniedError);
  });

  it('grade-data 0462-D1 — re-registration ROTATES: the old token 404s, only the new one works', async () => {
    const { token: oldToken, providerUserId } = await setupLive();
    const newToken = await registerWearableWebhook(T, 'google'); // rotate
    await expect(ingestWearableWebhook(oldToken, sign({ userId: providerUserId, readings: [] }))).rejects.toThrow(WebhookDeniedError);
    // the new token is live (reaches the pipeline — an empty reading list ingests nothing)
    expect(await ingestWearableWebhook(newToken, sign({ userId: providerUserId, readings: [] }))).toEqual({ ingested: 0 });
  });
});
