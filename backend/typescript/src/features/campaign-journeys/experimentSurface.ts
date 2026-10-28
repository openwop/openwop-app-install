/**
 * ADR 0949 P3b — the `journey.split` experiment surface adapter (contact units).
 *
 * A journey is a workflow chain; its `split` node routes each enrolled contact
 * to `control` or `treatment` (`bucketHoldout`). With an engine experiment named
 * (`exp:` id, the `experiments` toggle ON), the arm is the engine's
 * `assignAt(experiment, contactId, run's frozen asOf)`, so a replay or a `:fork`
 * of the journey run routes the contact identically.
 *
 * The target ref is the journey id (the chain the enrollments name). Exactly two
 * arms, neither referencing content: the journey's own branches ARE the
 * variants. Launch and stop flip status only (there is no public serving).
 *
 * `observe` re-derives every exposure rather than recording one, so the split
 * stays a pure read: an enrollment of this journey whose run is stamped and
 * whose contact the experiment assigned at that run's instant is a unit,
 * first exposed at enrollment. Outcomes, per the ADR 0955 P3b agreement:
 *   - conversion: a CLICK after exposure (opens never: Apple MPP inflates them);
 *   - `unsubscribe`: an unsubscribe engagement after exposure;
 *   - `complaint` / `hard_bounce`: a suppression row for the contact's address,
 *     reason `complaint` / `bounced`, recorded after exposure.
 * `sms_opt_out` is not reported: no SMS STOP record exists on this host yet.
 */
import { OpenwopError } from '../../types.js';
import { registerExperimentSurface } from '../../host/experiments/adapters.js';
import { listExperimentRows, mutateExperimentRow } from '../../host/experiments/store.js';
import { assignAt, readExperimentsRunStamp } from '../../host/experiments/runFreeze.js';
import type { UnitObservation } from '../../host/experiments/rollup.js';
import type { Experiment } from '../../host/experiments/types.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { getContact } from '../crm/contactsService.js';
import { listSuppressions } from '../crm/suppressionService.js';
import { listEngagement } from '../email/engagementService.js';
import { listEnrollments, resolveEnrollmentOrg } from './journeyService.js';

export const JOURNEY_SPLIT_SURFACE = 'journey.split';
export const JOURNEY_SPLIT_METRICS = ['unsubscribe', 'complaint', 'hard_bounce'] as const;

const nowIso = (): string => new Date().toISOString();
/** A wire run id is `<tenant>/<opaque>`; storage keys the opaque id. */
const bareRunId = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

export function registerJourneyExperimentSurface(): void {
  registerExperimentSurface({
    kind: JOURNEY_SPLIT_SURFACE,
    unit: 'contact',
    supportedMetrics: JOURNEY_SPLIT_METRICS,
    async validateTarget(_tenantId, _orgId, ref, arms) {
      if (!ref.trim()) throw new OpenwopError('validation_error', 'A journey split names its journey.', 400, { field: 'surface.ref' });
      if (arms.length !== 2) throw new OpenwopError('validation_error', 'A journey split has exactly two arms: control, then treatment.', 400, { field: 'arms' });
      if (arms.some((a) => a.ref !== null)) throw new OpenwopError('validation_error', "A journey split's arms reference no content: the journey's branches are the variants.", 400, { field: 'arms' });
    },
    async launch(e) {
      // One running split per journey: two would route the same contact twice.
      const others = (await listExperimentRows(e.tenantId, e.orgId, { kind: JOURNEY_SPLIT_SURFACE, ref: e.surface.ref }))
        .filter((x) => x.experimentId !== e.experimentId && x.status === 'running');
      if (others.length > 0) throw new OpenwopError('conflict', 'This journey already runs a split.', 409, { reason: 'surface_busy', experimentId: others[0]!.experimentId });
      const at = nowIso();
      const running = await mutateExperimentRow(e.tenantId, e.orgId, e.experimentId, (cur) => {
        if (cur.status !== 'draft') throw new OpenwopError('conflict', 'The experiment changed before it could launch.', 409, { reason: 'not_launchable', status: cur.status });
        return { ...cur, status: 'running', startedAt: at, updatedAt: at };
      });
      if (!running) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      return running;
    },
    async stop(e) {
      const at = nowIso();
      const stopped = await mutateExperimentRow(e.tenantId, e.orgId, e.experimentId, (cur) => (cur.status === 'running' ? { ...cur, status: 'stopped', stoppedAt: at, updatedAt: at } : null));
      if (!stopped) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      return stopped;
    },
    async observe(e: Experiment) {
      // Only this experiment's client: two clients may run journeys with the same
      // id (ADR 0955 D1), and the other's enrollments were never on this split.
      // A workspace with no clients maps every org to `''`, as enrollment does.
      const enrollOrg = await resolveEnrollmentOrg(e.tenantId, e.orgId).catch(() => null);
      if (enrollOrg === null) return { units: [], coverage: 'complete', sourceRetainedSince: null };
      const enrollments = (await listEnrollments(e.tenantId, e.surface.ref, enrollOrg)).filter((x) => x.runId);
      const engagement = await listEngagement(e.tenantId);
      const suppressions = await listSuppressions(e.tenantId);
      const units: UnitObservation[] = [];
      const emails = new Map<string, string | undefined>();
      const emailOf = async (contactId: string): Promise<string | undefined> => {
        if (!emails.has(contactId)) {
          const c = await getContact(contactId);
          emails.set(contactId, c && c.tenantId === e.tenantId ? c.email?.toLowerCase() : undefined);
        }
        return emails.get(contactId);
      };
      for (const en of enrollments) {
        const run = await hostExtStorage().getRun(bareRunId(en.runId!));
        if (!run || run.tenantId !== e.tenantId) continue;
        const stamp = readExperimentsRunStamp(run.metadata);
        if (!stamp) continue; // the engine never assigned an unstamped run
        const a = assignAt(e, en.contactId, stamp.asOf);
        if (!a) continue;
        const exposedAt = en.enrolledAt;
        const mine = engagement.filter((x) => x.contactId === en.contactId && x.at >= exposedAt);
        const email = await emailOf(en.contactId);
        const supp = email ? suppressions.filter((x) => x.email === email && x.at >= exposedAt) : [];
        units.push({
          arm: a.arm.key, firstExposureAt: exposedAt,
          converted: mine.some((x) => x.kind === 'clicked'),
          metrics: {
            unsubscribe: mine.some((x) => x.kind === 'unsubscribed') ? 1 : 0,
            complaint: supp.some((x) => x.reason === 'complaint') ? 1 : 0,
            hard_bounce: supp.some((x) => x.reason === 'bounced') ? 1 : 0,
          },
        });
      }
      return { units, coverage: 'complete', sourceRetainedSince: null };
    },
  });
}
