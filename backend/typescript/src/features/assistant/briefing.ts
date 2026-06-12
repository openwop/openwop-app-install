/**
 * Briefing composer (ADR 0023 loop 5, §12 T3) — the ONE place a brief is
 * assembled, used by both the read route (`GET /assistant/briefing`, a single
 * batched read — per-IP rate-limit discipline) and the scheduled loop (the
 * `compose-briefing` pack node calls this via `ctx.features.assistant`).
 *
 * Source-grounded by construction (the gap analysis' Gap 6): every surfaced
 * commitment carries its `SourceRef` (origin link + taint) and a human "why
 * this is surfaced" derived from the prioritization signals — trust is earned
 * by showing where claims came from, not asserting them.
 */

import { listCommitments, listMeetings, listPendingActions, type Commitment, type SourceRef } from './assistantService.js';
import { priorityScore, deadlineProximityOf, PRIORITY_PROFILES, type PriorityProfile } from './prioritization.js';

type PriorityProfileKey = PriorityProfile['key'];

export interface BriefingItem {
  commitmentId: string;
  description: string;
  status: string;
  dueAt?: string;
  score: number;
  /** Human-readable "why this is surfaced" (deadline + confidence signals). */
  why: string;
  source: Pick<SourceRef, 'kind' | 'externalId' | 'url' | 'contentTrust'>;
}

export interface Briefing {
  generatedAt: string;
  headline: string;
  topCommitments: BriefingItem[];
  /** Open commitments due within 48h or overdue — the "what's at risk" lane. */
  atRisk: BriefingItem[];
  upcomingMeetings: Array<{ meetingId: string; title: string; startAt: string }>;
  awaitingApprovalCount: number;
}

const TOP_N = 10;
const AT_RISK_WINDOW_MS = 48 * 60 * 60 * 1000;

function whyOf(c: Commitment, nowMs: number): string {
  const parts: string[] = [];
  if (c.dueAt) {
    const dueMs = Date.parse(c.dueAt);
    if (Number.isFinite(dueMs)) {
      const days = Math.round((dueMs - nowMs) / 86_400_000);
      parts.push(days < 0 ? `overdue by ${-days}d` : days === 0 ? 'due today' : `due in ${days}d`);
    }
  }
  parts.push(`extraction confidence ${Math.round(c.confidence * 100)}%`);
  if (c.source.contentTrust === 'untrusted') parts.push('from connected (untrusted) content');
  return parts.join(' · ');
}

function itemOf(c: Commitment, nowMs: number, profile: PriorityProfileKey): BriefingItem {
  const score = priorityScore(
    {
      senderImportance: 0.5,
      deadlineProximity: deadlineProximityOf(c.dueAt, nowMs),
      projectPriority: 0.5,
      priorEngagement: c.confidence,
    },
    PRIORITY_PROFILES[profile].weights,
  );
  return {
    commitmentId: c.commitmentId,
    description: c.description,
    status: c.status,
    score: Math.round(score * 100) / 100,
    why: whyOf(c, nowMs),
    source: {
      kind: c.source.kind,
      externalId: c.source.externalId,
      ...(c.source.url !== undefined ? { url: c.source.url } : {}),
      ...(c.source.contentTrust !== undefined ? { contentTrust: c.source.contentTrust } : {}),
    },
    ...(c.dueAt !== undefined ? { dueAt: c.dueAt } : {}),
  };
}

export async function composeBriefing(
  tenantId: string,
  opts: { nowMs?: number; profile?: PriorityProfileKey } = {},
): Promise<Briefing> {
  const nowMs = opts.nowMs ?? Date.now();
  const profile = opts.profile ?? 'balanced';
  const [open, meetings, pending] = await Promise.all([
    listCommitments(tenantId, { status: 'open' }),
    listMeetings(tenantId),
    listPendingActions(tenantId, 'pending'),
  ]);

  const items = open.map((c) => itemOf(c, nowMs, profile)).sort((a, b) => b.score - a.score);
  const atRisk = items.filter((i) => {
    if (!i.dueAt) return false;
    const dueMs = Date.parse(i.dueAt);
    return Number.isFinite(dueMs) && dueMs - nowMs < AT_RISK_WINDOW_MS;
  });
  const upcoming = meetings
    .filter((m) => {
      const startMs = Date.parse(m.startAt);
      return Number.isFinite(startMs) && startMs >= nowMs - 60 * 60 * 1000;
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 5)
    .map((m) => ({ meetingId: m.meetingId, title: m.title, startAt: m.startAt }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    headline: `${open.length} open commitment(s) — ${atRisk.length} at risk · ${upcoming.length} upcoming meeting(s) · ${pending.length} awaiting your approval`,
    topCommitments: items.slice(0, TOP_N),
    atRisk: atRisk.slice(0, TOP_N),
    upcomingMeetings: upcoming,
    awaitingApprovalCount: pending.length,
  };
}
