/**
 * CFP-1 — the Brand Steward's chat tools (feature.brand.agents). Before this the
 * pack allowlisted raw `feature.brand.nodes.*` typeIds that project into NO
 * conversational tool, so the Steward resolved zero tools. These tests boot the
 * REAL app (the ADR 0308 registration seam) and assert the three read tools
 * register, share the brand routes' org-scope authority, and fail EMPTY without
 * an acting user. Brand is always-on/core (ADR 0170) — no toggle gate.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  BRAND_LIST_TOOL_ID,
  BRAND_RESOLVE_VOICE_TOOL_ID,
  BRAND_COMPLIANCE_CHECK_TOOL_ID,
} from '../src/features/brand/agentTools.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrand } from '../src/features/brand/brandService.js';

const TENANT = 'default';
const ALL_IDS = [BRAND_LIST_TOOL_ID, BRAND_RESOLVE_VOICE_TOOL_ID, BRAND_COMPLIANCE_CHECK_TOOL_ID];

let server: http.Server;
let orgId: string;
let brandId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
  const brand = await createBrand(TENANT, orgId, 'u-1', {
    name: 'Acme Brand',
    keyPhrases: { bannedPhrases: ['synergy'] },
  } as never);
  brandId = brand.id;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('CFP-1 — brand agent tools register + resolve', () => {
  it('all three tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('the pack allowlist is exactly the three registered tool ids', () => {
    const packDir = new URL('../../../packs/feature.brand.agents/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as { agents: { toolAllowlist: string[] }[] };
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...ALL_IDS].sort());
    // Every allowlist entry is offerable at dispatch (the CFP-1 tripwire, locally).
    const universe = new Set(builtinAgentToolIds());
    for (const id of manifest.agents[0]!.toolAllowlist) expect(universe.has(id)).toBe(true);
  });
});

describe('CFP-1 — brand tools: authority + empty-without-acting-user', () => {
  it('list-brands returns the readable brand for its org owner', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: BRAND_LIST_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { brands: { brandId: string; bannedPhraseCount: number }[] };
    const row = parsed.brands.find((b) => b.brandId === brandId);
    expect(row).toBeTruthy();
    expect(row!.bannedPhraseCount).toBe(1);
  });

  it('list-brands fails EMPTY (not error) without an acting user', async () => {
    const out = await provider().executeTool({ name: BRAND_LIST_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { brands: unknown[]; note?: string };
    expect(parsed.brands).toEqual([]);
    expect(parsed.note).toBeTruthy();
  });

  it('list-brands never leaks a brand to a non-member', async () => {
    const out = await provider({ actingUserId: 'stranger' }).executeTool({ name: BRAND_LIST_TOOL_ID, input: {} });
    const parsed = JSON.parse(out.content) as { brands: { brandId: string }[] };
    expect(parsed.brands.some((b) => b.brandId === brandId)).toBe(false);
  });

  it('resolve-voice renders the voice for a readable brand; unknown is null', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const ok = await p.executeTool({ name: BRAND_RESOLVE_VOICE_TOOL_ID, input: { brandId } });
    expect(ok.isError).toBeFalsy();
    const parsed = JSON.parse(ok.content) as { voice: string | null };
    expect(typeof parsed.voice).toBe('string');
    expect((parsed.voice ?? '').length).toBeGreaterThan(0);

    const missing = await p.executeTool({ name: BRAND_RESOLVE_VOICE_TOOL_ID, input: { brandId: 'brand-nope' } });
    expect(JSON.parse(missing.content)).toMatchObject({ voice: null });
  });

  it('resolve-voice validates its input (missing brandId → typed error)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: BRAND_RESOLVE_VOICE_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });

  it('compliance-check scores content and flags the banned phrase', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: BRAND_COMPLIANCE_CHECK_TOOL_ID,
      input: { brandId, content: 'Our platform is all about synergy and results.' },
    });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { report: { deterministicScore: number } | null };
    expect(parsed.report).toBeTruthy();
    expect(parsed.report!.deterministicScore).toBeLessThanOrEqual(30); // banned-phrase ceiling
  });

  it('compliance-check requires content', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: BRAND_COMPLIANCE_CHECK_TOOL_ID, input: { brandId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });
});
