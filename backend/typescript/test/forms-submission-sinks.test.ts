/**
 * Submission-sink seam (ADR 0330 §D1) — unit coverage for the inversion seam
 * that decoupled forms from CRM: registration is replace-by-id (idempotent
 * boot), sinks run post-persist with first-marker-wins merging (and the markers
 * land on the persisted row), a thrown sink is fail-soft (capture never fails),
 * and `runSubmissionSinks` reports whether any marker was applied — the bit
 * `deliver` gates its marker write on.
 *
 * Sabotage-witnessed (grade-tests w8, probes w8g1-ss-*): appending instead of
 * replacing by id, last-marker-wins, dropping the persisted contactId, rethrowing a
 * sink error, and an always-true `changed` each turn a case red. "no registered
 * sinks: persists exactly once" was cut as redundant with forms-service
 * "recordSubmission (createToContact:false) appends…" (probes ss/svc-noSinks-dup
 * red-red).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  clearSubmissionSinksForTest,
  registerSubmissionSink,
  runSubmissionSinks,
} from '../src/features/forms/submissionSinks.js';
import { createForm, listSubmissions, recordSubmission, setFormStatus, __resetFormsStore } from '../src/features/forms/formsService.js';

const TENANT = 'tenant-sinks';
const ORG = 'org:sinks';

async function makeForm() {
  const form = await createForm({
    tenantId: TENANT,
    orgId: ORG,
    title: 'Sink form',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: false },
    ],
    createToContact: true,
    createdBy: 'user:test',
  });
  await setFormStatus(TENANT, ORG, form.formId, 'published');
  return form;
}

describe('forms submission sinks (ADR 0330)', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __resetFormsStore();
    clearSubmissionSinksForTest();
  });
  afterEach(() => clearSubmissionSinksForTest());

  it('re-registering an id replaces the prior sink (idempotent boot)', async () => {
    const calls: string[] = [];
    registerSubmissionSink({ id: 'x', onSubmission: async () => { calls.push('first'); return undefined; } });
    registerSubmissionSink({ id: 'x', onSubmission: async () => { calls.push('second'); return undefined; } });
    const form = await makeForm();
    await recordSubmission(form, { name: 'A' }, {});
    expect(calls).toEqual(['second']);
  });

  it('first marker-returning sink wins; markers land on the persisted row', async () => {
    registerSubmissionSink({ id: 'a', onSubmission: async () => ({ contactId: 'crm:one' }) });
    registerSubmissionSink({ id: 'b', onSubmission: async () => ({ contactId: 'crm:two', error: 'late_error' }) });
    const form = await makeForm();
    await recordSubmission(form, { name: 'A' }, {});
    const rows = await listSubmissions(TENANT, ORG, form.formId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contactId).toBe('crm:one');
    expect(rows[0]!.error).toBe('late_error'); // error slot independently first-wins
  });

  it('a thrown sink is fail-soft: capture succeeds, no marker, later sinks still run', async () => {
    const ran: string[] = [];
    registerSubmissionSink({ id: 'boom', onSubmission: async () => { throw new Error('sink exploded'); } });
    registerSubmissionSink({ id: 'after', onSubmission: async () => { ran.push('after'); return undefined; } });
    const form = await makeForm();
    const sub = await recordSubmission(form, { name: 'A' }, {});
    expect(sub.error).toBeUndefined();
    expect(ran).toEqual(['after']);
    const rows = await listSubmissions(TENANT, ORG, form.formId);
    expect(rows).toHaveLength(1);
  });

  it('runSubmissionSinks reports whether any marker was applied', async () => {
    registerSubmissionSink({ id: 'noop', onSubmission: async () => undefined });
    const form = await makeForm();
    const sub = await recordSubmission(form, { name: 'A' }, {});
    expect(await runSubmissionSinks(form, sub)).toBe(false);
    registerSubmissionSink({ id: 'marker', onSubmission: async () => ({ contactId: 'crm:m' }) });
    expect(await runSubmissionSinks(form, sub)).toBe(true);
  });
});
