/** ADR 0954 P3 recovery: real SQLite CAS preserves partial settings and
 * stages recipient/editor attribution before publication across erasure.
 *
 * Refusal reasons are asserted, not just 409: an erasure that lands before the
 * stage is refused by the publish-time tombstone read (`sla_settings_subject_erased`);
 * one that lands during publication disables the staged row, so the publish CAS
 * loses (`sla_settings_conflict`).
 *
 * Sabotage-witnessed (w74 probes sls-*): a blind stage CAS; dropping the
 * field merge from the saved row; inverting the staged-digest check; skipping
 * the publish-time tombstone read; staging a NEW agency lead before its
 * tombstone read; erasure not disabling a staged publication; reading a
 * pending/disabled row as settings; erasure keeping the editor attribution. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSlaSettingsSubjects, getSlaSettings, saveSlaSettings } from '../src/features/crm/leadIntel/speedToLead.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';

const tenantId = 'sla-settings-recovery'; const orgId = 'client';
const primary = `hostext:crm:lead-sla-settings:${tenantId}::${orgId}`;
let storage: Storage; let directory: string; let database: string;
async function reopen(): Promise<void> { await storage.close(); storage = openSqliteStorage(database); initHostExtPersistence(storage); }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'owp-sla-settings-')); database = join(directory, 'state.sqlite'); storage = openSqliteStorage(database); initHostExtPersistence(storage); });
afterEach(async () => { vi.restoreAllMocks(); await storage.close(); __resetHostExtPersistence(); rmSync(directory, { recursive: true }); });

describe('lead SLA settings primary', () => {
  it('retries a stale partial update against the winner without dropping another field', async () => {
    await saveSlaSettings(tenantId, orgId, { timezone: 'UTC', agencyLead: 'agency-lead' }, 'operator');
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next);
      if (!crossed && key === primary && row.publicationPending && row.timezone === 'America/New_York') {
        crossed = true; await saveSlaSettings(tenantId, orgId, { escalation: 'reroute' }, 'second-editor');
      }
      return cas(key, expected, next);
    });
    await saveSlaSettings(tenantId, orgId, { timezone: 'America/New_York' }, 'first-editor');
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await getSlaSettings(tenantId, orgId)).toMatchObject({ escalation: 'reroute', timezone: 'America/New_York', agencyLead: 'agency-lead', updatedBy: 'first-editor' });
  });

  it('reconciles the same partial save after a lost stage acknowledgement and restart', async () => {
    await saveSlaSettings(tenantId, orgId, { agencyLead: 'retained-lead', timezone: 'UTC' }, 'operator');
    const cas = storage.kvCompareAndSwap.bind(storage); let lost = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const applied = await cas(key, expected, next);
      if (!lost && applied && key === primary && JSON.parse(next).publicationPending) { lost = true; throw new Error('stage acknowledgement lost'); }
      return applied;
    });
    await expect(saveSlaSettings(tenantId, orgId, { escalation: 'reroute' }, 'editor')).rejects.toThrow('stage acknowledgement lost');
    expect(lost).toBe(true); vi.restoreAllMocks(); await reopen();
    await expect(getSlaSettings(tenantId, orgId)).rejects.toMatchObject({ details: { reason: 'sla_settings_pending' } });
    expect(await saveSlaSettings(tenantId, orgId, { escalation: 'reroute' }, 'editor')).toMatchObject({ escalation: 'reroute', agencyLead: 'retained-lead', timezone: 'UTC' });
  });

  it.each(['stage', 'publication'] as const)('a recipient erased across the %s CAS cannot be republished', async (phase) => {
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next);
      if (!crossed && key === primary && (phase === 'stage' ? row.publicationPending : row.agencyLead === 'erased-lead')) {
        crossed = true; await eraseSlaSettingsSubjects(tenantId, 'erased-lead');
      }
      return cas(key, expected, next);
    });
    await expect(saveSlaSettings(tenantId, orgId, { agencyLead: 'erased-lead' }, 'operator')).rejects.toMatchObject({
      httpStatus: 409, details: { reason: phase === 'stage' ? 'sla_settings_subject_erased' : 'sla_settings_conflict' },
    });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    const raw = await storage.kvGet(primary); expect(raw).toBeTruthy(); expect(JSON.parse(raw!).agencyLead).toBeUndefined();
    await expect(getSlaSettings(tenantId, orgId)).rejects.toMatchObject({ details: { reason: 'sla_settings_pending' } });
  });

  it('clears erased editor and recipient attribution in the committed settings', async () => {
    await saveSlaSettings(tenantId, orgId, { agencyLead: 'person', timezone: 'UTC' }, 'person');
    await eraseSlaSettingsSubjects(tenantId, 'person'); await reopen();
    const row = await getSlaSettings(tenantId, orgId);
    expect(row?.agencyLead).toBeUndefined(); expect(row?.updatedBy).toBe(ERASED); expect(row?.timezone).toBe('UTC');
    await expect(saveSlaSettings(tenantId, orgId, { agencyLead: 'person' }, 'operator')).rejects.toMatchObject({ details: { reason: 'sla_settings_subject_erased' } });
  });
});
