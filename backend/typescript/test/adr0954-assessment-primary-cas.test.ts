/** P4 recovery: actual SQLite boundaries must retain uncertain commits and
 * prevent erased or superseded qualification content from being republished. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { bindLead, closeLeadBinding, freezeQualificationRead, commitLeadStatedSubmission, getQualificationRead, getLeadBindingId, getLeadGrade, readLeadAssessments, readLeadStatedSubmissions, stampPendingGrade, type GradeReservationPin } from '../src/features/crm/leadIntel/leadStore.js';
import { readLeadEvidence } from '../src/features/crm/leadIntel/evidence.js';
import { recordAssessment } from '../src/features/crm/leadIntel/assessment.js';

const tenantId = 'qualification-primary'; const orgId = 'client';
let storage: Storage; let directory: string; let database: string; let contactId: string; let pin: GradeReservationPin;
const gradeKey = () => `hostext:crm:lead-grade:${tenantId}::${orgId}::${contactId}`;
const ownerKey = () => `hostext:crm:lead-profile-of:${tenantId}::${contactId}`;
const assessment = () => ({ tenantId, orgId, contactId, runId: 'run-1', modelId: 'qualified', modelVersion: 1, modelHash: pin.modelHash,
  answers: [{ criterionId: 'budget', value: 'large', confidence: 0.8, evidence: [{ kind: 'contact-field' as const, ref: 'contact:source' }] }],
  summary: 'Sensitive qualification claim', bandAdjustment: 0 as const });
async function reopen(): Promise<void> { await storage.close(); storage = openSqliteStorage(database); initHostExtPersistence(storage); }
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'owp-assessment-primary-')); database = join(directory, 'state.sqlite');
  storage = openSqliteStorage(database); initHostExtPersistence(storage);
  contactId = (await createContact({ tenantId, name: 'Lead', company: 'Private qualification company', email: 'lead@example.test', silent: true })).contactId;
  await bindLead({ tenantId, orgId, contactId, source: 'manual', boundBy: 'operator' });
  pin = { bindingId: await getLeadBindingId(tenantId, orgId, contactId), qualification: true, modelId: 'qualified', modelVersion: 1, modelHash: '1'.repeat(64), definitionHash: '2'.repeat(64), requesterHash: 'operator-hash' };
  await stampPendingGrade(tenantId, orgId, contactId, 'run-1', pin);
  await freezeQualificationRead(tenantId, orgId, contactId, 'run-1', pin, (await readLeadEvidence(tenantId, orgId, contactId))!);
});
afterEach(async () => { vi.restoreAllMocks(); await storage.close(); __resetHostExtPersistence(); rmSync(directory, { recursive: true }); });

describe('qualification primary ownership', () => {
  it('reconciles a frozen evidence read after lost acknowledgement and restart', async () => {
    await stampPendingGrade(tenantId, orgId, contactId, 'run-2', pin);
    const evidence = (await readLeadEvidence(tenantId, orgId, contactId))!;
    const cas = storage.kvCompareAndSwap.bind(storage); let lost = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const applied = await cas(key, expected, next);
      if (!lost && applied && key === gradeKey() && JSON.parse(next).qualificationReads?.some((r: { runId: string }) => r.runId === 'run-2')) { lost = true; throw new Error('evidence acknowledgement lost'); }
      return applied;
    });
    await expect(freezeQualificationRead(tenantId, orgId, contactId, 'run-2', pin, evidence)).rejects.toThrow('evidence acknowledgement lost');
    expect(lost).toBe(true); vi.restoreAllMocks(); await reopen();
    const recorded = await getQualificationRead(tenantId, orgId, contactId, 'run-2');
    expect(recorded?.evidence).toEqual(evidence);
    expect(await freezeQualificationRead(tenantId, orgId, contactId, 'run-2', pin, evidence)).toEqual(recorded);
    expect(JSON.stringify(await getLeadGrade(tenantId, orgId, contactId))).not.toContain('Private qualification company');
  });

  it('erasure crossing the evidence freeze CAS removes all frozen text and defeats a late writer', async () => {
    await stampPendingGrade(tenantId, orgId, contactId, 'run-2', pin);
    const evidence = (await readLeadEvidence(tenantId, orgId, contactId))!;
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === gradeKey() && JSON.parse(next).qualificationReads?.some((r: { runId: string }) => r.runId === 'run-2')) { crossed = true; await closeLeadBinding(tenantId, contactId); }
      return cas(key, expected, next);
    });
    expect(await freezeQualificationRead(tenantId, orgId, contactId, 'run-2', pin, evidence)).toBeNull();
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await getQualificationRead(tenantId, orgId, contactId, 'run-1')).toBeNull();
    expect(await getQualificationRead(tenantId, orgId, contactId, 'run-2')).toBeNull();
    expect(await storage.kvGet(gradeKey())).not.toContain('Private qualification company');
  });

  it('reconciles a committed assessment after lost acknowledgement and restart', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage); let lost = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const applied = await cas(key, expected, next);
      if (!lost && applied && key === gradeKey() && JSON.parse(next).assessments?.length) { lost = true; throw new Error('assessment acknowledgement lost'); }
      return applied;
    });
    await expect(recordAssessment(assessment(), pin)).rejects.toThrow('assessment acknowledgement lost');
    expect(lost).toBe(true); vi.restoreAllMocks(); await reopen();
    expect((await recordAssessment(assessment(), pin)).outcome).toBe('replayed');
    expect(await readLeadAssessments(tenantId, orgId, contactId)).toHaveLength(1);
    expect(JSON.stringify(await getLeadGrade(tenantId, orgId, contactId))).not.toContain('Sensitive qualification claim');
  });

  it('erasure at the actual assessment CAS leaves no retained qualification text after restart', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === gradeKey() && JSON.parse(next).assessments?.length) { crossed = true; await closeLeadBinding(tenantId, contactId); }
      return cas(key, expected, next);
    });
    expect((await recordAssessment(assessment(), pin)).outcome).toBe('superseded');
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await readLeadAssessments(tenantId, orgId, contactId)).toEqual([]);
    expect(await storage.kvGet(gradeKey())).not.toContain('Sensitive qualification claim');
    expect((await recordAssessment(assessment(), pin)).outcome).toBe('superseded');
  });

  it('a newer pending run defeats the older assessment at the primary write', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === gradeKey() && JSON.parse(next).assessments?.length) { crossed = true; await stampPendingGrade(tenantId, orgId, contactId, 'run-2', pin); }
      return cas(key, expected, next);
    });
    expect((await recordAssessment(assessment(), pin)).outcome).toBe('superseded');
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await readLeadAssessments(tenantId, orgId, contactId)).toEqual([]);
    expect((await getLeadGrade(tenantId, orgId, contactId))?.pendingRunId).toBe('run-2');
  });

  it('separate visitor submissions survive a same-client bind without replacing one another', async () => {
    await commitLeadStatedSubmission(tenantId, contactId, { submissionId: 'visitor-one', at: '2026-10-25T01:00:00Z', answers: [{ criterionId: 'budget', value: 'small' }] });
    await commitLeadStatedSubmission(tenantId, contactId, { submissionId: 'visitor-two', at: '2026-10-25T02:00:00Z', answers: [{ criterionId: 'budget', value: 'large' }] });
    await bindLead({ tenantId, orgId, contactId, source: 'widget', boundBy: 'operator' }); await reopen();
    expect((await readLeadStatedSubmissions(tenantId, contactId)).map((s) => s.answers[0]?.value)).toEqual(['small', 'large']);
  });

  it('binds a previously unbound visitor contact once without losing its immutable statements', async () => {
    const unbound = (await createContact({ tenantId, name: 'Unbound', email: 'unbound@example.test', silent: true })).contactId;
    const submission = { submissionId: 'unbound-visitor', at: '2026-10-25T01:00:00Z', answers: [{ criterionId: 'budget', value: 'small' }] };
    await commitLeadStatedSubmission(tenantId, unbound, submission);
    await bindLead({ tenantId, orgId, contactId: unbound, source: 'widget', boundBy: 'operator' }); await reopen();
    expect(await readLeadStatedSubmissions(tenantId, unbound)).toEqual([submission]);
    await expect(bindLead({ tenantId, orgId: 'another-client', contactId: unbound, source: 'widget', boundBy: 'operator' })).rejects.toMatchObject({ httpStatus: 409 });
    expect(await readLeadStatedSubmissions(tenantId, unbound)).toEqual([submission]);
  });

  it('one visitor run cannot overwrite its own earlier immutable submission', async () => {
    const submission = { submissionId: 'one-run', at: '2026-10-25T01:00:00Z', answers: [{ criterionId: 'budget', value: 'small' }] };
    await commitLeadStatedSubmission(tenantId, contactId, submission);
    await commitLeadStatedSubmission(tenantId, contactId, { ...submission, at: '2026-10-25T02:00:00Z' });
    await expect(commitLeadStatedSubmission(tenantId, contactId, { ...submission, answers: [{ criterionId: 'budget', value: 'large' }] })).rejects.toMatchObject({ httpStatus: 409 });
    await reopen(); expect(await readLeadStatedSubmissions(tenantId, contactId)).toEqual([submission]);
  });

  it.each(['bound', 'unbound'] as const)('a late visitor publication cannot recreate erased answers on the %s owner row', async (state) => {
    if (state === 'unbound') contactId = (await createContact({ tenantId, name: 'Not yet bound', email: 'erase-unbound@example.test', silent: true })).contactId;
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === ownerKey() && JSON.parse(next).statedSubmissions?.length) { crossed = true; await closeLeadBinding(tenantId, contactId); }
      return cas(key, expected, next);
    });
    await commitLeadStatedSubmission(tenantId, contactId, { submissionId: 'late', at: new Date().toISOString(), answers: [{ criterionId: 'budget', value: 'private visitor answer' }] });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await readLeadStatedSubmissions(tenantId, contactId)).toEqual([]);
    expect(await storage.kvGet(ownerKey())).not.toContain('private visitor answer');
  });
});
