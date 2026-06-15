/**
 * Shared workflow-template pack (ADR 0032 Phase 2.0).
 *
 * Validates the pinned template catalog (`host/workflowTemplates.ts`) the ten
 * work-twins compose, and drives two representative templates end-to-end
 * through the real executor — a pure draft flow to completion and an
 * approval-gated flow to its `core.approvalGate` suspension.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import {
  WORKFLOW_TEMPLATES,
  WORKFLOW_TEMPLATE_CATEGORIES,
  getWorkflowTemplate,
  listWorkflowTemplates,
  listWorkflowTemplatesByCategory,
} from '../src/host/workflowTemplates.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-wf-templates-')) });

beforeAll(() => {
  ensureNodesRegistered();
});

const ALLOWED_TYPE_IDS = new Set(['local.openwop-app.mock-ai', 'core.approvalGate', 'core.subWorkflow']);

async function newRun(workflowId: string): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    workflowId,
    tenantId: 'demo',
    status: 'pending',
    inputs: { topic: 'Q2 planning' },
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

describe('workflow-template pack — catalog shape', () => {
  it('ships exactly 44 templates (11 categories × 4), one canonical list', () => {
    expect(WORKFLOW_TEMPLATES).toHaveLength(44);
    expect(listWorkflowTemplates()).toBe(WORKFLOW_TEMPLATES);
    expect(WORKFLOW_TEMPLATE_CATEGORIES).toHaveLength(11);
    for (const category of WORKFLOW_TEMPLATE_CATEGORIES) {
      expect(listWorkflowTemplatesByCategory(category)).toHaveLength(4);
    }
  });

  it('has unique, `tmpl.<category>.*` ids that match their definition', () => {
    const ids = new Set<string>();
    for (const t of WORKFLOW_TEMPLATES) {
      expect(ids.has(t.workflowId)).toBe(false);
      ids.add(t.workflowId);
      expect(t.workflowId).toBe(`tmpl.${t.category}.${t.workflowId.split('.').slice(2).join('.')}`);
      // The definition's own id must match the spec id (catalog resolves by it).
      expect(t.definition.workflowId).toBe(t.workflowId);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.purpose.length).toBeGreaterThan(0);
    }
  });

  it('every definition is a well-formed DAG over registered core nodes', () => {
    for (const { definition: def } of WORKFLOW_TEMPLATES) {
      expect(def.nodes.length).toBeGreaterThan(0);
      const nodeIds = new Set(def.nodes.map((n) => n.nodeId));
      // unique node ids
      expect(nodeIds.size).toBe(def.nodes.length);
      // only already-registered core/demo node typeIds (no new I/O node)
      for (const n of def.nodes) {
        expect(ALLOWED_TYPE_IDS.has(n.typeId)).toBe(true);
      }
      // edges reference existing nodes
      for (const e of def.edges ?? []) {
        expect(nodeIds.has(e.sourceNodeId)).toBe(true);
        expect(nodeIds.has(e.targetNodeId)).toBe(true);
      }
      // exactly one primary (canonical-deliverable) terminal node
      const primaries = def.nodes.filter((n) => n.outputRole === 'primary');
      expect(primaries).toHaveLength(1);
    }
  });

  it('composition is closed: every core.subWorkflow binds a template in this pack', () => {
    let subWorkflowCount = 0;
    for (const { definition: def } of WORKFLOW_TEMPLATES) {
      for (const n of def.nodes) {
        if (n.typeId !== 'core.subWorkflow') continue;
        subWorkflowCount++;
        const childId = (n.config as { workflowId?: unknown } | undefined)?.workflowId;
        expect(typeof childId).toBe('string');
        // the bound child resolves within the pinned catalog (no dangling ref)
        expect(getWorkflowTemplate(childId as string)).not.toBeNull();
      }
    }
    // the two composition examples (post-meeting-follow-up, finance approval-chase)
    expect(subWorkflowCount).toBeGreaterThanOrEqual(2);
  });

  it('every approvals.* template carries a core.approvalGate', () => {
    for (const t of listWorkflowTemplatesByCategory('approvals')) {
      expect(t.definition.nodes.some((n) => n.typeId === 'core.approvalGate')).toBe(true);
    }
  });
});

describe('workflow-template pack — resolver', () => {
  it('resolves a known id and returns null for an unknown one', () => {
    expect(getWorkflowTemplate('tmpl.reporting.daily-summary')).not.toBeNull();
    expect(getWorkflowTemplate('tmpl.reporting.daily-summary')!.workflowId).toBe('tmpl.reporting.daily-summary');
    expect(getWorkflowTemplate('tmpl.nope.missing')).toBeNull();
  });
});

describe('workflow-template pack — end-to-end execution', () => {
  it('runs a pure draft template to completion', async () => {
    const def = getWorkflowTemplate('tmpl.reporting.daily-summary')!;
    const run = await newRun(def.workflowId);
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    const events = (await storage.listEvents(run.runId)).map((e) => e.type);
    expect(events).toContain('run.completed');
  });

  it('runs an approval template to its core.approvalGate suspension', async () => {
    const def = getWorkflowTemplate('tmpl.approvals.single-approver')!;
    const run = await newRun(def.workflowId);
    const result = await executeRun(storage, run, def);
    // core.approvalGate suspends → finalize maps the approval interrupt to
    // 'waiting-approval'; the gate node is the paused node.
    expect(result.status).toBe('waiting-approval');
    expect(result.pausedNodeIds).toContain('approve');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.suspended' && e.nodeId === 'approve')).toBe(true);
  });
});
