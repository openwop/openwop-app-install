/**
 * openwop#1698 (errors.md §The registry) — `error.code` on `run.failed`,
 * `node.failed` and the snapshot's `error` MUST be a code registered in
 * `spec/v2/errors.json` or a vendor code whose org is registered in
 * `spec/v2/declaration.json`. Witnessed upstream by
 * `openwop.requirement.errors.event-code-registered` (advisory in 2.43.1);
 * openwop-app was gap row `openwop.gap.0171.6` (22 codes).
 *
 * The rule is applied ONCE, at major-2 egress (`projectV2Payload` for events,
 * `closeV2Snapshot` for the snapshot), never at the writer: stored rows keep
 * the host's code, so a run recorded before this change reads back under the
 * same rule, the v1 wire is untouched, and replay/fork see the bytes they
 * always saw.
 *
 * The acceptance predicate below is the conformance leg's own, over the
 * PACKAGE registry — not a copy of this host's alias table.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { closeV2Snapshot } from '../src/host/v2Snapshot.js';
import { projectV2ErrorObject, v2EventErrorCode } from '../src/middleware/protocolVersion.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const req = createRequire(`${process.cwd()}/`);
const artifactsRoot = join(req.resolve('@openwop/spec-artifacts/package.json'), '..');
const errorsJson = JSON.parse(readFileSync(join(artifactsRoot, 'spec', 'v2', 'errors.json'), 'utf8')) as {
  vendorCodePattern: string;
  rows: Array<{ code: string }>;
};
const REGISTERED = new Set(errorsJson.rows.map((r) => r.code));
const VENDOR = new RegExp(errorsJson.vendorCodePattern);
const declarationPath = join(artifactsRoot, 'spec', 'v2', 'declaration.json');
const ORGS = new Set(Object.keys((JSON.parse(readFileSync(existsSync(declarationPath) ? declarationPath : join(process.cwd(), '..', '..', 'schemas', 'v2', 'declaration.json'), 'utf8')) as { extensions?: Record<string, unknown> }).extensions ?? {}));
/** The conformance leg's `codeAccepted`, verbatim in effect. */
const accepted = (code: string): boolean => REGISTERED.has(code) || (VENDOR.test(code) && ORGS.has(code.split('.')[0] ?? ''));

/**
 * old → new, the whole remap EXCEPT the two RFC 0228 host-service rows
 * (`path_outside_sandbox`, `table_schema_violation`), which carry `details.service`
 * and are pinned by `rfc0228-host-service-codes.test.ts`. `aliased` rows move onto a
 * REGISTERED code and keep the host's code in `details.hostCode`; the rest are
 * namespaced. These are LITERALS on purpose: the expected code is never computed by
 * `v2EventErrorCode`, the function under test (wave 43).
 */
const TABLE: ReadonlyArray<{ old: string; next: string; aliased: boolean }> = [
  // onto a registered row that means the same failure
  { old: 'host_capability_missing', next: 'capability_not_provided', aliased: true },
  { old: 'host_capability_disabled', next: 'capability_not_provided', aliased: true },
  { old: 'invalid_config', next: 'node_config_invalid', aliased: true },
  { old: 'invalid_request', next: 'validation_error', aliased: true },
  { old: 'invalid_args', next: 'validation_error', aliased: true },
  { old: 'agent_not_found', next: 'not_found', aliased: true },
  { old: 'workflow_not_found', next: 'not_found', aliased: true },
  { old: 'run_not_found', next: 'not_found', aliased: true },
  { old: 'envelope_validation_failed', next: 'envelope_invalid', aliased: true },
  { old: 'envelope_contract_violation', next: 'envelope_invalid', aliased: true },
  // this host's own codes, namespaced to its registered org
  { old: 'fork_interrupt_unavailable', next: 'openwop-app.fork_interrupt_unavailable', aliased: false },
  { old: 'unsupported_snapshot_version', next: 'openwop-app.unsupported_snapshot_version', aliased: false },
  { old: 'child_runtime_error', next: 'openwop-app.child_runtime_error', aliased: false },
  { old: 'handoff_task_schema_violation', next: 'openwop-app.handoff_task_schema_violation', aliased: false },
  { old: 'handoff_return_schema_violation', next: 'openwop-app.handoff_return_schema_violation', aliased: false },
  { old: 'cap_breached', next: 'openwop-app.cap_breached', aliased: false },
  { old: 'conflict', next: 'openwop-app.conflict', aliased: false },
  { old: 'sync_failed', next: 'openwop-app.sync_failed', aliased: false },
  { old: 'ad_metrics_failed', next: 'openwop-app.ad_metrics_failed', aliased: false },
  { old: 'ad_budget_update_failed', next: 'openwop-app.ad_budget_update_failed', aliased: false },
  { old: 'no_model_available', next: 'openwop-app.no_model_available', aliased: false },
  // RFC 0226 (suite 2.44.0) registered these two; before the pin they were
  // `openwop-app.*` vendor codes. They now pass through unchanged.
  { old: 'sandbox_invocation_error', next: 'sandbox_invocation_error', aliased: false },
  { old: 'mcp_error', next: 'mcp_error', aliased: false },
  { old: 'dispatch_failed', next: 'openwop-app.dispatch_failed', aliased: false },
  { old: 'empty_completion', next: 'openwop-app.empty_completion', aliased: false },
  { old: 'timeout', next: 'openwop-app.timeout', aliased: false },
  // outside the vendor name grammar: folded, original kept
  { old: 'Anthropic-429', next: 'openwop-app.anthropic_429', aliased: true },
  // already registered / already vendor: untouched
  { old: 'approval_rejected', next: 'approval_rejected', aliased: false },
  { old: 'capability_not_provided', next: 'capability_not_provided', aliased: false },
  { old: 'internal_error', next: 'internal_error', aliased: false },
  { old: 'openwop-app.already_vendor', next: 'openwop-app.already_vendor', aliased: false },
];

