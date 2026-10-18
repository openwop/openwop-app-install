/**
 * ADR 0855 D4 / P5 — drift on a PULL REQUEST. A person with write access to a
 * project names a GitHub pull request; the host reads its title, description
 * and diff through the caller's read-only GitHub connection (`github-read`,
 * brokered: the token stays host-side and only `api.github.com` is reachable),
 * and runs the SAME drift check as a run (`classifyDrift`, `unexplainedFindings`)
 * against the ledger's CURRENT version. Unexplained findings become possible
 * decisions linked to the pull request. On demand and awaited (the person waits
 * for the answer), so there is no background work (ADR 0699 D1); one check from
 * the same per-workspace daily budget. Advisory: nothing is posted to GitHub.
 */
import { OpenwopError } from '../../types.js';
import { brokeredFetch, type BrokeredCallDeps } from '../../host/brokeredEgress.js';
import type { Project } from '../projects/projectsService.js';
import { classifyDrift, decisionTitlesOf, DRIFT_FEATURE_ID, DRIFT_LIMITS, ledgerText, takeDriftBudget, unexplainedFindings, type DriftClassifier } from './driftCheck.js';
import { getLedger, stateAt } from './ledgerStore.js';
import { createSuggestion } from './suggestions.js';

// The repo segment may not be `.` or `..` (ADR 0835 D6: spliced into
// `/repos/<owner>/<repo>/…`, URL normalization would re-target the call).
const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/((?!\.{1,2}\/)[A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:\/(?:files|commits|checks))?\/?(?:[?#].*)?$/;

export interface PullRequestRef { owner: string; repo: string; number: number; url: string }

/** A github.com pull-request URL, or null. Nothing else is ever fetched. */
export function parsePullRequestUrl(raw: unknown): PullRequestRef | null {
  if (typeof raw !== 'string') return null;
  const m = PR_URL_RE.exec(raw.trim());
  if (!m) return null;
  const [, owner, repo, num] = m;
  return { owner: owner!, repo: repo!, number: Number(num), url: `https://github.com/${owner}/${repo}/pull/${num}` };
}

export interface PullRequestText { title: string; body: string; diff: string }
export type PullRequestReader = (deps: BrokeredCallDeps, pr: PullRequestRef) => Promise<PullRequestText>;

const API = 'https://api.github.com';
const HEADERS = { 'x-github-api-version': '2022-11-28', 'user-agent': 'openwop-app' };

async function ghGet(deps: BrokeredCallDeps, path: string, accept: string) {
  const out = await brokeredFetch(deps, { provider: 'github-read', url: `${API}${path}`, method: 'GET', extraHeaders: { ...HEADERS, accept } });
  if (out.outcome === 'no_connection') {
    throw new OpenwopError('credential_unavailable', 'No GitHub (read) connection — connect one under Connections with read access to pull requests first.', 424, { provider: 'github-read' });
  }
  if (out.outcome !== 'sent') throw new OpenwopError('egress_blocked', `GitHub was not reachable (${out.outcome}).`, 502, { outcome: out.outcome });
  if (out.res.status === 404 || out.res.status === 403) {
    throw new OpenwopError('not_found', 'GitHub has no pull request at that address that your connection can read.', 404, { status: out.res.status });
  }
  if (out.res.status >= 400) throw new OpenwopError('egress_blocked', `GitHub answered ${out.res.status}.`, 502, { status: out.res.status });
  return out.res;
}

export const readPullRequest: PullRequestReader = async (deps, pr) => {
  const path = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
  const meta = (await (await ghGet(deps, path, 'application/vnd.github+json')).json().catch(() => ({}))) as { title?: unknown; body?: unknown };
  const diff = await (await ghGet(deps, path, 'application/vnd.github.diff')).text();
  return { title: typeof meta.title === 'string' ? meta.title : '', body: typeof meta.body === 'string' ? meta.body : '', diff };
};

/** What the drift check reads for a pull request (the eval composes it the same way). */
export function pullRequestProduced(text: PullRequestText): string {
  return [`# Pull request: ${text.title}`, text.body, '# Diff', text.diff].join('\n\n').slice(0, DRIFT_LIMITS.producedChars);
}

let reader: PullRequestReader = readPullRequest;
/** Test seam: CI has no GitHub. */
export function __setPullRequestReaderForTest(r: PullRequestReader | null): void { reader = r ?? readPullRequest; }

export interface PullRequestCheck { pullRequest: string; ledgerVersion: number; findings: number; unexplained: number; suggestionIds: string[] }

export async function checkPullRequest(
  project: Project, actingUserId: string, rawUrl: unknown, classify: DriftClassifier = classifyDrift,
): Promise<PullRequestCheck> {
  const pr = parsePullRequestUrl(rawUrl);
  if (!pr) throw new OpenwopError('validation_error', '`url` must be a GitHub pull request, like https://github.com/owner/repo/pull/123.', 400, { field: 'url' });
  const ledger = await getLedger(project.tenantId, project.id);
  if (!ledger) throw new OpenwopError('not_found', 'This project has no team ledger yet.', 404, { projectId: project.id });
  const text = await reader({ tenantId: project.tenantId, actingUserId, orgId: project.orgId }, pr);
  const produced = pullRequestProduced(text);
  if (!(await takeDriftBudget(project.tenantId))) {
    throw new OpenwopError('rate_limited', 'Today’s drift-check budget for this workspace is used up. Try again tomorrow.', 429, {});
  }
  const state = await stateAt(project.tenantId, ledger.ledgerId, ledger.version);
  if (!state) throw new OpenwopError('not_found', 'This project has no team ledger yet.', 404, { projectId: project.id });
  const decisions = await decisionTitlesOf(project, state);
  const findings = await classify(project.tenantId, ledgerText(project.name, state, decisions), produced);
  if (!findings) throw new OpenwopError('egress_blocked', 'The drift check could not get an answer from the model. Try again.', 502, {});
  const unexplained = unexplainedFindings(findings, decisions);
  const suggestionIds: string[] = [];
  for (const [i, f] of unexplained.entries()) {
    const s = await createSuggestion({
      tenantId: project.tenantId, projectId: project.id,
      title: f.claim.slice(0, 80), text: f.ledgerItem ? `${f.claim} (departs from: ${f.ledgerItem})` : f.claim,
      source: { kind: 'drift', ref: `pr:${pr.owner}/${pr.repo}#${pr.number}@v${ledger.version}:${i}`, link: pr.url },
      suggestedBy: { kind: 'agent', id: DRIFT_FEATURE_ID },
    });
    if (s) suggestionIds.push(s.suggestionId);
  }
  return { pullRequest: pr.url, ledgerVersion: ledger.version, findings: findings.length, unexplained: unexplained.length, suggestionIds };
}
