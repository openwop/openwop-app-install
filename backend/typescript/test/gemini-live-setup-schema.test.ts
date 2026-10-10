/**
 * Gemini Live setup payloads are VALID Gemini values — the class guard for the
 * 2026-10-08 `Gemini Live closed (1007: Request contains an invalid argument.)`.
 *
 * Finding: the ADR 0315 default-on baseline tool `openwop:walkthroughs.register-draft`
 * declared `steps.items: {type:'object'}` with NO properties — the ONLY value in the
 * default voice session's tool set outside Gemini's Schema subset (Gemini has rejected an
 * OBJECT without properties). `toGeminiSchema` filtered KEYWORDS only (the
 * `additionalProperties` precedent) and passed invalid VALUES through, and the baseline
 * put that tool into every agent-scoped voice session. Not confirmed against Google live.
 *
 * This test assembles the REAL tool universe (every registered builtin agent tool — the
 * only tools `resolveAgentToolDecls` can offer) plus the REAL default session payloads
 * (the auth-token constraint and the SPA's `setup`), and validates every declaration
 * recursively. A future tool with an unrepresentable schema fails here, by name:
 *   - hard: every PROJECTED declaration validates except FREE-FORM members;
 *   - ratchet: free-form members (OBJECT without properties, untyped `{}`, ARRAY without
 *     items — no faithful Gemini spelling, so passed through) may not grow;
 *   - hard: the default-on baseline and the real default session payloads have NONE.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { DEFAULT_ON_AGENT_TOOL_IDS } from '../src/host/agentToolAllowlistService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { resolveAgentToolDecls } from '../src/features/voice/realtime/toolBridge.js';
import { buildGeminiConstraint, geminiLiveProvider } from '../src/features/voice/realtime/geminiLive.js';
import { sanitizeToolName } from '../src/providers/dispatchProviderTools.js';
import {
  geminiFreeFormPaths, geminiFunctionDeclarationViolations, geminiSchemaViolations,
  toGeminiFunctionDeclaration, toGeminiSchema,
} from '../src/providers/geminiSchema.js';

/** Free-form members that exist today, per tool. NO-GROWTH: shrink it by giving the
 *  member a typed schema (an OBJECT needs properties; every value needs a type); never
 *  add to it to make a new tool pass. A tool listed here is NOT in the default-on
 *  baseline — it reaches a Gemini Live session only through an agent's own allowlist. */
const KNOWN_FREE_FORM: Readonly<Record<string, readonly string[]>> = {
  'openwop:workflows.compose-and-run': ['.properties.definition', '.properties.inputs'],
  'openwop:workflows.propose': ['.properties.definition', '.properties.inputs'],
  'openwop:feature.crm.nodes.persist-segment': ['.properties.filters.items'],
  'openwop:destination-sync.dry-run': ['.properties.sample'],
  'openwop:destination-sync.run': ['.properties.records.items'],
  'openwop:cms.translate-section': ['.properties.data'],
  'openwop:cms.update-section-draft': ['.properties.data'],
  'openwop:assistant.upsert-commitment': ['.properties.owner', '.properties.source'],
  'openwop:assistant.enqueue-action': ['.properties.payload'],
  'openwop:documents.generate-from-template': ['.properties.params'],
  'openwop:priority-matrix.score-idea': ['.properties.scores'],
  'openwop:feature.workflow-author.nodes.validate': ['.properties.definition'],
  'openwop:feature.workflow-author.nodes.persist': ['.properties.definition'],
  'openwop:feature.builder-pair.nodes.suggest-edits': ['.properties.ops.items.properties.config', '.properties.ops.items.properties.value', '.properties.ops.items.properties.condition'],
  'openwop:interactive-artifacts.render': ['.properties.chart'],
  'openwop:slides.render': ['.properties.deck'],
  'openwop:app-builder.render': ['.properties.app'],
  'openwop:campaign-studio.render': ['.properties.campaign'],
  'openwop:drawings.render': ['.properties.drawing'],
  'openwop:cad.render': ['.properties.model'],
  'openwop:accessibility.check': ['.properties.images.items', '.properties.headings.items', '.properties.links.items', '.properties.colorPairs.items'],
  'openwop:discovery.create-rule': ['.properties.actions.items'],
  'openwop:funnels.draft': ['.properties.steps.items'],
  'openwop:entities.query': ['.properties.filters.items.properties.value'],
};

