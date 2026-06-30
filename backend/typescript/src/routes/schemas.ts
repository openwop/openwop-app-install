/**
 * Artifact-type schema serving (ADR 0055 / RFC 0075). Serves each registered
 * artifact type's JSON Schema at the canonical
 * `{HostBase}/schemas/artifacts/{artifactTypeId}.schema.json` so other hosts/clients
 * can fetch the contract advertised under `host.artifactTypes`. Public, read-only,
 * unauthenticated (schemas are not tenant data); uniform 404 for unknown ids.
 */

import type { Express } from 'express';
import { getArtifactType } from '../host/artifactTypes.js';

export function registerSchemaRoutes(app: Express): void {
  app.get('/schemas/artifacts/:file', (req, res) => {
    const file = req.params.file;
    const m = /^([A-Za-z0-9._-]+)\.schema\.json$/.exec(file);
    const t = m ? getArtifactType(m[1]) : undefined;
    if (!t) { res.status(404).json({ error: { code: 'not_found', message: 'Unknown artifact type schema.' } }); return; }
    res.set('Cache-Control', 'public, max-age=300');
    res.type('application/schema+json').json(t.schema);
  });
}
