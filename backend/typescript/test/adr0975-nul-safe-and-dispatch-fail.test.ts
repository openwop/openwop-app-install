/**
 * ADR 0975 D10 — a NUL in node output cannot take a run down, and a run whose
 * dispatch throws fails closed instead of reading `running` forever.
 *
 * MEASURED on kicktodo.com (2026-10-27): both Challenge Factory runs logged
 * `run_starter_dispatch_failed: unsupported Unicode escape sequence`. One fetched
 * web page carried U+0000, Postgres `jsonb` refused the `node.completed` append,
 * the executor threw, and `startWorkflowRun`'s catch only LOGGED, so both runs
 * stayed `running` on a step that would never finish.
 *
 * Pins: `nulSafe` replaces U+0000 with U+FFFD in every string of a jsonb value
 * (nested, in arrays) and changes nothing else; the web-research text extractor
 * drops C0/DEL controls but keeps tabs and newlines as whitespace; a starter
 * dispatch that throws marks the run `failed` with a `run.failed` event.
 *
 * Red when (sabotage-witnessed): `nulSafe` stops replacing U+0000; the
 * extractor's control-character pass is removed; the starter's catch stops
 * calling `failRunClosedOnDispatchError`. (That `jsonbParam` applies `nulSafe` is
 * a one-line read, not witnessed here: the Postgres adapter needs a live database.)
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/executor/executor.js', async (orig) => ({
  ...(await orig<typeof import('../src/executor/executor.js')>()),
  executeRun: async () => { throw new Error('unsupported Unicode escape sequence'); },
}));

import { nulSafe } from '../src/storage/postgres/index.js';
import { extractReadableText } from '../src/host/webResearchSurface.js';
import { startWorkflowRun, type StartRunDeps } from '../src/host/runStarter.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend, getEventLog } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';

describe('ADR 0975 D10 — jsonb values are NUL-safe', () => {
  it('every string, nested or in an array, has U+0000 as U+FFFD; nothing else changes', () => {
    const value = { text: 'a\u0000b', pages: [{ extractedText: 'x\u0000\u0000y' }], tags: ['\u0000'], n: 3, ok: true, none: null };
    const json = JSON.stringify(value, nulSafe);
    expect(json).not.toContain('\\u0000');
    expect(JSON.parse(json)).toEqual({ text: 'a�b', pages: [{ extractedText: 'x��y' }], tags: ['�'], n: 3, ok: true, none: null });
    expect(JSON.stringify({ plain: 'café', tab: 'a\tb' }, nulSafe)).toBe(JSON.stringify({ plain: 'café', tab: 'a\tb' }));
  });
});

describe('ADR 0975 D10 — fetched page text carries no control characters', () => {
  it('C0/DEL controls are dropped as whitespace; the readable text survives', () => {
    const text = extractReadableText('<p>Walk\u0000 10\u0007 minutes</p>\u007f<script>x</script><p>a\tday</p>');
    expect(text).toBe('Walk 10 minutes a day');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)).toBe(false);
  });
});

describe('ADR 0975 D10 — a starter dispatch that throws fails the run closed', () => {
  it('the run is `failed` with a run.failed event, not `running` forever', async () => {
    const storage = await openStorage('memory://');
    setEventLogBackend(storage);
    setSuspendBackend(storage);
    const deps: StartRunDeps = {
      storage,
      hostSuite: {
        workflowCatalog: { getWorkflow: async (id: string) => ({ workflowId: id, definition: { workflowId: id, nodes: [{ nodeId: 'n', typeId: 'core.noop', config: {} }], edges: [] } }) },
        providerPolicyResolver: { resolveForRun: async () => [] },
      } as unknown as StartRunDeps['hostSuite'],
    };
    const runId = await startWorkflowRun(deps, { tenantId: 't-d10', workflowId: 'wf.d10' });
    expect(runId).toBeTruthy();
    await vi.waitFor(async () => { expect((await storage.getRun(runId!))?.status).toBe('failed'); }, { timeout: 5000, interval: 50 });
    const events = await getEventLog().list(runId!, { fromSeq: -1, limit: 100 });
    expect(events.some((e) => e.type === 'run.failed')).toBe(true);
  });
});
