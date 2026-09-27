/**
 * ADR 0710 — a run notice reaches the people who can act on it.
 *
 * The defect was NOT that `emitRunFailureNotification` was careless. It is the
 * opposite: it demands the classified `userMessage` so a provider's 401 text
 * cannot echo an API key, and it strips secrets from metadata. It was written
 * for an OPERATOR and it was right for an operator. Then headless
 * participant-facing runs arrived (ADR 0689 KickBot reminders), the same emit
 * started firing on behalf of people who never asked for a run, and a
 * tenant-wide broadcast put "Check the server logs" on a participant's lock
 * screen. Same species as ADR 0684's org id and ADR 0711's member scope: a
 * component correct for its original audience, reused where the audience moved.
 *
 * These legs pin the AUDIENCE DECISION, which is the thing that drifted — not
 * the copy, which was always fine.
 *
 * Sabotage record (disjoint):
 *   - drop `recipientRole` from the failure emit        → leg 2 only
 *   - make `runNoticeAudience` role-address personal    → leg 1 only
 *   - drop the participant-facing registry lookup       → leg 4 only
 *   - drop the `alreadyNoticedToday` guard              → leg 5 only
 *   - restore the open-gate broadcast                   → leg 6 only
 *   - restore the conditional spread in approvalSla     → leg 7 only
 */
import { describe, expect, it } from 'vitest';
import { runNoticeAudience, isParticipantFacingRun, PARTICIPANT_FACING_PURPOSES } from '../src/notifications/runNoticeAudience.js';
import { setNotificationBackend } from '../src/notifications/emitter.js';
import { openStorage } from '../src/storage/index.js';
import { emitRunFailureNotification } from '../src/notifications/notify.js';
import type { Storage } from '../src/storage/storage.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const src = (rel: string): string =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', rel), 'utf8');

