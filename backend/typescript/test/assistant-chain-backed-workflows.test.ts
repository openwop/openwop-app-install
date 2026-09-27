/**
 * WF-COS-1 — the six assistant workflows are CHAINS, not in-tree literals.
 *
 * THE DEFECT. `features/assistant/loops.ts` and
 * `features/assistant/actionExecution.ts` each built `WorkflowDefinition`
 * literals in a module-local factory and handed them to `registerWorkflow()` at
 * boot. That is the pattern `CLAUDE.md` § "Workflows — never hard-code" forbids:
 * a code-pinned workflow is invisible to `/builder` and the `/` picker (both list
 * only the tenant ownership index) and is not tenant-editable. This feature held
 * TWO of the seven `PIN_SITE_QUARANTINE` entries, against a ceiling of 7 with
 * zero headroom.
 *
 * WHAT THIS FILE IS FOR. A migration like this is dangerous precisely because it
 * is invisible: `expandChain` produces a structurally different object (prefixed
 * node ids, generated edge ids, an auto-assigned terminal `outputRole`, added
 * metadata), so "it still boots" proves almost nothing. Each case below pins ONE
 * property the retired literals had, quoted from the source they came from — the
 * ADR 0024 Option-C posture, the `confirm-action-send` verdict gate, the ingest
 * volume cap, and byte-stable expansion — so an equivalence claim is a measured
 * fact rather than a reading of the diff.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { getChainBackedWorkflow, buildChainBackedDefinition } from '../src/host/chainBackedWorkflows.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { MAX_ITEMS_PER_TICK, ASSISTANT_LOOPS } from '../src/features/assistant/loops.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const LOOPS = ['assistant.loop.calendar-ingest', 'assistant.loop.drive-ingest', 'assistant.loop.morning-briefing'] as const;
const ACTIONS = ['assistant.action.email-send', 'assistant.action.calendar-invite', 'assistant.action.calendar-reschedule'] as const;
const ALL = [...LOOPS, ...ACTIONS];

type Def = NonNullable<ReturnType<typeof getChainBackedWorkflow>>;
const nodeBySuffix = (def: Def, id: string): Def['nodes'][number] | undefined =>
  def.nodes.find((n) => n.nodeId === id || n.nodeId.endsWith(`_${id}`));
/** Comments out — a docblock that MENTIONS `registerWorkflow()` must not read as
 *  a call (the repo's "ratchet gates count comments" lesson, in a test). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18995, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('WF-COS-1 — all six resolve, chain-backed, under their ORIGINAL ids', () => {
  it('every id resolves, and NONE of them is an in-tree registration any more', () => {
    for (const id of ALL) {
      expect(getChainBackedWorkflow(id), `${id} must be registered chain-backed`).toBeDefined();
      // The other half of the claim: if a literal were ALSO registered, the
      // migration would be additive rather than a replacement and the pin site
      // would still be live. `getRegisteredWorkflow` is the in-tree registry.
      expect(getRegisteredWorkflow(id), `${id} must NOT also be pinned in-tree`).toBeUndefined();
    }
  });

  it('the ids are the ones the runtime dispatches — not new ones', () => {
    // The whole reason to keep the ids: the per-tenant scheduler job rows
    // (`assistant:<loopId>:<tenantId>`) and `EXEC_WORKFLOW_BY_KIND` resolve by
    // these strings, and so does every existing run stamp. Derived from the
    // live source of each, not restated.
    expect(ASSISTANT_LOOPS.map((l) => l.workflowId).sort()).toEqual([...LOOPS].sort());
    const execSrc = readFileSync(join(REPO, 'backend/typescript/src/features/assistant/actionExecution.ts'), 'utf8');
    for (const id of ACTIONS) expect(execSrc).toContain(`'${id}'`);
  });

  it('neither module calls registerWorkflow any more (the pin site is GONE, not merely unused)', () => {
    for (const f of ['loops.ts', 'actionExecution.ts']) {
      const src = stripComments(readFileSync(join(REPO, 'backend/typescript/src/features/assistant', f), 'utf8'));
      expect(/\bregisterWorkflow\s*\(/.test(src), `${f} must not register an in-tree definition`).toBe(false);
      // …and the factories are deleted, not left dangling: a module that still
      // declares a definition literal trips the ratchet's tier-3 fallback the
      // moment anything in it registers again.
      expect(/\bnodes\s*:\s*\[/.test(src), `${f} must not still declare a definition literal`).toBe(false);
    }
  });
});

describe('WF-COS-1 — the properties the retired literals carried are preserved', () => {
  it('ADR 0024 Option C: NOTHING connection-shaped in any node config, and no secret-shaped string', () => {
    for (const id of ALL) {
      const def = getChainBackedWorkflow(id)!;
      for (const node of def.nodes) {
        expect((node.config as Record<string, unknown> | undefined)?.connection, `${id}/${node.nodeId}`).toBeUndefined();
      }
      // Scoped to the NODES, deliberately. `def.metadata.purpose` is the pack's
      // human description, which legitimately contains the words "write-scoped
      // token" while describing the seam that keeps credentials OUT of the
      // definition. Matching prose would be a gate that fails on documentation.
      expect(JSON.stringify(def.nodes), id).not.toMatch(/Bearer |secret|token/i);
    }
  });

  it('the send lane keeps its VERDICT GATE — without it a refused send records as `sent`', () => {
    // An HTTP fetch completes on ANY outcome (side-effect-once), so
    // `confirm-action-send` is what fails the run on a non-2xx and lets the
    // terminal projection mark the action `failed`. Losing it in the migration
    // would silently turn every refused send into a reported success.
    for (const id of ACTIONS) {
      const def = getChainBackedWorkflow(id)!;
      expect(nodeBySuffix(def, 'prepare')?.typeId, id).toBe('feature.assistant.nodes.prepare-action-request');
      expect(nodeBySuffix(def, 'send')?.typeId, id).toBe('core.openwop.http.fetch');
      expect(nodeBySuffix(def, 'confirm')?.typeId, id).toBe('feature.assistant.nodes.confirm-action-send');
      // …and it is genuinely DOWNSTREAM of the send, not merely present.
      const sendId = nodeBySuffix(def, 'send')!.nodeId;
      const confirmId = nodeBySuffix(def, 'confirm')!.nodeId;
      expect((def.edges ?? []).some((e) => e.sourceNodeId === sendId && e.targetNodeId === confirmId), id).toBe(true);
    }
    expect((nodeBySuffix(getChainBackedWorkflow('assistant.action.calendar-reschedule')!, 'send')!.config as Record<string, unknown>).method).toBe('PATCH');
    // The reschedule URL must keep the placeholder the prepare node substitutes.
    expect(String((nodeBySuffix(getChainBackedWorkflow('assistant.action.calendar-reschedule')!, 'send')!.config as Record<string, unknown>).url)).toContain('{{eventId}}');
  });

  it('the ingest volume cap agrees across the constant, the node config AND the fetch page size', () => {
    // Three places carried this number before the migration and only one is code
    // now. A silent disagreement would mean the loop fetches more than it
    // ingests (or vice versa) with nothing to notice it.
    for (const id of ['assistant.loop.calendar-ingest', 'assistant.loop.drive-ingest'] as const) {
      const def = getChainBackedWorkflow(id)!;
      expect((nodeBySuffix(def, 'ingest')!.config as Record<string, unknown>).maxItemsPerTick, id).toBe(MAX_ITEMS_PER_TICK);
      const url = String((nodeBySuffix(def, 'fetch')!.config as Record<string, unknown>).url);
      expect(url, id).toMatch(new RegExp(`(maxResults|pageSize)=${MAX_ITEMS_PER_TICK}\\b`));
    }
    expect((nodeBySuffix(getChainBackedWorkflow('assistant.loop.calendar-ingest')!, 'ingest')!.config as Record<string, unknown>).sourceKind).toBe('calendar');
    expect((nodeBySuffix(getChainBackedWorkflow('assistant.loop.drive-ingest')!, 'ingest')!.config as Record<string, unknown>).sourceKind).toBe('drive');
  });

  it('the briefing loop keeps notify:true — the notification IS the loop\'s entire product', () => {
    const def = getChainBackedWorkflow('assistant.loop.morning-briefing')!;
    expect(def.nodes).toHaveLength(1);
    expect(def.nodes[0]!.typeId).toBe('feature.assistant.nodes.compose-briefing');
    expect((def.nodes[0]!.config as Record<string, unknown>).notify).toBe(true);
  });

  it('NO node gains an outputRole the retired literals never had', () => {
    // `expandChain` auto-assigns `outputRole: 'primary'` to a chain's terminal
    // node. The six literals declared none, and the field is not decorative —
    // the builder renders it and `reviewProjection` reads it — so
    // `stripAutoTerminalOutputRole` removes it. Without that postProcess this
    // migration would smuggle a behaviour change in under a refactor.
    for (const id of ALL) {
      for (const node of getChainBackedWorkflow(id)!.nodes) {
        expect(node.outputRole, `${id}/${node.nodeId}`).toBeUndefined();
      }
    }
  });
});

describe('WF-COS-1 — replay stability', () => {
  it('expansion is DETERMINISTIC: building twice is byte-identical', () => {
    // The chain-backed shape replaces bare node ids with
    // `<chain>_<expansionId>_<id>`. If `expansionId` moved between boots, every
    // replay and every stored run reference would break on a restart — a far
    // worse defect than the one this migration fixes. Byte-compare, not
    // shape-compare.
    for (const id of ALL) {
      expect(JSON.stringify(buildChainBackedDefinition(id)), id)
        .toBe(JSON.stringify(buildChainBackedDefinition(id)));
    }
  });

  it('node ids ARE expansion-prefixed — the one-time replay discontinuity is a stated fact', () => {
    // Asserted rather than implied, because the deploy note depends on it: a run
    // created against the OLD definition (bare `fetch`/`prepare`/…) does not
    // replay def-identically against this one.
    const def = getChainBackedWorkflow('assistant.action.email-send')!;
    expect(def.nodes.map((n) => n.nodeId)).not.toContain('prepare');
    expect(def.nodes.every((n) => n.nodeId.startsWith('assistant_action_email-send_'))).toBe(true);
  });
});
