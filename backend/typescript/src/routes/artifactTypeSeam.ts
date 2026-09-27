/**
 * RFC 0071 artifact-type conformance test seam — `host-sample-test-seams.md`.
 *   POST /v1/host/sample/artifacttypes/install   { manifest, schemas }
 *   POST /v1/host/sample/artifacttypes/produce   { artifactTypeId, payload }
 *
 * The behavioral witness for `artifactTypes`. Until this landed, the RFC 0071
 * legs SOFT-SKIPPED against this host — and a soft-skip is an early `return`,
 * which vitest counts as PASSED. A measured run at origin/main reported
 * `13 passed | 2522 skipped` where all 13 were skips: the capability gate passed
 * (this host advertises `artifactTypes` at the document root,
 * `discovery.ts:1291`) but `installArtifactTypePack` 404'd, so every leg
 * returned early. Green and worthless are indistinguishable without the counts.
 *
 * WHY THIS INVERTS THE RFC 0137 SEAM. `formContentSeam.ts` takes a `templateId`
 * and loads fixtures the host pre-placed on disk. Here the SUITE supplies the
 * pack inline, so the seam must install what it is handed. That is why the
 * manifest is materialised to a temp dir and fed to the REAL
 * `loadArtifactTypePacks` rather than shortcutting to `registerArtifactType`:
 * the leg asserts "a valid artifact-type pack MUST install cleanly"
 * (`artifact-type-packs.md §"Pack kind"`), which is a claim about PACK
 * INSTALLATION — schemaRef resolution, manifest shape, rejection paths. Calling
 * the registry directly would witness the registry and label it installation.
 *
 * WHAT THIS SEAM DELIBERATELY DOES NOT WITNESS. It does not emit
 * `artifact.created`. This host emits that event only from nodes inside a real
 * run — `feature.documents.nodes` and, since ADR 0746, the conformance-only
 * `conformance.artifact.emit`; `persistRunArtifact` itself emits nothing. The scenario asserts on `artifactCreated`
 * only IF PRESENT, so omitting it is honest reporting — fabricating an event
 * that was never dispatched would be strictly worse than omitting one. Stated
 * plainly here because "which legs does this witness NOT discriminate?" is the
 * question a conformance witness must answer about itself.
 *
 * SAFETY. `registerArtifactType` mutates a PROCESS-GLOBAL registry with no
 * tenant scoping, so this surface is gated twice: an env flag AND an id-prefix
 * allowlist. The env flag alone is insufficient — one misconfigured deploy would
 * let any caller inject a type visible to every tenant. The prefix guard bounds
 * the blast radius even if the flag leaks.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { Express, Request, Response, NextFunction } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { locateRepoSchemasDir } from '../host/_repoPath.js';
import { loadArtifactTypePacks } from '../host/artifactTypePackLoader.js';
import { validateArtifact, getArtifactType, isRegisteredArtifactType } from '../host/artifactTypes.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { persistRunArtifact } from '../host/runArtifactStore.js';
import { createLogger } from '../observability/logger.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('host.artifactTypeSeam');

/** Opt-in flag. Absent ⇒ both routes 404 ⇒ the suite soft-skips, which is the
 *  correct posture for a production deploy. */
const SEAM_ENV = 'OPENWOP_ARTIFACT_TYPE_CONFORMANCE_SEAM';

/** Only conformance-namespaced ids may be installed through this surface. A
 *  pack that tried to shadow `core.openwop.*` or a feature's types is refused
 *  even when the seam is enabled. */
const ALLOWED_ID_PREFIX = 'vendor.conformance.';

/** Conformance-only tenant — never a real workspace. */
const SEAM_TENANT = 'user:conformance-artifacttypes';

/** RFC 0142 leg B needs to start a REAL run, so this seam needs the same two
 *  handles `POST /v1/runs` uses. Optional so the install/produce routes keep
 *  working (and the leg-B route honestly 404s) if a caller wires it without. */
export interface RunProduceDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

function seamEnabled(): boolean {
  return process.env[SEAM_ENV] === 'true' || process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';
}

interface InstallBody { manifest?: unknown; schemas?: Record<string, unknown> }

/**
 * RFC 0139 leg 5 — the seam validates the manifest against its CANONICAL schema.
 *
 * openwop-1 read the path and found leg 5 red against this host: the loader picks
 * fields BY NAME (`pickString(at.title, t['displayName'])`) and never validates
 * the manifest, so a typo'd `dispalyName` is silently ignored, the type registers,
 * and the seam returned 200 where the leg asserts non-2xx. Their framing:
 * "a host can satisfy legs 1-4 by simply ignoring its manifest schema entirely.
 * Accepting everything is not the same as accepting extensions."
 *
 * Validated HERE, at the boundary, not in the loader — the PMC-5 ruling. The
 * canonical schema governs a PUBLISHED pack; in-tree host packs are not published
 * and 0 of 4 of them validate today, so enforcing in the loader would reject packs
 * this repo ships at boot. The seam only ever installs `vendor.conformance.*`,
 * which the suite authors canonically, so enforcing here is measured-safe.
 */
