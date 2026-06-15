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
    expect(body.endpoints.exampleDataSummary).toBe('/v1/host/openwop-app/example-data-summary');
    expect(body.endpoints.nodeCatalog).toBe('/v1/host/openwop-app/node-catalog');
    expect(body.demo.nodeCatalog.total).toBeGreaterThan(0);
    expect(body.demo.nodeCatalog.runnable).toBe(body.demo.nodeCatalog.total);
    expect(body.demo.workflows.fixtures).toBeGreaterThan(0);
    expect(body.demo.hostSurfaces.supported).toBeGreaterThan(0);
    expect(body.demo.hostSurfaces.total).toBeGreaterThanOrEqual(body.demo.hostSurfaces.supported);
    expect(body.demo.prompts.endpointsSupported).toBe(true);
    expect(Array.isArray(body.recommendations)).toBe(true);
  });
});
