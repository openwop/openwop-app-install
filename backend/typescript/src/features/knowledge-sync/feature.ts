/**
 * Knowledge-sync feature (ADR 0107) — scheduled diff-sync of an external-drive
 * folder (via a Connection) into a KB collection. Phase 2 ships the config layer
 * (`SyncSource` CRUD + diff-state store + REST); the `knowledge-sync.run` workflow,
 * scheduler binding, and "Add sync" UI are later phases. Composes Connections
 * (auth), `knowledgeSourceFetch` (listing), the scheduler, and KB ingest — no
 * parallel infra. OFF by default (a new external-egress surface; opt-in per tenant).
 */
import type { BackendFeature } from '../types.js';
import { registerKnowledgeSyncRoutes } from './routes.js';

export const knowledgeSyncFeature: BackendFeature = {
  id: 'knowledge-sync',
  registerRoutes: registerKnowledgeSyncRoutes,
  toggleDefault: {
    id: 'knowledge-sync',
    label: 'Knowledge sync',
    description:
      'Scheduled diff-sync of an external drive folder (Google Drive or OneDrive, via a Connection) into a KB collection (ADR 0107). One-way (drive → KB), content untrusted-fenced, SSRF-guarded egress. Phase 2 manages sync sources; the scheduled sync run + UI are later phases. New external-egress surface — OFF by default, opt-in per tenant.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'knowledge-sync',
  },
};
