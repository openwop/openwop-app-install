/**
 * Docs MCP tools + surface + llms.txt (ADR 0392 Phases 3-4).
 *  - PARITY: the SSoT const (`DOCS_MCP_TOOLS`) ↔ the expose-tool workflows ↔ the
 *    `feature.docs.nodes` pack manifest cannot drift (the agent-prompt-tool-ids
 *    precedent).
 *  - SURFACE: ctx.features.docs search/get over the managed docs KB collection.
 *  - llms.txt: published docs listed with absolute /docs URLs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage, transitionPage, type Page } from '../src/features/cms/cmsService.js';
import { syncDocsPage } from '../src/features/docs/docsKnowledgeService.js';
import { buildDocsSurface } from '../src/features/docs/surface.js';
import { DOCS_MCP_TOOLS } from '../src/features/docs/docsMcpSchemas.js';
import { docsMcpToolWorkflows, DOCS_MCP_WORKFLOW_PREFIX } from '../src/features/docs/mcpToolsWorkflows.js';

describe('docs MCP — SSoT parity (no drift)', () => {
  const packManifest = JSON.parse(readFileSync(join(process.cwd(), '../../packs/feature.docs.nodes/pack.json'), 'utf8')) as { nodes: Array<{ typeId: string }> };
  const nodeTypeIds = new Set(packManifest.nodes.map((n) => n.typeId));

  it('every SSoT tool has a workflow whose backing node exists in the pack, gated read-only', () => {
    for (const spec of DOCS_MCP_TOOLS) {
      const wf = docsMcpToolWorkflows.find((w) => w.workflowId === `${DOCS_MCP_WORKFLOW_PREFIX}${spec.name}`);
      expect(wf, `workflow for ${spec.name}`).toBeTruthy();
      // the expose node carries the SSoT inputSchema verbatim (no drift)
      const expose = wf!.nodes.find((n) => n.nodeId === 'expose')!;
      expect((expose.config as { inputSchema: unknown }).inputSchema).toEqual(spec.inputSchema);
      const backing = wf!.nodes.find((n) => n.nodeId === 'backing')!;
      expect(backing.typeId).toBe(spec.backingType);
      expect(nodeTypeIds.has(spec.backingType)).toBe(true); // the pack ships the backing node
      expect(wf!.metadata).toMatchObject({ mcpFeatureToggle: 'docs', mcpRequiresAuth: true, mcpSafetyTier: 'read', mcpApproval: 'never' });
    }
  });

  it('the pack ships exactly the SSoT backing nodes (no dead nodes)', () => {
    expect([...nodeTypeIds].sort()).toEqual(DOCS_MCP_TOOLS.map((t) => t.backingType).sort());
  });
});

describe('ctx.features.docs surface + llms.txt', () => {
  let BASE: string;
  let server: http.Server;
  let TENANT = '';
  let ORG = '';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['docs', 'users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
    // A REAL tenant + org (getOrg must resolve for the public /docs + llms.txt routes).
    let cookie = '';
    const call = async (path: string, body: unknown): Promise<any> => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return res.json();
    };
    const login = await call('/v1/host/openwop-app/test/login', { email: `docsmcp-${Date.now()}@acme.test` });
    TENANT = login.user.tenantId ?? login.tenantId;
    const org = await call('/v1/host/openwop-app/orgs', { name: 'Docs Co' });
    ORG = org.orgId;
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function publishDoc(slug: string, title: string, body: string): Promise<Page> {
    const page = await createPage({ tenantId: TENANT, orgId: ORG, title, slug, collection: 'docs', sections: [{ type: 'richText', data: { heading: title, text: body } }] as unknown, createdBy: 'u1' });
    const pub = await transitionPage(TENANT, ORG, page.pageId, 'publish', 'u1');
    await syncDocsPage({ tenantId: TENANT, orgId: ORG, pageId: page.pageId, slug, title, collection: 'docs', event: 'published' });
    return pub!;
  }

  it('search returns hits with /docs URLs; get returns the doc by slug', async () => {
    await publishDoc('install', 'Installation', 'Run npm install to set up the toolkit.');
    const surface = buildDocsSurface({ tenantId: TENANT });

    const search = await surface.search({ query: 'install the toolkit' }) as { hits: Array<{ url: string; title: string }> };
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0]!.url).toBe('/docs/install');

    const got = await surface.get({ slug: 'install' }) as { doc: { title: string; url: string; text: string } | null };
    expect(got.doc?.title).toBe('Installation');
    expect(got.doc?.url).toBe('/docs/install');
    expect(got.doc?.text).toContain('npm install');

    const miss = await surface.get({ slug: 'nonexistent' }) as { doc: unknown };
    expect(miss.doc).toBeNull();
  });

  it('llms.txt lists published docs with absolute /docs URLs', async () => {
    await publishDoc('guide', 'The Guide', 'How to use it.');
    const res = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(ORG)}/llms.txt`);
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt).toContain('## Docs');
    expect(txt).toMatch(/- \[The Guide\]\(https?:\/\/[^)]+\/docs\/guide\)/);
  });

  // R2-D11 (UX_UPGRADE-docs round 2) — llms.txt is a CHANNEL now: per-line
  // freshness, the operator's site name, and the ROOT door agents actually probe.
  it('llms.txt carries per-line updated dates and honors OPENWOP_PUBLIC_SITE_NAME', async () => {
    process.env.OPENWOP_PUBLIC_SITE_NAME = 'Acme Product';
    try {
      const res = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(ORG)}/llms.txt`);
      const txt = await res.text();
      expect(txt.startsWith('# Acme Product')).toBe(true);
      expect(txt).toMatch(/- \[The Guide\]\([^)]+\) - updated \d{4}-\d{2}-\d{2}/);
    } finally {
      delete process.env.OPENWOP_PUBLIC_SITE_NAME;
    }
  });

  it('the ROOT /llms.txt door serves the configured site org and 404s when unset', async () => {
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = ORG;
    try {
      const res = await fetch(`${BASE}/llms.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('/docs/guide');
    } finally {
      delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
    }
    const missing = await fetch(`${BASE}/llms.txt`);
    expect(missing.status).toBe(404);
  });

  // R2-D12 — the `.md` page door (the append-`.md` convention).
  it('GET pages/:slug.md serves the page as one markdown document; unknown slug 404s', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(ORG)}/pages/guide.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('markdown');
    const md = await res.text();
    expect(md).toContain('# The Guide');
    expect(md).toContain('How to use it.');
    expect(md).toMatch(/\*Updated \d{4}-\d{2}-\d{2}\*/);

    const miss = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(ORG)}/pages/nope.md`);
    expect(miss.status).toBe(404);
  });
});
