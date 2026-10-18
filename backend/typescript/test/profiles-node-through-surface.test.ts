/**
 * ADR 0624 D1/D2 — `feature.profiles.nodes.{get,list}` driven THROUGH the real
 * `buildProfilesSurface` on a seeded tenant (`UPWF-3`).
 *
 * WHY THIS TEST EXISTS: from #1935 (2026-07-16) to ADR 0624 the pack sent
 * `{ profileId }` while the surface read `args.userId`; `surfaceStr` coerced
 * the absent key to `''`, `getProfile(tenantId, '')` was a store miss, and the
 * node reported `{ status: 'success', outputs: { profile: null } }` for EVERY
 * input. The surface was tested (`team-portfolio-kb.test.ts` calls it with
 * `{ userId }`) and the pack was not — the `mechanism-vs-wiring-must-be-tested-
 * separately` class. This test crosses the pack→surface edge with the pack's
 * OWN `nodes` map, so a key drift on either side turns it red.
 *
 * What is pinned:
 *   - `get { userId }` on a seeded member → a NON-NULL projection, `found: true`;
 *   - an unknown id → `{ profile: null, found: false }` (an EXPLICIT empty);
 *   - NO `userId` → the node returns `status: 'failure'` carrying the surface's
 *     typed `validation_error` (never a success-with-null), and the surface
 *     itself rejects the same call with an `OpenwopError('validation_error')`;
 *   - the 1.0.0 key (`profileId`) is now a FAILURE, not a silent null;
 *   - `list` → the roster, internal columns stripped, endorsements projected as
 *     `{ count, endorserUserIds }` (D7 — viewer-independent);
 *   - the manifest declares the schemas with ADR 0525 `$id`s at the manifest
 *     version (the feature→pack version pin lives in
 *     `required-packs-pin-parity.test.ts`; the `profiles` surface id in
 *     `pack-surface-arg-parity.test.ts`'s anti-vacuity case).
 *
 * Sabotage that turns it red (grade-tests w3 probes, each witnessed):
 *   - the pack sends `{ profileId }` again                       → the seeded-member case
 *   - the surface stops refusing an empty id                     → the three refusal cases
 *   - the node maps a refusal to success-with-null               → NO-userId + 1.0.0-key cases
 *   - `found` forced true                                        → the unknown-id case
 *   - internal columns not stripped / `endorsedByMe` on the surface → get + list cases
 *   - `getProfile` drops its tenant check                        → the foreign-tenant case
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { OpenwopError } from '../src/types.js';
import { buildProfilesSurface } from '../src/features/profiles/surface.js';
import { createUser } from '../src/features/users/usersService.js';
import { registerSessionAuthority, __resetSessionAuthority } from '../src/host/sessionAuthority.js';
import {
  __resetProfiles,
  getOrCreateProfile,
  setEndorsement,
  setOwnSkills,
  updateOwnProfile,
} from '../src/features/profiles/profilesService.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK_DIR = join(REPO, 'packs/feature.profiles.nodes');

interface Manifest {
  name: string;
  version: string;
  nodes: Array<{ typeId: string; role?: string; inputSchemaRef?: string; outputSchemaRef?: string }>;
}
type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>;

const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as Manifest;
const T = 'org:profiles-node-surface';
// Real users of T (the directory skips ORPHAN profiles — `listHomeDirectory`,
// ADR 0888 PROF2CD-4 — so a profile with no owning user is not a member's row).
let ALICE: string;
let BOB: string;

let nodes: Record<string, NodeFn>;
/** ADR 0888 D3 — the run's acting user: a durable, active member of `T` (a run
 *  with no acting user is refused, and that refusal has its own case below). */
let ACTOR: string;

/** A NodeContext the way the executor binds one: `inputs` + the feature
 *  surfaces built for the run's tenant scope (`buildFeatureSurfaces` → `ctx.features`). */
