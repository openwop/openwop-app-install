/**
 * ADR 0592 §8 (CMSL-4 / CMSLWF-9) + UX_UPGRADE-content ROUND 3 — the CMS
 * zero-eraser known-open, closed.
 *
 * Sabotage-witnessed (/grade-tests w16): dropping any `hit(...)` redaction arm in
 * `eraseCmsSubject` (page createdBy/authorId, grant delete, grant updatedBy, shared
 * section, language settings, experiments), widening `hit` past the subject's key
 * forms, matching only the raw key form, or dropping the universal decidedBy/note
 * walk in `applyApprovalRedactorsForSubject` turns the named case red.
 *
 * CMS registered no subject eraser and neither ratchet could see it (both bind
 * on a field named `userId`; CMS holds `authorId`/`createdBy`/`updatedBy`/
 * `publishedBy` + `CmsLocaleGrant.subject`). Anonymize-not-delete for org
 * content; the subject's OWN locale grant is DELETED (an anonymized grant
 * would still grant, to nobody auditable).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import {
  createPage, getPage, putLocaleGrant, getLocaleGrant, createSharedSection, listSharedSections, transitionPage,
} from '../src/features/cms/cmsService.js';
import { updateContentLanguageSettings, getContentLanguageSettings } from '../src/host/contentLocales.js';
import { createExperiment, listExperiments } from '../src/features/cms/pageExperimentsService.js';
import { queueContentApproval } from '../src/features/cms/contentApproval.js';
import {
  createApproval, findPendingContentApprovalForPage, resolveApproval, eraseApprovalSubject, listApprovals,
} from '../src/host/approvalService.js';
import { eraseCmsSubject, ERASED_SUBJECT } from '../src/features/cms/erasure.js';

const T = 'org:cms-erase';
let ORG = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // createApp wires the stores + approval kinds; no HTTP server is needed (no case calls a route).
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const org = await createOrg({ tenantId: T, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  ORG = org.orgId;
  // ADR 0592 §9 (CMSL-7) — grants are now validated against the configured
  // locale set, so the fixtures configure it first (production-shaped).
  await updateContentLanguageSettings(T, ORG, { supportedLocales: ['fr', 'es', 'pt-BR'] }, 'u-seed');
});

describe('R3 — CMS is erasable: attributions anonymize, the grant deletes, others untouched', () => {
  it('erases page attributions and deletes the subject grant; the keeper subject is untouched', async () => {
    const mine = await createPage({ tenantId: T, orgId: ORG, title: 'Mine', createdBy: 'u-erase-me', authorId: 'u-erase-me' });
    const theirs = await createPage({ tenantId: T, orgId: ORG, title: 'Theirs', createdBy: 'u-keeper' });
    await putLocaleGrant(T, ORG, 'u-erase-me', ['fr'], 'u-admin');
    await putLocaleGrant(T, ORG, 'u-keeper', ['es'], 'u-admin');

    await eraseCmsSubject(T, 'u-erase-me');

    const mineAfter = await getPage(T, ORG, mine.pageId);
    expect(mineAfter!.createdBy).toBe(ERASED_SUBJECT);
    expect(mineAfter!.authorId).toBe(ERASED_SUBJECT);
    expect(mineAfter!.updatedBy).toBe(ERASED_SUBJECT); // createPage stamps updatedBy = createdBy
    const theirsAfter = await getPage(T, ORG, theirs.pageId);
    expect(theirsAfter!.createdBy).toBe('u-keeper');                    // untouched polarity
    expect(await getLocaleGrant(T, ORG, 'u-erase-me')).toBeNull();      // the grant DELETES
    expect((await getLocaleGrant(T, ORG, 'u-keeper'))!.locales).toEqual(['es']); // …only theirs
  });

  it('a grant the subject merely UPDATED anonymizes updatedBy and keeps granting', async () => {
    await putLocaleGrant(T, ORG, 'u-someone', ['pt-BR'], 'u-erase-me2');
    await eraseCmsSubject(T, 'u-erase-me2');
    const g = await getLocaleGrant(T, ORG, 'u-someone');
    expect(g!.locales).toEqual(['pt-BR']);        // the grant still grants
    expect(g!.updatedBy).toBe(ERASED_SUBJECT);    // the attribution is gone
  });
});

// ── ADR 0592 §8 (CMSL-4 / CMSLWF-9) — the enumeration gaps, closed with
// per-store pins (the module-level `hasEraser` in the feature-stores census
// reads a store "covered" without one — these are the store-level truth).
describe('ADR 0592 §8 — shared sections, language settings, experiments, rowsTouched, key forms', () => {
  it('anonymizes cms:sharedsection createdBy/updatedBy and reports rowsTouched', async () => {
    await createSharedSection(T, ORG, { name: 'Footer', type: 'cta', data: { label: 'Go', url: '/x' } }, 'u-shared-erase');
    await createSharedSection(T, ORG, { name: 'Header', type: 'cta', data: { label: 'Hi', url: '/y' } }, 'u-shared-keeper');

    const report = await eraseCmsSubject(T, 'u-shared-erase');
    expect(report.rowsTouched).toBe(1); // the SubjectEraseReport contract (WF-TWIN-3): one shared row

    const all = await listSharedSections(T, ORG);
    const mine = all.find((s) => s.name === 'Footer');
    const theirs = all.find((s) => s.name === 'Header');
    expect(mine!.createdBy).toBe(ERASED_SUBJECT);
    expect(mine!.updatedBy).toBe(ERASED_SUBJECT);
    expect(theirs!.createdBy).toBe('u-shared-keeper'); // keeper polarity
  });

  it('anonymizes cms:langsettings.updatedBy (the census row moved from REVIEWED_EXEMPT — operator attribution IS a subject id)', async () => {
    // Re-saves the SAME locale set the fixture configured: narrowing it here made the
    // grant cases above 400 (CMSL-7) whenever this case ran first under shuffle.
    await updateContentLanguageSettings(T, ORG, { supportedLocales: ['fr', 'es', 'pt-BR'] }, 'u-lang-erase');
    await eraseCmsSubject(T, 'u-lang-erase');
    const s = await getContentLanguageSettings(T, ORG);
    expect(s.supportedLocales).toEqual(['fr', 'es', 'pt-BR']);  // config kept — org data
    expect(s.updatedBy).toBe(ERASED_SUBJECT);    // attribution gone
  });

  it('anonymizes cms:pageexperiment.createdBy', async () => {
    const page = await createPage({ tenantId: T, orgId: ORG, title: 'Exp page', createdBy: 'u-exp-keeper' });
    await createExperiment({
      tenantId: T, orgId: ORG, pageId: page.pageId, name: 'Hero test',
      variants: [{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: null, weight: 50 }],
      createdBy: 'u-exp-erase',
    });
    await eraseCmsSubject(T, 'u-exp-erase');
    const after = await listExperiments(T, ORG, page.pageId);
    expect(after[0]!.createdBy).toBe(ERASED_SUBJECT);
  });

  it('matches every subject-key FORM (a scoped `user:` DSAR key reaches raw-stored rows)', async () => {
    const raw = 'raw-form-subject';
    const page = await createPage({ tenantId: T, orgId: ORG, title: 'Forms page', createdBy: raw });
    // Erase by the SCOPED form — the raw-stored attribution must still be hit.
    const report = await eraseCmsSubject(T, `user:${raw}`);
    expect(report.rowsTouched).toBe(1); // the one page row (createdBy + updatedBy on it)
    expect((await getPage(T, ORG, page.pageId))!.createdBy).toBe(ERASED_SUBJECT);
  });
});

describe('ADR 0592 §8 — content-publish reviewer redaction (CMSLWF-9 a)', () => {
  it('an erased REVIEWER\'s decidedBy + note are redacted on the resolved row; the proposal survives', async () => {

    const page = await createPage({ tenantId: T, orgId: ORG, title: 'Reviewed page', createdBy: 'u-author' });
    await transitionPage(T, ORG, page.pageId, 'submit', 'u-author');
    await queueContentApproval(T, ORG, page, 'Publish "Reviewed page"', { notify: false });
    const appr = await findPendingContentApprovalForPage(T, page.pageId);
    expect(appr, 'submit must queue a content approval').toBeTruthy();

    // Reject with a reviewer note — decidedBy is persisted ON the row now.
    const resolved = await resolveApproval(appr!.approvalId, { status: 'rejected', note: 'Tone is off — rewrite the hero.', decidedBy: 'u-reviewer-erased' });
    expect(resolved?.changed).toBe(true);
    expect(resolved?.approval.decidedBy).toBe('u-reviewer-erased');

    await eraseApprovalSubject(T, 'u-reviewer-erased');
    const after = (await listApprovals(T)).find((a) => a.approvalId === appr!.approvalId);
    expect(after!.decidedBy).toBe('[erased]');
    expect(after!.note).toBe('[erased]');
    expect(after!.proposal).toContain('Reviewed page'); // page-naming audit text survives (not the reviewer's data)
  });
});

// ── Review F2 (ADR 0592 §Corrections) — decidedBy redaction is UNIVERSAL.
// The first draft redacted the reviewer only on content-publish via per-kind
// idFields, while resolveApproval persists decidedBy on EVERY kind — so an
// erased reviewer's id + attributed note survived DSAR on all other kinds.
describe('ADR 0592 §8 correction — reviewer redaction is kind-INDEPENDENT (review F2)', () => {
  it('an erased decider is redacted on a NON-content-publish kind too (run-proposal)', async () => {
    const appr = await createApproval({
      tenantId: T,
      rosterId: 'roster:demo',
      persona: 'analyst',
      workflowId: 'wf.demo',
      proposal: 'Run wf.demo on the imported batch',
    });
    const resolved = await resolveApproval(appr.approvalId, { status: 'rejected', note: 'Not this quarter.', decidedBy: 'u-generic-reviewer' });
    expect(resolved?.changed).toBe(true);
    expect(resolved?.approval.kind ?? 'run-proposal').not.toBe('content-publish');

    await eraseApprovalSubject(T, 'u-generic-reviewer');
    const after = (await listApprovals(T)).find((a) => a.approvalId === appr.approvalId);
    expect(after!.decidedBy).toBe('[erased]');
    expect(after!.note).toBe('[erased]');
    expect(after!.proposal).toContain('wf.demo'); // audit text that is not the reviewer's data survives
  });
});
