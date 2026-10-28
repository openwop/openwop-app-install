/**
 * ADR 0937 (Book AI SRV-2) — a pack node entry's `x-localizations` puts its
 * palette label and description in the reader's language.
 *
 * The node catalog route resolves them for `Accept-Language` through the one
 * chain every localized surface here shares (exact → script family → language →
 * base, `resolveLocalizedValues`). It serves one locale, never the overlay map,
 * and says which locale it served.
 *
 * Sabotage: dropping the route's `localizeCatalogNode` call reds the pt-BR case;
 * resolving the exact tag only (no language family) reds the `pt-PT` case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { localizeCatalogNode, readNodeLocalizations, type CatalogNode } from '../src/host/nodeCatalogBuilder.js';

const TYPE_ID = 'adr0937.demo.nodes.draft-scene';
let server: http.Server;
let BASE = '';
let packDir = '';
const savedPackDir = process.env.OPENWOP_PACK_DIR;

beforeAll(async () => {
  packDir = mkdtempSync(join(tmpdir(), 'adr0937-'));
  mkdirSync(join(packDir, 'adr0937.demo.nodes'));
  writeFileSync(join(packDir, 'adr0937.demo.nodes', 'pack.json'), JSON.stringify({
    name: 'adr0937.demo.nodes',
    version: '1.0.0',
    nodes: [{
      typeId: TYPE_ID,
      version: '1.0.0',
      label: 'Draft a scene',
      description: 'Writes the next scene from the outline.',
      'x-localizations': {
        pt: { label: 'Escrever uma cena', description: 'Escreve a próxima cena a partir do roteiro.' },
        'pt-BR': { label: 'Rascunhar uma cena' },
        'bad tag': { label: 'dropped' },
      },
    }],
  }));
  process.env.OPENWOP_PACK_DIR = packDir;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (savedPackDir === undefined) delete process.env.OPENWOP_PACK_DIR; else process.env.OPENWOP_PACK_DIR = savedPackDir;
  rmSync(packDir, { recursive: true, force: true });
});

async function catalog(acceptLanguage?: string): Promise<{ node: CatalogNode | undefined; contentLanguage: string | null; vary: string | null }> {
  const res = await fetch(`${BASE}/host/openwop-app/node-catalog`, {
    headers: { authorization: 'Bearer dev-token', ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}) },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { nodes: CatalogNode[] };
  return { node: body.nodes.find((n) => n.typeId === TYPE_ID), contentLanguage: res.headers.get('content-language'), vary: res.headers.get('vary') };
}

describe('ADR 0937 — the palette speaks the reader\'s language', () => {
  it('pt-BR gets its exact overlay over the base, and the response says so', async () => {
    const { node, contentLanguage, vary } = await catalog('pt-BR,pt;q=0.9,en;q=0.5');
    expect(node?.label).toBe('Rascunhar uma cena');
    // pt-BR overlays only the label; the description stays the base (a shallow overlay, as for sections).
    expect(node?.description).toBe('Writes the next scene from the outline.');
    expect(contentLanguage).toBe('pt-BR');
    expect(vary?.toLowerCase()).toContain('accept-language');
    expect(node).not.toHaveProperty('localizations');
  });

  it('pt-PT falls back to the language overlay', async () => {
    const { node, contentLanguage } = await catalog('pt-PT');
    expect(node?.label).toBe('Escrever uma cena');
    expect(contentLanguage, 'the locale SERVED, not the one asked for').toBe('pt');
    expect(node?.description).toBe('Escreve a próxima cena a partir do roteiro.');
  });

  it('no header, or a locale with no overlay, serves the pack\'s own text and no Content-Language', async () => {
    for (const lang of [undefined, 'de-DE']) {
      const { node, contentLanguage } = await catalog(lang);
      expect(node?.label).toBe('Draft a scene');
      expect(contentLanguage).toBeNull();
    }
  });
});

describe('ADR 0937 — the pieces', () => {
  it('readNodeLocalizations keeps well-formed tags and bounded, non-empty strings only', () => {
    expect(readNodeLocalizations({
      'zh-Hant': { label: '撰寫場景' },
      'pt-BR': { label: '   ', description: 'ok' },
      'bad tag': { label: 'x' },
      fr: { label: 'x'.repeat(121) },
      de: 'not an object',
    })).toEqual({ 'zh-Hant': { label: '撰寫場景' }, 'pt-BR': { description: 'ok' } });
    expect(readNodeLocalizations(undefined)).toBeUndefined();
    expect(readNodeLocalizations({ 'bad tag': { label: 'x' } })).toBeUndefined();
  });

  it('a script-family overlay wins over the language family (zh-Hant-TW never reads a zh overlay)', () => {
    const node = { typeId: 't', label: 'Draft', description: '', category: 'flow', source: 'pack', requiresHostSurfaces: [], missingHostSurfaces: [],
      localizations: { zh: { label: '撰写' }, 'zh-Hant': { label: '撰寫' } } } as CatalogNode;
    expect(localizeCatalogNode(node, 'zh-Hant-TW', 'en').node.label).toBe('撰寫');
    expect(localizeCatalogNode(node, 'zh-CN', 'en').node.label).toBe('撰写');
  });
});
