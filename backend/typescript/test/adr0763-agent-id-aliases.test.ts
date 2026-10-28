/**
 * ADR 0763 P1 — the agent-id alias is INERT before the rename, and correct after.
 *
 * `feature.<feature>.agents.<name>` ids move to `vendor.openwop-app.*` (the v1
 * AgentManifest namespace grammar). P1 ships the alias ahead of the rename, so
 * two properties are pinned here:
 *   1. INERT — with no agent registered under a canonical id, every lookup,
 *      identity resolution and storage key is exactly what it was.
 *   2. CORRECT — once an agent is registered under the canonical id, a legacy id
 *      (a roster row, a deep link, the `inputs.agentId` a :fork re-resolves)
 *      reaches it; the reverse never happens (one-way); and every id-KEYED store
 *      addresses one row across both spellings.
 *
 * Red when (wave 60 probes, tracker TST-BRA-8): the registry's alias choke point
 * (`lookup`) stops trying the canonical spelling, or falls back canonical → legacy;
 * `agentStorageId` keys on the literal spelling; the DM key, memory scope, profile or
 * allowlist key stops normalising; identity reports the literal id; the explicit
 * `career-agent` map or the multi-segment rule is lost; node typeIds get mapped.
 *
 * Second guard, recorded: `resolveAgentForTenant(…, '*')` reaches its raw-id scan
 * only when `reg.resolve` misses, and for a pack agent the alias choke point answers
 * first, so the scan's canonical compare is unreachable here (w60g2-aid-wildcard-scan).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  agentIdForms,
  agentStorageId,
  canonicalAgentId,
  legacyAgentId,
  resolveAgentIdSpelling,
} from '../src/executor/agentIdAliases.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { resolveAgentForTenant } from '../src/host/agentVisibility.js';
import { resolveAgentIdentity } from '../src/host/agentIdentity.js';
import { agentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import { dmKeyOf } from '../src/host/conversationStore.js';
import { getAgentProfile, upsertAgentProfile } from '../src/host/agentProfileService.js';
import { getAgentToolAllowlistOverride, upsertAgentToolAllowlistOverride } from '../src/host/agentToolAllowlistService.js';

// A synthetic feature that no real pack uses, so nothing else is registered here.
const LEGACY = 'feature.adr0763probe.agents.helper';
const CANONICAL = 'vendor.openwop-app.adr0763probe.agents.helper';
const LEGACY_ONLY = 'feature.adr0763probe.agents.never-renamed';

describe('the mapping rule', () => {
  it('maps feature agent ids into vendor.openwop-app, and back', () => {
    expect(canonicalAgentId(LEGACY)).toBe(CANONICAL);
    expect(legacyAgentId(CANONICAL)).toBe(LEGACY);
    expect(canonicalAgentId(CANONICAL), 'idempotent').toBe(CANONICAL);
  });

  it('a MULTI-segment feature name maps too (feature.commerce.buyer.agents)', () => {
    expect(canonicalAgentId('feature.commerce.buyer.agents.shopper')).toBe('vendor.openwop-app.commerce.buyer.agents.shopper');
    expect(legacyAgentId('vendor.openwop-app.commerce.buyer.agents.shopper')).toBe('feature.commerce.buyer.agents.shopper');
  });

  it('career-agent (never matched its pack prefix) is mapped explicitly', () => {
    expect(canonicalAgentId('career-agent')).toBe('vendor.openwop-app.career-agent.agents.default');
    expect(legacyAgentId('vendor.openwop-app.career-agent.agents.default')).toBe('career-agent');
  });

  it('touches nothing else: core/vendor/user/host ids and feature NODE typeIds are unchanged', () => {
    for (const id of ['core.openwop.agents.sdr.default', 'vendor.myndhyve.ads-crew.creative-director', 'user.alice', 'host:iris', 'feature.crm.nodes.enrich']) {
      expect(canonicalAgentId(id), id).toBe(id);
      expect(agentIdForms(id), id).toEqual([id]);
      expect(agentStorageId(id), id).toBe(id);
    }
    expect(legacyAgentId('vendor.myndhyve.ads-crew.creative-director'), 'a real vendor pack has no legacy form').toBeUndefined();
  });

  it('forms list canonical first; the storage spelling is the legacy one', () => {
    expect(agentIdForms(LEGACY)).toEqual([CANONICAL, LEGACY]);
    expect(agentIdForms(CANONICAL)).toEqual([CANONICAL, LEGACY]);
    expect(agentStorageId(LEGACY)).toBe(LEGACY);
    expect(agentStorageId(CANONICAL)).toBe(LEGACY);
  });

  it('canonical-if-registered: the literal id wins until a canonical agent exists', () => {
    expect(resolveAgentIdSpelling(LEGACY, () => false)).toBe(LEGACY);
    expect(resolveAgentIdSpelling(LEGACY, (c) => c === CANONICAL)).toBe(CANONICAL);
  });
});

describe('storage keys are spelling-independent (no split, no backfill)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
  it('memory scope and DM key are identical across spellings', () => {
    expect(agentMemoryScope(CANONICAL)).toBe(agentMemoryScope(LEGACY));
    expect(dmKeyOf('user:u1', `agent:${CANONICAL}`)).toBe(dmKeyOf(`agent:${LEGACY}`, 'user:u1'));
    expect(dmKeyOf('user:u1', 'agent:host:iris'), 'non-agent-id refs unchanged').toBe(['agent:host:iris', 'user:u1'].sort().join('|'));
  });

  it('a profile written under the legacy id is read under the canonical id', async () => {
    await upsertAgentProfile('t-adr0763', LEGACY, { roleKey: 'adr0763-probe', autonomy: { specLevel: 'recommend' } });
    const read = await getAgentProfile('t-adr0763', CANONICAL);
    expect(read?.roleKey, 'the canonical spelling must address the same row').toBe('adr0763-probe');
  });

  it('a tool-allowlist override written under the legacy id applies under the canonical id', async () => {
    await upsertAgentToolAllowlistOverride('t-adr0763', LEGACY, { toolAllowlist: ['openwop:schema.lookup'], updatedBy: 'tester' });
    const read = await getAgentToolAllowlistOverride('t-adr0763', CANONICAL);
    expect(read?.toolAllowlist, 'the override must apply under the canonical spelling').toEqual(['openwop:schema.lookup']);
  });
});

describe('resolution — inert before the rename, correct after', () => {
  beforeAll(() => {
    getAgentRegistry().register({
      agentId: LEGACY_ONLY, persona: 'Old', modelClass: 'general', systemPrompt: 'x',
      packName: 'feature.adr0763probe.agents', packVersion: '0', toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
  });

  it('INERT: a legacy id with no canonical agent resolves to itself, exactly as before', async () => {
    const a = await getAgentRegistry().resolve(LEGACY_ONLY);
    expect(a?.agentId).toBe(LEGACY_ONLY);
    const id = await resolveAgentIdentity('t-adr0763', LEGACY_ONLY);
    expect(id).toEqual({ agentId: LEGACY_ONLY, profileId: LEGACY_ONLY });
  });

  it('AFTER the rename: the legacy id (roster row, deep link, a :fork re-resolve) reaches the canonical agent', async () => {
    getAgentRegistry().register({
      agentId: CANONICAL, persona: 'Helper', modelClass: 'general', systemPrompt: 'x',
      packName: 'vendor.openwop-app.adr0763probe.agents', packVersion: '1', toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
    expect((await getAgentRegistry().resolve(LEGACY))?.agentId).toBe(CANONICAL);
    expect(getAgentRegistry().has(LEGACY)).toBe(true);
    expect((await resolveAgentForTenant(LEGACY, 't-adr0763'))?.agentId, 'the tenant-visible path').toBe(CANONICAL);
    expect((await resolveAgentForTenant(LEGACY, '*'))?.agentId, "the '*' admin branch resolves through the alias choke point").toBe(CANONICAL);
    const identity = await resolveAgentIdentity('t-adr0763', LEGACY);
    expect(identity.agentId, 'identity reports the canonical id').toBe(CANONICAL);
  });

  it('ONE-WAY: a canonical id never falls back to a legacy agent', async () => {
    const canonicalOfLegacyOnly = canonicalAgentId(LEGACY_ONLY);
    expect(await getAgentRegistry().resolve(canonicalOfLegacyOnly)).toBeNull();
  });
});
