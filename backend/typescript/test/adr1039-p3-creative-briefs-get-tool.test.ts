/**
 * ADR 1039 D8 (CB82XC-1) — `openwop:creative-briefs.get`: the Creative Director
 * reads a brief before directing work on it.
 *
 * Red when: the tool is not registered or not schema-carrying (its `directions[]`
 * order is what `directionIndex` cites, so compaction must never touch it); it
 * stops failing closed with the toggle off, or stops failing EMPTY without an
 * acting user; a non-member, a write-only custom role (the route asks EXACTLY
 * `workspace:read`) or a brief in another org reads it; the directions lose their
 * index; a deleted mood-board asset id leaks out; or the Creative Director is no
 * longer allowlisted for it.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentTool } from '../src/host/agentToolProvider.js';
import { CREATIVE_BRIEFS_GET_TOOL_ID, CREATIVE_BRIEFS_LIST_TOOL_ID } from '../src/features/creative-briefs/agentTools.js';
import { createBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { createOrg, createCustomRole, createMember } from '../src/host/accessControlService.js';
import { createAsset } from '../src/features/media/mediaService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TENANT = 'cb-p3-tool';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const run = (name: string, input: Record<string, unknown> = {}, scope: { actingUserId?: string } = {}) =>
  createAgentToolProvider({ tenantId: TENANT, runId: 'run-cb-p3', ...scope }).executeTool({ name, input });
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;
const setToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('creative-briefs');
  if (d) await saveConfig({ ...d, status }, 'test');
};

async function orgWithBrief(owner: string): Promise<{ orgId: string; briefId: string }> {
  const org = await createOrg({ tenantId: TENANT, createdBy: owner, name: `Org ${owner}`, ownerSubject: owner });
  const kept = await createAsset({ tenantId: TENANT, orgId: org.orgId, name: 'hero.png', contentType: 'image/png', sizeBytes: 10, storageRef: 'blob:x', serveToken: 'tok-x', uploadedBy: owner, tags: [] });
  const brief = await createBrief(TENANT, org.orgId, owner, {
    title: 'Spring hero', sceneDescription: 'A hiker at dawn',
    directions: [{ label: 'Product in use', rationale: 'Show the outcome' }, { label: 'Before / after' }],
    moodBoard: [{ mediaAssetId: kept.assetId, note: 'matched: hero' }, { mediaAssetId: 'masset:deleted' }],
  });
  return { orgId: org.orgId, briefId: brief.briefId };
}

describe('ADR 1039 D8 — openwop:creative-briefs.get', () => {
  it('is registered, read-only and schema-carrying', () => {
    const tool = builtinAgentTool(CREATIVE_BRIEFS_GET_TOOL_ID);
    expect(tool).toBeDefined();
    expect(tool?.schemaCarrying).toBe(true);
  });

  it('fails closed with the toggle off, and EMPTY without an acting user', async () => {
    await setToggle('off');
    const off = await run(CREATIVE_BRIEFS_GET_TOOL_ID, { briefId: 'cbrief:x' }, { actingUserId: 'u-off' });
    expect(off.isError).toBe(true);
    expect(parse(off).error).toBe('feature_disabled');
    await setToggle('on');
    const anon = parse(await run(CREATIVE_BRIEFS_GET_TOOL_ID, { briefId: 'cbrief:x' }));
    expect(anon.found).toBe(false);
    expect(String(anon.note)).toContain('No acting user');
  });

  it('a member reads the brief with indexed directions and only resolvable mood-board assets', async () => {
    await setToggle('on');
    const { orgId, briefId } = await orgWithBrief('u-cd-owner');
    const out = parse(await run(CREATIVE_BRIEFS_GET_TOOL_ID, { orgId, briefId }, { actingUserId: 'u-cd-owner' }));
    const brief = out.brief as { title: string; directions: Array<{ index: number; label: string }>; moodBoard: Array<{ mediaAssetId: string; name: string }> };
    expect(brief.title).toBe('Spring hero');
    expect(brief.directions).toEqual([{ index: 0, label: 'Product in use', rationale: 'Show the outcome' }, { index: 1, label: 'Before / after' }]);
    expect(brief.moodBoard.map((m) => m.name)).toEqual(['hero.png']);
    expect(JSON.stringify(out)).not.toContain('masset:deleted');
    expect(JSON.stringify(out)).not.toContain('tok-x');
    expect(Array.isArray(out.issues)).toBe(true);
  });

  it('a non-member, a write-only custom role, and a brief of another org all read as not_found', async () => {
    await setToggle('on');
    const a = await orgWithBrief('u-a-owner');
    const b = await orgWithBrief('u-b-owner');
    const stranger = await run(CREATIVE_BRIEFS_GET_TOOL_ID, { orgId: a.orgId, briefId: a.briefId }, { actingUserId: 'u-stranger' });
    expect(parse(stranger).error).toBe('not_found');
    const role = await createCustomRole({ orgId: a.orgId, tenantId: TENANT, name: 'write-only', scopes: ['workspace:write'] });
    await createMember({ orgId: a.orgId, tenantId: TENANT, displayName: 'W', subject: 'u-write-only', roles: [role.roleId] });
    const writeOnly = await run(CREATIVE_BRIEFS_GET_TOOL_ID, { orgId: a.orgId, briefId: a.briefId }, { actingUserId: 'u-write-only' });
    expect(parse(writeOnly).error).toBe('not_found');
    // B's owner names A's brief under B's org: the brief is keyed by org, so it is not there.
    const crossOrg = await run(CREATIVE_BRIEFS_GET_TOOL_ID, { orgId: b.orgId, briefId: a.briefId }, { actingUserId: 'u-b-owner' });
    expect(parse(crossOrg).error).toBe('not_found');
    // The list tool shares the gate.
    const listStranger = await run(CREATIVE_BRIEFS_LIST_TOOL_ID, { orgId: a.orgId }, { actingUserId: 'u-stranger' });
    expect(parse(listStranger).error).toBe('not_found');
  });

  it('the Creative Director is allowlisted for it and its prompt teaches it', () => {
    const packs = join(dirname(fileURLToPath(import.meta.url)), '../../../packs/vendor.openwop-app.campaign-studio.agents');
    const pack = JSON.parse(readFileSync(join(packs, 'pack.json'), 'utf8')) as { agents: Array<{ agentId: string; toolAllowlist?: string[] }> };
    const cd = pack.agents.find((a) => a.agentId === 'vendor.openwop-app.campaign-studio.agents.creative-director');
    expect(cd?.toolAllowlist).toContain(CREATIVE_BRIEFS_GET_TOOL_ID);
    expect(readFileSync(join(packs, 'prompts/creative-director.md'), 'utf8')).toContain(CREATIVE_BRIEFS_GET_TOOL_ID);
  });
});