let manifestValidator: ReturnType<Ajv2020['compile']> | null | undefined;
function canonicalManifestValidator(): ReturnType<Ajv2020['compile']> | null {
  if (manifestValidator !== undefined) return manifestValidator;
  try {
    const file = 'artifact-type-pack-manifest.schema.json';
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), file);
    const path = join(dir, file);
    manifestValidator = existsSync(path)
      ? new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(path, 'utf8')) as object)
      : null;
  } catch { manifestValidator = null; }
  return manifestValidator;
}

/**
 * The observable result of registering a type, for the RFC 0139 differential
 * check. Derived values only — anything the host COMPUTED from the manifest.
 *
 * `schemaKeys` rather than the whole schema: the schema is echoed input, and the
 * suite strips extensions before comparing, so echoing is safe but uninformative.
 * The derived surface (which keys the resolved schema actually produced, the
 * facets registered) is where a leaked extension would show up.
 */
function registeredProjection(ids: readonly string[]): Array<Record<string, unknown>> {
  return [...ids].sort().map((id) => {
    const t = getArtifactType(id);
    return {
      artifactTypeId: id,
      displayName: t?.title ?? null,
      exportFormats: [...(t?.export ?? [])].sort(),
      registrationSource: t?.registrationSource ?? null,
      // Derived from the RESOLVED schema (schemaRef read off disk, or inline).
      // A `properties` key appearing here that the stripped manifest cannot
      // account for means an extension reached schema resolution.
      schemaKeys: Object.keys((t?.schema as Record<string, unknown> | undefined)?.properties ?? {}).sort(),
      schemaRequired: [...(((t?.schema as { required?: unknown } | undefined)?.required as string[]) ?? [])].sort(),
    };
  });
}

