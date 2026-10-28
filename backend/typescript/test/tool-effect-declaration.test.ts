/**
 * ADR 0784 P1 — every agent tool declares whether a call can CHANGE anything.
 * The compiler enforces presence (the field is required, the `contentTrust`
 * way); this pins the VALUES: every registered tool is 'read' or 'write', every
 * pure compute tool is 'read', and a fixed sample of known readers and writers
 * holds — so a blanket default in either direction turns red.
 *
 * Floors MEASURED 2026-10-23 after createApp: 211 tools, 63 write, 148 read
 * (9 projected compute tools). Each floor is the measured value minus a small
 * margin. Wave 61: "every pure compute tool is 'read'" was claimed but not
 * asserted (probe ed-compute vacuous); it is now asserted per projected id.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds, builtinAgentTool, PROJECTABLE_COMPUTE_NODE_TYPE_IDS } from '../src/host/agentToolProvider.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

const KNOWN: Record<string, 'read' | 'write'> = {
  'openwop:knowledge.search': 'read',
  'openwop:schema.lookup': 'read',
  'openwop:ai.research.web': 'read', // an external READ is a read
  'openwop:kanban.add-todo': 'write',
  'openwop:job-search.applications.read': 'read', // lazy bootstrap is not a change
  'openwop:bi.run-metric': 'read',
  'openwop:comments.post': 'write',
  'openwop:notifications.notify-me': 'write', // an effect outside the host
};

describe('tool effect declaration (ADR 0784)', () => {
  it('every registered tool declares read or write, every pure compute tool is read, and both kinds exist', () => {
    const ids = builtinAgentToolIds();
    expect(ids.length).toBeGreaterThanOrEqual(207);
    const bad = ids.filter((id) => !['read', 'write'].includes(builtinAgentTool(id)?.effect as string));
    expect(bad).toEqual([]);
    const writes = ids.filter((id) => builtinAgentTool(id)!.effect === 'write').length;
    expect(writes).toBeGreaterThanOrEqual(61);
    expect(ids.length - writes).toBeGreaterThanOrEqual(143);
    // Every projected compute node (named `openwop:<typeId>`, the way
    // computeNodeTool names it) is registered and is a READ.
    expect(PROJECTABLE_COMPUTE_NODE_TYPE_IDS.length).toBeGreaterThan(0);
    const compute = Object.fromEntries(PROJECTABLE_COMPUTE_NODE_TYPE_IDS.map((t) => [t, builtinAgentTool(`openwop:${t}`)?.effect]));
    expect(compute).toEqual(Object.fromEntries(PROJECTABLE_COMPUTE_NODE_TYPE_IDS.map((t) => [t, 'read'])));
  });

  it('pins a sample of known readers and writers', () => {
    const got = Object.fromEntries(Object.keys(KNOWN).map((id) => [id, builtinAgentTool(id)?.effect]));
    expect(got).toEqual(KNOWN);
  });
});
