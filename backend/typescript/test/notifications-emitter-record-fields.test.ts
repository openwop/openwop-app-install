/**
 * `emitter.buildRecord` must carry EVERY targeting field `NotificationRecord`
 * declares — asserted against the REAL emitter, with no mock.
 *
 * WHY A SEPARATE FILE. `notifications-node-surface.test.ts` mocks
 * `getNotificationEmitter`, so it can only prove what the SURFACE passes to
 * `signal()` — it cannot see what `buildRecord` does with it. That gap was real:
 * `recipientRole` was declared on the record (ADR 0050 Phase 3), persisted by the
 * storage adapters, and filtered by the read path (default-deny — a member lacking
 * the role does not see it), but silently DROPPED in `buildRecord`. Re-introducing
 * that bug left all 12 mocked tests green.
 *
 * A record with neither `recipientUserId` nor `recipientRole` is a TENANT-WIDE
 * BROADCAST, so dropping the field inverts default-deny into everyone-sees-it.
 * Nothing wrote it before, so no live data was affected — but the first caller to
 * use role targeting would have leaked to the whole tenant.
 *
 * `signal()` is transient (no insert, no web-push) and RETURNS the built record,
 * so this needs no storage backend.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { getNotificationEmitter, setNotificationBackend } from '../src/notifications/emitter.js';
import { openStorage } from '../src/storage/index.js';

// `signal()` is transient — it never inserts — but `getNotificationEmitter()`
// refuses without a backend installed, so give it a real in-memory one. Using the
// REAL emitter is the whole point of this file.
beforeAll(async () => {
  setNotificationBackend(await openStorage('memory://'));
});

describe('buildRecord carries every declared targeting field', () => {
  it('recipientRole survives — the field the mocked suite could not see', () => {
    const rec = getNotificationEmitter().signal({
      tenantId: 'user:t1',
      recipientRole: 'admin',
      type: 'workflow.notice',
      priority: 'normal',
      title: 'Quota at 90%',
      message: '',
    });
    expect(rec.recipientRole, 'dropping this makes a role-addressed notice a tenant-wide broadcast').toBe('admin');
  });

  it('recipientUserId survives', () => {
    const rec = getNotificationEmitter().signal({
      tenantId: 'user:t1',
      recipientUserId: 'u-42',
      type: 'workflow.notice',
      priority: 'normal',
      title: 'Yours',
      message: '',
    });
    expect(rec.recipientUserId).toBe('u-42');
  });

  it('an unaddressed record is a broadcast — both targeting fields absent', () => {
    const rec = getNotificationEmitter().signal({
      tenantId: 'user:t1',
      type: 'workflow.notice',
      priority: 'normal',
      title: 'Everyone',
      message: '',
    });
    expect(rec.recipientUserId).toBeUndefined();
    expect(rec.recipientRole).toBeUndefined();
  });

  /**
   * The structural guard. `buildRecord`'s own docblock calls it the "single source
   * of truth ... keeps `emit` and `signal` from drifting if `NotificationRecord`
   * gains a field" — and then it drifted. This asserts the claim mechanically:
   * every optional targeting-ish field on the type must be copied through.
   */
  it('no declared targeting field is silently dropped', () => {
    const rec = getNotificationEmitter().signal({
      tenantId: 'user:t1',
      recipientUserId: 'u-1',
      recipientRole: 'owner',
      type: 't',
      priority: 'high',
      title: 'T',
      message: 'M',
      runId: 'run-9',
      workflowId: 'wf-9',
      nodeId: 'n-9',
      actionUrl: '/x',
      metadata: { k: 'v' },
    });
    for (const [field, expected] of Object.entries({
      recipientUserId: 'u-1',
      recipientRole: 'owner',
      runId: 'run-9',
      workflowId: 'wf-9',
      nodeId: 'n-9',
      actionUrl: '/x',
    })) {
      expect((rec as unknown as Record<string, unknown>)[field], `buildRecord dropped \`${field}\``).toBe(expected);
    }
    expect(rec.metadata).toEqual({ k: 'v' });
  });
});
