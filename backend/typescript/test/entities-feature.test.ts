/**
 * Entities feature (ADR 0386 Phases 1–4) — route-level coverage: toggle gating,
 * three-tier RBAC, type-name uniqueness, closed-world value validation,
 * cross-tenant IDOR (404, no existence leak), pagination, delete guards,
 * references/taxonomies/relationships, query + import/export, and API-key auth.
 *
 * Every case seeds its OWN tenant and fixtures (no case reads another's state),
 * and every refusal is asserted by its exact envelope code + message, so a
 * refusal from a different check cannot stand in.
 *
 * Tracker TST-CXG-3. Red when (features/entities/routes.ts / entitiesService.ts):
 * an API key's read or write tier stops checking its per-type scope; the admin
 * tier is granted without `entities:admin`; a key reaches a draft type; the
 * default onDelete stops being `restrict`; or the session toggle gate is removed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

interface Client {
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
  post: (path: string, body?: unknown) => Promise<Response>;
  patch: (path: string, body?: unknown) => Promise<Response>;
  del: (path: string) => Promise<Response>;
}

function client(): Client & { login: (subject: string, tenantId: string) => Promise<void> } {
  let cookie = '';
  const send = async (
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(extraHeaders ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    return res;
  };
  return {
    get: (p, h) => send('GET', p, undefined, h),
    post: (p, b) => send('POST', p, b),
    patch: (p, b) => send('PATCH', p, b),
    del: (p) => send('DELETE', p),
    login: async (subject, tenantId) => {
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
}

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default: ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

const B = '/host/openwop-app/entities';

/** The `{ error, message }` envelope every refusal carries (middleware/errorEnvelope.ts). */
async function expectRefusal(res: Response, status: number, code: string, message: string | RegExp): Promise<void> {
  const body = (await res.json()) as { error?: string; message?: string };
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(body.error).toBe(code);
  if (typeof message === 'string') expect(body.message).toBe(message);
  else expect(body.message).toMatch(message);
}

