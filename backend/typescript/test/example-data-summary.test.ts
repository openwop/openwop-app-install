/**
 * CLI demo summary (`GET /host/openwop-app/example-data-summary`,
 * routes/exampleDataSummary.ts) — the one low-chatter readiness read local tools
 * use instead of scraping several endpoints (TST-DBA-7).
 *
 * Asserts: the storage KIND is parsed from the DSN scheme, the advertised paths
 * follow the cut (ADR 0669 `advertisedPath`), the loaded conformance fixtures and
 * catalog nodes are counted, and the "no fixtures loaded" warning is absent when
 * fixtures did load.
 *
 * `demo.nodeCatalog.runnable` is not asserted: the product sets it to the same
 * `nodes.length` as `total` without computing runnability (grade-code row
 * EDS-RUNNABLE-1), so an equality check would pin that identity, not behaviour.
 *
 * Red when: `storageKind` stops parsing the scheme, the summary path changes,
 * or the fixture count is dropped (probes w70g2-sum-storage / -sum-endpoint /
 * -sum-fixtures).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { seedDefaultHostSurfaces } from '../src/bootstrap/hostSurfaceRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { buildExampleDataSummary } from '../src/routes/exampleDataSummary.js';

beforeAll(async () => {
  seedDefaultHostSurfaces();
  ensureNodesRegistered();
});

describe('demo summary route', () => {
  it('returns CLI-oriented readiness details', async () => {
    const body = buildExampleDataSummary({
      port: 18198,
      storageDsn: 'memory://',
      serviceName: 'demo-summary-test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    }) as {
      app: { name: string; serviceName: string; storage: string };
      endpoints: { exampleDataSummary: string; nodeCatalog: string };
      demo: {
        nodeCatalog: { total: number; runnable: number };
        workflows: { fixtures: number };
        hostSurfaces: { total: number; supported: number };
        prompts: { endpointsSupported: boolean };
      };
      recommendations: string[];
    };
    expect(body.app.name).toBe('workflow-engine');
    expect(body.app.serviceName).toBe('demo-summary-test');
    expect(body.app.storage).toBe('memory');
    expect(body.endpoints.exampleDataSummary).toBe('/host/openwop-app/example-data-summary');
    expect(body.endpoints.nodeCatalog).toBe('/host/openwop-app/node-catalog');
    expect(body.demo.nodeCatalog.total).toBeGreaterThan(0);
    expect(body.demo.workflows.fixtures).toBeGreaterThan(0);
    expect(body.demo.hostSurfaces.supported).toBeGreaterThan(0);
    expect(body.demo.hostSurfaces.total).toBeGreaterThanOrEqual(body.demo.hostSurfaces.supported);
    expect(body.demo.prompts.endpointsSupported).toBe(true);
    // Fixtures loaded above ⇒ the missing-fixtures warning must not be emitted.
    expect(body.recommendations).not.toContain('No conformance fixtures were loaded; verify the repo-relative fixture path.');
  });
});
