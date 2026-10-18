/**
 * ADR 0099 §residuals — the per-agent compaction config that rides the frozen
 * decision. What each case guards, and the sabotage that turns it red
 * (w22 probes):
 *   - Residual C, per-tool exemption: an exempt tool's output stays byte-exact
 *     (`toolResultTransform.ts` exemptTools check → `if (false)`), and ONLY that
 *     tool is exempt (`includes` → `length`).
 *   - The replay read: `readCompactionDecision` round-trips `minChars` and
 *     `exemptTools` off a frozen blob (drop the `minChars` copy) and drops
 *     non-string exemptions (drop the filter).
 *   - Residual B: an agent's `minChars` applies in `lossless` too (gate the
 *     copy on `cfg.lossy`), and `exemptTools` is carried (drop the copy).
 *
 * The no-agent default, and toggle ON/OFF through `stampRunStartContext`, are
 * asserted in `tool-output-compaction-seam.test.ts` and
 * `tool-output-compaction-phase2.test.ts`. The runless `/agents/:id/dispatch`
 * lane's own wiring (`routes/agents.ts`) is held only by the regex ratchet in
 * `tool-result-compaction-callers.test.ts` — this file does not drive it.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  registerToolResultTransform,
  applyToolResultTransform,
  __resetToolResultTransform,
} from '../src/host/toolResultTransform.js';
import { __resetRunStartContributors } from '../src/host/runStartContext.js';
import { readCompactionDecision } from '../src/executor/compaction.js';
import { resolveCompactionDecision } from '../src/features/tool-output-compaction/decision.js';
import { compactToolOutput } from '../src/features/tool-output-compaction/compact.js';
import { toolOutputCompactionFeature } from '../src/features/tool-output-compaction/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';

const TENANT = 'tenant-res';
const ROSTER = 'roster-res';
const storage = openSqliteStorage(':memory:');
const sparse = JSON.stringify({ items: [{ id: 1, tags: [], note: null }, { id: 2, tags: [], note: '' }] }, null, 2);

async function setToggle(status: 'on' | 'off'): Promise<void> {
  await saveConfig({ ...toolOutputCompactionFeature.toggleDefault!, status }, 'test');
}
async function setAgentCompaction(cfg: Record<string, unknown>): Promise<void> {
  await upsertAgentProfile(TENANT, ROSTER, {
    roleKey: 'worker',
    configParameters: { compaction: cfg },
    autonomy: { specLevel: 'draft-only' },
  });
}

beforeAll(() => initHostExtPersistence(storage));
afterAll(async () => storage.close());
beforeEach(async () => {
  initHostExtPersistence(storage);
  __resetToolResultTransform();
  __resetRunStartContributors();
  await __clearToggleStore();
  registerToggleDefault(toolOutputCompactionFeature.toggleDefault!);
  registerToolResultTransform((content, ctx) => (ctx.decision ? compactToolOutput(content, ctx.decision) : content));
});

describe('per-tool exemptions (Residual C)', () => {
  it('skips compaction for an exempt tool (byte-exact)', () => {
    const out = applyToolResultTransform(sparse, { decision: { mode: 'lossless', exemptTools: ['ledger'] }, toolName: 'ledger' });
    expect(out).toBe(sparse);
  });
  it('compacts a non-exempt tool', () => {
    const out = applyToolResultTransform(sparse, { decision: { mode: 'lossless', exemptTools: ['ledger'] }, toolName: 'list' });
    // Exactly the lossless minification of the indented fixture — not merely "shorter".
    expect(out).toBe(JSON.stringify(JSON.parse(sparse)));
  });
  it('readCompactionDecision round-trips exemptTools + minChars (replay)', () => {
    const meta = { compaction: { mode: 'lossless', minChars: 128, exemptTools: ['a', 'b'] } };
    expect(readCompactionDecision(meta)).toEqual({ mode: 'lossless', minChars: 128, exemptTools: ['a', 'b'] });
  });
  it('drops non-string entries from a malformed exemptTools', () => {
    const meta = { compaction: { mode: 'lossless', exemptTools: ['ok', 7, null] } };
    expect(readCompactionDecision(meta)?.exemptTools).toEqual(['ok']);
  });
});

describe('per-agent minChars applies in BOTH modes (Residual B)', () => {
  beforeEach(async () => {
    await setToggle('on');
  });
  it('lossless agent can set minChars (was previously lossy-only)', async () => {
    await setAgentCompaction({ minChars: 512 });
    const patch = await resolveCompactionDecision({ tenantId: TENANT, agentId: ROSTER });
    expect(readCompactionDecision(patch)).toEqual({ mode: 'lossless', minChars: 512 });
  });
  it('lossy agent carries minChars + exemptTools together', async () => {
    await setAgentCompaction({ lossy: true, head: 2, tail: 1, minChars: 256, exemptTools: ['raw'] });
    const patch = await resolveCompactionDecision({ tenantId: TENANT, agentId: ROSTER });
    expect(readCompactionDecision(patch)).toEqual({ mode: 'lossy', head: 2, tail: 1, minChars: 256, exemptTools: ['raw'] });
  });
});
