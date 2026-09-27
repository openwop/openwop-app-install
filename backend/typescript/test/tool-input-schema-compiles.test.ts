/**
 * ADR 0547 P4 — every registered tool's `inputSchema` MUST compile.
 *
 * Why this exists: `agentDispatch.compileToolValidator` (`:506`) catches a
 * compile failure and returns a PERMISSIVE validator — `() => ({ ok: true })`.
 * So a tool whose schema does not compile has NO argument validation on the
 * chat path, silently, forever. It logs `agent_tool_schema_compile_failed` and
 * ships anyway; the log has never been the thing that catches it.
 *
 * The failure is reachable, not theoretical. Ajv2020 with `strict:false` throws
 * on exactly the mistakes a hand-written schema makes — and all of these are
 * hand-written:
 *
 *   THROWS   bad $ref     can't resolve reference #/definitions/nope
 *   THROWS   bad regex    Invalid regular expression: /[/u
 *   THROWS   bogus type   .../type must be equal to one of the allowed values
 *   COMPILES unknown keyword (`propertyz`) — the one that does NOT throw
 *
 * This moves the whole class from runtime to CI, where a broken schema is a red
 * build naming the tool instead of a guard that quietly stopped guarding.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { createApp } from '../src/index.js';
import { builtinAgentTool, builtinAgentToolIds } from '../src/host/agentToolProvider.js';

/** Mirrors both runtime call sites: `mcpServerRouter` compiles the schema as-is;
 *  `agentDispatch` strips `$id` first. Identical Ajv config on both. */
const ajv = new Ajv2020({ strict: false, allErrors: true });

function compileErr(schema: Record<string, unknown>, stripId: boolean): string | undefined {
  try {
    const { $id: _drop, ...rest } = schema;
    ajv.compile(stripId ? rest : schema);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('ADR 0547 — every tool inputSchema compiles', () => {
  let ids: readonly string[];

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    // A BARE import registers almost nothing — only the static BUILTINS. The
    // ~166 feature-registered tools (ADR 0308 `registerFeatureAgentTool`) land
    // only once `registerBackendFeatures` has run, which `createApp` does. Skip
    // this and the walk below is vacuous: it would pass by inspecting a handful
    // of tools while every feature tool went unchecked. (This is the exact trap
    // `tool-content-trust-required.test.ts` documents.) No `listen()` needed.
    await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    ids = builtinAgentToolIds();
  });

  it('registers the full tool surface — otherwise the walk below proves nothing', () => {
    // The vacuity floor. A bare import yields single digits; the real surface is
    // in the hundreds. If this ever drops, the ratchet has stopped ratcheting and
    // must be fixed rather than re-baselined downward.
    expect(ids.length, 'feature tools did not register — every assertion below is vacuous').toBeGreaterThan(100);
  });

  it('has teeth — a known-bad schema is actually rejected by this check', () => {
    // Self-sabotage. Without this, a bug that made `compileErr` always return
    // undefined would render the whole file green and meaningless.
    expect(compileErr({ type: 'object', properties: { a: { $ref: '#/definitions/nope' } } }, true)).toBeDefined();
    expect(compileErr({ type: 'object', properties: { a: { type: 'string', pattern: '[' } } }, true)).toBeDefined();
    expect(compileErr({ type: 'object', properties: { a: { type: 'strin' } } }, true)).toBeDefined();
  });

  it('every registered tool declares an inputSchema object', () => {
    const bad = ids.filter((id) => {
      const s = builtinAgentTool(id)?.def.inputSchema;
      return !s || typeof s !== 'object' || Array.isArray(s);
    });
    expect(bad, 'tools with a missing or non-object inputSchema').toEqual([]);
  });

  it('every registered inputSchema compiles on the CHAT path ($id stripped)', () => {
    const failures = ids
      .map((id) => ({ id, err: compileErr(builtinAgentTool(id)!.def.inputSchema, true) }))
      .filter((r) => r.err)
      .map((r) => `${r.id}: ${r.err}`);
    expect(failures, 'these tools run with NO argument validation on the chat path').toEqual([]);
  });

  it('every registered inputSchema compiles on the MCP path ($id kept)', () => {
    // MCP fails CLOSED on a compile error, so a failure here is a tool that is
    // uncallable over MCP rather than unvalidated — a different symptom of the
    // same defect, and worth naming separately.
    const failures = ids
      .map((id) => ({ id, err: compileErr(builtinAgentTool(id)!.def.inputSchema, false) }))
      .filter((r) => r.err)
      .map((r) => `${r.id}: ${r.err}`);
    expect(failures, 'these tools are uncallable over MCP — inputSchema compile fails').toEqual([]);
  });
});
