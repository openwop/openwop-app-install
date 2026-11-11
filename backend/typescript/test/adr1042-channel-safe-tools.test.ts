/**
 * ADR 1042 CHAN-F8 — the reviewed tools a narrow channel turn (an outside sender,
 * any group, a relay contact) may be offered, on the real booted app.
 *
 *  (a) the list is exactly the reviewed one: a new id needs a review and an edit
 *      here, and every id in source carries its review note on the same line;
 *  (b) after a full boot every listed id is still OFFERED by the narrow filter: it
 *      is a registered builtin declaring `effect: 'read'`, outside the safe-mode
 *      baseline, with no classified egress. A tool that changes any of those (a
 *      rename, a write effect, a new egress class) drops off and turns this red,
 *      instead of silently vanishing from outsiders' turns or, worse, staying
 *      listed under a new meaning;
 *  (c) the workspace reads it left OFF stay off on a narrow turn even when the
 *      agent allowlists them.
 *
 * Red when: an id is added or removed without updating the pin; an id loses its
 * note; a listed tool stops passing the filter's other conditions; a workspace read
 * is offered to a narrow turn.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
const { bootChannelHarness } = await import('./support/channelCoreHarness.js');
const { narrowChannelToolIds, CHANNEL_SAFE_READ_TOOLS } = await import('../src/host/conversationToolLoop.js');
const { builtinAgentTool } = await import('../src/host/agentToolProvider.js');
type Harness = Awaited<ReturnType<typeof bootChannelHarness>>;

const REVIEWED = [
  'openwop:accessibility.check',
  'openwop:app-builder.catalog',
  'openwop:ask-user',
  'openwop:core.flow.aggregate-text',
  'openwop:core.flow.split-in-batches',
  'openwop:core.openwop.data.json-schema-validate',
  'openwop:feature.insights-suite.nodes.talent-score',
  'openwop:feature.insights-suite.nodes.variance-compute',
  'openwop:feature.workflow-author.nodes.validate',
  'openwop:schema.lookup',
  'openwop:slides.catalog',
];
/** Reads of workspace data the review kept off (a sample across features). */
const KEPT_OFF = [
  'openwop:knowledge.search',
  'openwop:feature.crm.nodes.list-companies',
  'openwop:documents.get',
  'openwop:conversations.search',
  'openwop:feature.workflow-author.nodes.draft',
  'openwop:core.openwop.http.fetch',
];

let h: Harness;
beforeAll(async () => { h = await bootChannelHarness('c1042f8'); }, 120_000);
afterAll(async () => { await h?.close(); });

describe('(a) the reviewed list', () => {
  it('is exactly the reviewed set, and every id carries its review note', () => {
    expect([...CHANNEL_SAFE_READ_TOOLS].sort()).toEqual(REVIEWED);
    const src = readFileSync(join(__dirname, '..', 'src', 'host', 'conversationToolLoop.ts'), 'utf8');
    for (const id of REVIEWED) {
      expect(src, `${id} must be listed with a review note on its line`).toMatch(new RegExp(`'${id.replace(/\./g, '\\.')}', // \\S`));
    }
  });
});

describe('(b) every listed tool is still offered after a real boot', () => {
  it.each(REVIEWED)('%s passes the narrow filter', (id) => {
    expect(builtinAgentTool(id), `${id} is not a registered builtin`).toBeTruthy();
    expect(builtinAgentTool(id)?.effect).toBe('read');
    expect(narrowChannelToolIds([id])).toEqual([id]);
  });
});

describe('(c) workspace reads stay off a narrow turn', () => {
  it('even when the agent allowlists them', () => {
    const registered = KEPT_OFF.filter((id) => builtinAgentTool(id));
    expect(registered.length, 'non-vacuity: most kept-off reads are registered at boot').toBeGreaterThanOrEqual(4);
    expect(narrowChannelToolIds([...KEPT_OFF, ...REVIEWED])).toEqual(REVIEWED.filter((id) => narrowChannelToolIds([id]).length === 1));
    expect(narrowChannelToolIds(KEPT_OFF)).toEqual([]);
  });
});
