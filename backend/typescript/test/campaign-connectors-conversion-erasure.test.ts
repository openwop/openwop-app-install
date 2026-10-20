/**
 * ADR 0907 D8 — a data-subject erasure reaches the conversions relay queue.
 *
 * Driven through the real `eraseSubject` fan-out after a real `createApp` boot,
 * so a registration that is never wired (the WF-CONS-2 shape) fails here too,
 * not only in the manifest pin.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { eraseSubject, registeredSubjectEraserIds } from '../src/host/subjectErasure.js';
import {
  relayConversion, listConversions, hashEmail, deleteSubjectConversions, __resetPixels,
} from '../src/features/campaign-connectors/pixelService.js';

const T = 'erase-t';
const ORG = 'erase-org';

describe('ADR 0907 D8 — conversions relay subject erasure', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 18993, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });
  beforeEach(async () => { await __resetPixels(); });

  const seed = async () => {
    await relayConversion(T, ORG, { eventId: 'a', eventName: 'purchase', email: 'Ann@X.test', visitor: 'vk-ann' });
    await relayConversion(T, ORG, { eventId: 'b', eventName: 'lead', visitor: 'vk-ann' });
    await relayConversion(T, ORG, { eventId: 'c', eventName: 'purchase', email: 'bob@x.test', visitor: 'vk-bob' });
    await relayConversion('other-t', ORG, { eventId: 'd', eventName: 'purchase', email: 'ann@x.test', visitor: 'vk-ann' });
  };
  const ids = async (t: string) => (await listConversions(t, ORG)).map((c) => c.eventId).sort();

  it('a booted app registers the eraser', () => {
    expect(registeredSubjectEraserIds()).toContain('eraseCampaignConversions');
  });

  it('erasing by consent visitor key removes that visitor\'s rows only, in that tenant only', async () => {
    await seed();
    const out = await eraseSubject(T, 'vk-ann');
    expect(out.failed).toBe(0);
    expect(await ids(T)).toEqual(['c']);
    expect(await ids('other-t')).toEqual(['d']); // tenant isolation
  });

  it('erasing by email reaches the hashed row (case-folded), and by the hash itself', async () => {
    await seed();
    expect(await deleteSubjectConversions(T, 'ann@x.test')).toEqual({ removed: 1, failed: 0 });
    expect(await ids(T)).toEqual(['b', 'c']);
    expect(await deleteSubjectConversions(T, hashEmail('bob@x.test'))).toEqual({ removed: 1, failed: 0 });
    expect(await ids(T)).toEqual(['b']);
  });

  it('ADR 0907 D6: a phone-keyed erasure reaches the hashed phone (either E.164 spelling)', async () => {
    await relayConversion(T, ORG, { eventId: 'p1', eventName: 'lead', phone: '+1 555 123 4567' });
    await relayConversion(T, ORG, { eventId: 'p2', eventName: 'lead', phone: '+44 20 7946 0958' });
    expect(await deleteSubjectConversions(T, '+15551234567')).toEqual({ removed: 1, failed: 0 });
    expect(await deleteSubjectConversions(T, '0044 20 7946 0958')).toEqual({ removed: 1, failed: 0 });
    expect(await ids(T)).toEqual([]);
  });

  it('never matches on a substring or an unrelated key', async () => {
    await seed();
    expect(await deleteSubjectConversions(T, 'vk-')).toEqual({ removed: 0, failed: 0 });
    expect(await deleteSubjectConversions(T, 'ann')).toEqual({ removed: 0, failed: 0 });
    expect(await ids(T)).toEqual(['a', 'b', 'c']);
  });
});
