/**
 * ADR 0120 Phase 1 — memory auto-extraction consent grant (the opt-in gate).
 *
 * Auto-extracting durable memory from chat is a cross-content→personal-memory
 * WRITE path, so it is FAIL-CLOSED: nothing is extracted for a subject without an
 * explicit, revocable grant (the ADR 0044 consent-fence shape). This Phase ships
 * ONLY the grant — no extraction happens yet (Phase 2). The grant is keyed by the
 * subject (`user:<id>` / `agent:<id>`) within a tenant; default = NOT granted.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';

export interface MemoryExtractionGrant {
  tenantId: string;
  /** The subject whose memory may be auto-written (`user:<id>` / `agent:<id>`). */
  subject: string;
  granted: boolean;
  /** The principal who set the grant (audit attribution, ADR 0044). */
  grantedBy: string;
  updatedAt: string;
}

const grants = new DurableCollection<MemoryExtractionGrant>('memextract:grant', (g) => `${g.tenantId}:${g.subject}`);

/** Set (or clear) the extraction grant for a subject. Idempotent. */
export async function setExtractionGrant(tenantId: string, subject: string, granted: boolean, actor: string): Promise<MemoryExtractionGrant> {
  const g: MemoryExtractionGrant = { tenantId, subject, granted, grantedBy: actor, updatedAt: new Date().toISOString() };
  await grants.put(g);
  return g;
}

/** Read the grant record (null when never set). */
export async function getExtractionGrant(tenantId: string, subject: string): Promise<MemoryExtractionGrant | null> {
  return (await grants.get(`${tenantId}:${subject}`)) ?? null;
}

/** FAIL-CLOSED: true ONLY when an explicit grant exists AND is `granted`. The
 *  extraction op (Phase 2) gates on this — absent/revoked ⇒ no write. */
export async function isExtractionGranted(tenantId: string, subject: string): Promise<boolean> {
  const g = await getExtractionGrant(tenantId, subject);
  return g?.granted === true;
}
