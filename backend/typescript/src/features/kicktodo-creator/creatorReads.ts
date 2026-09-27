/**
 * ADR 0460 §3 (read 1–3) — the kicktodo-creator HONESTY READS.
 *
 * Three DISPLAY-ONLY projections the Studio read-only workspace renders. They
 * add NO durable state and change nothing — each is re-derived from the same
 * owners the write path already trusts (`getCandidate` + the lesson-media
 * pointers), so the surface can never paint a status the server can't back
 * (the ADR 0458 "no painted status" discipline; OQ2):
 *
 *   - gateStatus         → the honest 5-gate matrix, re-derived from the SAME
 *                          predicates `assertGates` enforces (never a fork).
 *   - simulationVerdicts → the durable persona-verdict record, VERBATIM.
 *   - lessonStatus       → per-day durable build signals ONLY: `planned` (the
 *                          day exists in the validated plan revision) + `hasMedia`
 *                          (a media pointer row exists). There is deliberately NO
 *                          `enriched` flag — the rich lesson body is ephemeral
 *                          node output with no host SSoT (ADR 0460 §3 correction),
 *                          so an `enriched:true` would be painted status.
 *
 * All three are manage-gated + tenant-scoped at the route (see routes.ts); a
 * cross-tenant id resolves to null → a uniform 404 (no existence leak).
 */

import { getCandidate, listCandidates } from './creatorService.js';
import { decideRights, evaluateGates, getPublication, type GateRow } from './publishService.js';
import { getMonitorReport } from './monitorService.js';
import { getApproval } from '../../host/approvalService.js';
import { listLessonMedia, type LessonMediaKind, type SimulationVerdict } from './lessonAssembly.js';

/** The durable simulation record, returned verbatim. */
export interface SimulationVerdictsRead {
  verdicts: SimulationVerdict[];
  recordedAt: string;
}

/** Per-day build status — durable signals only (no ephemeral lesson-body claim). */
export interface LessonDayStatus {
  day: number;
  /** The day is present in the validated plan revision (its plan-level content
   *  passed `validateDays`). NOT a claim about a persisted rich lesson body. */
  planned: boolean;
  /** A `LessonMediaPointer` row exists for this day. */
  hasMedia: boolean;
  mediaKind?: LessonMediaKind;
}

/** Read 1 — the 5-gate matrix (display-only; re-derives rights exactly as
 *  `submitForPublication` does). `null` when the candidate is absent/cross-tenant. */
export async function gateStatus(tenantId: string, candidateId: string): Promise<GateRow[] | null> {
  const candidate = await getCandidate(tenantId, candidateId);
  if (!candidate) return null;
  const rights = decideRights(candidate.dossier?.sources ?? []);
  return evaluateGates(candidate, rights);
}

/** Read 2 — the durable three-persona simulation record, verbatim. `null` when
 *  the candidate is absent OR has not been simulated (honest not-run, not empty). */
export async function simulationVerdicts(tenantId: string, candidateId: string): Promise<SimulationVerdictsRead | null> {
  const candidate = await getCandidate(tenantId, candidateId);
  if (!candidate) return null;
  return candidate.simulation ?? null;
}

/** Read 3 — per-day durable build signals (planned + hasMedia). `null` when the
 *  candidate is absent; `[]` when it has no plan revision yet. */
export async function lessonStatus(tenantId: string, candidateId: string): Promise<LessonDayStatus[] | null> {
  const candidate = await getCandidate(tenantId, candidateId);
  if (!candidate) return null;
  const mediaByDay = new Map((await listLessonMedia(tenantId, candidateId)).map((p) => [p.day, p]));
  return (candidate.plan?.plan.days ?? []).map((d) => {
    const media = mediaByDay.get(d.day);
    return {
      day: d.day,
      planned: true,
      hasMedia: media !== undefined,
      ...(media ? { mediaKind: media.kind } : {}),
    };
  });
}

/** One "Needs you" queue row — SCREEN_POLISH Studio residue (ADR 0437 §4.2):
 *  the queue must be STORE-BACKED precision, not a client-side state filter.
 *  `detail` is verbatim server-side text (the approver's note / the first open
 *  gate's message) — the FE labels the KIND and never invents detail. */
export type NeedsYouKind = 'returned' | 'gates-open' | 'broken-sources';
export interface NeedsYouRow {
  candidateId: string;
  topic: string;
  kind: NeedsYouKind;
  detail: string;
  count?: number;
}

/** The creator's precise "waiting on you" queue, composed from the three
 *  owners that already back the workspace reads (never a parallel store):
 *   - `returned`        → a submitted publication whose `challenge-publish`
 *                         approval was REJECTED (the note is the feedback);
 *   - `gates-open`      → a planned, unsubmitted candidate whose gate matrix
 *                         has enforced `open` rows (informational rows never
 *                         count — the write path doesn't enforce them);
 *   - `broken-sources`  → a monitor report with broken sources (matters most
 *                         on a published challenge). */
export async function creatorNeedsYou(tenantId: string): Promise<NeedsYouRow[]> {
  const rows: NeedsYouRow[] = [];
  for (const c of await listCandidates(tenantId)) {
    if (c.state === 'withdrawn') continue;
    const pub = await getPublication(tenantId, c.id);
    if (pub && !pub.completedAt) {
      const approval = await getApproval(pub.approvalId);
      if (approval && approval.tenantId === tenantId && approval.status === 'rejected') {
        rows.push({ candidateId: c.id, topic: c.topic, kind: 'returned', detail: approval.note ?? '' });
      }
    }
    if (!pub && c.state === 'planned') {
      const open = ((await gateStatus(tenantId, c.id)) ?? []).filter((g) => g.state === 'open' && g.informational !== true);
      const first = open[0];
      if (first) rows.push({ candidateId: c.id, topic: c.topic, kind: 'gates-open', detail: first.detail, count: open.length });
    }
    const monitor = await getMonitorReport(tenantId, c.id);
    if (monitor && monitor.broken > 0) {
      rows.push({ candidateId: c.id, topic: c.topic, kind: 'broken-sources', detail: '', count: monitor.broken });
    }
  }
  const rank: Record<NeedsYouKind, number> = { returned: 0, 'gates-open': 1, 'broken-sources': 2 };
  return rows.sort((a, b) => rank[a.kind] - rank[b.kind]);
}
