/**
 * issue 5921 — create forms on list pages open from a header button into `CreateDialog`
 * (`ui/CreateDialog.tsx`), not as a form sitting above the list on every visit.
 *
 * A `<form>` rendered directly in a page, tab or panel under `features/` is how that
 * pattern looks in source; edit forms on detail pages look the same, which is why this
 * pins per-file COUNTS instead of refusing every form. The counts only go down:
 *  - a new file with a form, or a higher count, fails: use `CreateDialog` for a create
 *    action, or raise the count here with the reason in the commit;
 *  - a lower count fails too, until the baseline below is lowered to match, so a
 *    moved form cannot quietly come back.
 * Baseline measured 2026-11-14 with /projects moved (PR 1 of issue 5921).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Like selectArrowRatchet: vitest runs from frontend/react, and jsdom gives no file: URL.
const SRC = join(process.cwd(), 'src');

const BASELINE: Record<string, number> = {
  'features/advisory-board/AdvisoryBoardPage.tsx': 1,
  'features/agent-knowledge/AgentKnowledgePanel.tsx': 4,
  'features/brand/BrandPage.tsx': 1,
  'features/campaign-brief/CampaignBriefPage.tsx': 3,
  'features/campaign-connectors/CampaignConnectorsPage.tsx': 2,
  'features/campaign-intel/CampaignIntelPage.tsx': 1,
  'features/campaign-intel/SpendCapsPanel.tsx': 2,
  'features/campaign-ops/ClientCollaboratorsPanel.tsx': 2,
  'features/campaign-ops/OperationsPage.tsx': 3,
  'features/campaign-ops/TeamPanel.tsx': 1,
  'features/campaign-orchestration/CampaignDetailPage.tsx': 1,
  'features/campaign-orchestration/CampaignStudioPage.tsx': 1,
  'features/cdp/CdpConsolePage.tsx': 1,
  'features/channel-ingress/ConnectionChannelPanel.tsx': 2,
  'features/claude-code/ClaudeCodePairPage.tsx': 1,
  'features/connections/VaultAdminPanel.tsx': 1,
  'features/consent/ConsentPage.tsx': 1,
  'features/creative-video/CreativeVideoPage.tsx': 1,
  'features/crm/BookingTab.tsx': 1,
  'features/crm/CompaniesTab.tsx': 1,
  'features/crm/CompanyDetailPage.tsx': 1,
  'features/crm/ContactFieldsPage.tsx': 1,
  'features/crm/ContactsTab.tsx': 4,
  'features/crm/DealDetailPage.tsx': 2,
  'features/crm/DealsTab.tsx': 1,
  'features/crm/GmailSyncTab.tsx': 1,
  'features/crm/PipelinesPage.tsx': 2,
  'features/crm/PublicBookingPage.tsx': 1,
  'features/crm/PublicSignPage.tsx': 1,
  'features/crm/SignTab.tsx': 1,
  'features/crm/TasksTab.tsx': 1,
  'features/csm/CsmPage.tsx': 3,
  'features/custom-domains/DomainsPage.tsx': 1,
  'features/dealers/OutletDetailPage.tsx': 1,
  'features/developer-keys/ApiKeysPage.tsx': 1,
  'features/docs/DocsPublicPage.tsx': 1,
  'features/email/EmailPage.tsx': 1,
  'features/entities/EntitiesPage.tsx': 2,
  'features/experiments/ExperimentDetailPage.tsx': 1,
  'features/experiments/ExperimentsPage.tsx': 1,
  'features/experiments/OptimizePanel.tsx': 1,
  'features/forms/FormsPage.tsx': 1,
  'features/funnels/FunnelsPage.tsx': 1,
  'features/notebooks/NotebooksPage.tsx': 4,
  'features/podcasts/PodcastStudioPage.tsx': 3,
  'features/priority-matrix/PriorityListPage.tsx': 3,
  'features/priority-matrix/PriorityMatrixPage.tsx': 3,
  'features/product-discovery/DiscoveryPage.tsx': 3,
  'features/production/ProductionPage.tsx': 1,
  'features/projects/ProjectLedgerTab.tsx': 1,
  'features/promotions/PromotionsPage.tsx': 1,
  'features/recommendations/RecommendationsPage.tsx': 2,
  'features/settings-shell/SecurityPanel.tsx': 1,
  'features/sharing/SharingPage.tsx': 2,
  'features/site/BlogPage.tsx': 1,
  'features/strategy/StrategyPage.tsx': 1,
  'features/territories/TerritoriesPage.tsx': 3,
  'features/users/UsersPage.tsx': 1,
  'features/webinars/WebinarsPage.tsx': 2,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/(Page|Tab|Panel)\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

function census(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of walk(join(SRC, 'features'))) {
    const n = (readFileSync(file, 'utf8').match(/<form\b/g) ?? []).length;
    if (n > 0) counts[relative(SRC, file).split('\\').join('/')] = n;
  }
  return counts;
}

describe('inline create forms on list pages (issue 5921)', () => {
  const now = census();
  it('no page, tab or panel gains a form (use CreateDialog for a create action)', () => {
    const grew = Object.entries(now).filter(([f, n]) => n > (BASELINE[f] ?? 0)).map(([f, n]) => `${f}: ${BASELINE[f] ?? 0} -> ${n}`);
    expect(grew, 'a create form belongs in ui/CreateDialog, opened from the page header').toEqual([]);
  });
  it('the baseline is lowered when a form moves out, so it cannot quietly come back', () => {
    const shrank = Object.entries(BASELINE).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `${f}: ${n} -> ${now[f] ?? 0}`);
    expect(shrank, 'lower these counts in BASELINE').toEqual([]);
  });
  it('the census is not vacuous: it sees forms, and /projects has none', () => {
    expect(Object.keys(now).length).toBeGreaterThan(40);
    expect(now['features/projects/ProjectsPage.tsx']).toBeUndefined();
  });
});