let seq = 0;
/** A fresh owner in a fresh tenant — the per-case isolation every case relies on. */
async function owner(prefix: string): Promise<{ c: ReturnType<typeof client>; tenantId: string }> {
  seq += 1;
  const tenantId = `${prefix}-${seq}`;
  const c = client();
  await c.login(`owner-${prefix}-${seq}`, tenantId);
  return { c, tenantId };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({
    port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Every case starts with the feature ON; the one case that turns it off
// restores it in `finally`.
beforeEach(async () => {
  await setToggle('entities', 'on');
});

const RECIPE_FIELDS = [
  { key: 'title', label: 'Title', type: 'string', required: true },
  { key: 'servings', label: 'Servings', type: 'number', required: false },
  { key: 'cuisine', label: 'Cuisine', type: 'enum', required: false, options: ['italian', 'thai'] },
];

async function recipeType(c: ReturnType<typeof client>): Promise<void> {
  expect((await c.post(`${B}/types`, { name: 'recipe', fields: RECIPE_FIELDS })).status).toBe(201);
}

describe('entities (ADR 0386 Phase 1)', () => {
  it('404s every route while the toggle is off (fail-closed)', async () => {
    const { c } = await owner('ent-off');
    await setToggle('entities', 'off');
    try {
      await expectRefusal(await c.get(`${B}/types`), 404, 'not_found', 'Entities is not enabled for this tenant.');
      await expectRefusal(await c.post(`${B}/types`, { name: 'x', fields: RECIPE_FIELDS }), 404, 'not_found', 'Entities is not enabled for this tenant.');
    } finally {
      await setToggle('entities', 'on');
    }
    // Positive control: the same caller is served once the toggle is back on.
    expect((await c.get(`${B}/types`)).status).toBe(200);
  });

  it('type CRUD: create (owner), slug-normalize, structural uniqueness, publish, delete guard', async () => {
    const { c } = await owner('ent-crud');

    const created = await c.post(`${B}/types`, { name: 'Recipe', displayName: 'Recipe', fields: RECIPE_FIELDS });
    expect(created.status).toBe(201);
    const type = (await created.json()) as { name: string; status: string; fields: unknown[] };
    expect(type.name).toBe('recipe'); // slug-normalized
    expect(type.status).toBe('draft');
    expect(type.fields).toHaveLength(3);

    // duplicate name in the same scope → 409 (structural uniqueness via CAS)
    await expectRefusal(await c.post(`${B}/types`, { name: 'recipe', fields: RECIPE_FIELDS }), 409, 'conflict', 'A type named `recipe` already exists in this scope.');

    // publish
    const patched = await c.patch(`${B}/types/recipe`, { status: 'published' });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { status: string }).status).toBe('published');

    // invalid slug rejected
    await expectRefusal(await c.post(`${B}/types`, { name: '9bad name!', fields: RECIPE_FIELDS }), 400, 'validation_error',
      'Type `name` must be a slug: start with a letter, then letters/digits/`_`/`-`, max 64 chars.');
    // a reference field with no target is refused
    await expectRefusal(await c.post(`${B}/types`, {
      name: 'refy', fields: [{ key: 'r', label: 'R', type: 'reference', required: false }],
    }), 400, 'validation_error', /^(refEntityType must be one of: |reference fields are not supported here\.)/);
  });

  it('entity CRUD: closed-world validation, idempotent create, patch + clear, pagination, delete', async () => {
    const { c } = await owner('ent-rows');
    await recipeType(c);

    // unknown key rejected (closed world)
    await expectRefusal(await c.post(`${B}/types/recipe/entities`, { values: { title: 'Pad Thai', bogus: 1 } }), 400, 'validation_error',
      'Unknown custom field `bogus` for recipe.');
    // missing required rejected
    await expectRefusal(await c.post(`${B}/types/recipe/entities`, { values: { servings: 2 } }), 400, 'validation_error',
      'Custom field `title` is required.');
    // enum membership enforced
    await expectRefusal(await c.post(`${B}/types/recipe/entities`, { values: { title: 'X', cuisine: 'sushi' } }), 400, 'validation_error',
      'Custom field `cuisine` must be one of: italian, thai.');

    const created = await c.post(`${B}/types/recipe/entities`, {
      values: { title: 'Pad Thai', servings: 2, cuisine: 'thai' }, entityId: 'seed-1',
    });
    expect(created.status).toBe(201);
    const entity = (await created.json()) as { entityId: string; values: Record<string, unknown> };
    expect(entity.entityId).toBe('seed-1');

    // idempotent re-create with the same id returns the existing row (ADR 0162)
    const again = await c.post(`${B}/types/recipe/entities`, { values: { title: 'Pad Thai' }, entityId: 'seed-1' });
    expect(again.status).toBe(201);
    expect(((await again.json()) as { values: Record<string, unknown> }).values.servings).toBe(2);

    // patch merges; explicit null clears a non-required key; required can't clear
    const patched = await c.patch(`${B}/types/recipe/entities/seed-1`, { values: { servings: 4, cuisine: null } });
    expect(patched.status).toBe(200);
    const pv = ((await patched.json()) as { values: Record<string, unknown> }).values;
    expect(pv.servings).toBe(4);
    expect(pv.cuisine).toBeUndefined();
    await expectRefusal(await c.patch(`${B}/types/recipe/entities/seed-1`, { values: { title: null } }), 400, 'validation_error',
      'Field `title` is required and cannot be cleared.');

    // pagination
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await c.post(`${B}/types/recipe/entities`, { values: { title: `R${i}` }, entityId: `seed-p${i}` })).status,
      ).toBe(201);
    }
    const page1 = await c.get(`${B}/types/recipe/entities?limit=2`);
    expect(page1.status).toBe(200);
    const p1 = (await page1.json()) as { entities: Array<{ entityId: string }>; nextCursor?: string };
    expect(p1.entities).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const page2 = await c.get(`${B}/types/recipe/entities?limit=2&cursor=${encodeURIComponent(p1.nextCursor ?? '')}`);
    const p2 = (await page2.json()) as { entities: Array<{ entityId: string }> };
    expect(p2.entities).toHaveLength(2); // 4 rows: 2 + 2
    const ids1 = new Set(p1.entities.map((e) => e.entityId));
    for (const e of p2.entities) expect(ids1.has(e.entityId)).toBe(false);

    // type delete blocked while rows exist
    await expectRefusal(await c.del(`${B}/types/recipe`), 409, 'conflict', 'Type still has entities — delete or export them first.');

    // entity delete
    expect((await c.del(`${B}/types/recipe/entities/seed-1`)).status).toBe(204);
    await expectRefusal(await c.get(`${B}/types/recipe/entities/seed-1`), 404, 'not_found', 'Entity not found.');
  });

  it('cross-tenant isolation: tenant B sees nothing of tenant A (404, no existence leak)', async () => {
    // Tenant A holds a REAL type and row; tenant B asks for them by name and id.
    const a = await owner('ent-xa');
    await recipeType(a.c);
    expect((await a.c.post(`${B}/types/recipe/entities`, { values: { title: 'A only' }, entityId: 'seed-p0' })).status).toBe(201);
    expect((await a.c.get(`${B}/types/recipe/entities/seed-p0`)).status).toBe(200); // owner positive control

    const { c: cb } = await owner('ent-xb');
    await expectRefusal(await cb.get(`${B}/types/recipe`), 404, 'not_found', 'Entity type not found.');
    await expectRefusal(await cb.get(`${B}/types/recipe/entities/seed-p0`), 404, 'not_found', 'Entity not found.');
    const list = await cb.get(`${B}/types`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { types: unknown[] }).types).toHaveLength(0);
    // same-named type in another tenant is independent (no cross-tenant uniqueness bleed)
    expect((await cb.post(`${B}/types`, { name: 'recipe', fields: RECIPE_FIELDS })).status).toBe(201);
  });

  it('RBAC tiers: anon sandbox is isolated; unknown acting member fail-closed 403', async () => {
    // A real tenant with a type exists, so an empty anon list is not vacuous.
    const { c } = await owner('ent-rbac');
    await recipeType(c);
    // A cookie-less caller is minted an ANON sandbox tenant (ADR 0372) — it owns
    // its own empty workspace and can never see another tenant's types.
    const anon = client();
    const res = await anon.get(`${B}/types`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { types: unknown[] }).types).toHaveLength(0);
    await expectRefusal(await anon.get(`${B}/types/recipe`), 404, 'not_found', 'Entity type not found.');
    // Acting-as an unknown member resolves to zero scopes (fail-closed, RFC 0049).
    const denied = await c.get(`${B}/types`, { 'x-openwop-act-as': 'no-such-member' });
    const body = (await denied.json()) as { error?: string };
    expect(denied.status).toBe(403);
    expect(body.error).toBe('forbidden_scope');
  });

  it('project namespace: unknown projectId 404s; project-scoped type is separate', async () => {
    const { c } = await owner('ent-proj');
    await expectRefusal(await c.post(`${B}/types`, { name: 'scoped', fields: RECIPE_FIELDS, projectId: 'no-such-project' }),
      404, 'not_found', 'Not found.');
  });
});