function ctxFor(inputs: Record<string, unknown>): Record<string, unknown> {
  return { inputs, config: {}, features: { profiles: buildProfilesSurface({ tenantId: T, actingUserId: ACTOR }) } };
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetProfiles();
  registerSessionAuthority(async () => ({ status: 'active', sessionEpoch: 0 }));
  ACTOR = (await createUser({ tenantId: T, principalId: 'oidc:pns-actor', source: 'oidc' })).userId;
  ALICE = (await createUser({ tenantId: T, principalId: 'oidc:pns-alice', source: 'oidc' })).userId;
  BOB = (await createUser({ tenantId: T, principalId: 'oidc:pns-bob', source: 'oidc' })).userId;
  const mod = (await import(pathToFileURL(join(PACK_DIR, 'index.mjs')).href)) as { nodes: Record<string, NodeFn> };
  nodes = mod.nodes;
  await getOrCreateProfile(T, ALICE);
  await updateOwnProfile(T, ALICE, { jobTitle: 'Producer', bio: 'Ships things.' });
  await setOwnSkills(T, ALICE, [{ name: 'TypeScript', proficiency: 4 }]);
  await getOrCreateProfile(T, BOB);
  await setEndorsement(T, ALICE, 'TypeScript', BOB, true);
});

afterEach(() => {
  __resetSessionAuthority();
  __resetHostExtPersistence();
});

describe('feature.profiles.nodes.get through the REAL surface (UPWF-1 / UPWF-3)', () => {
  it('get { userId } on a seeded member → a non-null projection with found:true', async () => {
    const out = await nodes['feature.profiles.nodes.get']!(ctxFor({ userId: ALICE }));
    expect(out.status).toBe('success');
    expect(out.outputs?.found).toBe(true);
    const profile = out.outputs?.profile as Record<string, unknown> | null;
    expect(profile).not.toBeNull();
    expect(profile!.userId).toBe(ALICE);
    expect(profile!.jobTitle).toBe('Producer');
    // Internal columns stripped; endorsements projected viewer-independently (D7).
    expect('tenantId' in profile!).toBe(false);
    expect('updatedBy' in profile!).toBe(false);
    expect(profile!.skills).toEqual([{ name: 'TypeScript', proficiency: 4, endorsements: { count: 1, endorserUserIds: [BOB] } }]);
    expect(JSON.stringify(profile)).not.toContain('endorsedByMe');
    expect('completenessMissing' in profile!).toBe(false); // D4 — self-lane only, never on the surface
  });

  it('an unknown id is an EXPLICIT empty: { profile: null, found: false } with status success', async () => {
    const out = await nodes['feature.profiles.nodes.get']!(ctxFor({ userId: 'user:nobody' }));
    expect(out.status).toBe('success');
    expect(out.outputs).toEqual({ profile: null, found: false });
  });

  it('NO userId → status:failure carrying the surface\'s typed validation_error (never success-with-null)', async () => {
    for (const inputs of [{}, { userId: '' }, { userId: '   ' }, { userId: 42 }]) {
      const out = await nodes['feature.profiles.nodes.get']!(ctxFor(inputs));
      expect(out.status, JSON.stringify(inputs)).toBe('failure');
      expect(out.error?.code).toBe('validation_error');
      expect(out.error?.message).toContain('`userId` is required');
      expect(out.outputs).toBeUndefined();
    }
  });

  it('the 1.0.0 key ({ profileId }) is now a typed FAILURE, not a silent null', async () => {
    const out = await nodes['feature.profiles.nodes.get']!(ctxFor({ profileId: ALICE }));
    expect(out.status).toBe('failure');
    expect(out.error?.code).toBe('validation_error');
  });

  it('the surface itself refuses an empty id with OpenwopError(validation_error, 400)', async () => {
    const surface = buildProfilesSurface({ tenantId: T, actingUserId: ACTOR });
    await expect(surface.getProfile!({})).rejects.toMatchObject({ code: 'validation_error', httpStatus: 400 });
    await expect(surface.getProfile!({ userId: '' })).rejects.toBeInstanceOf(OpenwopError);
    // …and a real miss is a typed empty, not a refusal.
    await expect(surface.getProfile!({ userId: 'user:nobody' })).resolves.toEqual({ profile: null, found: false });
  });

  // CORRECTED (ADR 0888 D3): this read `{ found: false }` for a scope with NO
  // acting user, which is the hole (`PR2WF-1`) — the surface served whatever
  // tenant the run named. A foreign tenant is now a typed refusal for the actor,
  // and a run with no actor is refused outright; both reach the chain as a node
  // FAILURE carrying `forbidden_scope` + the reason, never a success.
  it('a foreign-tenant scope is a typed forbidden_scope failure (the actor is not a member there)', async () => {
    const out = await nodes['feature.profiles.nodes.get']!({ inputs: { userId: ALICE }, config: {}, features: { profiles: buildProfilesSurface({ tenantId: 'org:someone-else', actingUserId: ACTOR }) } });
    expect(out.status).toBe('failure');
    expect(out.error).toMatchObject({ code: 'forbidden_scope', details: { reason: 'not_a_member' } });
  });

  it('a run with NO acting user is a typed forbidden_scope failure on both nodes', async () => {
    const features = { profiles: buildProfilesSurface({ tenantId: T }) };
    for (const id of ['feature.profiles.nodes.get', 'feature.profiles.nodes.list']) {
      const out = await nodes[id]!({ inputs: { userId: ALICE }, config: {}, features });
      expect(out.status, id).toBe('failure');
      expect(out.error, id).toMatchObject({ code: 'forbidden_scope', details: { reason: 'no_acting_user' } });
      expect(out.outputs, id).toBeUndefined();
    }
  });
});

