/** ADR 0346 4c — the typed app.research secondary deliverable: the artifact-type
 *  pack registers the schema, the research node emits the `.artifact` envelope,
 *  and the two agree (detectTypedArtifact would fall through otherwise). */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadArtifactTypePacks } from '../../../host/artifactTypePackLoader.js';
import { validateArtifact } from '../../../host/artifactTypes.js';
import { locateRepoDir } from '../../../host/_repoPath.js';

const packsRoot = (): string => locateRepoDir(new URL('.', import.meta.url).pathname, 'packs', 'feature.app-builder.artifact-types/pack.json');

beforeAll(() => { loadArtifactTypePacks({ roots: [packsRoot()] }); });

describe('feature.app-builder.artifact-types', () => {
  it('registers app.research (pack-sourced) and validates a real research payload', () => {
    const payload = {
      personas: [{ name: 'Ada', role: 'Runner', goals: ['track runs'], frustrations: ['clunky apps'] }],
      brand: { tone: 'warm', voice: 'direct', personality: ['friendly'] },
      visualDirection: { style: 'clean', themePrimary: '#7c5cff', themeSecondary: '#22d3ee', imagery: 'motion' },
    };
    const v = validateArtifact('app.research', payload);
    expect(v.registered).toBe(true);
    expect(v.registrationSource).toBe('pack');
    expect(v.valid).toBe(true);
    // Bounded: an open-world payload is rejected (closed schemas, never `{}`).
    expect(validateArtifact('app.research', { personas: [{ name: 'x' }], evil: 'y' }).valid).toBe(false);
  });

  it('the research node emits a `.artifact` envelope that VALIDATES against the pack schema', async () => {
    const { research } = await import('../../../../../../packs/feature.app-builder.nodes/index.mjs');
    const content = JSON.stringify({
      personas: [{ name: 'Ada', role: 'Runner', goals: ['g'], frustrations: ['f'] }],
      brand: { tone: 't', voice: 'v', personality: ['p'] },
      visualDirection: { style: 's', themePrimary: '#123abc', themeSecondary: '#abc123', imagery: 'i' },
    });
    const res = await research({ inputs: { idea: 'i', prd: 'p' }, config: {}, callAI: async () => ({ content }) });
    const env = res.outputs.artifact as { artifactTypeId: string; payload: unknown; title: string };
    expect(env.artifactTypeId).toBe('app.research');
    expect(env.title).toBe('Product research');
    expect(validateArtifact(env.artifactTypeId, env.payload).valid).toBe(true);
    // Soft-fail path emits NO envelope (nothing pretends to be research).
    const bad = await research({ inputs: { prd: 'p' }, config: {}, callAI: async () => ({ content: 'not json' }) });
    expect(bad.outputs.artifact).toBeUndefined();
  });
});
