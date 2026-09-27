/**
 * CLNP-3 — the CDP node surface masks the golden record.
 *
 * `feature.cdp.nodes.resolve-identity` is `role:"action"`, so its output is recorded
 * into `node.completed` and replay-served to anyone who can read the run. The surface
 * used to call bare `resolveIdentity`, so the CLEAR record (name, email) landed in the
 * durable event log even though the agent tool over the same data pinned
 * `hasPiiGrant:false`. This drives the REAL pack node over the REAL surface, which is
 * the lane the leak travelled — a service-level test of `resolveIdentityWithAccess`
 * would pass with the surface still bypassing it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cdpFeature } from '../src/features/cdp/feature.js';
import { createApp } from '../src/index.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { buildCdpSurface } from '../src/features/cdp/surface.js';
import { maskGoldenRecord } from '../src/features/cdp/identityService.js';
// @ts-expect-error — .mjs pack module has no type declarations (pure-JS node pack).
import { resolveIdentity as resolveIdentityNode } from '../../../packs/feature.cdp.nodes/index.mjs';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

type NodeResult = {
  status: string;
  outputs: { resolved: { contact: Record<string, unknown>; identifiers: Array<{ type: string; value: string }> } | null; masked: boolean };
};

describe('CLNP-3 — the recorded CDP node output carries no clear PII', () => {
  it('masks name + email in the node output, keeps contactId clear, and says so', async () => {
    const tenantId = `org:clnp3-${Date.now()}`;
    const contact = await createContact({ tenantId, name: 'Jane Clearname', email: 'jane.clear@acme.test', phone: '+15551234567', address: '12 Clearstreet, Springfield' });
    const ctx = { features: { cdp: buildCdpSurface({ tenantId }) }, inputs: { type: 'email', value: 'jane.clear@acme.test' } };

    const res = (await resolveIdentityNode(ctx)) as NodeResult;

    expect(res.status).toBe('success');
    expect(res.outputs.masked).toBe(true);
    // The whole output is what gets recorded — assert on its serialisation, not one field.
    const recorded = JSON.stringify(res.outputs);
    expect(recorded).not.toContain('jane.clear@acme.test');
    expect(recorded).not.toContain('Jane Clearname');
    // grade-data #1: the derived `phone` and the declared-PII `address` rode through a
    // spread of the contact and were recorded in clear under a `masked:true` flag.
    expect(recorded).not.toContain('5551234567');
    expect(recorded).not.toContain('Clearstreet');
    // An opaque id is not person PII — a workflow can still branch on it.
    expect(res.outputs.resolved?.contact.contactId).toBe(contact.contactId);
    // Host identity columns stay projected out.
    expect(res.outputs.resolved?.contact).not.toHaveProperty('tenantId');
  });

  it('string custom-field values are masked fail-closed; non-strings are kept', () => {
    const masked = maskGoldenRecord({
      contact: { contactId: 'c1', tenantId: 't', name: 'N', stage: 'lead', customFields: { spouse: 'Jane Doe', tier: 3, vip: true }, createdAt: '', updatedAt: '' },
      identifiers: [],
      resolvedBy: { type: 'crm_id', value: 'c1' },
    });
    expect(JSON.stringify(masked)).not.toContain('Jane Doe');
    expect(masked.contact.customFields).toMatchObject({ tier: 3, vip: true });
  });

  it('a miss is null + unmasked, not an error', async () => {
    const ctx = { features: { cdp: buildCdpSurface({ tenantId: `org:clnp3-miss-${Date.now()}` }) }, inputs: { type: 'email', value: 'nobody@acme.test' } };
    const res = (await resolveIdentityNode(ctx)) as NodeResult;
    expect(res.outputs).toEqual({ resolved: null, masked: false });
  });
});

describe('CLNP-3 — the masked pack reaches a host that installs from the registry', () => {
  it('feature.ts pins feature.cdp.nodes at the manifest version (the pack rule\'s third step)', () => {
    // A bumped pack whose `requiredPacks` pin was not bumped installs the OLD, unmasked
    // node on any host without the vendored copy — green here, leaking there.
    const manifest = JSON.parse(readFileSync(new URL('../../../packs/feature.cdp.nodes/pack.json', import.meta.url), 'utf8')) as { version: string };
    expect(cdpFeature.requiredPacks).toContainEqual({ name: 'feature.cdp.nodes', version: manifest.version });
  });
});
