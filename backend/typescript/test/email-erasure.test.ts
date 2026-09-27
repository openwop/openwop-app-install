/**
 * EM-3 — the email feature's subject erasure actually reaches its stores.
 *
 * It used to reach ONE of them. `emailEraser`'s entire body was
 * `deleteSubjectSends` (`email:sendlog`), while the erased recipient's raw
 * lower-cased address survived in `email:engagement-token` — whose
 * `unsubscribe`/`preferences` kinds are EXPLICITLY excluded from the retention
 * purger, i.e. kept forever — and in `email:soft-bounce-count`, which had no
 * eraser, no purger and no age-out at all. `email:engagement` was likewise
 * unreached. Because `SubjectEraser` returns `void`, `eraseSubject` reported
 * `{failed: 0}` and consent wrote `erasure_complete`: success rendered over data
 * that was still there.
 *
 * These assertions are on the STORES, through the public read paths, not on the
 * eraser's own return value — an eraser that says it removed things is exactly
 * the claim under test. Each case seeds through the real write path, runs the
 * real host fan-out (`eraseSubject`, not the private handler), and then asserts
 * the data is gone.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import {
  instrumentBody, mintToken, recordUnsubscribe, listEngagement, resolveUnsubscribeToken,
  resolvePreferencesToken, __clearEngagement,
} from '../src/features/email/engagementService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __clearEngagement(); });

const T = 'user:email-erasure';

describe('EM-3 — erasure reaches email:engagement-token', () => {
  it('removes the unsubscribe + preferences tokens carrying the raw address', async () => {
    const mint = { tenantId: T, campaignId: 'cmp-e1', contactId: 'ct-e1', email: 'erase-me@example.com' };
    const body = await instrumentBody('See https://example.test/a', BASE, mint);
    const unsub = /public-email\/u\/([^\s]+)/.exec(body)?.[1];
    const prefs = /public-email\/p\/([^\s]+)/.exec(body)?.[1];
    expect(unsub, 'the send path must mint an unsubscribe token').toBeTruthy();
    expect(prefs, 'the send path must mint a preferences token').toBeTruthy();

    // Pre-condition: both resolve. These are the rows the purger deliberately
    // keeps FOREVER, so erasure is the only thing that can ever remove them.
    expect(await resolveUnsubscribeToken(decodeURIComponent(unsub!))).not.toBeNull();
    expect(await resolvePreferencesToken(decodeURIComponent(prefs!))).not.toBeNull();

    const out = await eraseSubject(T, 'ct-e1');
    expect(out.failed, 'the fan-out must not report a failure').toBe(0);

    expect(await resolveUnsubscribeToken(decodeURIComponent(unsub!))).toBeNull();
    expect(await resolvePreferencesToken(decodeURIComponent(prefs!))).toBeNull();
  });

  it('reaches the tokens from an EMAIL-shaped subject key too', async () => {
    // The fan-out delivers whichever identity space the DSAR arrived through.
    const mint = { tenantId: T, campaignId: 'cmp-e2', contactId: 'ct-e2', email: 'by-address@example.com' };
    const body = await instrumentBody('x', BASE, mint);
    const unsub = /public-email\/u\/([^\s]+)/.exec(body)?.[1];
    expect(await resolveUnsubscribeToken(decodeURIComponent(unsub!))).not.toBeNull();

    await eraseSubject(T, 'by-address@example.com');
    expect(await resolveUnsubscribeToken(decodeURIComponent(unsub!))).toBeNull();
  });

  it('leaves ANOTHER subject\'s tokens alone — erasure must not over-reach', async () => {
    const mine = await instrumentBody('x', BASE, { tenantId: T, campaignId: 'c', contactId: 'ct-mine', email: 'mine@example.com' });
    const other = await instrumentBody('x', BASE, { tenantId: T, campaignId: 'c', contactId: 'ct-other', email: 'other@example.com' });
    const mineTok = /public-email\/u\/([^\s]+)/.exec(mine)?.[1];
    const otherTok = /public-email\/u\/([^\s]+)/.exec(other)?.[1];

    await eraseSubject(T, 'ct-mine');
    expect(await resolveUnsubscribeToken(decodeURIComponent(mineTok!))).toBeNull();
    expect(await resolveUnsubscribeToken(decodeURIComponent(otherTok!)), 'a different subject must survive').not.toBeNull();
  });

  it('leaves ANOTHER tenant\'s tokens alone', async () => {
    const other = 'user:email-erasure-2';
    const tok = await mintToken({ tenantId: other, campaignId: 'c', contactId: 'ct-x', kind: 'unsubscribe', email: 'x@example.com' });
    await eraseSubject(T, 'ct-x');
    expect(await resolveUnsubscribeToken(tok), 'cross-tenant erasure is the worst possible over-reach').not.toBeNull();
  });
});

describe('EM-3 — erasure reaches email:engagement', () => {
  it('removes the engagement rows for the erased contact only', async () => {
    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-e3', contactId: 'ct-e3', kind: 'unsubscribe', email: 'e3@example.com' });
    const tok2 = await mintToken({ tenantId: T, campaignId: 'cmp-e3', contactId: 'ct-keep', kind: 'unsubscribe', email: 'keep@example.com' });
    expect((await recordUnsubscribe(tok)).status).toBe('revoked');
    expect((await recordUnsubscribe(tok2)).status).toBe('revoked');
    expect(await listEngagement(T, 'cmp-e3')).toHaveLength(2);

    await eraseSubject(T, 'ct-e3');
    const left = await listEngagement(T, 'cmp-e3');
    expect(left.map((e) => e.contactId)).toEqual(['ct-keep']);
  });
});

describe('EM-3 — erasure reaches email:soft-bounce-count', () => {
  it('removes the address-keyed streak row', async () => {
    // Seeded through the module's own store shape via a direct import of the
    // eraser's counterpart: the bounce ingest path needs a signed provider
    // webhook, so the row is written through the same collection the eraser
    // reads. (A no-op here would be indistinguishable from success, so the
    // pre-condition below asserts the seed landed.)
    const { __seedSoftBounceForTest, __readSoftBounceForTest } = await import('../src/features/email/bounceWebhooks.js');
    await __seedSoftBounceForTest(T, 'bouncy@example.com', 3);
    expect(await __readSoftBounceForTest(T, 'bouncy@example.com'), 'the seed must land or the assertion is vacuous').toBe(3);

    await eraseSubject(T, 'bouncy@example.com');
    expect(await __readSoftBounceForTest(T, 'bouncy@example.com')).toBeNull();
  });

  it('leaves another address alone', async () => {
    const { __seedSoftBounceForTest, __readSoftBounceForTest } = await import('../src/features/email/bounceWebhooks.js');
    await __seedSoftBounceForTest(T, 'a@example.com', 1);
    await __seedSoftBounceForTest(T, 'b@example.com', 2);
    await eraseSubject(T, 'a@example.com');
    expect(await __readSoftBounceForTest(T, 'a@example.com')).toBeNull();
    expect(await __readSoftBounceForTest(T, 'b@example.com')).toBe(2);
  });
});
