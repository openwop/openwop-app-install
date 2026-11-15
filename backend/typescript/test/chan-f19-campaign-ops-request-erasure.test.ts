/**
 * CHAN-F19 #3 (ADR 0464 §9) — `campaign-ops:request` names the person who made a change
 * request, each person who answered its questions, and the person who overrode a duplicate
 * warning with a reason they wrote. Its fields arrive through `extends ChangeRequest`, so the
 * census could not see them, and campaign-ops' eraser never reached the store.
 *
 * This boots the REAL app (so the registered eraser set is the production one), builds two
 * requests through the real request service, and erases one person through the host fan-out
 * (`eraseSubject`). It pins:
 *  - the erased person's creator, answerer and override-author fields become the tombstone,
 *    and their override reason is blanked;
 *  - another person on the SAME rows is untouched (the match is per field, not per row);
 *  - the request text, its answer values and its version are KEPT: they are the client's
 *    change instruction, the agency's record (ADR 0464 §9 CHAN-F19 #3);
 *  - the same person's request in ANOTHER workspace is untouched (tenant-scoped).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { answerQuestions, createRequest, getRequest, recordInterpretation } from '../src/features/campaign-ops/requestService.js';

let server: http.Server;
const ALICE = 'user:cops-f19-alice';
const BOB = 'user:cops-f19-bob';

interface Ws { tenantId: string; orgId: string; assetId: string }
async function workspace(name: string): Promise<Ws> {
  const tenantId = (await createWorkspace({ name, ownerSubject: `oidc:${name}-owner` })).tenantId;
  const orgId = (await createOrg({ tenantId, createdBy: 'seed', name: `${name} client (synthetic)` })).orgId;
  await createClient({ tenantId, orgId, name: `${name} client (synthetic)`, createdBy: 'seed' });
  const page = await createPage({ tenantId, orgId, title: 'Webinar', createdBy: 'seed', sections: [{ type: 'hero', data: { heading: 'Q4 pipeline review' } }] });
  const field = `sections[${page.sections[0].sectionId}].data.heading`;
  const assetId = (await addAsset({ tenantId, orgId, destination: 'openwop.cms.page', locator: { pageId: page.pageId }, label: 'Webinar page', editableFields: [field], createdBy: 'seed' })).assetId;
  return { tenantId, orgId, assetId };
}

/** A request by `by`, asked one question, answered by `answerer`. */
async function answered(w: Ws, text: string, by: string, answerer: string, override?: string): Promise<string> {
  const r = await createRequest({ tenantId: w.tenantId, orgId: w.orgId, text, assetIds: [w.assetId], createdBy: by, ...(override ? { overrideDuplicate: { reason: override } } : {}) });
  await recordInterpretation(w.tenantId, w.orgId, r.requestId, r.version, { intents: [], questions: [{ id: 'q1', slot: 'webinar.date', prompt: 'Which Thursday?' }] });
  await answerQuestions(w.tenantId, w.orgId, r.requestId, [{ questionId: 'q1', value: 'Nov 12' }], answerer);
  return r.requestId;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo).port; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('CHAN-F19 #3 — change requests on a DSAR', () => {
  it('tombstones the person on every field that names them, keeps the record and the other person', async () => {
    const w = await workspace('cops-f19-a');
    const other = await workspace('cops-f19-b');
    const mine = await answered(w, 'Move the webinar to the second Thursday', ALICE, BOB, 'The client asked twice; the first one was cancelled');
    const theirs = await answered(w, 'Change the webinar heading to Q4 review', BOB, ALICE);
    const elsewhere = await answered(other, 'Move the webinar to the second Thursday', ALICE, ALICE);
    const before = await getRequest(w.tenantId, w.orgId, mine);
    expect(before?.duplicateOverride?.by).toBe(ALICE);

    await eraseSubject(w.tenantId, ALICE);

    const a = await getRequest(w.tenantId, w.orgId, mine);
    expect(a?.createdBy).toBe(ERASED_USER_REF);
    expect(a?.duplicateOverride).toEqual({ reason: '', by: ERASED_USER_REF, at: before?.duplicateOverride?.at });
    expect(a?.answers.map((x) => x.answeredBy)).toEqual([BOB]); // Bob answered Alice's request: kept
    expect(a?.text).toBe('Move the webinar to the second Thursday');
    expect(a?.answers[0]?.value).toBe('Nov 12');
    expect(a?.version).toBe(before?.version); // a CAS on the row, never a new version

    const b = await getRequest(w.tenantId, w.orgId, theirs);
    expect(b?.createdBy).toBe(BOB);
    expect(b?.answers.map((x) => x.answeredBy)).toEqual([ERASED_USER_REF]);
    expect(b?.answers[0]?.value).toBe('Nov 12');

    const c = await getRequest(other.tenantId, other.orgId, elsewhere);
    expect(c?.createdBy).toBe(ALICE); // another workspace: a principal id is not issuer-qualified
    expect(c?.answers[0]?.answeredBy).toBe(ALICE);
  });
});
