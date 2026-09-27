/**
 * ADR 0694 — `visibility` is the ACL, not an ordinary field.
 *
 * D1 (`PLC-6`): `updateEntry` deliberately reads UNFILTERED so an org writer keeps
 * managing any entry, and it used to apply `input.visibility` with no owner check.
 * A `workspace:write` member could therefore flip a co-member's `private` entry to
 * `org`/`shared` and read the body — a GRANT wearing the costume of an edit, and the
 * same lane ADR 0644 D1 closed on the sharing MINT path.
 *
 * D3 (`PLC-7`): portability import stamped `createdBy` with the RAW request subject
 * (`callerSubject(req) ?? 'import'`) while every read compares the CANONICAL
 * `user.userId`, and defaulted `visibility` to `private`. An unbound-OIDC import was
 * therefore owned by an id no read can produce; the `'import'` fallback was unownable
 * outright. Both mint rows readable by NOBODY that `listEntriesUnfiltered` re-exports.
 *
 * D2 (`PLWF-3`): the three nodes are pure reads and are NOT replay-served. The role
 * correction must move no set MEMBERSHIP.
 *
 * Born red on all three: before ADR 0694, leg 1 widened successfully, leg 5 produced
 * an unreadable row, and leg 7 read `role:"action"`.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createUserTemplate, clearUserTemplatesForTest } from '../src/host/promptStore.js';
import { userIdFor } from '../src/features/users/usersService.js';
import {
  createEntry, listEntries, getEntry, updateEntry, readableBy, VALID_VISIBILITY,
} from '../src/features/prompts/promptLibraryService.js';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED, MANIFEST_DECLARED_TYPE_IDS } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const T = 'pl-vis-tenant';
const OWNER = 'user:owner-1';
const OTHER = 'user:other-1';
const NODES = ['feature.prompts.nodes.list-library', 'feature.prompts.nodes.get-entry', 'feature.prompts.nodes.render-entry'];

let orgN = 0;
let ORG = 'org-a';

function seed(id: string): void {
  expect(createUserTemplate({ templateId: id, version: '1.0.0', kind: 'user', text: 'Hello {{name}}', name: id }).ok).toBe(true);
}

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-plvis-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(() => { clearUserTemplatesForTest(); ORG = `vorg-${orgN++}`; });

describe('ADR 0694 D1 — only the owner may change a private prompt visibility', () => {
  it('leg 1: a co-member with write authority may NOT widen someone else private entry', async () => {
    seed('t1');
    const e = await createEntry(T, ORG, OWNER, { name: 'Mine', promptRef: 't1', visibility: 'private' });
    expect(e.visibility).toBe('private');
    expect(await getEntry(T, ORG, e.entryId, OTHER), 'precondition: OTHER cannot read it').toBeNull();

    await expect(
      updateEntry(T, ORG, e.entryId, OTHER, { visibility: 'shared' }),
      'a workspace:write co-member must not be able to GRANT access to it',
    ).rejects.toMatchObject({ code: 'forbidden' });

    expect((await getEntry(T, ORG, e.entryId, OWNER))?.visibility, 'the refused widening wrote nothing').toBe('private');
    expect(await getEntry(T, ORG, e.entryId, OTHER), 'and it is still unreadable').toBeNull();
  });

  it('leg 2: the OWNER may widen their own entry', async () => {
    seed('t2');
    const e = await createEntry(T, ORG, OWNER, { name: 'Mine2', promptRef: 't2', visibility: 'private' });
    const up = await updateEntry(T, ORG, e.entryId, OWNER, { visibility: 'org' });
    expect(up.visibility).toBe('org');
    expect(await getEntry(T, ORG, e.entryId, OTHER), 'now visible to the org').not.toBeNull();
  });

  it('leg 3: once org-visible, any writer may change it (the gate is about PRIVATE, not about visibility edits)', async () => {
    seed('t3');
    const e = await createEntry(T, ORG, OWNER, { name: 'Shared3', promptRef: 't3', visibility: 'org' });
    const up = await updateEntry(T, ORG, e.entryId, OTHER, { visibility: 'shared' });
    expect(up.visibility, 'a readable entry is not owner-gated').toBe('shared');
  });

  it('leg 4 (negative control): the OTHER fields stay org-writable — D1 must not become a general owner-only rule', async () => {
    seed('t4a'); seed('t4b');
    const e = await createEntry(T, ORG, OWNER, { name: 'Editable', promptRef: 't4a', visibility: 'private' });
    const up = await updateEntry(T, ORG, e.entryId, OTHER, { name: 'Renamed', tags: ['x'], promptRef: 't4b' });
    expect(up.name, 'org-scoped write authority over ordinary fields is UNCHANGED').toBe('Renamed');
    expect(up.promptRef).toBe('t4b');
    expect(up.visibility, 'and visibility is untouched by an edit that did not name it').toBe('private');
  });
});

describe('ADR 0694 D3 — an imported entry must be readable by the org it was imported into', () => {
  it('leg 5: the raw-subject hazard — a non-canonical owner id would make the row readable by NOBODY', async () => {
    seed('t5');
    // This is the id space the import path used to stamp: the RAW request subject.
    const raw = 'oidc:sub-abc';
    const canonical = userIdFor(T, raw);
    expect(canonical, 'the two id spaces genuinely differ — otherwise this leg is vacuous').not.toBe(raw);

    // A row stamped with the RAW id is unreadable by its own owner's canonical id.
    const bad = await createEntry(T, ORG, raw, { name: 'RawOwned', promptRef: 't5', visibility: 'private' });
    expect(readableBy(bad, canonical), 'THE DEFECT: the owner cannot read their own row').toBe(false);
    expect(await getEntry(T, ORG, bad.entryId, canonical)).toBeNull();

    // Stamped canonically (what D3a now does), the owner can read it.
    const good = await createEntry(T, ORG, canonical, { name: 'Canonical', promptRef: 't5', visibility: 'private' });
    expect(readableBy(good, canonical)).toBe(true);
  });

  it('leg 6: the import default is org-visible, so a second member can read it', async () => {
    seed('t6');
    const e = await createEntry(T, ORG, OWNER, { name: 'Imported', promptRef: 't6', visibility: 'org' });
    expect((await listEntries(T, ORG, OTHER)).map((r) => r.entryId), 'an org-visible import is visible to the org').toContain(e.entryId);
    expect(VALID_VISIBILITY.has('org'), 'the allowlist the import validates against is the SAME exported set').toBe(true);
  });
});

describe('ADR 0694 D3 — the IMPORT LANE itself canonicalizes (wiring, not just the helper)', () => {
  it('leg 6b: a raw-subject import produces a row the canonical owner CAN read', async () => {
    // WHY THIS LEG EXISTS: legs 5/6 exercise the RULE. Sabotaging
    // `canonicalPromptActor` reds pre-existing surface tests — but reverting the
    // PORTABILITY CALL SITE to the raw actor (the exact PLC-7 defect) left all 35
    // tests GREEN. Mechanism and wiring must be pinned separately; this leg drives
    // `applyImport` end-to-end so the CALL SITE cannot silently regress.
    const { applyImport } = await import('../src/features/portability/portabilityService.js');
    const TB = 'pl-import-tenant';
    seed('tpl-import-1');
    const raw = 'oidc:importer-9';
    const canonical = userIdFor(TB, raw);
    expect(canonical, 'the id spaces must genuinely differ or this leg is vacuous').not.toBe(raw);

    const res = await applyImport(TB, raw, {
      bundleVersion: '1',
      source: { origin: 'adapter:test' },
      items: [{ kind: 'prompt-template', ref: 'p1', payload: { name: 'imported-one', orgId: 'io1', promptRef: 'tpl-import-1' } }],
    });
    expect(res.items.find((i) => i.ref === 'p1')?.status, JSON.stringify(res)).toBe('imported');

    const mine = await listEntries(TB, 'io1', canonical);
    expect(mine.map((e) => e.name), 'the importer must be able to read what they imported').toContain('imported-one');
    const row = mine.find((e) => e.name === 'imported-one')!;
    expect(row.createdBy, 'createdBy lands in the id space reads compare against').toBe(canonical);
    expect(row.visibility, 'a bundle naming no visibility defaults to the CONSERVATIVE private (D3b, corrected)').toBe('private');
    // The point of D3a: a private import is readable by its IMPORTER — not by nobody.
    expect((await listEntries(TB, 'io1', 'user:someone-else')).map((e) => e.name))
      .not.toContain('imported-one');
  });

  it('leg 6d: a ROUND TRIP preserves visibility — export→import must never widen a private prompt', async () => {
    // THE BUG THIS PINS WAS MINE. An earlier draft of D3b defaulted an unspecified
    // import to `org`, and the exporter did not carry `visibility` at all — so every
    // exported `private` prompt would have returned `org`-visible. A fix that creates
    // a fresh instance of the class it closes.
    const { buildExportBundle, applyImport } = await import('../src/features/portability/portabilityService.js');
    const { createOrg } = await import('../src/host/accessControlService.js');
    const TS = 'pl-rt-src';
    seed('tpl-rt');
    // The exporter walks `listOrgs(tenantId)` (portabilityService.ts:276), so the
    // org must really exist — writing entries under a bare orgId string exports NOTHING.
    const srcOrg = await createOrg({ tenantId: TS, createdBy: OWNER, name: 'RT Src' });
    const priv = await createEntry(TS, srcOrg.orgId, OWNER, { name: 'rt-private', promptRef: 'tpl-rt', visibility: 'private' });
    const shared = await createEntry(TS, srcOrg.orgId, OWNER, { name: 'rt-org', promptRef: 'tpl-rt', visibility: 'org' });
    expect(priv.visibility).toBe('private');
    expect(shared.visibility).toBe('org');

    const bundle = await buildExportBundle(TS, ['prompt-template'], OWNER) as { items: { payload: Record<string, unknown> }[] };
    const exported = bundle.items.filter((i) => ['rt-private', 'rt-org'].includes(String(i.payload.name)));
    expect(exported.length, 'both entries exported').toBe(2);
    for (const i of exported) {
      expect(i.payload.visibility, `export must CARRY visibility for ${String(i.payload.name)}`).toBeDefined();
    }

    const TD = 'pl-rt-dst';
    // No re-seed: `createUserTemplate` is GLOBAL (no tenantId), so the template
    // seeded above is already resolvable from the destination tenant.
    const res = await applyImport(TD, OWNER, { bundleVersion: '1', source: { origin: 'adapter:test' }, items: bundle.items });
    expect(res.imported, JSON.stringify(res)).toBeGreaterThan(0);
    const destOrg = String((bundle.items.find((i) => i.payload.name === 'rt-private')!).payload.orgId);
    const landed = await listEntries(TD, destOrg, OWNER);
    expect(landed.find((e) => e.name === 'rt-private')?.visibility, 'private must STAY private across a round trip').toBe('private');
    expect(landed.find((e) => e.name === 'rt-org')?.visibility, 'and org must stay org').toBe('org');
  });

  it('leg 6c: an import with no resolvable subject is refused, not minted unownable (D3c)', async () => {
    const { applyImport } = await import('../src/features/portability/portabilityService.js');
    const TB = 'pl-import-tenant2';
    seed('tpl-import-2');
    const res = await applyImport(TB, 'import', {
      bundleVersion: '1',
      source: { origin: 'adapter:test' },
      items: [{ kind: 'prompt-template', ref: 'p2', payload: { name: 'orphan', orgId: 'io2', promptRef: 'tpl-import-2' } }],
    });
    const item = res.items.find((i) => i.ref === 'p2')!;
    expect(item.status, 'a subject-less import must SKIP rather than mint a row nobody can read').toBe('skipped');
    expect(String(item.message ?? '')).toMatch(/authenticated importer|no subject/i);
    expect((await listEntries(TB, 'io2', undefined)).length, 'and nothing was written').toBe(0);
  });
});

describe('ADR 0694 D2 — the prompts nodes are honest reads', () => {
  const PM = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.prompts.nodes', 'pack.json'), 'utf8')) as {
    version: string; nodes: { typeId: string; role: string; capabilities?: string[] }[];
  };

  it('leg 7: all three declare role:read (was "action" over three pure reads)', () => {
    const byId = new Map(PM.nodes.map((n) => [n.typeId, n]));
    for (const id of NODES) {
      expect(byId.get(id)?.role, id).toBe('read');
      expect(byId.get(id)?.capabilities ?? [], id).not.toContain('side-effectful');
    }
  });

  it('leg 8: set MEMBERSHIP is unchanged — not in the floor, not served, still declared', () => {
    for (const id of NODES) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), `${id} is not a side effect`).toBe(false);
      expect(MANIFEST_FAST_PATH_SERVED.has(id), `${id} is NOT replay-served (the old docblock claimed it was)`).toBe(false);
      expect(MANIFEST_DECLARED_TYPE_IDS.has(id), `${id} is declared`).toBe(true);
      expect(isSideEffectingNode(id), id).toBe(false);
    }
  });

  it('leg 9: the feature pin equals the manifest version (RFC 0076 lockstep)', () => {
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'prompts', 'feature.ts'), 'utf8');
    expect(feature).toContain(`{ name: 'feature.prompts.nodes', version: '${PM.version}' }`);
  });

  it('leg 10: the retired replay claim may appear only inside a correction that disowns it', () => {
    const src = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'prompts', 'promptSurface.ts'), 'utf8');
    const RETIRED = 'replay-safe via the';
    const at = src.indexOf(RETIRED);
    if (at !== -1) {
      // Asserting ABSENCE would go red against this file's own correction note, which
      // quotes the claim in order to retire it (the "ratchets count comments" trap).
      const preamble = src.slice(Math.max(0, at - 400), at);
      expect(preamble, 'the retired claim may appear only inside a CORRECTED note').toMatch(/CORRECTED|used to claim/);
      expect(src.indexOf(RETIRED, at + RETIRED.length), 'and exactly once, quoted').toBe(-1);
    }
    expect(src, 'the true mechanism must be stated').toMatch(/NOT replay-served|re-read the LIVE store/);
  });
});