/** Mirror of the SPA's `setup` frame (frontend/react/src/chat/voice/realtimeClient.ts). */
function spaSetup(session: { model: string; instructions: string; tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }> }): Record<string, unknown> {
  return {
    model: `models/${session.model}`,
    systemInstruction: { parts: [{ text: session.instructions }] },
    ...(session.tools.length ? { tools: [{ functionDeclarations: session.tools.map((t) => ({
      name: t.name, description: t.description,
      ...(t.parameters && Object.keys(t.parameters).length > 0 ? { parameters: t.parameters } : {}),
    })) }] } : {}),
    generationConfig: { responseModalities: ['AUDIO'] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

/** The BidiGenerateContentSetup fields this host sends, and their value shape. */
function setupViolations(setup: Record<string, unknown>): string[] {
  const out: string[] = [];
  const allowed = new Set(['model', 'generationConfig', 'systemInstruction', 'tools', 'inputAudioTranscription', 'outputAudioTranscription']);
  for (const k of Object.keys(setup)) if (!allowed.has(k)) out.push(`setup.${k}: not a field this host sends`);
  if (typeof setup.model !== 'string' || !/^models\/[a-z0-9][a-z0-9.-]*$/.test(setup.model)) out.push(`setup.model: ${JSON.stringify(setup.model)}`);
  const gc = setup.generationConfig as { responseModalities?: unknown } | undefined;
  if (JSON.stringify(gc?.responseModalities) !== '["AUDIO"]') out.push('setup.generationConfig.responseModalities must be ["AUDIO"]');
  const tools = setup.tools as Array<{ functionDeclarations?: unknown[] }> | undefined;
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.length === 0) out.push('setup.tools: omit when empty');
    for (const [ti, t] of (tools ?? []).entries()) {
      if (!Array.isArray(t.functionDeclarations) || t.functionDeclarations.length === 0) out.push(`setup.tools[${ti}].functionDeclarations: empty`);
      for (const [i, d] of (t.functionDeclarations ?? []).entries()) {
        for (const v of geminiFunctionDeclarationViolations(d as Record<string, unknown>)) out.push(`setup.tools[${ti}].functionDeclarations[${i}] (${(d as { name?: string }).name}): ${v}`);
      }
    }
  }
  return out;
}

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  getAgentRegistry().register({
    agentId: 'probe.geminisetup.agent', persona: 'Gemini Setup Probe', modelClass: 'chat',
    systemPrompt: 'x', toolAllowlist: [], packName: 'test.geminisetup', packVersion: '0.0.1',
  });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('every offerable tool projects to a valid Gemini FunctionDeclaration', () => {
  it('the projected declaration of EVERY builtin agent tool validates', () => {
    const { resolveTool } = createAgentToolProvider({ tenantId: '_decls' });
    const ids = builtinAgentToolIds();
    expect(ids.length).toBeGreaterThan(50); // the universe is real, not an empty pass
    const failures: string[] = [];
    for (const id of ids) {
      const def = resolveTool(id);
      if (!def) continue;
      const decl = toGeminiFunctionDeclaration({ name: sanitizeToolName(def.name), description: def.description ?? '', parameters: def.inputSchema ?? { type: 'object' } });
      for (const v of geminiFunctionDeclarationViolations(decl, { allowFreeForm: true })) failures.push(`${id}: ${v}`);
    }
    expect(failures).toEqual([]);
  });

  it('free-form members do not grow (KNOWN_FREE_FORM is a no-growth ratchet)', () => {
    const { resolveTool } = createAgentToolProvider({ tenantId: '_decls' });
    for (const id of builtinAgentToolIds()) {
      const def = resolveTool(id);
      if (!def) continue;
      const found = geminiFreeFormPaths(toGeminiSchema(def.inputSchema ?? { type: 'object' }));
      expect(KNOWN_FREE_FORM[id] ?? [], `${id} has a member Gemini cannot express: ${found.join(', ')} — give it a typed schema (an OBJECT needs properties, every value needs a type)`).toEqual(expect.arrayContaining(found));
    }
  });

  it('the ADR 0315 default-on baseline (offered to EVERY agent) has no free-form member', () => {
    const { resolveTool } = createAgentToolProvider({ tenantId: '_decls' });
    for (const id of DEFAULT_ON_AGENT_TOOL_IDS) {
      const def = resolveTool(id);
      if (!def) continue;
      expect(geminiSchemaViolations(toGeminiSchema(def.inputSchema)), id).toEqual([]);
      expect(KNOWN_FREE_FORM[id], `${id} is in the baseline — it may not be ratcheted`).toBeUndefined();
    }
  });
});

describe('the REAL default voice-session payloads validate', () => {
  it('auth-token constraint + the SPA setup for an agent-scoped session (baseline tools)', async () => {
    const tools = await resolveAgentToolDecls('default', 'probe.geminisetup.agent');
    expect(tools.length).toBeGreaterThanOrEqual(DEFAULT_ON_AGENT_TOOL_IDS.length - 1);
    expect(tools.map((t) => t.name)).toContain(sanitizeToolName('openwop:walkthroughs.register-draft'));

    const constraint = buildGeminiConstraint(geminiLiveProvider.defaultModel, 'instructions', tools) as { uses: number; bidiGenerateContentSetup: Record<string, unknown> };
    expect(constraint.uses).toBe(1);
    expect(setupViolations(constraint.bidiGenerateContentSetup)).toEqual([]);

    const prev = process.env.OPENWOP_VOICE_MOCK;
    process.env.OPENWOP_VOICE_MOCK = 'true';
    try {
      const session = await geminiLiveProvider.createSession({ apiKey: 'unused-under-mock', instructions: 'instructions', tools });
      expect(setupViolations(spaSetup(session))).toEqual([]);
      // ONE converter: the client decls equal the constraint decls.
      const constraintDecls = (constraint.bidiGenerateContentSetup.tools as Array<{ functionDeclarations: unknown[] }>)[0]!.functionDeclarations;
      expect(((spaSetup(session).tools as Array<{ functionDeclarations: unknown[] }>)[0]!.functionDeclarations)).toEqual(constraintDecls);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_VOICE_MOCK; else process.env.OPENWOP_VOICE_MOCK = prev;
    }
  });

  it('an unscoped session (no tools) omits tools entirely on both payloads', async () => {
    const constraint = buildGeminiConstraint(geminiLiveProvider.defaultModel, 'i', []) as { bidiGenerateContentSetup: Record<string, unknown> };
    expect(constraint.bidiGenerateContentSetup.tools).toBeUndefined();
    expect(setupViolations(constraint.bidiGenerateContentSetup)).toEqual([]);
    expect(spaSetup({ model: 'm', instructions: 'i', tools: [] }).tools).toBeUndefined();
  });
});

describe('validator: each FREE-FORM class is caught and survives projection as a reported free-form path', () => {
  const freeForm: Record<string, [Record<string, unknown>, string[]]> = {
    'object without properties (the 2026-10-08 finding)': [{ type: 'object', properties: { steps: { type: 'array', items: { type: 'object' } }, name: { type: 'string' } }, required: ['name', 'steps'] }, ['.properties.steps.items']],
    'untyped any': [{ type: 'object', properties: { value: {}, k: { type: 'string' } } }, ['.properties.value']],
    'array without items': [{ type: 'object', properties: { a: { type: 'array' }, b: { type: 'string' } } }, ['.properties.a']],
  };
  for (const [label, [schema, paths]] of Object.entries(freeForm)) {
    it(label, () => {
      expect(geminiSchemaViolations(schema).some((v) => v.includes('free-form'))).toBe(true);
      expect(geminiFreeFormPaths(toGeminiSchema(schema))).toEqual(paths);
      expect(geminiSchemaViolations(toGeminiSchema(schema), { allowFreeForm: true })).toEqual([]);
    });
  }
});

describe('validator + converter: each normalisable bad-value class is CAUGHT raw and VALID projected', () => {
  const bad: Record<string, Record<string, unknown>> = {
    'type array': { type: 'object', properties: { x: { type: ['string', 'null'] } } },
    'nullable anyOf': { type: 'object', properties: { x: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } },
    'unsupported format': { type: 'object', properties: { u: { type: 'string', format: 'uri' } } },
    'non-string enum': { type: 'object', properties: { n: { type: 'integer', enum: [1, 2] } } },
    'required not in properties': { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'ghost'] },
    'unknown keyword': { type: 'object', properties: { a: { type: 'string', pattern: '^x$', const: 'x' } }, additionalProperties: false },
  };
  for (const [label, schema] of Object.entries(bad)) {
    it(label, () => {
      expect(geminiSchemaViolations(schema), 'the validator must catch the raw schema').not.toEqual([]);
      expect(geminiSchemaViolations(toGeminiSchema(schema)), 'the projection must be valid').toEqual([]);
    });
  }

  it('keeps the valid subset intact (nullable/format/enum survive when legal)', () => {
    const out = toGeminiSchema({
      type: 'object',
      properties: { when: { type: 'string', format: 'date-time' }, n: { type: ['integer', 'null'], format: 'int32' }, op: { type: 'string', enum: ['eq', 'neq'] } },
      required: ['op'],
    }) as Record<string, any>;
    expect(out.properties.when.format).toBe('date-time');
    expect(out.properties.n).toEqual({ type: 'integer', format: 'int32', nullable: true });
    expect(out.properties.op.enum).toEqual(['eq', 'neq']);
    expect(out.required).toEqual(['op']);
  });

  it('free-form members are REPORTED, never silently dropped (a required render payload must survive)', () => {
    const schema = { type: 'object', properties: { app: { type: 'object', description: 'payload' } }, required: ['app'] };
    const decl = toGeminiFunctionDeclaration({ name: 't', description: 'd', parameters: schema });
    expect(decl.parameters).toEqual(schema);
    expect(geminiFreeFormPaths(decl.parameters)).toEqual(['.properties.app']);
  });
});