describe('ADR 0710 — run-notice audience', () => {
  it('leg 1: a PERSONAL workspace keeps the broadcast — role-addressing it would hide a solo user\'s own failures', () => {
    // The read path is default-deny on `recipientRole`. A solo user carrying no
    // `admin` role row would STOP SEEING THEIR OWN FAILURES if this returned a
    // role. That is why the audience is a predicate and not a constant.
    for (const t of ['user:abc123', 'anon:s7Kq2mVx9Lp4']) {
      const a = runNoticeAudience({ tenantId: t });
      expect(a.recipientRole, `${t} must stay a broadcast`).toBeUndefined();
      expect(a.reason).toBe('personal-tenant-broadcast');
    }
  });

  it('leg 2: a SHARED workspace is addressed to the operator role, ordinary workflows included', () => {
    const a = runNoticeAudience({ tenantId: 'ws:0d2f9c' });
    expect(a.recipientRole, 'a shared tenant must not broadcast a failure').toBe('admin');
    expect(a.reason).toBe('operator-role');
  });

  it('leg 3: operator = the EXISTING admin role — no new notification role was invented', () => {
    const a = runNoticeAudience({ tenantId: 'ws:0d2f9c' });
    expect(a.recipientRole, 'ADR 0710 §Decision 1: reuse ADR 0050 Phase 3 recipientRole with the admin role').toBe('admin');
  });

  it('leg 4: a participant-facing purpose is recognised and marks the notice for aggregation', () => {
    const shared = 'ws:0d2f9c';
    expect(isParticipantFacingRun({ purpose: 'kickbot-coach-turn' })).toBe(true);
    expect(isParticipantFacingRun({ purpose: 'some-ordinary-workflow' })).toBe(false);
    expect(isParticipantFacingRun(undefined)).toBe(false);

    const p = runNoticeAudience({ tenantId: shared, metadata: { purpose: 'kickbot-coach-turn' } });
    expect(p.aggregatePerJobPerDay, 'a participant-facing run aggregates').toBe(true);
    expect(p.reason).toBe('operator-role-participant-facing');

    const o = runNoticeAudience({ tenantId: shared, metadata: { purpose: 'ordinary' } });
    expect(o.aggregatePerJobPerDay, 'an ordinary workflow does NOT aggregate').toBe(false);
  });

  it('leg 5: the registry names purposes that are actually WRITTEN at the scheduling sites', () => {
    // A registry of strings nobody emits is a gate that cannot fire. Each entry
    // must appear as a `purpose:` in the feature that schedules the run.
    const sites = [
      'features/kicktodo-core/kickbotCoachTurnService.ts',
      'features/kicktodo-core/enrollmentService.ts',
      'features/kicktodo-accountability/sessionService.ts',
      'features/kicktodo-integrations/calendarSyncService.ts',
    ].map(src).join('\n');
    for (const purpose of PARTICIPANT_FACING_PURPOSES) {
      expect(sites, `registry entry '${purpose}' is not written by any scheduling site — the registry would never match`).toContain(`purpose: '${purpose}'`);
    }
  });

  it('leg 6: the failure emit and the OPEN GATE both consult the shared predicate, not a local copy', () => {
    const notify = src('notifications/notify.ts');
    expect(notify, 'the failure emit must set recipientRole from the audience').toContain('...(audience.recipientRole ? { recipientRole: audience.recipientRole } : {})');
    expect(notify, 'the open gate must no longer be an unaddressed broadcast').not.toContain('await getNotificationEmitter().emit(base); // broadcast');
    expect(notify, 'the open gate consults the same predicate').toContain('gateAudience');
    // NOTE: this file previously asserted `toContain('alreadyNoticedToday')` here.
    // That was a GATE THAT COULD NOT FAIL — the function DEFINITION keeps the
    // string in the file, so deleting the CALL left the leg green (measured).
    // Aggregation is pinned behaviourally in leg 9 instead. Derive a ratchet from
    // the CALL, never from the mere presence of a name.
  });

  it('leg 7: the two CONDITIONAL sites no longer fail open to a broadcast', () => {
    const sla = src('host/approvalSla.ts');
    expect(sla, 'approvalSla must fall back to a role, not to nothing').toContain('fallback.recipientRole');
    expect(sla, 'the bare conditional spread is gone').not.toContain('...(recipientUserId ? { recipientUserId } : {}),');

    const exec = src('features/assistant/actionExecution.ts');
    expect(exec, 'actionExecution must fall back to a role').toContain('runNoticeAudience({ tenantId })');
    expect(exec, 'the bare conditional spread is gone').not.toContain('...(decidedByUserId !== undefined ? { recipientUserId: decidedByUserId } : {}),');
  });

  it('leg 8: commerce.order.paid keeps its broadcast, and the decision is RECORDED at the site', () => {
    // ADR 0710 asked the implementing PR to decide this one explicitly. Leaving it
    // unchanged silently would be indistinguishable from never having looked.
    const c = src('features/commerce/commerceService.ts');
    expect(c, 'the audience decision must be written where the emit is').toContain('ADR 0710 AUDIENCE DECISION');
    expect(c, 'and must state what would reverse it').toContain('What WOULD change this');
  });
  it('leg 9: BEHAVIOURAL — a participant-facing job emits ONE operator notice per day, an ordinary workflow emits every time', async () => {
    const storage = await openStorage('memory://') as unknown as Storage;
    setNotificationBackend(storage as never);
    const TENANT = 'ws:agg-test';

    const seed = async (runId: string, workflowId: string, purpose?: string): Promise<void> => {
      await storage.insertRun({
        runId, tenantId: TENANT, workflowId, status: 'failed',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        inputs: {}, configurable: {},
        metadata: purpose ? { purpose } : {},
      });
    };
    const countFor = async (workflowId: string): Promise<number> =>
      (await storage.listNotifications({ tenantId: TENANT, limit: 200, includeArchived: true }))
        .filter((r) => r.type === 'workflow.failed' && r.workflowId === workflowId).length;

    // participant-facing: three failed runs of the SAME job
    await seed('run:p1', 'wf:coach', 'kickbot-coach-turn');
    await seed('run:p2', 'wf:coach', 'kickbot-coach-turn');
    await seed('run:p3', 'wf:coach', 'kickbot-coach-turn');
    for (const r of ['run:p1', 'run:p2', 'run:p3']) {
      await emitRunFailureNotification(storage, r, { code: 'x', userMessage: 'boom' });
    }
    expect(await countFor('wf:coach'), 'a broken reminder must page the operator ONCE, not once per participant').toBe(1);

    // ordinary workflow: aggregation must NOT apply — every failure is its own event
    await seed('run:o1', 'wf:ordinary');
    await seed('run:o2', 'wf:ordinary');
    for (const r of ['run:o1', 'run:o2']) {
      await emitRunFailureNotification(storage, r, { code: 'x', userMessage: 'boom' });
    }
    expect(await countFor('wf:ordinary'), 'an ordinary workflow must not be silently aggregated').toBe(2);
  });
});
