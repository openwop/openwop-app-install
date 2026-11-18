/**
 * CC-JOURNEY-1: a deferred workflow binds a bare param name passed in `inputs`.
 *
 * MEASURED on prod 2026-11-17 (build 569fdfec88, QA-CC). campaign-journeys.
 * segment-winback dispatched its member to a re-engage-contact child installed
 * in DEFERRED mode, as the chain's own `childWorkflowId` description says. The
 * child got its per-item inputs keyed by the bare names (`contactId`, …), while
 * the deferred definition reads the prefixed variable
 * `campaign_journeys_re_engage_contact_<hash>_contactId`. Every child failed at
 * enroll ("journeyId and contactId … are required"). A direct v2 run with bare
 * inputs failed the same way, and a bare `configurable` key is a 400 under the
 * closed v2 contract, so a deferred param could not be set by its bare name at all.
 *
 * Uses the REAL campaign-journeys pack chain, so the alias map is the one prod
 * builds.
 * Red on main: the bag's prefixed contactId is undefined in case 1, so the
 * expectation reads `undefined`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import { deferredConfigurableInputs, seedRunVariables, snapshotRunVariables } from '../src/host/variablesRuntime.js';

const pack = JSON.parse(readFileSync(new URL('../../../examples/workflow-chain-packs/campaign-journeys/pack.json', import.meta.url), 'utf8')) as { chains: WorkflowChain[] };
const reEngage = pack.chains.find((c) => c.chainId === 'campaign-journeys.re-engage-contact')!;
const def = expandChain(reEngage, { deferred: true, params: { orgId: 'org-qa', senderEmail: 'sender@example.invalid' } });
const aliases = def.metadata?.deferredParameterAliases as Record<string, string>;
const LEAD = 'crm:lead-1';

describe('CC-JOURNEY-1: bare param names in run inputs reach a deferred workflow', () => {
  it('per-item inputs keyed by the bare name (what core.dispatch sends) bind the prefixed variables', () => {
    expect(aliases.contactId).toMatch(/^campaign_journeys_re_engage_contact_.+_contactId$/);
    const enroll = def.nodes.find((n) => n.nodeId.endsWith('_enroll'))!;
    expect(enroll.inputs?.contactId).toEqual({ type: 'variable', variableName: aliases.contactId });

    seedRunVariables('cc-j1-a', def.variables, deferredConfigurableInputs(def, undefined, { contactId: LEAD, subject: 'Hello again' }));
    const bag = snapshotRunVariables('cc-j1-a')!;
    expect(bag[aliases.contactId]).toBe(LEAD);
    expect(bag[aliases.subject]).toBe('Hello again');
    expect(bag[aliases.orgId]).toBe('org-qa'); // install-time default, untouched
  });

  it('a prefixed input beats its bare alias, and configurable beats both', () => {
    seedRunVariables('cc-j1-b', def.variables, deferredConfigurableInputs(def, undefined, { contactId: 'crm:bare', [aliases.contactId]: 'crm:prefixed' }));
    expect(snapshotRunVariables('cc-j1-b')![aliases.contactId]).toBe('crm:prefixed');
    seedRunVariables('cc-j1-c', def.variables, deferredConfigurableInputs(def, { contactId: 'crm:configurable' }, { contactId: 'crm:bare' }));
    expect(snapshotRunVariables('cc-j1-c')![aliases.contactId]).toBe('crm:configurable');
  });

  it('a non-deferred workflow and an input with nothing to translate are returned untouched', () => {
    const frozen = expandChain(reEngage, { params: { contactId: LEAD, orgId: 'org-qa', senderEmail: 'sender@example.invalid' } });
    const inputs = { contactId: 'crm:other' };
    expect(deferredConfigurableInputs(frozen, undefined, inputs)).toBe(inputs);
    const unrelated = { somethingElse: 1 };
    expect(deferredConfigurableInputs(def, undefined, unrelated)).toBe(unrelated);
  });
});
