/**
 * ADR 0399 Phase 3 — pack + surface pins:
 *  - feature.creative-briefs.nodes manifest ↔ feature.ts requiredPacks version
 *    (the crm.nodes three-place pin discipline);
 *  - the render node's hand-carried template-id vocabulary is TEST-PINNED to
 *    the live catalog (the promptCatalogParity rule — a model reading the
 *    manifest must never see a template id the app won't accept, or miss one
 *    it would);
 *  - the Channel Generator's toolAllowlist references only REAL node typeIds;
 *  - the ctx.features surface renders through the same service path as HTTP.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { creativeBriefsFeature } from '../src/features/creative-briefs/feature.js';
import { AD_LAYOUT_TEMPLATES } from '../src/features/creative-briefs/render/templates.js';
import { compositeHashOf } from '../src/features/creative-briefs/render/renderService.js';
import { RENDERER_VERSION } from '../src/features/creative-briefs/render/renderCreative.js';
import { BUNDLED_FONTS_VERSION } from '../src/features/creative-briefs/render/fonts.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const NODES_PACK = join(REPO_ROOT, 'packs', 'feature.creative-briefs.nodes', 'pack.json');
const AGENTS_PACK = join(REPO_ROOT, 'packs', 'feature.campaign-channels.agents', 'pack.json');

interface NodesManifest { name: string; version: string; nodes: Array<{ typeId: string; description: string }> }
interface AgentsManifest { agents: Array<{ agentId: string; toolAllowlist: string[] }> }

const manifest = JSON.parse(readFileSync(NODES_PACK, 'utf8')) as NodesManifest;

describe('creative-briefs render pack pins (ADR 0399 P3)', () => {
  it('feature.ts requiredPacks pin matches the pack manifest version', () => {
    const pin = creativeBriefsFeature.requiredPacks?.find((p) => p.name === 'feature.creative-briefs.nodes');
    expect(pin).toBeTruthy();
    expect(pin?.version).toBe(manifest.version);
  });

  it('declares the three ADR 0399 render nodes', () => {
    const ids = manifest.nodes.map((n) => n.typeId);
    expect(ids).toContain('feature.creative-briefs.nodes.render');
    expect(ids).toContain('feature.creative-briefs.nodes.render-variants');
    expect(ids).toContain('feature.creative-briefs.nodes.list-render-templates');
  });

  it('the render node description’s template-id vocabulary === the live catalog (both directions)', () => {
    const desc = manifest.nodes.find((n) => n.typeId === 'feature.creative-briefs.nodes.render')?.description ?? '';
    for (const t of AD_LAYOUT_TEMPLATES) {
      expect(desc, `manifest must name ${t.templateId}`).toContain(t.templateId);
    }
    // Inverse tripwire: every dotted id-looking token in the description that
    // matches a template-id shape must exist in the catalog (no phantom ids).
    const claimed = desc.match(/\b(?:meta|tiktok|linkedin|google)\.[a-z0-9.]+\b/g) ?? [];
    const live = new Set(AD_LAYOUT_TEMPLATES.map((t) => t.templateId));
    for (const id of claimed) {
      expect(live.has(id), `manifest names phantom template id ${id}`).toBe(true);
    }
    expect(claimed.length).toBeGreaterThanOrEqual(live.size);
  });

  it('the Channel Generator names no PHANTOM creative-briefs node typeIds', () => {
    // ADR 0399 P3 invariant: any creative-briefs id an agent allowlists must be a
    // REAL declared node. CFP-1 replaced the dead `feature.creative-briefs.nodes.*`
    // typeIds (no provider projected them into conversational tools) with the
    // Channel Generator's OWN registered `openwop:campaign-channels.*` tools, so
    // it now names ZERO creative-briefs ids. The no-phantom guard still holds
    // (vacuously) — the render nodes remain reachable via workflows, not chat.
    const agents = JSON.parse(readFileSync(AGENTS_PACK, 'utf8')) as AgentsManifest;
    const allow = agents.agents[0]?.toolAllowlist ?? [];
    const cbTools = allow.filter((t) => t.includes('creative-briefs'));
    expect(cbTools.length).toBe(0);
    const real = new Set(manifest.nodes.map((n) => `openwop:${n.typeId}`));
    for (const t of cbTools) expect(real.has(t), `allowlisted ${t} must be a declared node`).toBe(true);
  });
});

describe('replay pinning (ADR 0399 P4)', () => {
  it('render nodes are role:action — recorded results, read verbatim on replay', () => {
    for (const id of ['render', 'render-variants', 'list-render-templates']) {
      const n = manifest.nodes.find((x) => x.typeId === `feature.creative-briefs.nodes.${id}`) as { role?: string } | undefined;
      expect(n?.role, id).toBe('action');
    }
  });

  it('RENDERER_VERSION pins the EXACT @resvg/resvg-js dependency version', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const dep = pkg.dependencies['@resvg/resvg-js'];
    expect(dep, 'dependency must be exact-pinned (no ^/~) — resvg output is version-sensitive').toMatch(/^\d/);
    expect(RENDERER_VERSION).toContain(`resvg-${dep}`);
    expect(RENDERER_VERSION).toContain(BUNDLED_FONTS_VERSION);
  });

  it('the composite hash is sensitive to every determinism input', () => {
    const template = AD_LAYOUT_TEMPLATES[0]!;
    const base = {
      briefSnapshot: { briefId: 'b1', version: 3 },
      template,
      copy: { headline: 'H' },
      layerAssets: { background: { mediaAssetId: 'masset:a', sha256: 'a'.repeat(64) } },
      brand: { colors: { ink: '#111111', paper: '#ffffff', accent: '#3b5bdb', accentInk: '#ffffff' }, fontFamilies: { sans: 'Inter', serif: 'PT Serif' } },
    };
    const h = compositeHashOf(base);
    expect(compositeHashOf({ ...base })).toBe(h); // stable
    expect(compositeHashOf({ ...base, copy: { headline: 'H2' } })).not.toBe(h);
    expect(compositeHashOf({ ...base, briefSnapshot: { briefId: 'b1', version: 4 } })).not.toBe(h);
    expect(compositeHashOf({ ...base, layerAssets: { background: { mediaAssetId: 'masset:a', sha256: 'b'.repeat(64) } } })).not.toBe(h);
    expect(compositeHashOf({ ...base, template: { ...template, version: template.version + 1 } })).not.toBe(h);
    expect(compositeHashOf({ ...base, overrides: { headline: { dx: 5 } } })).not.toBe(h);
    expect(compositeHashOf({ ...base, logoSha: 'c'.repeat(64) })).not.toBe(h);
    expect(compositeHashOf({ ...base, brand: { ...base.brand, colors: { ...base.brand.colors, accent: '#ff0000' } } })).not.toBe(h);
  });
});
