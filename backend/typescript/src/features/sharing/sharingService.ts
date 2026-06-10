/**
 * Sharing (ADR 0013). Mints unguessable capability links to a SPECIFIC resource
 * and resolves them on a public, unauthenticated surface. It does NOT copy
 * resource data — a link stores a `(resourceType, resourceId)` reference and a
 * RESOLVER for that type loads a read-only projection at resolve time (so an
 * edited/revoked/deleted resource is reflected live). Resource types are
 * pluggable via a static resolver registry, not special-cased per route.
 *
 * @see docs/adr/0013-sharing.md
 */

import { randomBytes } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { optionalCleanString } from '../../host/boundedStrings.js';
import { getOrg } from '../../host/accessControlService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getPage, type Section } from '../cms/cmsService.js';
import { getCollection, listDocuments } from '../kb/kbService.js';

const TOGGLE_ID = 'sharing';

const MAX = {
  label: 160,
  expiresInDays: 3650,
  /** Documents listed in a shared KB-collection overview (public, bounded). */
  collectionDocs: 200,
  descr: 320,
} as const;

export type ResourceType = 'cms_page' | 'kb_collection';
export const RESOURCE_TYPES: readonly ResourceType[] = ['cms_page', 'kb_collection'];

export interface ShareLink {
  token: string;
  tenantId: string;
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  label?: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  revoked: boolean;
}

interface Card { title: string; description: string; imageToken?: string }

interface ShareResolver {
  /** Mint-time: assert the resource exists in (tenant, org); throw 404 otherwise. */
  validate(tenantId: string, orgId: string, resourceId: string): Promise<void>;
  /** Public read-only projection (or null if the resource is gone). */
  load(tenantId: string, orgId: string, resourceId: string): Promise<Record<string, unknown> | null>;
  /** Social-card metadata (or null if gone). */
  card(tenantId: string, orgId: string, resourceId: string): Promise<Card | null>;
}

const RESOLVERS: Record<ResourceType, ShareResolver> = {
  cms_page: {
    async validate(tenantId, orgId, resourceId) {
      if (!(await getPage(tenantId, orgId, resourceId))) throw notFound(resourceId);
    },
    async load(tenantId, orgId, resourceId) {
      const p = await getPage(tenantId, orgId, resourceId);
      if (!p) return null;
      return { kind: 'cms_page', title: p.title, slug: p.slug, status: p.status, sections: p.sections, updatedAt: p.updatedAt };
    },
    async card(tenantId, orgId, resourceId) {
      const p = await getPage(tenantId, orgId, resourceId);
      if (!p) return null;
      const c: Card = { title: p.title, description: describeSections(p.sections, p.title) };
      const hero = heroImageToken(p.sections);
      if (hero) c.imageToken = hero;
      return c;
    },
  },
  kb_collection: {
    async validate(tenantId, orgId, resourceId) {
      if (!(await getCollection(tenantId, orgId, resourceId))) throw notFound(resourceId);
    },
    async load(tenantId, orgId, resourceId) {
      const col = await getCollection(tenantId, orgId, resourceId);
      if (!col) return null;
      // `.catch(() => [])`: listDocuments re-validates the collection, so a delete
      // racing between getCollection and here would throw — degrade to an empty
      // doc list rather than surfacing an inconsistent error.
      const docs = (await listDocuments(tenantId, orgId, resourceId).catch(() => [])).slice(0, MAX.collectionDocs);
      return {
        kind: 'kb_collection',
        name: col.name,
        description: col.description,
        documentCount: col.documentCount,
        chunkCount: col.chunkCount,
        documents: docs.map((d) => ({ documentId: d.documentId, title: d.title })),
      };
    },
    async card(tenantId, orgId, resourceId) {
      const col = await getCollection(tenantId, orgId, resourceId);
      if (!col) return null;
      return { title: col.name, description: (col.description ?? `${col.documentCount} document(s)`).slice(0, MAX.descr) };
    },
  },
};

const links = new DurableCollection<ShareLink>('sharing:link', (l) => l.token);

// ─── authed management (authorizeOrgScope-gated in routes) ───────────────────

