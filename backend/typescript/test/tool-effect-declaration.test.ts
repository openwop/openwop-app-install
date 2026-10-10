/**
 * ADR 0784 P1 — every agent tool declares whether a call can CHANGE anything.
 * The compiler enforces presence (the field is required, the `contentTrust`
 * way); this pins the VALUES: every registered tool is 'read' or 'write', every
 * pure compute tool is 'read', and a fixed sample of known readers and writers
 * holds — so a blanket default in either direction turns red.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds, builtinAgentTool } from '../src/host/agentToolProvider.js';

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
  it('every registered tool declares read or write, and both kinds exist', () => {
    const ids = builtinAgentToolIds();
    expect(ids.length).toBeGreaterThan(150);
    const bad = ids.filter((id) => !['read', 'write'].includes(builtinAgentTool(id)?.effect as string));
    expect(bad).toEqual([]);
    const writes = ids.filter((id) => builtinAgentTool(id)!.effect === 'write').length;
    expect(writes).toBeGreaterThan(40);
    expect(ids.length - writes).toBeGreaterThan(40);
  });

  it('pins a sample of known readers and writers', () => {
    const got = Object.fromEntries(Object.keys(KNOWN).map((id) => [id, builtinAgentTool(id)?.effect]));
    expect(got).toEqual(KNOWN);
  });
});
