/**
 * CRM org-scoped business objects (ADR 0008) — Companies, Deals, Pipelines
 * (Phase 1); Tasks, Activities (Phase 2); custom-field defs (Phase 3). Distinct
 * from the legacy tenant-scoped `contactsService` (preserved untouched): these
 * are org-scoped and RBAC-gated. Every record carries tenantId + orgId and every
 * accessor verifies BOTH (CTI-1 IDOR guard).
 *
 * CRMGAP-10: this file used to be a 1,178+ line, 8-entity god-file. It is now a
 * PURE RE-EXPORT BARREL over `entities/{shared,companies,pipelines,deals,
 * tasks,activities,fieldDefs,snapshots}.ts` — every symbol below is re-exported
 * verbatim (same name, same shape) from its new home, so EVERY existing
 * importer (`orgRoutes.ts`, `routes.ts`, `surface.ts`, `segmentsService.ts`,
 * `snapshotDaemon.ts`, `crmMergeService.ts`, `convertService.ts`,
 * `reportService.ts`, `csvExport.ts`, tests, …) keeps importing from
 * `./crmEntitiesService.js` unchanged. See each `entities/*.ts` file's header
 * doc for its slice of the split (including the deliberate, documented-safe
 * `pipelines.ts` ↔ `deals.ts` import cycle).
 *
 * @see docs/adr/0008-crm-full-port.md
 */

export { MAX_PER_ORG_ENTITIES, assertUnderCap } from './entities/shared.js';

export {
  type Company,
  listCompanies,
  getCompany,
  createCompany,
  getCompanyForCas,
  casUpdateCompany,
  updateCompany,
  deleteCompany,
  tombstoneCompany,
  untombstoneCompany,
  casRevertCompanyAbsorption,
  companyExistsInTenant,
} from './entities/companies.js';

export {
  type PipelineStage,
  type Pipeline,
  listPipelines,
  getPipeline,
  getOrCreateDefaultPipeline,
  createPipeline,
  updatePipeline,
  deletePipeline,
} from './entities/pipelines.js';

export {
  type DealStatus,
  DEAL_STATUSES,
  type Deal,
  type StageHistoryRow,
  getStageHistory,
  listStageHistoryForPipeline,
  listDeals,
  getDeal,
  createDeal,
  updateDeal,
  deleteDeal,
  dealExistsInTenant,
} from './entities/deals.js';

export {
  type TaskStatus,
  TASK_STATUSES,
  type Task,
  type LinkValidators,
  makeLinkValidators,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
} from './entities/tasks.js';

export {
  type ActivityKind,
  ACTIVITY_KINDS,
  type Activity,
  listActivities,
  listActivitiesByIdPrefix,
  getActivity,
  createActivity,
  relinkContactReferences,
  relinkCompanyReferences,
  type CompanyRefIds,
  captureCompanyRefIds,
  restoreCompanyRefsToSource,
} from './entities/activities.js';

export {
  type FieldType,
  FIELD_TYPES,
  type CustomEntity,
  CUSTOM_ENTITIES,
  ORG_CUSTOM_ENTITIES,
  type RefEntityType,
  type FieldDef,
  CONTACT_FIELD_DEF_ORG,
  listFieldDefs,
  listContactFieldDefs,
  createFieldDef,
  createContactFieldDef,
  deleteFieldDef,
  deleteContactFieldDef,
  type CustomFieldRefResolvers,
  validateCustomFields,
  resolveContactCustomFields,
} from './entities/fieldDefs.js';

export {
  type StageSnapshotEntry,
  type CrmSnapshot,
  MAX_SNAPSHOTS_PER_PIPELINE,
  crmSnapshotId,
  upsertCrmSnapshot,
  listCrmSnapshots,
  listCrmOrgScopes,
} from './entities/snapshots.js';

export {
  type BookingLinkStatus,
  BOOKING_LINK_STATUSES,
  type BookingLink,
  type BookingLinkInput,
  listBookingLinks,
  getBookingLink,
  getPublishedBookingLinkBySlug,
  createBookingLink,
  updateBookingLink,
  deleteBookingLink,
} from './entities/bookingLinks.js';

export {
  type BookingStatus,
  type Booking,
  type ClaimResult,
  bookingIdFor,
  getBooking,
  getBookingById,
  listBookings,
  listBookingsForLink,
  claimBooking,
  putBooking,
  countBookingsCreatedOn,
} from './entities/bookings.js';

export {
  type SignerStatus,
  type SignRequestStatus,
  SIGN_REQUEST_STATUSES,
  type Signer,
  type SignRequest,
  type SignatureRecord,
  listSignRequests,
  getSignRequest,
  getSignRequestById,
  createSignRequest,
  putSignRequest,
  appendSignatureRecord,
  listSignatureRecords,
} from './entities/signRequests.js';

import { __clearCompanies } from './entities/companies.js';
import { __clearBookingLinks } from './entities/bookingLinks.js';
import { __clearBookings } from './entities/bookings.js';
import { __clearSignRequests } from './entities/signRequests.js';
import { __clearPipelines } from './entities/pipelines.js';
import { __clearDeals } from './entities/deals.js';
import { __clearTasks } from './entities/tasks.js';
import { __clearActivities } from './entities/activities.js';
import { __clearFieldDefs } from './entities/fieldDefs.js';
import { __clearSnapshots } from './entities/snapshots.js';

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetCrmEntities(): Promise<void> {
  await __clearPipelines();
  await __clearCompanies();
  await __clearDeals();
  await __clearTasks();
  await __clearActivities();
  await __clearFieldDefs();
  await __clearSnapshots();
  await __clearBookingLinks();
  await __clearBookings();
  await __clearSignRequests();
}