export async function createLink(
  tenantId: string,
  orgId: string,
  actor: string,
  input: { resourceType?: unknown; resourceId?: unknown; label?: unknown; expiresInDays?: unknown },
): Promise<ShareLink> {
  const resourceType = input.resourceType;
  if (typeof resourceType !== 'string' || !(RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
    throw new OpenwopError('validation_error', `\`resourceType\` MUST be one of: ${RESOURCE_TYPES.join(', ')}.`, 400, { field: 'resourceType' });
  }
  const resourceId = optionalCleanString(input.resourceId, 256);
  if (!resourceId) throw new OpenwopError('validation_error', '`resourceId` is required.', 400, { field: 'resourceId' });

  // Validate cheap input (label, expiry) BEFORE the resource lookup, so a bad
  // expiresInDays 400s rather than masking behind the resolver's 404.
  const now = new Date();
  const expiry = expiryFields(input.expiresInDays, now);
  const label = optionalCleanString(input.label, MAX.label);

  // The resource MUST exist in THIS (tenant, org) — cross-org/tenant id 404s.
  await RESOLVERS[resourceType as ResourceType].validate(tenantId, orgId, resourceId);

  const link: ShareLink = {
    token: randomBytes(32).toString('base64url'),
    tenantId,
    orgId,
    resourceType: resourceType as ResourceType,
    resourceId,
    ...(label !== undefined ? { label } : {}),
    createdBy: actor,
    createdAt: now.toISOString(),
    ...expiry,
    revoked: false,
  };
  await links.put(link);
  return link;
}

export async function listLinks(tenantId: string, orgId: string): Promise<Array<ShareLink & { cardTitle?: string }>> {
  const rows = (await links.list())
    .filter((l) => l.tenantId === tenantId && l.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // Annotate with the resource's current card title (best-effort — a deleted
  // resource just has no title). N+1 by design: this is an AUTHED, low-volume
  // management list (unlike the public sitemap/feed path, which must not fan out).
  const out: Array<ShareLink & { cardTitle?: string }> = [];
  for (const l of rows) {
    const card = await RESOLVERS[l.resourceType].card(l.tenantId, l.orgId, l.resourceId).catch(() => null);
    out.push(card ? { ...l, cardTitle: card.title } : { ...l });
  }
  return out;
}

export async function revokeLink(tenantId: string, orgId: string, token: string): Promise<void> {
  const link = await links.get(token);
  if (!link || link.tenantId !== tenantId || link.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Share link not found.', 404, {});
  }
  link.revoked = true;
  await links.put(link);
}

// ─── public resolve (unauthed — tenant from the link, toggle-gated) ──────────

/** Load a share link by token, enforcing every public gate (existence, revoke,
 *  expiry, the link-tenant's `sharing` toggle). Throws a uniform 404 on ANY
 *  failure so the surface leaks nothing about which condition failed. */
async function resolveActiveLink(token: string): Promise<ShareLink> {
  const gone = (): never => { throw new OpenwopError('not_found', 'Shared link not found.', 404, {}); };
  if (typeof token !== 'string' || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) gone();
  const link = await links.get(token);
  if (!link || link.revoked) gone();
  if (link!.expiresAt) {
    const exp = Date.parse(link!.expiresAt);
    if (Number.isNaN(exp) || exp <= Date.now()) gone(); // unparseable expiry → fail-closed
  }
  const org = await getOrg(link!.orgId);
  if (!org || org.tenantId !== link!.tenantId) gone();
  const assignment = await resolveOne(TOGGLE_ID, { tenantId: link!.tenantId });
  if (!assignment || !assignment.enabled) gone();
  return link!;
}

export async function resolveShared(token: string): Promise<{ resourceType: ResourceType; label?: string; resource: Record<string, unknown> }> {
  const link = await resolveActiveLink(token);
  const resource = await RESOLVERS[link.resourceType].load(link.tenantId, link.orgId, link.resourceId);
  if (!resource) throw new OpenwopError('not_found', 'Shared resource not found.', 404, {});
  return { resourceType: link.resourceType, ...(link.label ? { label: link.label } : {}), resource };
}

export async function resolveSharedCard(token: string, baseUrl: string): Promise<{ title: string; description: string; imageUrl?: string }> {
  const link = await resolveActiveLink(token);
  const card = await RESOLVERS[link.resourceType].card(link.tenantId, link.orgId, link.resourceId);
  if (!card) throw new OpenwopError('not_found', 'Shared resource not found.', 404, {});
  return {
    title: card.title,
    description: card.description,
    ...(card.imageToken ? { imageUrl: `${baseUrl}/v1/host/sample/assets/${encodeURIComponent(card.imageToken)}` } : {}),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function notFound(resourceId: string): OpenwopError {
  return new OpenwopError('not_found', 'Resource not found in this organization.', 404, { resourceId });
}

function expiryFields(raw: unknown, now: Date): { expiresAt?: string } {
  if (raw == null || raw === '') return {};
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0 || days > MAX.expiresInDays) {
    throw new OpenwopError('validation_error', `\`expiresInDays\` MUST be an integer 1–${MAX.expiresInDays}.`, 400, { field: 'expiresInDays' });
  }
  return { expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() };
}

/** A short description from the first hero/richText section text, bounded. */
function describeSections(sections: Section[], fallback: string): string {
  for (const s of sections) {
    const d = s.data as Record<string, unknown>;
    const text = typeof d.subheading === 'string' ? d.subheading
      : typeof d.text === 'string' ? d.text
        : typeof d.heading === 'string' ? d.heading : '';
    if (text.trim().length > 0) return text.trim().slice(0, MAX.descr);
  }
  return fallback;
}

/** The first hero/image section's media token, for the social card. */
function heroImageToken(sections: Section[]): string | undefined {
  for (const s of sections) {
    const d = s.data as Record<string, unknown>;
    const token = typeof d.imageToken === 'string' ? d.imageToken : typeof d.token === 'string' ? d.token : '';
    if (token) return token;
  }
  return undefined;
}