describe('openwop#1698 — the remap table', () => {
  for (const { old, next, aliased } of TABLE) {
    it(`${old} → ${next}`, () => {
      expect(v2EventErrorCode(old)).toBe(next);
      expect(accepted(next), `${next} must satisfy the conformance predicate`).toBe(true);
      const projected = projectV2ErrorObject({ code: old, message: 'm' }) as { code: string; details?: { hostCode?: string } };
      expect(projected.code).toBe(next);
      if (aliased) expect(projected.details?.hostCode, 'an alias keeps the host code').toBe(old);
      else expect(projected.details?.hostCode).toBeUndefined();
      // Idempotent: the fan-out projects twice; a snapshot route closes twice.
      expect(projectV2ErrorObject(projected)).toBe(projected);
    });
  }

  it('existing details survive an alias', () => {
    expect(projectV2ErrorObject({ code: 'invalid_request', message: 'm', details: { field: 'x' } }))
      .toEqual({ code: 'validation_error', message: 'm', details: { field: 'x', hostCode: 'invalid_request' } });
  });
});

describe('openwop#1698 — a REAL failed run, read on both majors', () => {
  const storageP = openStorage('memory://');
  const CODES = ['host_capability_missing', 'invalid_config', 'sync_failed', 'approval_rejected'] as const;

  beforeAll(async () => {
    const storage = await storageP;
    setEventLogBackend(storage);
    setSuspendBackend(storage);
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-err-codes-')) });
    for (const code of CODES) {
      getNodeRegistry().register({
        typeId: `test.fail.${code}`,
        version: '1.0.0',
        async execute() {
          return { status: 'failure', error: { code, message: `failed with ${code}` } };
        },
      });
    }
  });

  for (const code of CODES) {
    it(`node.failed / run.failed / snapshot for ${code}: accepted on v2, unchanged on v1 and at rest`, async () => {
      const storage = await storageP;
      const now = new Date().toISOString();
      const run: RunRecord = {
        runId: `run-errcode-${code}-${Math.random().toString(36).slice(2)}`, workflowId: `wf.errcode.${code}`, tenantId: 'default',
        status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
      };
      await storage.insertRun(run);
      const def: WorkflowDefinition = { workflowId: run.workflowId, nodes: [{ nodeId: 'n', typeId: `test.fail.${code}` }], edges: [] };
      expect((await executeRun(storage, run, def)).status).toBe('failed');

      const failures = (evs: ReadonlyArray<{ type: string; payload: unknown }>) =>
        evs.filter((e) => e.type === 'run.failed' || e.type === 'node.failed')
          .map((e) => ({ type: e.type, code: (e.payload as { error?: { code?: string } }).error?.code }));

      const v2 = failures(await storage.listEvents(run.runId, { contract: 2 }));
      expect(v2.map((f) => f.type).sort()).toEqual(['node.failed', 'run.failed']);
      for (const f of v2) expect(accepted(f.code ?? ''), `${f.type} carried ${f.code} on v2`).toBe(true);
      // The expectation comes from the pinned TABLE, never from v2EventErrorCode (the
      // function under test): round-1 probe 8fw4g1-ec-alias-run stayed green here because
      // the oracle moved with the sabotage.
      const expected = TABLE.find((r) => r.old === code)!.next;
      expect(v2.map((f) => f.code)).toEqual([expected, expected]);

      // The v1 wire and the stored row keep the host's code — nothing rewritten.
      const v1 = failures(await storage.listEvents(run.runId, { contract: 1 }));
      expect(v1.every((f) => f.code === code), 'v1 wire unchanged').toBe(true);

      const stored = (await storage.getRun(run.runId))!;
      expect((stored.error as { code?: string } | undefined)?.code).toBe(code);
      const snap = closeV2Snapshot({ runId: stored.runId, status: stored.status, error: stored.error }) as { error?: { code?: string } };
      expect(accepted(snap.error?.code ?? ''), `snapshot carried ${snap.error?.code}`).toBe(true);
      expect(snap.error?.code).toBe(expected);
    });
  }
});
