/**
 * ADR 0540 P4 — the workflow surface + node pack.
 *
 * The headline assertions are about what is ABSENT. A surface op or node that
 * could submit an application would route around the ADR 0541 apply grant — the
 * authority object whose entire purpose is to bound submission — so its absence
 * is a security property, not an omission, and it needs a test that fails if
 * someone helpfully adds one.
 *
 * Tracker TST-DHB-7 (wave 71). Red when: `runCampaignPass` gains a parameter
 * (`w71g3-sp-noinputs`); the surface drops the posting's quote (`sp-quote`) or
 * blesses a fabricating rewrite (`sp-guard`); a missing orgId reaches the
 * provisioning read (`sp-orgid-r2`); the campaign node loses `side-effectful`
 * (`sp-sideeffect`); a node with no surface stops failing loudly (`sp-loud`);
 * the surface stops normalising a partial digest (`sp-scorefit-r2`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJobSearchSurface } from '../src/features/job-search/surface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { listPipelines } from '../src/features/crm/crmEntitiesService.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const PACK_DIR = join(process.cwd(), '..', '..', 'packs', 'feature.job-search.nodes');
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as {
  name: string;
  nodes: Array<{ typeId: string; role: string; capabilities?: string[] }>;
};

const SCOPE: BundleScope = { tenantId: 'user:t-surface', runId: 'run:1' };
const surface = () => buildJobSearchSurface(SCOPE);

describe('ADR 0540 P4 — the surface exposes read + ONE terminal write', () => {
  it('has no op that could SUBMIT an application', () => {
    const ops = Object.keys(surface());
    for (const forbidden of ['submit', 'apply', 'send']) {
      expect(ops, `a "${forbidden}" op would route around the ADR 0541 grant`).not.toContain(forbidden);
    }
  });

  it('exposes exactly the declared op set', () => {
    // `runCampaignPass` joined deliberately (WF-JS-1, ADR 0543 §D3 correction
    // note): it takes NO inputs — a chain can trigger the tenant's standing
    // campaign but cannot aim, widen, or target a submission. The closed set is
    // still the law; this list changing without that deliberation is the defect
    // this test exists to catch.
    expect(Object.keys(surface()).sort()).toEqual([
      'checkEligibility', 'guardRewrite', 'listApplications', 'recordOutcome', 'runCampaignPass', 'scoreFit',
    ]);
  });

  it('runCampaignPass takes NO targeting inputs — the amended law, structurally', () => {
    // The op's signature is the guarantee: zero parameters means a workflow
    // cannot pass a listing, an answer set, or an origin. (The pass derives
    // everything from the tenant's own steering/grants/listings/bank.)
    expect(surface().runCampaignPass.length).toBe(0);
  });

  it('scoreFit normalises a partial workflow digest — and is pure', async () => {
    const s = surface();
    const input = { digest: { title: 'Backend Engineer', skills: ['typescript'] }, profile: { skills: ['TypeScript'], targetTitles: ['Backend Engineer'] } };
    const a = await s.scoreFit!(input);
    const b = await s.scoreFit!(input);
    // Hand-derived: every listed skill held (10), title contained (10); no
    // salary floor and no remote preference ⇒ the neutral 5s.
    expect(a.scores).toEqual({ 'skill-overlap': 10, 'title-match': 10, 'salary-fit': 5, 'location-fit': 5 });
    expect(a.score).toBe(b.score);
  });

  it('checkEligibility carries the posting’s QUOTE through the surface', async () => {
    // The quote is what makes a skip falsifiable. If the surface dropped it, a
    // chain could report a skip the user cannot check against the posting.
    const s = surface();
    const v = await s.checkEligibility!({
      digest: { sponsorship: 'not-offered', sponsorshipQuote: 'We cannot sponsor visas.' },
      applicant: { requiresSponsorship: true },
    });
    expect(v.eligible).toBe(false);
    expect(v.quote).toBe('We cannot sponsor visas.');
  });

  it('guardRewrite reports a fabrication rather than throwing', async () => {
    // A dishonest rewrite is a negative VERDICT, not a host failure — the chain
    // must be able to branch on it and repair.
    const s = surface();
    const v = await s.guardRewrite!({
      original: 'Cut latency 40%.', reworded: 'Cut latency 90%.',
    });
    expect(v.ok).toBe(false);
  });

  it('a missing orgId reads EMPTY and provisions nothing', async () => {
    // With a real store: a missing orgId must never reach `listApplications`,
    // which PROVISIONS the application pipeline for the org it is handed.
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(':memory:'));
    try {
      const out = await surface().listApplications!({});
      expect(out.applications).toEqual([]);
      expect(await listPipelines(SCOPE.tenantId, ''), 'no pipeline minted for an empty org').toEqual([]);
    } finally {
      __resetHostExtPersistence();
    }
  });
});

describe('ADR 0540 P4 — the node pack', () => {
  it('ships no node a workflow could AIM — the amended law (ADR 0543 §D3 correction note)', () => {
    // `run-campaign` triggers the tenant's standing campaign and carries no
    // target; what stays forbidden is a node that takes a listing/answers/
    // destination. The regex spares the campaign trigger deliberately — its
    // no-target guarantee is pinned structurally in job-search-surface-pack +
    // career-search-chain suites.
    const ids = manifest.nodes.map((n) => n.typeId).filter((i) => i !== 'feature.job-search.nodes.run-campaign');
    expect(ids.some((i) => /submit|apply|send/.test(i)), 'a targetable submit node would bypass the ADR 0541 grant').toBe(false);
    // …and the campaign trigger must be declared side-effectful (the pack half
    // of the two-leg replay classification).
    const campaign = manifest.nodes.find((n) => n.typeId === 'feature.job-search.nodes.run-campaign');
    expect(campaign?.capabilities).toContain('side-effectful');
  });

  it('declares the five nodes, all role:action so replay reads the RECORDED verdict', () => {
    expect(manifest.nodes.map((n) => n.typeId).sort()).toEqual([
      'feature.job-search.nodes.check-eligibility',
      'feature.job-search.nodes.guard-rewrite',
      'feature.job-search.nodes.record-outcome',
      'feature.job-search.nodes.run-campaign',
      'feature.job-search.nodes.score-fit',
    ]);
    // `role: action` is what makes the engine record the output. A re-decided
    // verdict on replay would silently rewrite the reason a past application
    // was (or was not) sent.
    for (const n of manifest.nodes) expect(n.role).toBe('action');
  });

  it('every node in the manifest is implemented by the entry module', async () => {
    // A declared-but-missing node is an advert the host cannot honour.
    const mod = (await import(join(PACK_DIR, 'index.mjs'))) as { nodes: Record<string, unknown> };
    for (const n of manifest.nodes) {
      expect(typeof mod.nodes[n.typeId], `${n.typeId} declared but not implemented`).toBe('function');
    }
    expect(Object.keys(mod.nodes).sort()).toEqual(manifest.nodes.map((n) => n.typeId).sort());
  });

  it('a node fails LOUDLY when the surface is absent', async () => {
    // Silent success with an empty result is the failure mode the repo treats as
    // a defect: the model would read "no jobs matched" from "the feature is off".
    const mod = (await import(join(PACK_DIR, 'index.mjs'))) as { nodes: Record<string, (ctx: unknown) => Promise<unknown>> };
    await expect(mod.nodes['feature.job-search.nodes.score-fit']!({ features: {}, inputs: {} })).rejects.toThrow(/job-search/);
  });
});