describe('entities Phase 2 — taxonomies, references, relationships', () => {
  /** author + book types; book.author is a reference; book.cover is media. */
  async function bookTypes(c: ReturnType<typeof client>): Promise<void> {
    expect((await c.post(`${B}/types`, {
      name: 'author',
      fields: [{ key: 'name', label: 'Name', type: 'string', required: true }],
    })).status).toBe(201);
    expect((await c.post(`${B}/types`, {
      name: 'book',
      fields: [
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'author', label: 'Author', type: 'reference', required: false, refEntityType: 'author' },
        { key: 'cover', label: 'Cover', type: 'media', required: false },
      ],
    })).status).toBe(201);
  }

  it('reference values must resolve; media tokens are shape-checked', async () => {
    const { c } = await owner('ent-p2ref');
    await bookTypes(c);
    expect((await c.post(`${B}/types/author/entities`, { values: { name: 'Ada' }, entityId: 'ada' })).status).toBe(201);
    // dangling ref rejected
    await expectRefusal(await c.post(`${B}/types/book/entities`, { values: { title: 'X', author: 'nobody' } }), 400, 'validation_error',
      /^Custom field `author` references a .+ that does not exist\.$/);
    // resolving ref accepted
    expect(
      (await c.post(`${B}/types/book/entities`, { values: { title: 'On Refs', author: 'ada', cover: 'media:tok-1' }, entityId: 'b1' })).status,
    ).toBe(201);
    // empty media token rejected
    await expectRefusal(await c.post(`${B}/types/book/entities`, { values: { title: 'Y', cover: '   ' } }), 400, 'validation_error',
      'Custom field `cover` must be a media token.');
  });

  it('onDelete default restrict blocks; set-null clears; cascade deletes', async () => {
    const { c } = await owner('ent-p2del');
    await bookTypes(c);
    expect((await c.post(`${B}/types/author/entities`, { values: { name: 'Ada' }, entityId: 'ada' })).status).toBe(201);
    expect((await c.post(`${B}/types/book/entities`, { values: { title: 'On Refs', author: 'ada' }, entityId: 'b1' })).status).toBe(201);

    // restrict (no relationship row → default)
    await expectRefusal(await c.del(`${B}/types/author/entities/ada`), 409, 'conflict',
      'Entity is still referenced by `book` records (onDelete: restrict).');
    expect((await c.get(`${B}/types/book/entities/b1`)).status).toBe(200); // nothing was deleted

    // set-null policy
    expect((await c.post(`${B}/relationships`, { fromTypeName: 'book', toTypeName: 'author', onDelete: 'set-null' })).status).toBe(201);
    expect((await c.del(`${B}/types/author/entities/ada`)).status).toBe(204);
    const b1 = await c.get(`${B}/types/book/entities/b1`);
    expect(b1.status).toBe(200);
    expect(((await b1.json()) as { values: Record<string, unknown> }).values.author).toBeUndefined();

    // cascade policy
    expect((await c.del(`${B}/relationships/book/author`)).status).toBe(204);
    expect((await c.post(`${B}/relationships`, { fromTypeName: 'book', toTypeName: 'author', onDelete: 'cascade' })).status).toBe(201);
    expect((await c.post(`${B}/types/author/entities`, { values: { name: 'Bram' }, entityId: 'bram' })).status).toBe(201);
    expect(
      (await c.post(`${B}/types/book/entities`, { values: { title: 'Cascada', author: 'bram' }, entityId: 'b2' })).status,
    ).toBe(201);
    expect((await c.del(`${B}/types/author/entities/bram`)).status).toBe(204);
    await expectRefusal(await c.get(`${B}/types/book/entities/b2`), 404, 'not_found', 'Entity not found.'); // cascaded away
  });

  it('taxonomy + term CRUD, ordering, nesting, membership and delete guards', async () => {
    const { c } = await owner('ent-p2tax');
    await bookTypes(c);
    expect((await c.post(`${B}/types/book/entities`, { values: { title: 'On Refs' }, entityId: 'b1' })).status).toBe(201);

    expect((await c.post(`${B}/taxonomies`, { name: 'genre' })).status).toBe(201);
    await expectRefusal(await c.post(`${B}/taxonomies`, { name: 'genre' }), 409, 'conflict', 'A taxonomy named `genre` already exists in this scope.');
    expect((await c.post(`${B}/taxonomies/genre/terms`, { slug: 'fiction' })).status).toBe(201);
    expect((await c.post(`${B}/taxonomies/genre/terms`, { slug: 'nonfiction' })).status).toBe(201);
    const terms1 = (await (await c.get(`${B}/taxonomies/genre/terms`)).json()) as { terms: Array<{ slug: string; termId: string; order: number }> };
    expect(terms1.terms.map((x) => x.slug)).toEqual(['fiction', 'nonfiction']);

    // nesting: child of fiction
    const fictionId = terms1.terms[0]?.termId ?? '';
    expect((await c.post(`${B}/taxonomies/genre/terms`, { slug: 'scifi', parentId: fictionId })).status).toBe(201);

    // reorder
    expect((await c.patch(`${B}/taxonomies/genre/terms/reorder`, { orderedSlugs: ['nonfiction', 'fiction', 'scifi'] })).status).toBe(200);
    const terms2 = (await (await c.get(`${B}/taxonomies/genre/terms`)).json()) as { terms: Array<{ slug: string }> };
    expect(terms2.terms.map((x) => x.slug)).toEqual(['nonfiction', 'fiction', 'scifi']);

    // membership: assign fiction + nonfiction to b1; unknown term rejected
    const nonfictionId = terms1.terms[1]?.termId ?? '';
    await expectRefusal(await c.patch(`${B}/types/book/entities/b1`, { termIds: ['nope'] }), 400, 'validation_error', 'Unknown term `nope`.');
    expect((await c.patch(`${B}/types/book/entities/b1`, { termIds: [fictionId, nonfictionId] })).status).toBe(200);

    // delete guards: a childless term in use → 409; a term with children → 409
    // (checked first, so `fiction` reports its child); taxonomy with terms → 409
    await expectRefusal(await c.del(`${B}/taxonomies/genre/terms/nonfiction`), 409, 'conflict', 'Term is still assigned to entities — unassign it first.');
    await expectRefusal(await c.del(`${B}/taxonomies/genre/terms/fiction`), 409, 'conflict', 'Term still has child terms — delete or re-parent them first.');
    expect((await c.patch(`${B}/types/book/entities/b1`, { termIds: [] })).status).toBe(200);
    expect((await c.del(`${B}/taxonomies/genre/terms/scifi`)).status).toBe(204);
    expect((await c.del(`${B}/taxonomies/genre/terms/fiction`)).status).toBe(204);
    await expectRefusal(await c.del(`${B}/taxonomies/genre`), 409, 'conflict', 'Taxonomy still has terms — delete them first.');
    expect((await c.del(`${B}/taxonomies/genre/terms/nonfiction`)).status).toBe(204);
    expect((await c.del(`${B}/taxonomies/genre`)).status).toBe(204);
  });

  it('reference fields must target an existing sibling type', async () => {
    const { c } = await owner('ent-p2ghost');
    await bookTypes(c);
    await expectRefusal(await c.post(`${B}/types`, {
      name: 'badref',
      fields: [{ key: 'r', label: 'R', type: 'reference', required: false, refEntityType: 'ghost' }],
    }), 400, 'validation_error', /^refEntityType must be one of: /);
  });

  it('mixed cascade+restrict closure rejects BEFORE any mutation (atomic plan)', async () => {
    // review (cascade→author) and shelf (restrict→author, the default) both
    // reference the same author. Deleting the author must 409 AND leave the
    // cascade referrer intact — no partial delete (grade-code #1).
    const { c } = await owner('ent-p2mix');
    await bookTypes(c);
    expect((await c.post(`${B}/types`, {
      name: 'review',
      fields: [
        { key: 'body', label: 'Body', type: 'string', required: true },
        { key: 'author', label: 'Author', type: 'reference', required: false, refEntityType: 'author' },
      ],
    })).status).toBe(201);
    expect((await c.post(`${B}/relationships`, { fromTypeName: 'review', toTypeName: 'author', onDelete: 'cascade' })).status).toBe(201);
    expect((await c.post(`${B}/types`, {
      name: 'shelf',
      fields: [
        { key: 'label', label: 'Label', type: 'string', required: true },
        { key: 'author', label: 'Author', type: 'reference', required: false, refEntityType: 'author' },
      ],
    })).status).toBe(201);
    // no relationship row for shelf→author ⇒ default restrict

    expect((await c.post(`${B}/types/author/entities`, { values: { name: 'Mixed' }, entityId: 'mx' })).status).toBe(201);
    expect((await c.post(`${B}/types/review/entities`, { values: { body: 'r', author: 'mx' }, entityId: 'rv1' })).status).toBe(201);
    expect((await c.post(`${B}/types/shelf/entities`, { values: { label: 's', author: 'mx' }, entityId: 'sh1' })).status).toBe(201);

    // restrict anywhere in the closure rejects the whole delete...
    await expectRefusal(await c.del(`${B}/types/author/entities/mx`), 409, 'conflict',
      'Entity is still referenced by `shelf` records (onDelete: restrict).');
    // ...and the cascade referrer was NOT deleted (no partial mutation).
    expect((await c.get(`${B}/types/review/entities/rv1`)).status).toBe(200);
    expect((await c.get(`${B}/types/author/entities/mx`)).status).toBe(200);

    // Removing the restrict blocker lets the cascade complete atomically.
    expect((await c.del(`${B}/types/shelf/entities/sh1`)).status).toBe(204);
    expect((await c.del(`${B}/types/author/entities/mx`)).status).toBe(204);
    await expectRefusal(await c.get(`${B}/types/review/entities/rv1`), 404, 'not_found', 'Entity not found.');
  });

  it('type delete refuses while another type declares a reference to it', async () => {
    const { c } = await owner('ent-p2tdel');
    await bookTypes(c); // book.author → author
    await expectRefusal(await c.del(`${B}/types/author`), 409, 'conflict', /^Type is referenced by `book` — remove those reference fields first\.$/);
    // Positive control: a type nothing references deletes.
    expect((await c.post(`${B}/types`, { name: 'loner', fields: [{ key: 'x', label: 'X', type: 'string', required: false }] })).status).toBe(201);
    expect((await c.del(`${B}/types/loner`)).status).toBe(204);
  });
});

