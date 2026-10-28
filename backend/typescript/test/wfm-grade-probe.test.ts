/**
 * Workflow-collab eligibility — the reserved-namespace refusal ("Workflow builder
 * multiplayer", FEATURES.md ordinal 232; WFMP-1 from the /grade-code pass).
 *
 * `workflowCollabEligible` (`src/host/collab/workflowCollabResource.ts:58`) refuses a
 * reserved / seeded / template / built-in id (`SHARED_WORKFLOW_ID`: `wf.seed.*`,
 * `tmpl.*`, `openwop-app.*`, the two seeded walkthroughs) BEFORE its ownership lookup:
 * their one row is shared by every tenant, so a live co-editing room on one would make
 * one tenant its author.
 *
 * The fixture makes that short-circuit LOAD-BEARING. Every reserved id below is
 * genuinely OWNED by the tenant (as a seeded `wf.seed.*` row is in a real seeded
 * tenant), so the ownership lookup alone would answer `true`; only the reserved check
 * refuses it. A positive control — an owned, non-reserved id — must be eligible, so
 * the refusal cannot come from "nothing is owned". (Round 1 read this file as
 * vacuous; probe 8fw4g1-wfm-reserved was witnessed, but only because the store was
 * uninitialised and the ownership lookup THREW. Re-witnessed by 8fw4g1-wfm-reserved-r2.)
 *
 * Unique: `workflow-collab-canary.test.ts:235` checks the reserved leg at the route,
 * by status only, on an id (`tmpl.anything`) that is not owned — the same blind spot.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { recordOwnership } from '../src/host/workflowOwnership.js';
import { workflowCollabEligible } from '../src/host/collab/workflowCollabResource.js';

const TENANT = 'org:probe';
const RESERVED = ['wf.seed.onboarding', 'tmpl.campaign-brief', 'openwop-app.kicktodo.replan', 'walkthrough.chat.first-message'];
const OWNED_DRAFT = 'wf.user.probe-draft';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  for (const id of [...RESERVED, OWNED_DRAFT]) await recordOwnership(TENANT, id, { name: id, nodeCount: 1 });
});

describe('Workflow-collab eligibility — reserved-namespace refusal (by execution)', () => {
  it('positive control: an OWNED, non-reserved draft IS co-editable', async () => {
    expect(await workflowCollabEligible(TENANT, OWNED_DRAFT)).toBe(true);
  });

  it('WFMP-1: refuses seeded / template / built-in / empty ids even when the tenant OWNS the row', async () => {
    for (const id of RESERVED) expect(await workflowCollabEligible(TENANT, id), id).toBe(false);
    expect(await workflowCollabEligible(TENANT, '')).toBe(false); // empty id
  });
});