export function registerArtifactTypeSeamRoutes(app: Express, deps?: RunProduceDeps): void {
  app.post('/v1/host/sample/artifacttypes/install', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!seamEnabled()) { sendError(res, 404, 'not_found', 'The artifact-type conformance seam is not enabled on this host.'); return; }
      const { manifest, schemas } = (req.body ?? {}) as InstallBody;
      if (!manifest || typeof manifest !== 'object') {
        sendError(res, 400, 'invalid_request', 'manifest is required');
        return;
      }
      const types = (manifest as { artifactTypes?: unknown }).artifactTypes;
      if (!Array.isArray(types) || types.length === 0) {
        sendError(res, 400, 'invalid_request', 'manifest.artifactTypes[] is required');
        return;
      }
      // Fail CLOSED on anything outside the conformance namespace — the global
      // registry has no tenant scoping to fall back on.
      const ids = types.map((t) => (t as { artifactTypeId?: unknown }).artifactTypeId).filter((x): x is string => typeof x === 'string');
      const foreign = ids.filter((id) => !id.startsWith(ALLOWED_ID_PREFIX));
      if (ids.length === 0 || foreign.length > 0) {
        // H27-b — `foreign` was a NEW TOP-LEVEL key; contextual data belongs
        // under `details` (`additionalProperties: false`).
        sendError(res, 403, 'forbidden', `this seam installs only ${ALLOWED_ID_PREFIX}* ids`, { foreign });
        return;
      }

      // RFC 0139 leg 5 — reject a manifest that violates its canonical schema.
      // Runs BEFORE materialisation so a bad manifest never reaches the loader.
      const mv = canonicalManifestValidator();
      if (mv && !mv(manifest)) {
        const detail = (mv.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).join('; ');
        // H27-b — `detail` WAS the human message (the validator's rendered
        // errors), so it becomes `message`; `registeredIds` is contextual and
        // moves to `details`. Both were new top-level keys the schema forbids.
        sendError(res, 422, 'manifest_invalid', detail || 'The manifest failed canonical-schema validation.', { registeredIds: [] });
        return;
      }

      // Materialise the pack and run it through the REAL loader, so schemaRef
      // resolution and the manifest rejection paths are what actually execute.
      const dir = mkdtempSync(join(tmpdir(), 'owp-conf-attype-'));
      try {
        const packDir = join(dir, 'conformance-pack');
        mkdirSync(join(packDir, 'schemas'), { recursive: true });
        for (const t of types) {
          const id = (t as { artifactTypeId?: string }).artifactTypeId;
          const ref = (t as { schemaRef?: string }).schemaRef;
          const schema = id ? (schemas ?? {})[id] : undefined;
          if (!id || !ref || !schema) continue;
          const target = join(packDir, ref);
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, JSON.stringify(schema), 'utf8');
        }
        writeFileSync(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');

        const outcome = loadArtifactTypePacks({ roots: [dir] });
        // RFC 0139 finding 2 (openwop-1) — derive from THIS install's outcome, not
        // a registry query. Legs 3/4 install the SAME id twice. `registerArtifactType`
        // overwrites on success and deletes nothing on failure, so a rejected second
        // install leaves install #1's entry behind: a registry query would report
        // `registered.length > 0`, return 200, and project the STALE entry — a
        // baseline-identical projection while the extension actually changed
        // behaviour. That is the exact false-negative the differential exists to
        // prevent, reintroduced in the harness.
        const registered = [...outcome.registered].filter((id) => ids.includes(id));
        if (registered.length === 0) {
          sendError(res, 422, 'install_failed', 'The pack loader registered none of the requested artifact types.', { errors: outcome.errors, registeredIds: [] });
          return;
        }
        log.info('artifact_type_conformance_pack_installed', { registeredIds: registered });
        res.status(200).json({
          installed: true,
          registeredIds: registered,
          errors: outcome.errors,
          // RFC 0139 leg 3 — the OBSERVABLE REGISTRATION PROJECTION.
          //
          // The suite installs two manifests identical except that one carries
          // unrecognised `^(x-|vendor\.)` properties, then requires the two
          // projections to be equal after recursive extension-stripping. So this
          // must expose everything the host DERIVED from the manifest, not a
          // summary: if an unrecognised extension leaked into any derived value,
          // the projections diverge and the leg reds.
          //
          // A thinner projection would pass the leg while proving less — the
          // measured failure mode openwop-1 demonstrated, where a host routing an
          // extension into a derived facet still passes legs 1, 2 and 5. What is
          // NOT surfaced here cannot be caught here.
          projection: registeredProjection(registered),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) { next(err); }
  });

  app.post('/v1/host/sample/artifacttypes/produce', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!seamEnabled()) { sendError(res, 404, 'not_found', 'The artifact-type conformance seam is not enabled on this host.'); return; }
      const { artifactTypeId, payload } = (req.body ?? {}) as { artifactTypeId?: unknown; payload?: unknown };
      if (typeof artifactTypeId !== 'string' || artifactTypeId.length === 0) {
        sendError(res, 400, 'invalid_request', 'artifactTypeId is required');
        return;
      }

      // REAL ajv validation against the registered pack schema.
      const v = validateArtifact(artifactTypeId, payload);
      const registered = v.registered === true;
      const validated = registered && v.valid === true;

      // Store ONLY a validated registered artifact. The negative leg asserts a
      // schema-violating payload is not stored as validated+registered, so the
      // guard is the behaviour under test — not a convenience.
      let artifactId = '';
      let stored = false;
      if (validated) {
        const persisted = await persistRunArtifact({
          tenantId: SEAM_TENANT,
          runId: `conformance:artifacttypes:${artifactTypeId}`,
          nodeId: 'conformance-produce',
          role: 'deliverable',
          output: payload,
          now: new Date().toISOString(),
        });
        stored = persisted !== null;
        artifactId = persisted?.artifactId ?? '';
      }

      // `rendered` reports whether a renderer ACTUALLY ran. This host resolves
      // render facets from the registered type but runs no renderer on this
      // path, so it is honestly false rather than inferred from `export[]`.
      const rendered = false;

      res.status(200).json({
        artifactId,
        registered,
        validated,
        stored,
        rendered,
        runStatus: validated ? 'completed' : 'failed',
        renderFacets: getArtifactType(artifactTypeId)?.export ?? [],
        ...(validated ? {} : { errors: v.errors ?? [] }),
      });
    } catch (err) { next(err); }
  });

  // ── RFC 0142 leg B — the EMISSION witness ────────────────────────────────
  //
  // `POST /v1/host/sample/artifacttypes/runproduce { artifactTypeId } -> { runId }`
  //
  // WHY A SECOND SEAM RATHER THAN EXTENDING `produce`. RFC 0142 §Alternatives
  // rejected asserting emission through `produce`, and it is right: that route
  // calls `persistRunArtifact`, which by explicit design emits NOTHING
  // (`runArtifactStore.ts:18`). A leg there would witness the wrong path forever
  // and report green. Emission is a property of REAL RUNS on this host, so the
  // seam has to start one.
  //
  // WHAT IT ACTUALLY DOES. Binds a document template to the requested type, then
  // runs `feature.documents.nodes.generate-from-template` through the host's
  // NORMAL execution path (`buildRunRecord` -> `insertRunWithStartContext` ->
  // `dispatchRunInBackground`, the same three calls `POST /v1/runs` makes). That
  // node is this host's only PRODUCTION `ctx.emit('artifact.created', ...)` site
  // (ADR 0746 added the conformance-only `conformance.artifact.emit`) — verified
  // by grepping for real emit calls rather than for the string, which also
  // appears in three pack comments that do NOT emit.
  //
  // THE MODEL CALL, AND WHY IT IS NOT A CHEAT. The emitting node drafts content
  // via `ctx.callAI` before it can emit, so a keyless conformance run would fail
  // at generation and witness nothing. It uses `provider: 'mock'` — the
  // deterministic stub gated on the same seam env — so the RUN and the EMISSION
  // are entirely real; only the drafted prose is canned. Nothing about the
  // artifact path is stubbed.
  //
  // WHAT THIS SEAM DOES NOT DISCRIMINATE (the question a witness must answer
  // about itself): it exercises the documents-generation path only. This host
  // also persists artifacts through the outputs-`artifact` envelope, which does
  // NOT emit, and no leg here would notice. That is why `store` is advertised
  // per-type for the emitting types only, and why a global `store: true` would
  // be a false claim on this host.
  app.post('/v1/host/sample/artifacttypes/runproduce', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!seamEnabled() || !deps) { sendError(res, 404, 'not_found', 'The artifact-type conformance seam is not enabled on this host.'); return; }
      const { artifactTypeId } = (req.body ?? {}) as { artifactTypeId?: unknown };
      if (typeof artifactTypeId !== 'string' || artifactTypeId.length === 0) {
        sendError(res, 400, 'invalid_request', 'artifactTypeId is required');
        return;
      }
      if (!isRegisteredArtifactType(artifactTypeId)) {
        // Leg B is about an artifact of a REGISTERED type; an unregistered id is a
        // caller error, not a host failure to emit.
        res.status(400).json({ error: 'invalid_request', message: `artifactTypeId not registered: ${artifactTypeId}` });
        return;
      }

      const { createTemplate } = await import('../features/documents/documentsService.js');
      const { registerWorkflow } = await import('../host/workflowsRegistry.js');
      const { programMock } = await import('../providers/dispatchMock.js');
      const { buildRunRecord, dispatchRunInBackground } = await import('../host/runDispatch.js');
      const { insertRunWithStartContext } = await import('../host/runInsert.js');

      const orgId = 'org:conformance-artifacttypes';
      const nodeId = 'gen';
      const tpl = await createTemplate({
        tenantId: SEAM_TENANT, orgId, name: `RFC 0142 leg B (${artifactTypeId})`, kind: 'doc',
        outputFormat: 'markdown', promptBody: 'Produce a short conformance document.',
        artifactTypeId, createdBy: 'conformance-runproduce',
      });

      // The mock provider returns '' unless PROGRAMMED per nodeId, and an
      // unprogrammed run dies with `generation_empty` BEFORE the emission — a
      // soft failure that would look like "this host does not emit".
      programMock(nodeId, [{ content: `# Conformance artifact\n\nProduced for ${artifactTypeId}.` }]);

      const workflowId = `conformance.artifacttypes.runproduce.${artifactTypeId}`;
      const definition = {
        workflowId, name: 'RFC 0142 leg B emission witness', version: '1.0.0',
        nodes: [{
          nodeId, typeId: 'feature.documents.nodes.generate-from-template', config: {},
          inputs: { templateId: tpl.templateId, orgId, provider: 'mock', parameters: {} },
        }],
        edges: [],
      } as unknown as WorkflowDefinition;
      registerWorkflow(definition);

      const run = buildRunRecord({ workflowId, tenantId: SEAM_TENANT, inputs: {}, now: new Date().toISOString() });
      await insertRunWithStartContext(deps.storage, run, { definition });
      dispatchRunInBackground({ storage: deps.storage, run, definition, hostSuite: deps.hostSuite });

      // Await terminal so the caller can read the event log immediately. Bounded:
      // a hang must surface as a reported non-terminal status, never as a request
      // that never returns.
      let status = 'pending';
      for (let i = 0; i < 80; i++) {
        const cur = await deps.storage.getRun(run.runId);
        status = cur?.status ?? 'pending';
        if (status !== 'pending' && status !== 'running') break;
        await new Promise((r) => setTimeout(r, 125));
      }

      res.status(200).json({ runId: run.runId, runStatus: status, artifactTypeId });
    } catch (err) { next(err); }
  });
}
