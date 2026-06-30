/**
 * Chat artifact workbench client (ADR 0069) — the FE surface for the type-neutral
 * host `/v1/host/openwop-app/artifacts/*` projection over durable artifacts
 * (Documents-backed in v1). Mirrors `host/artifactProjection.ts`.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const BASE = '/v1/host/openwop-app/artifacts';

export interface ArtifactProjection {
  artifactId: string;
  tenantId: string;
  orgId: string;
  ownerSubject?: { kind: string; id: string };
  artifactTypeId?: string;
  source: 'document' | 'media' | 'run-event';
  sourceId: string;
  title: string;
  kind: string;
  format: string;
  status: string;
  latestRevisionId?: string;
  createdBy: { kind: 'user' | 'agent' | 'run'; id: string };
  createdAt: string;
  provenance: { runId?: string; nodeId?: string; templateId?: string; producedBy?: { kind: string; id: string } };
}

export interface ArtifactRevision {
  revisionId: string;
  artifactId: string;
  version: number;
  summary?: string;
  /** Present only on a single-revision fetch (preview/raw), not in the list. */
  content?: string;
  createdBy: { kind: string; id: string };
  createdAt: string;
}

export interface DiffLine {
  op: 'equal' | 'add' | 'remove';
  fromLine?: number;
  toLine?: number;
  text: string;
}
export interface TextDiff { format: 'text'; lines: DiffLine[]; added: number; removed: number }
export interface JsonDiffEntry { path: string; op: 'add' | 'remove' | 'change'; before?: unknown; after?: unknown }
export interface JsonDiff { format: 'json'; changes: JsonDiffEntry[] }
export interface ArtifactDiff { artifactId: string; from: string; to: string; diff: TextDiff | JsonDiff }

async function http<T>(path: string): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(),
    headers: authedHeaders({ 'content-type': 'application/json' }),
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** A bounded Library page + an opaque cursor for the next page (absent ⇒ no more). */
export interface ArtifactPage { artifacts: ArtifactProjection[]; nextCursor?: string }

/** ADR 0083 — the Library: a bounded, cursor-paginated page of every artifact the caller can
 *  see, across sources, newest first (ART-1 — caps the payload instead of shipping all rows). */
export async function listArtifacts(opts: { limit?: number; cursor?: string } = {}): Promise<ArtifactPage> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.cursor) q.set('cursor', opts.cursor);
  const qs = q.toString();
  return http<ArtifactPage>(qs ? `${BASE}?${qs}` : BASE);
}

export async function getArtifact(artifactId: string): Promise<ArtifactProjection> {
  return http<ArtifactProjection>(`${BASE}/${encodeURIComponent(artifactId)}`);
}

export async function listArtifactRevisions(artifactId: string): Promise<ArtifactRevision[]> {
  return (await http<{ revisions: ArtifactRevision[] }>(`${BASE}/${encodeURIComponent(artifactId)}/revisions`)).revisions;
}

export async function getArtifactRevision(artifactId: string, revisionId: string): Promise<ArtifactRevision> {
  return http<ArtifactRevision>(`${BASE}/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(revisionId)}`);
}

/** Diff two IMMUTABLE revisions. Both ids must be concrete versionIds. */
export async function diffArtifact(artifactId: string, from: string, to: string): Promise<ArtifactDiff> {
  return http<ArtifactDiff>(`${BASE}/${encodeURIComponent(artifactId)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}
