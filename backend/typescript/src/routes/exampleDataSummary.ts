/**
 * CLI-friendly demo summary endpoint.
 *
 * Namespace: host-extension under `/host/openwop-app/*`; this is not
 * part of the normative OpenWOP wire contract. It gives local tools a
 * stable, low-chatter way to understand the workflow-engine demo app
 * without scraping several unrelated endpoints.
 */

import type { Express } from 'express';
import type { AppConfig } from '../index.js';
import { listHostSurfaces } from '../bootstrap/hostSurfaceRegistry.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { listLoadedConformanceFixtures } from '../host/index.js';
import { getPromptsHostConfig } from '../host/promptHostConfig.js';
import { listRegisteredWorkflows } from '../host/workflowsRegistry.js';
import { advertisedPath, VENDOR_ROOT } from '../middleware/protocolVersion.js';

interface Deps {
  config: AppConfig;
}

export function registerExampleDataSummaryRoutes(app: Express, deps: Deps): void {
  app.get('/host/openwop-app/example-data-summary', (_req, res) => {
    res.json(buildExampleDataSummary(deps.config));
  });
}

export function buildExampleDataSummary(config: AppConfig): Record<string, unknown> {
  const hostSurfaces = listHostSurfaces();
  const supportedSurfaces = hostSurfaces.filter((surface) => surface.supported);
  const nodes = getNodeRegistry().listTypeIds();
  const prompts = getPromptsHostConfig();
  const fixtures = listLoadedConformanceFixtures();
  const registeredWorkflows = listRegisteredWorkflows();

  return {
    app: {
      name: 'workflow-engine',
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion,
      storage: storageKind(config.storageDsn),
    },
    // ADR 0669: every address follows the cut (`advertisedPath`). A literal
    // `/v1/...` here would be a link to a 410 once v1 retires. An operation with
    // no v2 address (`/packs`) is omitted after the cut rather than advertised dead.
    endpoints: withoutNulls({
      health: '/health',
      readiness: '/readiness',
      capabilities: '/.well-known/openwop',
      openapi: advertisedPath('/openapi.json'),
      nodeCatalog: advertisedPath(`${VENDOR_ROOT}/node-catalog`),
      exampleDataSummary: advertisedPath(`${VENDOR_ROOT}/example-data-summary`),
      workflows: advertisedPath(`${VENDOR_ROOT}/workflows`),
      runs: advertisedPath('/runs'),
      packs: advertisedPath('/packs'),
      prompts: advertisedPath('/prompts'),
    }),
    demo: {
      nodeCatalog: {
        total: nodes.length,
        runnable: nodes.length,
      },
      workflows: {
        registered: registeredWorkflows.length,
        fixtures: fixtures.length,
      },
      hostSurfaces: {
        total: hostSurfaces.length,
        supported: supportedSurfaces.length,
        inMemory: supportedSurfaces.filter((surface) => surface.implementation === 'in-memory').length,
      },
      prompts: {
        supported: prompts.supported,
        endpointsSupported: prompts.endpointsSupported,
        mutableLibrary: prompts.mutableLibrary,
        observability: prompts.observability,
      },
    },
    recommendations: buildRecommendations({
      hostSurfaces,
      fixtures,
    }),
  };
}

function withoutNulls(o: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => e[1] !== null));
}

function storageKind(dsn: string): string {
  const colon = dsn.indexOf(':');
  return colon === -1 ? 'unknown' : dsn.slice(0, colon);
}

function buildRecommendations(input: {
  hostSurfaces: ReturnType<typeof listHostSurfaces>;
  fixtures: readonly string[];
}): string[] {
  const recommendations: string[] = [];
  if (input.fixtures.length === 0) {
    recommendations.push('No conformance fixtures were loaded; verify the repo-relative fixture path.');
  }
  const unsupported = input.hostSurfaces.filter((surface) => !surface.supported);
  if (unsupported.length > 0) {
    recommendations.push(`${unsupported.length} host surfaces are advertised as unsupported; catalog entries that need them may be dimmed in the builder.`);
  }
  return recommendations;
}
