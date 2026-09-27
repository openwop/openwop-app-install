/** ADR 0344 2b — hidden/locked authoring traits at the backend boundaries:
 *  both artifact schemas accept them (additive), the editor validator keeps
 *  accepting documents that carry them, and hidden subtrees NEVER reach
 *  generated source (one shared stripHidden pass, all 7 targets). */
import { describe, it, expect, beforeAll } from 'vitest';
import { validateArtifact } from '../../../host/artifactTypes.js';
import { registerAppBuilderArtifactType } from '../artifactTypes.js';
import { registerAppBuilderComponents } from '../componentCatalog.js';
import { registerSlidesArtifactType } from '../../slides/artifactTypes.js';
import { validateAppDoc } from '../validateAppDoc.js';
import { generate, stripHidden, EXPORT_TARGETS, type AppModel } from '../export/generators.js';

beforeAll(() => {
  registerAppBuilderArtifactType();
  registerAppBuilderComponents();
  registerSlidesArtifactType();
});

const appDoc = {
  name: 'Traits',
  screens: [{
    id: 'home', name: 'Home', isInitial: true,
    components: [
      { type: 'text', props: { text: 'VISIBLE_MARKER' } },
      { type: 'stack', hidden: true, children: [{ type: 'text', props: { text: 'HIDDEN_MARKER' } }] },
      { type: 'button', props: { label: 'Locked' }, locked: true },
    ],
  }],
};

describe('schemas accept the traits (additive)', () => {
  it('canvas.app-builder', () => {
    expect(validateArtifact('canvas.app-builder', appDoc).valid).toBe(true);
    expect(validateAppDoc(appDoc).errors).toEqual([]);
  });
  it('canvas.slides', () => {
    const deck = { slides: [{ layout: 'blocks', blocks: [{ type: 'text', props: { text: 'x' }, hidden: true, locked: true }] }] };
    const v = validateArtifact('canvas.slides', deck);
    expect(v.errors ?? []).toEqual([]);
    expect(v.valid).toBe(true);
  });
});

describe('stripHidden', () => {
  it('drops hidden subtrees, keeps locked nodes (locked is editor-only)', () => {
    const out = stripHidden(appDoc as AppModel);
    const types = (out.screens[0]!.components ?? []).map((c) => c.type);
    expect(types).toEqual(['text', 'button']);
  });
  it('every export target excludes hidden content, keeps visible + locked', () => {
    for (const target of EXPORT_TARGETS) {
      const src = generate(target, appDoc as AppModel).files.map((f) => f.content).join('\n');
      expect(src, target).toContain('VISIBLE_MARKER');
      expect(src, target).not.toContain('HIDDEN_MARKER');
      expect(src, target).toContain('Locked');
    }
  });
});
