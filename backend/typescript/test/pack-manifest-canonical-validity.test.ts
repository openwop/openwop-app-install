/**
 * Publishable packs must satisfy their CANONICAL manifest schema.
 *
 * WHY THIS EXISTS. `registryInstaller.ts` verifies a pack's SRI integrity and
 * its Ed25519 signature — but performs NO manifest schema validation. A
 * signature proves AUTHORSHIP, not SHAPE, so a correctly-signed pack with a
 * structurally invalid manifest installs cleanly. That is the same distinction
 * RFC 0137 §F1 draws for pack-authored strings.
 *
 * Measured before writing this (the ADR 0504 rule — never enforce before you
 * count): across `packs/` in publishable namespaces,
 *   artifact-type : 0 pass, 2 FAIL   (missing `engines`; inline `schema` where
 *                                     canonical requires `schemaRef`)
 *   form-content  : 1 pass
 * so a blanket gate at install time would REJECT shipped packs today. The
 * sequencing is therefore: vendor the canonical schemas → pin the kinds that
 * already pass (here) → migrate the failing packs → only then gate the
 * installer. This test is step two; it must NOT be widened to failing kinds
 * before those packs are migrated, or it becomes a red gate on `main`.
 *
 * `form-content-pack-manifest.schema.json` was NOT vendored until now, even
 * though this host has PUBLISHED `core.openwop.forms.starters@1.0.0` to
 * packs.openwop.dev. A kind whose canonical schema is absent cannot be checked
 * locally at all — which is how `engines: { "openwop-app" }` (the host name
 * rather than the PROTOCOL name) once reached a publish attempt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';

const REPO = resolve(process.cwd(), '..', '..');
const SCHEMAS = join(REPO, 'schemas');
const PACKS = join(REPO, 'packs');

/** Kinds whose shipped packs are ALREADY canonical. Adding a kind here is a
 *  claim that every shipped pack of that kind validates — measure first. */
const ENFORCED: Record<string, string> = {
  'form-content': 'form-content-pack-manifest.schema.json',
};

/**
 * Artifact-type packs that are canonical EXCEPT for their `artifactTypeId`
 * namespace — the residual axis after #3026 (shape) and #3030 (read-side
 * aliases). These ids cannot be renamed: `detectTypedArtifact` reads
 * `artifactTypeId` out of a node output envelope, so they live in the
 * immutable, replayed run-event log. Upstream logged that as RFC 0138 gap G5.
 *
 * Only `core.`/`community.` packs appear here. The two `feature.*`
 * artifact-type packs are deliberately excluded: their PACK NAME is
 * non-canonical too, and that is a closed WON'T-FIX (`PMC-6`) because they are
 * mounted locally and never registry-published.
 */
const RESIDUAL_ID_NAMESPACE_ONLY = ['community.openwop.canvas-checklist', 'core.openwop.artifact-types'];

function compile(schemaFile: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(JSON.parse(readFileSync(join(SCHEMAS, schemaFile), 'utf8')) as object);
}

describe('publishable pack manifests validate against their canonical schema', () => {
  it('the canonical schema for every ENFORCED kind is vendored in-repo', () => {
    // A missing schema silently disables the check below — the failure mode is a
    // green run that validated nothing, so assert presence separately.
    for (const [kind, file] of Object.entries(ENFORCED)) {
      expect(existsSync(join(SCHEMAS, file)), `${kind}: ${file} is not vendored`).toBe(true);
    }
  });

  it('every shipped pack of an ENFORCED kind validates', () => {
    let checked = 0;
    for (const dir of readdirSync(PACKS)) {
      const manifestPath = join(PACKS, dir, 'pack.json');
      if (!existsSync(manifestPath)) continue;
      let manifest: { kind?: string };
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { kind?: string }; } catch { continue; }
      const kind = manifest.kind;
      if (!kind || !(kind in ENFORCED)) continue;
      const validate = compile(ENFORCED[kind]!);
      const ok = validate(manifest);
      expect(ok, `${dir} [${kind}] -> ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
      checked += 1;
    }
    // Non-vacuity: if no pack of an enforced kind exists, the loop asserted
    // nothing and would pass silently.
    expect(checked, 'no pack of an ENFORCED kind was found — the assertion was vacuous').toBeGreaterThan(0);
  });
});

/**
 * The tripwire this program lacked.
 *
 * `PMC-2` sat labelled "BLOCKED upstream" for a day after the block was lifted:
 * RFC 0138 reached `Active` and its `^(x-|vendor\.)` hatch was vendored here,
 * and nothing noticed. A blocked item that silently un-blocks is
 * indistinguishable from one that never will — so pin the residue instead of
 * the block. These assertions go RED the day upstream resolves G5, which is the
 * signal to promote `artifact-type` into ENFORCED above.
 */
describe('artifact-type packs: the residual canonical gap is EXACTLY the id namespace', () => {
  it('each residual pack fails on `artifactTypeId` and on nothing else', () => {
    const validate = compile('artifact-type-pack-manifest.schema.json');
    for (const dir of RESIDUAL_ID_NAMESPACE_ONLY) {
      const manifestPath = join(PACKS, dir, 'pack.json');
      expect(existsSync(manifestPath), `${dir}: pack.json is missing`).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as object;

      const ok = validate(manifest);
      const errors = validate.errors ?? [];

      // If this pack now PASSES, upstream resolved G5 (or the ids were renamed
      // — which must not happen, see the header). Either way the map in
      // `host/artifactTypes.ts` and ENFORCED above need revisiting.
      expect(
        ok,
        `${dir} now validates canonically. If RFC 0138 G5 landed, promote 'artifact-type' into ENFORCED. Do NOT reach this by renaming an artifactTypeId — those ids are in the replayed event log.`,
      ).toBe(false);

      // Non-vacuity: an empty error list would make the per-error loop below
      // assert nothing while still reporting "fails on the id namespace".
      expect(errors.length, `${dir}: validation failed with no reported errors`).toBeGreaterThan(0);

      for (const err of errors) {
        expect(
          { path: err.instancePath, keyword: err.keyword },
          `${dir}: an UNEXPECTED canonical divergence appeared — ${err.instancePath} ${err.message}`,
        ).toEqual({ path: expect.stringMatching(/\/artifactTypes\/\d+\/artifactTypeId$/), keyword: 'pattern' });
      }
    }
  });

  it('the RFC 0138 vendor-extension hatch keeps `x-openwop-app.canvas` legal', () => {
    // The original PMC-2 blocker: under `additionalProperties: false` this key
    // was structurally illegal, so migrating the pack would have DELETED a
    // working feature (it registers the canvas component catalog). Assert the
    // key is still carried AND still produces no error — a green run with the
    // key quietly dropped from the pack would otherwise look identical.
    const manifest = JSON.parse(
      readFileSync(join(PACKS, 'community.openwop.canvas-checklist', 'pack.json'), 'utf8'),
    ) as { artifactTypes?: Record<string, unknown>[] };

    const carrier = (manifest.artifactTypes ?? []).find((at) => 'x-openwop-app.canvas' in at);
    expect(carrier, '`x-openwop-app.canvas` is gone from the pack — the extension it guards was dropped').toBeDefined();

    const validate = compile('artifact-type-pack-manifest.schema.json');
    validate(manifest);
    const extensionErrors = (validate.errors ?? []).filter(
      (e) => e.keyword === 'additionalProperties' || String(e.instancePath).includes('x-openwop-app'),
    );
    expect(extensionErrors, 'the vendor-extension hatch regressed — RFC 0138 is no longer honoured').toEqual([]);
  });
});