describe('feature.profiles.nodes.list through the REAL surface', () => {
  it('lists the roster with internal columns stripped and endorsements projected', async () => {
    const out = await nodes['feature.profiles.nodes.list']!(ctxFor({}));
    expect(out.status).toBe('success');
    const profiles = out.outputs?.profiles as Array<Record<string, unknown>>;
    expect(profiles.map((p) => p.userId).sort()).toEqual([ALICE, BOB].sort()); // the actor never opened a profile
    // ADR 0888 D2 — a recorded node output carries capability, never bio/contact/asset tokens.
    expect(profiles.every((p) => !('bio' in p) && !('contact' in p) && !('avatarAssetToken' in p))).toBe(true);
    expect(profiles.every((p) => !('tenantId' in p) && !('updatedBy' in p))).toBe(true);
    const alice = profiles.find((p) => p.userId === ALICE)!;
    expect((alice.skills as Array<{ endorsements: unknown }>)[0]!.endorsements).toEqual({ count: 1, endorserUserIds: [BOB] });
  });
});

describe('pack shape — schemas with ADR 0525 $ids at the manifest version', () => {
  it('get declares input+output refs, list declares an output ref; every ref resolves with the <pack>/<version>/<file> $id', () => {
    const get = manifest.nodes.find((n) => n.typeId === 'feature.profiles.nodes.get');
    const list = manifest.nodes.find((n) => n.typeId === 'feature.profiles.nodes.list');
    expect(get?.inputSchemaRef).toBe('schemas/get.input.json');
    expect(get?.outputSchemaRef).toBe('schemas/get.output.json');
    expect(list?.outputSchemaRef).toBe('schemas/list.output.json');
    for (const ref of [get!.inputSchemaRef!, get!.outputSchemaRef!, list!.outputSchemaRef!]) {
      const path = join(PACK_DIR, ref);
      expect(existsSync(path), `${ref} missing`).toBe(true);
      const schema = JSON.parse(readFileSync(path, 'utf8')) as { $id?: string; type?: string };
      expect(schema.$id).toBe(`https://packs.openwop.dev/${manifest.name}/${manifest.version}/${ref.replace(/^schemas\//, '')}`);
      expect(schema.type).toBe('object');
    }
    // Reads stay recorded actions (replay-served), never side-effects.
    expect(manifest.nodes.every((n) => n.role === 'action')).toBe(true);
  });

  it('get.output requires BOTH profile and found; profile is object|null', () => {
    const out = JSON.parse(readFileSync(join(PACK_DIR, 'schemas/get.output.json'), 'utf8')) as { required: string[]; properties: Record<string, { type: unknown }>; additionalProperties: boolean };
    expect(out.required.sort()).toEqual(['found', 'profile']);
    expect(out.properties.found!.type).toBe('boolean');
    expect(out.properties.profile!.type).toEqual(['object', 'null']);
    expect(out.additionalProperties).toBe(false);
  });
});
