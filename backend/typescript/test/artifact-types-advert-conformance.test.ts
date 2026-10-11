/**
 * `artifactTypes` advert vs. its DECLARED shape — RFC 0144 / RFC 0075.
 *
 * WHY THIS EXISTS. Until RFC 0144 declared the family, `artifactTypes` had no
 * schema to be checked against — and it had drifted from its own normative prose
 * for as long as that was true. This host emitted a `types` ARRAY of
 * `{artifactTypeId, title, schemaUrl, export, registrationSource}` plus a
 * top-level `schemaEndpoint`, while `host-capabilities.md` §host.artifactTypes has
 * said since RFC 0075 that `types` is a MAP keyed by `artifactTypeId` carrying
 * `{validated, validation, schemaVersion, store, render, export}`.
 *
 * Nothing caught it. Not this repo's tests, not the conformance suite — both were
 * green throughout, because an undeclared family has nothing to disagree with.
 * Measured against the declaration the day it landed, the old advert failed ajv on
 * two counts: `additionalProperties: "schemaEndpoint"` and `/types must be object`.
 *
 * So the check is not "does the advert look right" but "does it VALIDATE against
 * the vendored declaration" — the same artifact a conformance consumer reads.
 * Vendored via `scripts/sync-schemas.sh`; if that sync goes stale this test is
 * checking against an old contract, which leg 3 exists to catch.
 *
 * RFC 0142 will add per-type `store` to these entries. That lands INSIDE `types`,
 * which is exactly the field whose shape was wrong — so this test is the
 * precondition for leg B's witness, not a parallel concern.
 */
import http from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { corpusSchema } from './support/corpusSchema.js';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let server: http.Server;
let BASE = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const advert = async (): Promise<Record<string, unknown>> => {
  // ADR 0812 P4 — the SERVED root (header-less is the v2 document). This used to
  // read the v1 builder, which is deleted; the v2 `artifactTypes` record carries
  // the same `types` map (`artifactTypesAdvert()`).
  const res = await fetch(`${BASE}/.well-known/openwop`);
  expect(res.status).toBe(200);
  const doc = (await res.json()) as Record<string, unknown>;
  return doc['artifactTypes'] as Record<string, unknown>;
};

/** The v2 declaration of the family, from the PACKAGE, not the vendored copy — a
 *  vendored copy can drift and certify the advert against a contract that no
 *  longer exists (RFC 0145 G2). Compiled through the whole document so any
 *  `$ref` inside the family resolves. */
const compileDeclared = (ajv: Ajv2020): ReturnType<Ajv2020['compile']> => {
  // The v2 schemas `$ref` their siblings by bare filename, so the one the family
  // record references (`configurable.schema.json`) is registered beside it.
  // Every sibling is registered, the way `adr0670-v2-advert-validates` does it.
  const caps = corpusSchema('v2/capabilities.schema.json') as { $id?: string };
  const dir = dirname(createRequire(`${process.cwd()}/`).resolve('@openwop/spec-artifacts/schemas/v2/capabilities.schema.json'));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try { ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>); } catch { /* a malformed sibling is its own test's problem */ }
  }
  return ajv.compile({ $ref: `${caps.$id ?? ''}#/properties/artifactTypes` });
};

describe('artifactTypes advert conforms to its declared shape', () => {
  it('leg 1: the LIVE advert validates against the v2 declaration of the family', async () => {
    const emitted = await advert();
    const validate = compileDeclared(new Ajv2020({ strict: false, allErrors: true }));
    const ok = validate(emitted);
    expect(
      ok,
      `advert does not validate: ${JSON.stringify(validate.errors ?? [], null, 1)}`,
    ).toBe(true);
  });

  it('leg 2: `types` is a keyed MAP of real registered types, not an array', async () => {
    const emitted = await advert();
    const types = emitted['types'];
    expect(Array.isArray(types), '`types` is a map keyed by artifactTypeId (RFC 0075), never an array').toBe(false);
    expect(typeof types).toBe('object');

    const entries = Object.entries(types as Record<string, Record<string, unknown>>);
    // Non-vacuity: an empty map would satisfy every assertion below.
    expect(entries.length, 'this host registers artifact types at boot').toBeGreaterThan(0);

    for (const [id, facets] of entries) {
      expect(id, 'the key IS the artifactTypeId').toMatch(/^[a-z][a-zA-Z0-9._-]*$/);
      // `validated: true` is a GUARANTEE, honoured by
      // runArtifactStore.detectTypedArtifact (registered-gate → validate → refuse).
      expect(facets['validated'], `${id}: this host validates registered types before emit`).toBe(true);
      expect(['open', 'closed']).toContain(facets['validation']);
    }
  });

  it('leg 3: no host-invented keys creep back in', async () => {
    const emitted = await advert();
    // Both were emitted before 2026-08-10 and both carried information the
    // consumer can DERIVE: the canonical schema URL is fixed by
    // `artifact-type-packs.md` §"Schema distribution" as
    // `{HostBase}/schemas/artifacts/{artifactTypeId}.schema.json`.
    expect(emitted['schemaEndpoint'], 'derivable — do not re-advertise').toBeUndefined();
    for (const facets of Object.values(emitted['types'] as Record<string, Record<string, unknown>>)) {
      expect(facets['schemaUrl'], 'derivable per-type — do not re-advertise').toBeUndefined();
    }
    // The declaration is `additionalProperties: false`, so leg 1 already rejects a
    // new top-level key. This leg names the two by hand because the REASON they
    // are gone (computable ⇒ not a discovery concern) is a judgement the schema
    // cannot express, and a future author would otherwise only see "schema says no".
  });
});
