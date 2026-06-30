/**
 * Executive Assistant feature (ADR 0023 Phase 0) — the memory graph + the
 * ctx.features.assistant surface, wired as a pure addition to BACKEND_FEATURES.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetAssistantStore,
  upsertCommitmentBySource,
  getCommitment,
  listCommitments,
  logDecision,
  listDecisions,
  contentHashOf,
} from '../src/features/assistant/assistantService.js';
import { buildAssistantSurface } from '../src/features/assistant/surface.js';

describe('Assistant feature (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __clearToggleStore();
    await __resetAssistantStore();
    await new Promise<void>((res) => {
      server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
    });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  it('is registered as a backend feature (additive — appended to BACKEND_FEATURES)', () => {
    expect(BACKEND_FEATURES.some((f) => f.id === 'assistant')).toBe(true);
  });

  it('project CRUD works (graduated off its toggle — serves unconditionally)', async () => {
    // ADR 0023 § Correction — no 404-while-off; the surface is always-on substrate.
    const created = await jf<{ projectId: string; priority: number }>('/v1/host/openwop-app/assistant/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Q3 launch', priority: 80 }),
    });
    expect(created.status).toBe(201);
    expect(created.body.priority).toBe(80);

    const list = await jf<{ projects: { projectId: string }[] }>('/v1/host/openwop-app/assistant/projects');
    expect(list.body.projects.some((p) => p.projectId === created.body.projectId)).toBe(true);
  });

  it('approval queue: pending action can be approved through the REST surface', async () => {
    // seed a pending action via the surface (loops normally enqueue these).
    // The API-key request path leaves req.tenantId unset → routes use 'default'.
    const surf = buildAssistantSurface({ tenantId: 'default' });
    const enq = (await surf.enqueueAction({ kind: 'email.send', draft: 'Hi there', payload: { to: 'a@b.com' } })) as {
      pendingAction: { actionId: string; status: string };
    };
    expect(enq.pendingAction.status).toBe('pending');

    const approved = await jf<{ status: string }>(`/v1/host/openwop-app/assistant/pending-actions/${enq.pendingAction.actionId}/approve`, { method: 'POST' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
  });

  it('advertises the ctx.features.assistant surface at /.well-known/openwop (ADR 0014)', async () => {
    const disco = await jf<{ hostExtensions?: { featureSurfaces?: string[] } }>('/.well-known/openwop');
    expect(disco.status).toBe(200);
    expect(disco.body.hostExtensions?.featureSurfaces).toContain('host.sample.assistant');
  });
});

describe('Assistant memory graph (service-level invariants)', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await __resetAssistantStore();
  });

  it('upsertCommitmentBySource is idempotent by (source hash + description) — replay-safe', async () => {
    const source = { kind: 'gmail' as const, externalId: 'msg-1', contentHash: contentHashOf('body-1'), capturedAt: '2026-06-10T00:00:00Z' };
    const r1 = await upsertCommitmentBySource('t1', { owner: { kind: 'self' }, description: 'Send the deck', source });
    const r2 = await upsertCommitmentBySource('t1', { owner: { kind: 'self' }, description: 'Send the deck', source, status: 'in-progress' });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false); // same key → update in place, no duplicate
    expect(r1.commitment.commitmentId).toBe(r2.commitment.commitmentId);
    expect(r2.commitment.status).toBe('in-progress');
    expect(await listCommitments('t1')).toHaveLength(1);
  });

  it('CTI-1 — identical source+description in two tenants do NOT collide/overwrite', async () => {
    await __resetAssistantStore();
    const source = { kind: 'drive' as const, externalId: 'shared-doc', contentHash: contentHashOf('same-bytes'), capturedAt: '2026-06-10T00:00:00Z' };
    const a = await upsertCommitmentBySource('tenant-A', { owner: { kind: 'self' }, description: 'Review the contract', source });
    const b = await upsertCommitmentBySource('tenant-B', { owner: { kind: 'self' }, description: 'Review the contract', source });
    // distinct ids (tenant in the dedup key) — neither overwrites the other
    expect(a.commitment.commitmentId).not.toBe(b.commitment.commitmentId);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect((await listCommitments('tenant-A'))).toHaveLength(1);
    expect((await listCommitments('tenant-B'))).toHaveLength(1);
    // and tenant B cannot read tenant A's commitment
    expect(await getCommitment('tenant-B', a.commitment.commitmentId)).toBeNull();
  });

  it('is tenant-guarded — a cross-tenant commitment id reads as not-found (CTI-1)', async () => {
    const source = { kind: 'drive' as const, externalId: 'f-9', contentHash: contentHashOf('x'), capturedAt: '2026-06-10T00:00:00Z' };
    const { commitment } = await upsertCommitmentBySource('t1', { owner: { kind: 'self' }, description: 'Review doc', source });
    expect((await getCommitment('t1', commitment.commitmentId))?.commitmentId).toBe(commitment.commitmentId);
    expect(await getCommitment('t2', commitment.commitmentId)).toBeNull();
  });

  it('logDecision is idempotent by (tenant, source, statement) — no duplicate on re-extract', async () => {
    await __resetAssistantStore();
    const source = { kind: 'transcript' as const, externalId: 'mtg-42', contentHash: contentHashOf('transcript-bytes'), capturedAt: '2026-06-10T00:00:00Z' };
    const d1 = await logDecision('t1', { statement: 'Ship in Q3', decidedBy: { kind: 'self' }, source });
    const d2 = await logDecision('t1', { statement: 'Ship in Q3', decidedBy: { kind: 'self' }, source, rationale: 'capacity confirmed' });
    expect(d1.decisionId).toBe(d2.decisionId); // same source+statement → update in place
    expect(d2.rationale).toBe('capacity confirmed');
    expect(await listDecisions('t1')).toHaveLength(1);
    // another tenant with the same source+statement does NOT collide (CTI-1)
    const dOther = await logDecision('t2', { statement: 'Ship in Q3', decidedBy: { kind: 'self' }, source });
    expect(dOther.decisionId).not.toBe(d1.decisionId);
    expect(await listDecisions('t2')).toHaveLength(1);
  });

  it('buildAssistantSurface projects out internal columns + tenant-isolates', async () => {
    await __resetAssistantStore();
    const source = { kind: 'manual' as const, externalId: 'm1', contentHash: contentHashOf('y'), capturedAt: '2026-06-10T00:00:00Z' };
    await upsertCommitmentBySource('t1', { owner: { kind: 'self' }, description: 'A', source });
    await upsertCommitmentBySource('t2', { owner: { kind: 'self' }, description: 'B', source });
    const surf = buildAssistantSurface({ tenantId: 't1' });
    const { commitments } = (await surf.listCommitments({})) as { commitments: Record<string, unknown>[] };
    expect(commitments).toHaveLength(1);
    expect(commitments[0].tenantId).toBeUndefined(); // internal column projected out
  });
});
