/**
 * ADR 0524 — the server-side half: a save must not lose authored content.
 *
 * The client fix stopped the builder deleting node `inputs`, but two lanes never
 * self-heal — the runs index and the chat `@workflow` mention serialize from
 * localStorage, so a record written by an older bundle keeps stripping the head
 * even on the corrected bundle. A workflow the user only RUNS is never healed.
 *
 * Everything here goes through the REAL route over HTTP. That is deliberate:
 * a test that calls `preserveDroppedFields` directly proves the mechanism and
 * says nothing about whether the route reaches it (ADR 0502's mechanism-vs-wiring
 * lesson, which this repo has paid for twice). The observable effect is asserted
 * by GETting the head back, never by spying.
 *
 * THE DOMINANT VACUITY RISK, guarded against below: a test that POSTs a stripped
 * definition with NO prior head and asserts "nothing lost" passes for the wrong
 * reason. Every case seeds the precondition through the route first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestRevision } from '../src/host/workflowRevisions.js';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('ADR 0523 — a save cannot silently drop fields the head carried', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
  };

  /** POST a definition DECLARING a field contract (ADR 0524 Phase E0). */
  const saveDeclaring = (
    workflowId: string,
    nodes: unknown[],
    contract: string,
    extra: Record<string, unknown> = {},
  ) =>
    api('/v1/host/openwop-app/workflows', {
      method: 'POST',
      headers: { 'x-openwop-field-contract': contract },
      body: JSON.stringify({ workflowId, metadata: { name: workflowId }, nodes, ...extra }),
    });

  /** POST a definition; returns the 201 body. */
  const save = (workflowId: string, nodes: unknown[], extra: Record<string, unknown> = {}) =>
    api('/v1/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({ workflowId, metadata: { name: workflowId }, nodes, ...extra }),
    });

  const head = async (workflowId: string) =>
    (await api(`/v1/workflows/${encodeURIComponent(workflowId)}`)).body as
      | { nodes?: { nodeId: string; inputs?: Record<string, unknown> }[]; variables?: unknown; configurableSchema?: unknown }
      | undefined;

  const WITH_INPUTS = [
    { nodeId: 'a', typeId: 'core.noop', config: {}, inputs: { to: 'someone@example.com' } },
    { nodeId: 'b', typeId: 'core.noop', config: {}, inputs: { subject: 'hello' } },
  ];
  /** The same graph as an OLD bundle serializes it — every `inputs` gone. */
  const STRIPPED = [
    { nodeId: 'a', typeId: 'core.noop', config: {} },
    { nodeId: 'b', typeId: 'core.noop', config: {} },
  ];

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('PRECONDITION: a definition with node inputs round-trips through the route', async () => {
    // Without this the assertions below could pass because the route never
    // stored `inputs` in the first place.
    const wf = 'adr0523.precondition';
    expect((await save(wf, WITH_INPUTS)).status).toBe(201);
    const h = await head(wf);
    expect(h?.nodes?.find((n) => n.nodeId === 'a')?.inputs).toEqual({ to: 'someone@example.com' });
  });

  it('restores node inputs an old bundle dropped WHOLESALE', async () => {
    const wf = 'adr0523.wholesale';
    await save(wf, WITH_INPUTS);
    const res = await save(wf, STRIPPED);
    expect(res.status).toBe(201);

    const h = await head(wf);
    expect(h?.nodes?.find((n) => n.nodeId === 'a')?.inputs).toEqual({ to: 'someone@example.com' });
    expect(h?.nodes?.find((n) => n.nodeId === 'b')?.inputs).toEqual({ subject: 'hello' });
  });

  it('DISCLOSES the restore — a silent merge would be the defect it fixes', async () => {
    const wf = 'adr0523.disclosure';
    await save(wf, WITH_INPUTS);
    const res = await save(wf, STRIPPED);
    expect(res.body?.preservedFields).toEqual(['inputs']);
  });

  it('does NOT restore a PARTIAL drop — that is a user deleting one input', async () => {
    // The discriminator. An old bundle zeroes every input at once; a person
    // clearing one leaves the others intact. Merging that would make deletion
    // impossible the day editable preset inputs ship.
    const wf = 'adr0523.partial';
    await save(wf, WITH_INPUTS);
    const partial = [
      { nodeId: 'a', typeId: 'core.noop', config: {} },
      { nodeId: 'b', typeId: 'core.noop', config: {}, inputs: { subject: 'hello' } },
    ];
    const res = await save(wf, partial);
    expect(res.body?.preservedFields).toBeUndefined();
    const h = await head(wf);
    expect(h?.nodes?.find((n) => n.nodeId === 'a')?.inputs, 'a deliberate deletion was resurrected').toBeUndefined();
  });

  it('restores def-level variables and configurableSchema', async () => {
    const wf = 'adr0523.deflevel';
    await save(wf, WITH_INPUTS, {
      variables: [{ name: 'recipientEmail', type: 'string' }],
      configurableSchema: { type: 'object', properties: { recipientEmail: {} } },
    });
    const res = await save(wf, WITH_INPUTS); // inputs intact, def-level absent
    expect(res.body?.preservedFields).toEqual(['variables', 'configurableSchema']);
    const h = await head(wf);
    expect(h?.variables).toEqual([{ name: 'recipientEmail', type: 'string' }]);
  });

  it('honours an EXPLICIT clear — an empty array is an author, not an old bundle', async () => {
    const wf = 'adr0523.explicit-clear';
    await save(wf, WITH_INPUTS, { variables: [{ name: 'x', type: 'string' }] });
    const res = await save(wf, WITH_INPUTS, { variables: [] });
    expect(res.body?.preservedFields).toBeUndefined();
    expect((await head(wf))?.variables).toEqual([]);
  });

  it('never resurrects inputs onto a node the save DELETED', async () => {
    const wf = 'adr0523.deleted-node';
    await save(wf, WITH_INPUTS);
    const res = await save(wf, [{ nodeId: 'a', typeId: 'core.noop', config: {} }]);
    expect(res.status).toBe(201);
    const h = await head(wf);
    expect(h?.nodes?.map((n) => n.nodeId)).toEqual(['a']);
    expect(h?.nodes?.find((n) => n.nodeId === 'b'), 'a deleted node came back').toBeUndefined();
  });

  it('never leaves a restored ref without its declaration', async () => {
    // The coherence hole a grade pass found: the three restorations were gated
    // independently, so a client that models `variables` (sends an explicit
    // `[]`) but NOT node `inputs` got restored refs pointing at a bag it had
    // just cleared — resolving to `undefined`, which is the exact failure the
    // pairing exists to prevent, and worse than either endpoint.
    const wf = 'adr0524.coherence';
    const withRef = [
      { nodeId: 'a', typeId: 'core.noop', config: {}, inputs: { to: { type: 'variable', variableName: 'recipient' } } },
    ];
    await save(wf, withRef, { variables: [{ name: 'recipient', type: 'string' }] });

    // A partially-upgraded client: models variables (clears them), drops inputs.
    const res = await save(wf, [{ nodeId: 'a', typeId: 'core.noop', config: {} }], { variables: [] });
    expect(res.body?.preservedFields).toEqual(['inputs', 'variables']);
    const h = await head(wf);
    expect(h?.variables, 'the ref came back but its declaration did not').toEqual([
      { name: 'recipient', type: 'string' },
    ]);
  });

  // ── ADR 0524 Phase E0 — the client field-contract marker ────────────────
  //
  // Route-level, never by calling the helper directly: ADR 0502's lesson, paid
  // for twice, is that a test proving the MECHANISM says nothing about whether
  // the route reaches it. The header parse, the wiring, and the guard's
  // behaviour are three separate things and only the route exercises all three.

  it('E0: a client DECLARING `inputs` deletes them instead of having them restored', async () => {
    const id = `e0-declares-${Date.now()}`;
    await save(id, WITH_INPUTS);
    const res = await saveDeclaring(id, STRIPPED, 'inputs,variables,configurableSchema');
    expect(res.status).toBe(201);
    expect(res.body?.preservedFields, 'a declared omission was treated as a bundle limitation').toBeUndefined();
    const after = await head(id);
    expect(after?.nodes?.every((n) => n.inputs === undefined), 'the declared deletion was reverted').toBe(true);
  });

  it('E0: the SAME save WITHOUT the header is still repaired — the old bundle keeps its guard', async () => {
    // The control. Without it, the test above would pass against a guard that
    // had simply stopped working, which is the failure mode that matters most.
    const id = `e0-no-header-${Date.now()}`;
    await save(id, WITH_INPUTS);
    const res = await save(id, STRIPPED);
    expect(res.body?.preservedFields).toContain('inputs');
    const after = await head(id);
    expect(after?.nodes?.find((n) => n.nodeId === 'a')?.inputs).toEqual({ to: 'someone@example.com' });
  });

  it('E0: declaring only `variables` leaves node `inputs` protected', async () => {
    // Per-field, not all-or-nothing. A client that models one field must not
    // switch the guard off for the others.
    const id = `e0-partial-${Date.now()}`;
    await save(id, WITH_INPUTS);
    const res = await saveDeclaring(id, STRIPPED, 'variables');
    expect(res.body?.preservedFields, 'declaring variables disabled the inputs guard').toContain('inputs');
  });

  it('E0: an UNRECOGNISED contract token does not disable a real guard', async () => {
    // NOTE ON WHAT THIS DOES AND DOES NOT PROVE. It pins the behaviour, but it
    // cannot discriminate the parser: `models(f)` tests an exact field name, so
    // a junk token is inert whether the parser drops it or stores it. A sabotage
    // that opened the parser to arbitrary tokens left this GREEN. The parser's
    // real (forward-compat) property is asserted directly in
    // `field-contract-parse.test.ts`.
    const id = `e0-unknown-${Date.now()}`;
    await save(id, WITH_INPUTS);
    const res = await saveDeclaring(id, STRIPPED, 'nodes,edges,metadata');
    expect(res.body?.preservedFields, 'an unknown token disabled a real guard').toContain('inputs');
  });

  // ── ADR 0524 Phase E — the declaration is RECORDED, not just honoured ───
  //
  // The planner tests prove the MECHANISM (a stamped revision blocks a repair).
  // They say nothing about whether the route ever writes the stamp. ADR 0502,
  // paid for twice: mechanism and wiring fail independently. The assertion reads
  // DURABLE STATE after a real POST, because the stamp is deliberately not
  // exposed on the history route — it is repair metadata, not user-facing.

  it('E: a declaring save STAMPS the contract on the revision', async () => {
    const id = `e-stamp-${Date.now()}`;
    await saveDeclaring(id, WITH_INPUTS, 'inputs,variables,configurableSchema');
    const rev = await latestRevision(id);
    expect(rev?.declaredFields, 'the route never recorded what the client declared').toContain('inputs');
  });

  it('E: a save with NO header leaves the revision unstamped', async () => {
    // The control. Without it the test above passes against an implementation
    // that stamps unconditionally — which would mark every old-bundle strip as
    // deliberate and disable the repair for exactly the population it exists for.
    const id = `e-nostamp-${Date.now()}`;
    await save(id, WITH_INPUTS);
    const rev = await latestRevision(id);
    expect(rev?.declaredFields, 'an undeclared save was recorded as deliberate').toBeUndefined();
  });

  it('E: re-saving IDENTICAL content still records a newly-declared contract', async () => {
    // Same content ⇒ same hash ⇒ the upsert branch, not the insert branch.
    // Re-saving an already-empty workflow from the builder is precisely how a
    // user confirms the zero is deliberate; dropping the stamp on that path
    // would leave the repair free to resurrect it.
    const id = `e-upsert-${Date.now()}`;
    await save(id, STRIPPED);
    await saveDeclaring(id, STRIPPED, 'inputs');
    const rev = await latestRevision(id);
    expect(rev?.declaredFields, 'the upsert path dropped the declaration').toContain('inputs');
  });

  // ── `M3` (ADR 0603 R1) — the THIRD metadata lane ─────────────────────────
  //
  // `parseWorkflowDefinition` replaces `metadata` WHOLESALE from the request
  // body, and `metadata` is deliberately NOT a `PreservableField` (a wholesale
  // restore would fight the `metadata.authoring` / `metadata.lifecycle`
  // stampers). Host-DERIVED chain provenance therefore had no protection at all
  // on either exposed writer — the REST save here and the collab derive. It was
  // mitigated client-side only, and this exact class already fired once on the
  // same keys (ADR 0440 P1).

  it('`M3` restores host-derived chain provenance a wholesale `metadata` replace dropped', async () => {
    const wf = 'adr0603.m3.provenance';
    const provenance = {
      name: wf,
      chainId: 'core.openwop.workflows.demo',
      expansionMode: 'deferred',
      deferredParameterAliases: { topic: 'wf_topic' },
      mintedPromptTemplates: ['tpl-1'],
    };
    expect((await save(wf, WITH_INPUTS, { metadata: provenance })).status).toBe(201);
    // PRECONDITION: it really round-tripped, so the assertion below is falsifiable.
    expect(((await head(wf)) as { metadata?: Record<string, unknown> } | undefined)?.metadata?.chainId)
      .toBe('core.openwop.workflows.demo');

    // A writer that models only the display name — exactly what a direct API
    // caller, or a collab blob composed by an older bundle, sends.
    const res = await save(wf, WITH_INPUTS, { metadata: { name: 'Renamed' } });
    expect(res.status).toBe(201);

    const meta = ((await head(wf)) as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {};
    expect(meta.chainId, 'the RFC 0124 alias map and its siblings are minted by the host, never authored').toBe('core.openwop.workflows.demo');
    expect(meta.expansionMode).toBe('deferred');
    expect(meta.deferredParameterAliases).toEqual({ topic: 'wf_topic' });
    expect(meta.mintedPromptTemplates).toEqual(['tpl-1']);
    // ...and the key the writer DID model still wins. Restoring the whole object
    // would have reverted the rename — the defect the `PreservableField` docblock
    // refuses `metadata` for.
    expect(meta.name, 'a host-key restore must never resurrect author-owned metadata').toBe('Renamed');
  });

  it('`M3` CONTROL — a NON host-derived metadata key is NOT resurrected', async () => {
    // The discriminating half. Without it the assertions above would be satisfied
    // by a wholesale `metadata` merge, which is the thing that must not happen.
    const wf = 'adr0603.m3.control';
    await save(wf, WITH_INPUTS, { metadata: { name: wf, authoring: { agent: 'workflow-author' } } });
    await save(wf, WITH_INPUTS, { metadata: { name: wf } });
    const meta = ((await head(wf)) as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {};
    expect(meta.authoring, '`metadata.authoring` is written by the author lane — restoring it would fight the stamper').toBeUndefined();
  });

  it('a FIRST write is untouched — there is no prior head to compare against', async () => {
    const wf = 'adr0523.first-write';
    const res = await save(wf, STRIPPED);
    expect(res.status).toBe(201);
    expect(res.body?.preservedFields).toBeUndefined();
    expect((await head(wf))?.nodes?.[0]?.inputs).toBeUndefined();
  });
});
