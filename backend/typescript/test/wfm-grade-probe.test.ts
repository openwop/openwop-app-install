/**
 * GRADING PROBE — "Workflow builder multiplayer" (FEATURES.md ordinal 232).
 * Evidence only. GREEN + CI-safe (pure predicate; the reserved-id branch returns
 * before any store/registry call, so no boot/DSN needed).
 *
 * Witnesses Headline #1(b) — the workflow-collab eligibility gate REFUSES a
 * reserved / seeded / template / public-namespace workflow id, so a
 * tenant-owned-immutable `wf.seed.*` row, a `tmpl.*` template, or an
 * `openwop-app.*` built-in can NEVER open a live co-editing room (they are not
 * free-form drafts). `workflowCollabEligible` short-circuits on
 * RESERVED_PUBLIC_ID (`workflowCollabResource.ts:58`) BEFORE the ownership /
 * chain-backed lookups — the pure, boot-free branch. The `/grade-code` pass
 * flagged the `wf.seed.*` / `openwop-app.*` refusals as having no direct test;
 * this closes that for the reserved branch.
 *
 * (The ownership + chain-backed refusals and the derive save-trio are traced by
 * reading — they need a durable store; not asserted here to keep the probe pure.)
 */
import { describe, it, expect } from 'vitest';
import { workflowCollabEligible } from '../src/host/collab/workflowCollabResource.js';

const TENANT = 'org:probe';

describe('Workflow-collab eligibility — reserved-namespace refusal (by execution)', () => {
  it('WFMP-1: refuses seeded / template / built-in / empty ids (never co-editable)', async () => {
    expect(await workflowCollabEligible(TENANT, 'wf.seed.onboarding')).toBe(false); // seeded tenant-owned-immutable
    expect(await workflowCollabEligible(TENANT, 'tmpl.campaign-brief')).toBe(false); // template
    expect(await workflowCollabEligible(TENANT, 'openwop-app.kicktodo.replan')).toBe(false); // reserved public/built-in
    expect(await workflowCollabEligible(TENANT, '')).toBe(false); // empty id
  });
});