describe('entities Phase 3 — query/filter + import/export', () => {
  async function productFixture(): Promise<ReturnType<typeof client>> {
    const { c } = await owner('ent-p3');
    expect((await c.post(`${B}/types`, {
      name: 'product',
      fields: [
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'price', label: 'Price', type: 'number', required: true },
        { key: 'active', label: 'Active', type: 'boolean', required: false },
      ],
    })).status).toBe(201);
    const seed = [
      { entityId: 'p1', values: { title: 'Red chair', price: 40, active: true } },
      { entityId: 'p2', values: { title: 'Blue chair', price: 80, active: false } },
      { entityId: 'p3', values: { title: 'Green table', price: 120, active: true } },
    ];
    for (const row of seed) {
      expect((await c.post(`${B}/types/product/entities`, row)).status).toBe(201);
    }
    return c;
  }

  it('filters: eq, contains, range, in; unknown field rejected', async () => {
    const c = await productFixture();
    const q = async (bodyFilters: unknown): Promise<string[]> => {
      const res = await c.post(`${B}/types/product/query`, { filters: bodyFilters });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { entities: Array<{ entityId: string }>; total: number };
      expect(out.total).toBe(out.entities.length);
      return out.entities.map((e) => e.entityId).sort();
    };
    expect(await q([{ key: 'active', op: 'eq', value: true }])).toEqual(['p1', 'p3']);
    expect(await q([{ key: 'title', op: 'contains', value: 'chair' }])).toEqual(['p1', 'p2']);
    expect(await q([{ key: 'price', op: 'gte', value: 80 }])).toEqual(['p2', 'p3']);
    expect(await q([{ key: 'price', op: 'lt', value: 80 }])).toEqual(['p1']);
    expect(await q([{ key: 'title', op: 'in', value: ['Red chair'] }])).toEqual(['p1']);
    expect(await q([{ key: 'price', op: 'gte', value: 80 }, { key: 'active', op: 'eq', value: true }])).toEqual(['p3']);
    await expectRefusal(await c.post(`${B}/types/product/query`, { filters: [{ key: 'ghost', op: 'eq', value: 1 }] }), 400, 'validation_error',
      'Unknown filter field `ghost`.');
  });

  it('sort + pagination with a stable cursor', async () => {
    const c = await productFixture();
    const res = await c.post(`${B}/types/product/query`, { sort: { key: 'price', dir: 'asc' }, limit: 2 });
    expect(res.status).toBe(200);
    const page1 = (await res.json()) as { entities: Array<{ entityId: string }>; nextCursor?: string };
    expect(page1.entities.map((e) => e.entityId)).toEqual(['p1', 'p2']);
    const res2 = await c.post(`${B}/types/product/query`, { sort: { key: 'price', dir: 'asc' }, limit: 2, cursor: page1.nextCursor });
    const page2 = (await res2.json()) as { entities: Array<{ entityId: string }> };
    expect(page2.entities.map((e) => e.entityId)).toEqual(['p3']);
  });

  it('export streams NDJSON; import is idempotent through the one validator', async () => {
    const c = await productFixture();
    const exp = await c.get(`${B}/types/product/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await exp.text()).trim().split('\n');
    expect(lines).toHaveLength(3);

    // import 2 new rows + 1 invalid; re-import must not double-create
    const ndjson = [
      JSON.stringify({ values: { title: 'Oak desk', price: 300 } }),
      JSON.stringify({ values: { title: 'Pine shelf', price: 60, active: true } }),
      JSON.stringify({ values: { title: 'No price' } }),
    ].join('\n');
    const imp1 = await c.post(`${B}/types/product/import`, { ndjson });
    expect(imp1.status).toBe(200);
    const r1 = (await imp1.json()) as { created: number; existing: number; errors: Array<{ line: number }> };
    expect(r1.created).toBe(2);
    expect(r1.errors).toHaveLength(1);
    expect(r1.errors[0]?.line).toBe(3);

    const imp2 = await c.post(`${B}/types/product/import`, { ndjson });
    const r2 = (await imp2.json()) as { created: number; existing: number };
    expect(r2.created).toBe(0);
    expect(r2.existing).toBe(2);

    const all = await c.post(`${B}/types/product/query`, {});
    expect(((await all.json()) as { total: number }).total).toBe(5);
  });
});

describe('entities Phase 4 — entityApi keys (dual auth) + publish gate', () => {
  const bearer = (token: string, path: string, init?: { method?: string; body?: unknown }): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

  /** A tenant with a PUBLISHED `catalog`, a DRAFT `draftling`, and three keys. */
  async function keyFixture(): Promise<{ c: ReturnType<typeof client>; readToken: string; writeToken: string; adminToken: string }> {
    // `developer-keys` graduated to always-on in ADR 0434 — no toggle to enable.
    const { c } = await owner('ent-p4');
    expect((await c.post(`${B}/types`, {
      name: 'catalog',
      fields: [{ key: 'title', label: 'Title', type: 'string', required: true }],
    })).status).toBe(201);
    expect((await c.post(`${B}/types`, {
      name: 'draftling',
      fields: [{ key: 'title', label: 'Title', type: 'string', required: true }],
    })).status).toBe(201);
    expect((await c.patch(`${B}/types/catalog`, { status: 'published' })).status).toBe(200);
    const issue = async (scopes: string[]): Promise<string> => {
      const res = await c.post('/host/openwop-app/developer-keys', { name: `k-${scopes[0]}`, scopes });
      expect(res.status).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    return {
      c,
      readToken: await issue(['entities:catalog:read']),
      writeToken: await issue(['entities:catalog:write']),
      adminToken: await issue(['entities:admin']),
    };
  }

  it('read key: list/query allowed on the published type; write denied', async () => {
    const { readToken, writeToken } = await keyFixture();
    expect((await bearer(writeToken, `${B}/types/catalog/entities`, { method: 'POST', body: { values: { title: 'Via key' }, entityId: 'k1' } })).status).toBe(201);
    expect((await bearer(readToken, `${B}/types/catalog/entities`)).status).toBe(200);
    expect((await bearer(readToken, `${B}/types/catalog/query`, { method: 'POST', body: {} })).status).toBe(200);
    await expectRefusal(await bearer(readToken, `${B}/types/catalog/entities`, { method: 'POST', body: { values: { title: 'Nope' } } }),
      403, 'forbidden_scope', 'API key lacks the required entities scope.');
    // write implies read
    expect((await bearer(writeToken, `${B}/types/catalog/entities`)).status).toBe(200);
  });

  it('publish gate: a draft type 404s to any key (even entities:admin on entity routes)', async () => {
    const { c, adminToken } = await keyFixture();
    await expectRefusal(await bearer(adminToken, `${B}/types/draftling/entities`), 404, 'not_found', 'Entity type not found.');
    // session caller still sees the draft (authoring path)
    expect((await c.get(`${B}/types/draftling/entities`)).status).toBe(200);
  });

  it('scope grammar is per-type; admin tier requires entities:admin', async () => {
    const { readToken, writeToken, adminToken } = await keyFixture();
    // a catalog-scoped key cannot touch another type
    await expectRefusal(await bearer(readToken, `${B}/types/draftling/entities`), 403, 'forbidden_scope', 'API key lacks the required entities scope.');
    // management routes need entities:admin
    await expectRefusal(await bearer(writeToken, `${B}/types`, { method: 'POST', body: { name: 'viaapi', fields: [{ key: 'x', label: 'X', type: 'string' }] } }),
      403, 'forbidden_scope', 'API key lacks the required entities scope.');
    expect((await bearer(adminToken, `${B}/types`, { method: 'POST', body: { name: 'viaapi', fields: [{ key: 'x', label: 'X', type: 'string' }] } })).status).toBe(201);
    // invalid token
    const bogus = await bearer('owk_bogus', `${B}/types/catalog/entities`);
    expect(bogus.status).toBe(401);
    expect(((await bogus.json()) as { error?: string }).error).toBe('unauthenticated');
  });

  it('key callers are tenant-bound: reads see only the key tenant', async () => {
    const { writeToken, readToken } = await keyFixture();
    expect((await bearer(writeToken, `${B}/types/catalog/entities`, { method: 'POST', body: { values: { title: 'Via key' }, entityId: 'k1' } })).status).toBe(201);
    // A SECOND tenant with the same published `catalog` type and its own row.
    const other = await owner('ent-p4b');
    expect((await other.c.post(`${B}/types`, { name: 'catalog', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] })).status).toBe(201);
    expect((await other.c.patch(`${B}/types/catalog`, { status: 'published' })).status).toBe(200);
    expect((await other.c.post(`${B}/types/catalog/entities`, { values: { title: 'Other' }, entityId: 'other-1' })).status).toBe(201);
    const otherList = (await (await other.c.get(`${B}/types/catalog/entities`)).json()) as { entities: Array<{ entityId: string }> };
    expect(otherList.entities.map((e) => e.entityId)).toEqual(['other-1']); // the other tenant's row exists

    const list = await bearer(readToken, `${B}/types/catalog/entities`);
    const page = (await list.json()) as { entities: Array<{ entityId: string }> };
    expect(page.entities.map((e) => e.entityId)).toEqual(['k1']);
  });
});
