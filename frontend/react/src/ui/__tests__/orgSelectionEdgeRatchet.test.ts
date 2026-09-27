/**
 * RATCHET — no page reintroduces the raw `listOrgs().catch(() => setOrgs([]))`
 * idiom, because `orgs` GATES A LATER FETCH.
 *
 * `[]` collapses "this tenant has no workspaces" into "we could not read them".
 * That is not cosmetic here: `orgId` stays `''`, the `if (orgId) load(orgId)`
 * effect never fires, and the page's rows state stays at its initial sentinel —
 * so the failure appears as a permanent skeleton, or as a "No workspaces —
 * create one to …" instruction, IN A STATE THAT NEVER FAILED. Several of these
 * pages had already hardened their rows read, carefully, and it made no
 * difference.
 *
 * The fix is `ui/useOrgSelection`, which keeps `orgs` null on failure and hands
 * the caller a third state. This file pins the pages migrated to it and carries
 * the ones still to go as DATA rather than as a silent gap.
 *
 * SCOPE IS THE MIGRATED SET ONLY (the `ui/Field` precedent, #2533): asserting
 * repo-wide would be a claim about files no one has read. `REMAINING` is the
 * to-do list; moving an entry across is the workflow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
/**
 * Comments stripped. `useOrgSelection`'s own docstring QUOTES the broken idiom in
 * order to explain it, so a naive scan matches the prose describing the bug and
 * "finds" the bug in the fix. (It did, on the first run.)
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/**
 * `code` takes a PATH; `stripComments` takes SOURCE. Split apart when the
 * hand-rolled arm below needed to strip text it had already read, passed the
 * source to `code()`, and got `ENOENT` with the file's own contents as the
 * filename. Loud, but only because the argument happened to be multi-line — a
 * short one-line source string would have been a plausible relative path.
 */
const code = (rel: string): string => stripComments(read(rel));

/**
 * DERIVED, not hand-kept. A file that imports `useOrgSelection` IS an adopter —
 * that is the definition — so scanning for the import is complete by
 * construction, while a literal array is a drift generator. It had already
 * drifted when a `/grade-data` pass caught it: 18 adopters, 17 listed
 * (`features/funnels/FunnelsPage.tsx` was missing, so the page was silently
 * exempt from both assertions below). Same lesson as the failed-read sentinel
 * baseline — derive the set, don't maintain it.
 */
function adopters(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...adopters(p)); continue; }
    if (!e.name.endsWith('.tsx')) continue;
    if (/from '[^']*useOrgSelection[^']*'/.test(readFileSync(p, 'utf8'))) out.push(relative(SRC, p));
  }
  return out.sort();
}
const ADOPTERS = adopters();

/**
 * Provenance only — why each page was migrated, kept because the reasoning is
 * the point. It is CHECKED against `ADOPTERS` below; it no longer drives the
 * assertions, so a new adopter is covered the moment it imports the hook.
 */
const MIGRATED = [
  // FRGATE-5, 2026-08-18: the failure here was not a hung skeleton but a DEAD
  // CONTROL — a failed `listOrgs` left the workspace select with no options,
  // `effectiveOrg` at '', and Create permanently disabled with nothing saying
  // why. Worth noting because it is a THIRD shape for this seam, alongside the
  // permanent skeleton and the "no workspaces — create one" instruction: the
  // page did not hang and made no false claim, it just quietly stopped working.
  // Its `listOrgs` arrives on an INJECTED client prop, which is exactly what the
  // hook's first parameter is for.
  'knowledge/SubjectKnowledgePanel.tsx',
  'byok/CompatEndpointsCard.tsx',
  'features/crm/CrmPage.tsx',
  'features/comments/CommentsPage.tsx',
  'features/commerce-ucp-buyer/PurchasesPage.tsx',
  // Group C, verified 2026-07-26: each hung on a skeleton the failed read never
  // let start. Support and BI ALSO rendered an error Notice beside a "no tickets
  // yet" / "no metrics yet" instruction — `-1`'s third deciding fact, which the
  // `.catch` scan alone does not surface.
  'features/service-desk/SupportPage.tsx',
  'features/bi/MetricsPage.tsx',
  'features/usage-analytics/UsageDashboardPage.tsx',
  // Group A, verified 2026-07-26: each rendered the "No organizations — create
  // one first" instruction over a failed read.
  'features/analytics/AnalyticsPage.tsx',
  'features/consent/ConsentPage.tsx',
  'features/sharing/SharingPage.tsx',
  'features/territories/TerritoriesPage.tsx',
  // Group B, verified 2026-07-26: each carried BOTH shapes — the org edge, and
  // `-3`'s error-beside-empty (an error Notice rendered next to "Add a promotion
  // above…"). Fixed together rather than leaving half a page for the other seam.
  'features/product-discovery/DiscoveryPage.tsx',
  'features/promotions/PromotionsPage.tsx',
  'features/recommendations/RecommendationsPage.tsx',
  // The hardest variant: `pickerOrgs` prepends a SYNTHETIC front-page scope, so a
  // failed read left the picker non-empty and the page rendered a silent SUBSET
  // rather than hanging or claiming emptiness.
  'features/cms/CmsPage.tsx',
  'features/marketplace/MarketplacePage.tsx',
  // The one that broke the pattern: `orgs` gates NO read here, so the failure is
  // confined to a write affordance (an unusable link picker) rather than a hang.
  'features/csm/CsmPage.tsx',
  // HG-4: the last page still hand-rolling the read. Its `.catch` set BOTH
  // `setOrgs([])` and a failed flag, so it carried the sentinel it was trying to
  // avoid, and it had no zero-organization branch at all.
  'features/chat-widget/WidgetsPage.tsx',
  // HG-4 residue, the last three of the class: each still hand-rolled the read
  // AND still shipped the old noun, so each was outside this scan entirely.
  // `scheduled-chats` and `creative-video` carried the same both-halves `.catch`
  // as `chat-widget`; `custom-domains` wrote the bare sentinel and answered
  // "No workspaces" in its org selector — a claim, over a list never read.
  'features/custom-domains/DomainsPage.tsx',
  'features/creative-video/CreativeVideoPage.tsx',
  'features/scheduled-chats/ScheduledChatsPage.tsx',
  // HG-4 round 2: the last two surfaces still shipping the FALSE CLAIM
  // ("workspace" for the `listOrgs` collection). `webinars` wrote BOTH halves in
  // one catch (`setOrgs([])` + an error), so its own zero-org early return
  // answered "No workspace yet" for a read that had failed. `podcasts` was worse
  // still: `orgs` was NON-nullable and started at `[]`, so its zero-org card
  // rendered on the FIRST PAINT, before the request was issued.
  'features/webinars/WebinarsPage.tsx',
  'features/podcasts/PodcastStudioPage.tsx',
  // HG-4 round 3 — the DETAIL page of a feature whose LIST page was fixed in the
  // same commit range, and which those commits edited. It never imported the
  // hook at all: it hand-rolled the read, resolved the workspace only when
  // `?org=` was absent, kept its own `orgsFailed` with no retry, and had NO
  // zero-organization branch — so a tenant with none fell through to the
  // `!funnel` skeleton, which had no terminal condition. The audit that found
  // the nine surfaces did not look inside the files it was editing.
  'features/funnels/FunnelDetailPage.tsx',
  // HG-4 round 3, the ORDERING half: seven adopters wrote the three states
  // themselves with EMPTY BELOW LOADING (`orgsFailed ? … : !orgs ? <Skeleton/> :
  // orgs.length === 0 ? …`) — the literal inversion of what this component
  // encodes. Not live defects (`!orgs` is true only for `null`; `[]` is truthy),
  // but one `!orgs` → `!orgs?.length` refactor away from being one, and that is
  // precisely the class a per-page ordering convention cannot hold. Migrated
  // rather than reordered, so the order stops being a thing anyone can get
  // wrong again.
  'features/analytics/AnalyticsPage.tsx',
  'features/sharing/SharingPage.tsx',
  'features/comments/CommentsPage.tsx',
  'features/consent/ConsentPage.tsx',
  'features/crm/CrmPage.tsx',
  'features/commerce-ucp-buyer/PurchasesPage.tsx',
  'features/territories/TerritoriesPage.tsx',
] as const;

/**
 * Still on the raw idiom. Each still needs the two deciding facts CHECKED before
 * it is touched — does a failed orgs read actually block the dependent fetch, and
 * does the render then claim something or hang? A page that already handles it
 * is a false positive, and editing a sound file is how you introduce the bug you
 * were hunting (8 of 17 candidates in the previous round were already correct).
 */
const REMAINING: readonly string[] = [
  // CORRECTION (2026-08-06) — "the seam is closed" below was FALSE, and it was
  // false when it was written. It is true only of the population this list can
  // see: pages that IMPORT the hook. Measured across call sites instead, 44
  // surfaces still read the org list by hand and SEVEN of them write the
  // sentinel (`setOrgs([])`) in the org catch — `commerce`, `documents`,
  // `email`, `evals`, `forms`, `production`, `publishing`. Pinned in
  // `SENTINEL_ORG_READS` below.
  //
  // AMENDED same day: this note first said EIGHT and named `priority-matrix`,
  // which was a greedy-regex false positive (its org catch is clean; the match
  // ran into a neighbouring `listPresets` chain). And "the exact defect, live"
  // overstated the seven that remain — each also branches on a failure flag, so
  // none renders a false empty state today. See `SENTINEL_ORG_READS`.
  //
  // The claim survived because both of its checks were scoped to adopters: a
  // page outside the seam is outside every assertion that could contradict it.
  // A closure claim can only be made by the widest scan available, never by the
  // one that happens to be convenient — which is this file's own recurring
  // lesson (see the ADOPTERS docstring, and FunnelDetailPage in MIGRATED).
  //
  // EMPTY — the seam is closed. 17 candidates: 16 real, 1 already correct
  // (`ui-plugins`, whose error branch already sat above its loading and empty
  // branches). Kept as a list rather than deleted, so the next instance of this
  // idiom has somewhere obvious to be recorded.
  // A PROVISIONAL triage is recorded below so the next batch starts from evidence
  // instead of from the grep again. Provisional is the operative word: these
  // shapes were read from the render tree, NOT confirmed by mounting the page,
  // and grep-derived groupings have been wrong before. Nothing here is a finding
  // until it has failed a test.
  //
  // The last three, still UNASSESSED — labelled so, not quietly carried.
  // Group C — no orgs branch at all: the rows sentinel renders a skeleton that
  // never resolves, because the read it waits for is never started. The three
  // confirmed members moved to MIGRATED; these two were never assessed.
] as const;

/** The idiom itself — a failed org read written as an empty org list. */
const RAW_IDIOM = /listOrgs\(\)[\s\S]{0,240}?\.catch\(\(\) => setOrgs\(\[\]\)\)/;

/**
 * The catch belonging to THE ORG READ — extracted by depth, never by regex.
 *
 * `RAW_IDIOM` above demands the exact spelling `.catch(() => setOrgs([]))`, which
 * MEASURED appears on zero surfaces outside the migrated set. The shape that
 * actually ships is a braced body carrying both halves,
 * `.catch(() => { setOrgs([]); setOrgsFailed(true); })`, so the narrow regex was
 * not "clean" — it was blind.
 *
 * CORRECTION (2026-08-06, same day) — the widened REGEX that replaced it was
 * wrong too, and it shipped in #3032 before this caught it. It read
 * `listOrgs\(\)[\s\S]{0,400}?\.catch\(…set[A-Za-z]*\(\[\]\)`, and `[\s\S]` does
 * not stop at a statement boundary. On `priority-matrix` the org read is clean
 * (`.catch(() => setOrgsFailed(true))`) and the match ran on THROUGH it into a
 * neighbouring chain two statements later:
 *
 *     void listOrgs().then(…).catch(() => setOrgsFailed(true));
 *     void listProjects().then(setProjects).catch(() => {});
 *     void listPresets().then(setPresets).catch(() => setPresets([]));   // <-- matched
 *
 * So the page was accused of a defect belonging to a different read. That is the
 * fifth entry in this file's list of regexes that answered a DIFFERENT question
 * than the one asked (see the ordering-arm docstring's four), and the fix is the
 * one `openingTag` already reached for: walk the depth. Find the statement
 * containing `listOrgs(` by scanning to its first depth-0 `;`, then return that
 * statement's own `.catch(` argument. A catch two statements away is now
 * unreachable by construction rather than by a character budget.
 *
 * Returns `null` when the org read has no catch at all.
 */
function orgCatchBody(src: string): string | null {
  const at = src.search(/\blistOrgs\s*\(/);
  if (at < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  let end = src.length;
  for (let i = at; i < src.length; i += 1) {
    // `noUncheckedIndexedAccess` types this `string | undefined`; the loop bound
    // guarantees it is present, and `?? ''` would be WRONG here — `''` is a
    // substring of every bracket set, so `.includes('')` is always true.
    const c = src[i]!;
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ';' && depth === 0) { end = i; break; }
  }
  const stmt = src.slice(at, end);
  const ci = stmt.search(/\.catch\s*\(/);
  if (ci < 0) return null;
  const open = stmt.indexOf('(', ci);
  depth = 0; quote = null;
  for (let i = open; i < stmt.length; i += 1) {
    const c = stmt[i]!;
    if (quote) { if (c === quote && stmt[i - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) { depth -= 1; if (depth === 0) return stmt.slice(open + 1, i); }
  }
  return null;
}

/** The org read's OWN catch writes an empty list into some state. */
const collapsesOrgRead = (src: string): boolean => {
  const body = orgCatchBody(src);
  return body !== null && /set[A-Za-z]*\(\[\]\)/.test(body);
};

/**
 * THE BLIND SPOT THIS CLOSES, and it is the same one twice.
 *
 * `ADOPTERS` is derived from the IMPORT — which is complete for adopters and
 * therefore says NOTHING about a file that never imports the hook. That is not
 * hypothetical: `funnels/FunnelDetailPage` (see MIGRATED) went unpinned by EVERY
 * assertion in this file for exactly that reason, and was found by a peer audit
 * rather than by this suite. Closing it one file at a time is how it recurs.
 *
 * So the population is derived from the CALL instead. A page that calls
 * `listOrgs()` itself is, by definition, hand-rolling the read the hook exists to
 * own — adopters pass the function BY REFERENCE (`useOrgSelection(listOrgs, …)`)
 * and never call it — so the call site is the precise signature of a page outside
 * the seam.
 *
 * Three exclusions, each a MEASURED false positive rather than a guessed one:
 *  - Comments. `podcasts/i18n/en.ts`, `webinars/i18n/en.ts` and `cad/meshStore.ts`
 *    mention `listOrgs` only in prose. This is the same trap `code()` was written
 *    for, one layer out.
 *  - Definers. Every feature ships its own `listOrgs` in a `*Client.ts`; the api
 *    layer is not a consumer of itself.
 *  - Re-exporters — `export { listOrgs } from '../crm/crmOrgClient.js'` (dealers,
 *    territories, sales-commissions, app-builder). A pass-through declares no
 *    states, so it cannot collapse any. Caught by the definer test only because
 *    the `export {` form is checked too.
 *  - `ui/useOrgSelection.ts` itself, which calls it because it IS the seam.
 */
/**
 * A pass-through ADAPTER BINDING — `listOrgs: () => listOrgs()` — handing the
 * feature's lister to a shared client interface (`SubjectKnowledgeClient`).
 *
 * The same class as the re-exports already excluded: it declares no state, so it
 * can collapse none. The READ (and its failure handling) happens wherever the
 * interface is consumed — `knowledge/SubjectKnowledgePanel`, which is itself in
 * HAND_ROLLED and handled.
 *
 * Found by AUDIT, 2026-08-08: `profile-memory/ProfileKnowledgeTab` and
 * `projects/ProjectDetailPage` were the last two files the detector called
 * hand-rolled org readers, and neither reads orgs at all. Stripping the binding
 * BEFORE the call test keeps the population honest without a name allowlist.
 */
const adapterBindingsStripped = (src: string): string =>
  src.replace(/\blistOrgs\s*:\s*\(\s*\)\s*=>\s*listOrgs\s*\(\s*\)/g, '');

function handRolledOrgReads(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...handRolledOrgReads(p)); continue; }
    if (!/\.tsx?$/.test(e.name) || /\.test\./.test(e.name)) continue;
    const rel = relative(SRC, p).split(sep).join('/');
    if (rel === 'ui/useOrgSelection.ts') continue;
    const src = adapterBindingsStripped(stripComments(readFileSync(p, 'utf8')));
    if (!/\blistOrgs\s*\(/.test(src)) continue;
    if (/export\s+(?:async\s+)?(?:function|const)\s+listOrgs/.test(src)) continue;
    if (/export\s*\{[^}]*\blistOrgs\b[^}]*\}\s*from/.test(src)) continue;
    out.push(rel);
  }
  return out.sort();
}

/**
 * Every surface that reads the org list WITHOUT the hook. NAMED, never counted.
 *
 * A count is the hole the live-regions grade found: it lets one file be swapped
 * for another with the number unchanged, so the ratchet reports "no growth" while
 * a fresh instance of the defect walks in. A name has to survive review.
 *
 * This list may only SHRINK. Adding to it is not forbidden by a test — nothing
 * static can forbid it — but it cannot be done quietly, which is the whole
 * mechanism. Removing an entry is the migration workflow, and the no-graveyard
 * arm below forces the removal to happen.
 *
 * AUDITED 2026-08-08 — the list is now REVIEWED, not merely recorded. Every
 * remaining entry was checked for how a FAILED org read is handled:
 *
 *     26  handled on the promise chain (`.catch(...)`)
 *      9  handled by an enclosing `try/catch` around `await listOrgs()`
 *      0  unhandled
 *
 * So the tail is not a defect backlog. Two files that the detector had counted
 * (`profile-memory/ProfileKnowledgeTab`, `projects/ProjectDetailPage`) turned out
 * not to read orgs at all — they only BIND the lister into a shared client
 * interface — and are excluded by `adapterBindingsStripped` above rather than by
 * name. 37 -> 35.
 *
 * Two audit passes were wrong before this one, both because the scan asked a
 * different question than the one that mattered: the first looked only for
 * `.catch(` on the statement and reported 11 files as unhandled (they used
 * `try/catch`); the second still counted the two adapter bindings. Neither
 * finding was filed. The rule that keeps paying: read the file before believing
 * the scanner.
 *
 * BEING ON THIS LIST IS NOT A CLAIM THAT THE FILE IS BROKEN. It is a claim that
 * the file is OUTSIDE the seam and has not been checked against the two deciding
 * facts (does a failed org read block a dependent fetch; does the render then
 * claim something or hang). Seven carry the both-halves catch — see
 * `SENTINEL_ORG_READS`, and note that "carries the sentinel" is not the same
 * claim as "is broken"; the first version of this line said eight and said
 * broken, and both halves of that were wrong.
 * The rest are unreviewed, and some are certainly fine: `orgs/useOrgsController`
 * manages orgs as its SUBJECT rather than selecting among them, and
 * `chat/hooks/useCommentsContext` documents a deliberate no-affordance fallback.
 * Calling all 44 defects would be the same overclaim in the other direction.
 */
const HAND_ROLLED: readonly string[] = [
  'canvas/CanvasEditorPage.tsx',
  'canvas/CanvasPresentPage.tsx',
  'canvas/CanvasPreviewPage.tsx',
  'chat/ChatSidebar.tsx',
  'chat/hooks/useCommentsContext.ts',
  'chat/hooks/useConversationActions.tsx',
  'features/advisory-board/AdvisoryBoardPage.tsx',
  'features/agent-knowledge/AgentKnowledgePanel.tsx',
  'features/ambient-work-graph/WorkGraphPage.tsx',
  'features/brand/BrandPage.tsx',
  'features/campaign-brief/CampaignBriefPage.tsx',
  'features/campaign-connectors/CampaignConnectorsPage.tsx',
  'features/campaign-intel/CampaignIntelPage.tsx',
  'features/campaign-orchestration/CampaignStudioPage.tsx',
  'features/canvas-packs/PackCanvasEditorPage.tsx',
  'features/capability-firewall/FirewallRulesPage.tsx',
  'features/commerce-ucp/CommerceUcpPage.tsx',
  'features/creative-briefs/CreativeBriefsPage.tsx',
  'features/dashboard/useDashboardOrg.ts',
  'features/dealers/DealersPage.tsx',
  'features/email/EmailTemplateDetailPage.tsx',
  'features/evals/ArenaPage.tsx',
  'features/forms/FormDetailPage.tsx',
  'features/kicktodo-org-programs/OrgProgramsPage.tsx',
  'features/media/MediaLibraryPage.tsx',
  'features/model-router/ModelRouterPage.tsx',
  'features/operations/OperationsWebhooksPage.tsx',
  'features/priority-matrix/PriorityMatrixPage.tsx',
  'features/sales-commissions/CommissionsPage.tsx',
  'features/sales-maps/SalesMapsPage.tsx',
  'features/strategy/StrategyPage.tsx',
  'orgs/useOrgsController.ts',
];

/**
 * The subset whose org catch WRITES THE SENTINEL — `setOrgs([])` on failure —
 * and the reason `REMAINING`'s "the seam is closed" was wrong.
 *
 * WHAT THIS IS NOT, corrected the same day it was written. #3032 called these
 * "the defect itself" and said eight surfaces "still write the failed org read as
 * an empty org list". Two things were wrong with that:
 *
 *  1. It was EIGHT because the regex was greedy — `priority-matrix`'s org read is
 *     clean and the match had run into a neighbouring chain. Removed. The real
 *     count is seven, and it is now DERIVED as well as listed, so the same
 *     mistake cannot be made silently again.
 *  2. "The defect itself" overstated the SEVEN that remain. Every one of them
 *     ALSO keeps a failure flag and branches on it, so none renders a false "No
 *     organizations" over a failed read today — `documents` even documents the
 *     history in its own catch (UX-DOC-1). I checked the render tree before
 *     saying this; the first version of this comment did not, which is precisely
 *     the mistake the file's ordering docstring warns about.
 *
 * What they ARE is the "both-halves catch": the sentinel is written AND then
 * compensated for by a second piece of state. That is a real defect class and
 * this repo has already migrated four pages out of it — `chat-widget`,
 * `scheduled-chats`, `creative-video`, `webinars`, each described in MIGRATED as
 * carrying "the sentinel it was trying to avoid". It is fragile rather than
 * broken: the two states can only disagree, `orgs.length === 0` now means two
 * things, and one `!orgs` → `!orgs?.length` refactor makes it live. The hook
 * removes the possibility instead of pairing it with a guard.
 *
 * Carried as DATA rather than fixed here on purpose, and this file already says
 * why: "editing a sound file is how you introduce the bug you were hunting"
 * (8 of 17 candidates in an earlier round were already correct). This arm's job
 * is to stop the list growing and to make the fix show up as a deletion.
 */
const SENTINEL_ORG_READS: readonly string[] = [
  // EMPTY — all seven migrated to `ui/useOrgSelection`, so no org read writes
  // the sentinel any more. Kept as a list rather than deleted, the same way
  // `REMAINING` is: the next instance of this shape needs somewhere obvious to
  // be recorded, and an empty named list says "checked, none" where a deleted
  // one would say nothing at all.
];

/**
 * The opening `<OrgSelectionState …>` tag, SCANNED rather than regexed.
 *
 * `<OrgSelectionState\b([^>]*)>` looks obvious and is wrong: attribute VALUES
 * contain both `>` and `/>` (`icon={<GlobeIcon />}`, `emptyBody={t('…')}`), so the
 * match ends in the middle of an attribute and eleven of the twelve adopters read
 * as self-closing. Brace depth — and skipping quoted strings — is the only thing
 * that says where the tag actually ends. Measured, not reasoned: the naive form
 * was written first and its output was checked against every adopter.
 *
 * Returns `null` when there is no tag at all.
 */
function openingTag(src: string, from = 0): { attrs: string; end: number; selfClosing: boolean } | null {
  const rel = src.slice(from).search(/<OrgSelectionState\b/);
  if (rel < 0) return null;
  const at = from + rel;
  let depth = 0;
  let quote: string | null = null;
  for (let i = at + '<OrgSelectionState'.length; i < src.length; i += 1) {
    const c = src[i];
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) {
      const attrs = src.slice(at, i);
      return { attrs, end: i + 1, selfClosing: attrs.trimEnd().endsWith('/') };
    }
  }
  return null;
}

/**
 * A child that renders NOTHING. `{null}` is the reviewer's proof case; the other
 * falsy literals are the same move spelled differently, and an EMPTY body is the
 * same move with nothing at all between the tags.
 */
/**
 * INVERTED after a `/grade-code` pass broke the blocklist version: `code()`
 * strips comments BEFORE this runs, so `{/* moved out *\/}` arrives as `{}`,
 * which was not on the list. The reviewer hoisted the metrics table out of the
 * wrapper, left a comment inside, and the suite stayed 68/68 green with the page
 * exactly as broken as before the migration. `<></>`, `{0}` and `{void 0}` were
 * the same hole spelled differently.
 *
 * Enumerating the ways to say "nothing" is unwinnable. Ask instead whether the
 * child says SOMETHING: every real adopter wraps page content, so the body must
 * contain a JSX element. A blocklist fails open on the case nobody thought of;
 * this fails closed.
 */
const hasRealChild = (child: string): boolean => /<[A-Za-z]/.test(child);

/**
 * Does this file genuinely DELEGATE its org states to `ui/OrgSelectionState`?
 *
 * The old test asked only whether the tag and an `orgsFailed=` prop both appeared
 * SOMEWHERE in the file, and a reviewer proved what that buys: `FunnelsPage`
 * rewritten to
 *
 *     <OrgSelectionState orgsFailed={orgsFailed}>{null}</OrgSelectionState>
 *     <DataTable … />                                  // the real table, UNGATED
 *
 * kept this ratchet green while the page was exactly as broken as before the
 * migration. So the shape is checked, not the spelling:
 *
 *  1. `orgs=` as well as `orgsFailed=` — the component decides the ZERO-ORG branch
 *     from `orgs`, so handing it only the failure flag delegates half the question
 *     and silently drops the branch this seam exists to add.
 *  2. Neither prop may be a LITERAL. `orgsFailed={false}` type-checks, renders, and
 *     hard-codes the answer to the question being asked.
 *  3. Not self-closing, and not closed over an empty child — both render nothing,
 *     which puts the feature's real content BESIDE the guard instead of inside it.
 *     Taking children is the whole mechanism (see the component's docstring): a
 *     caller cannot render content above the failure branch. A wrapper that wraps
 *     nothing has opted out of it while still looking like an adopter.
 *
 * What it still cannot see: content rendered BOTH inside and outside the wrapper.
 * That needs the render tree, and the per-feature mounting tests are where it is
 * caught. Named as a limit rather than guessed at — the mistake this file's
 * ordering-arm docstring already records four times over.
 */
function delegatesOrgStates(src: string): boolean {
  // GATE-1 — inspect EVERY `<OrgSelectionState>` in the file, not just the first.
  // A proper first wrap does not license a degenerate second instance (a
  // self-closing / empty-child / literal-prop sibling puts real content ungated
  // beside the guard). The file delegates iff there is at least one instance and
  // EVERY instance is a valid wrap by the same checks the first one always used.
  let cursor = 0;
  let seen = false;
  for (;;) {
    const tag = openingTag(src, cursor);
    if (!tag) break;
    if (tag.selfClosing) return false;
    if (!/\borgs=\{/.test(tag.attrs) || !/\borgsFailed=\{/.test(tag.attrs)) return false;
    if (/\b(?:orgs|orgsFailed)=\{\s*(?:false|true|null|\[\])\s*\}/.test(tag.attrs)) return false;
    const rest = src.slice(tag.end);
    const close = rest.indexOf('</OrgSelectionState>');
    if (close < 0) return false; // never closed — not a wrap at all
    if (!hasRealChild(rest.slice(0, close))) return false; // wraps nothing
    seen = true;
    cursor = tag.end + close + '</OrgSelectionState>'.length; // advance past this element
  }
  return seen;
}

describe('the org-selection dependency edge', () => {
  it.each(ADOPTERS)('%s no longer writes a failed read as an empty org list', (rel) => {
    const src = code(rel);
    expect(RAW_IDIOM.test(src), `${rel} reintroduced the raw catch-to-empty idiom`).toBe(false);
    expect(src, `${rel} is not using the shared hook`).toMatch(/useOrgSelection/);
  });

  /**
   * ORDERING IS NOT ASSERTED HERE, AND THAT IS A DELIBERATE RETREAT.
   *
   * "The failure branch must precede the loading branch" is the real property,
   * and I could not express it statically. Four attempts, each wrong in a
   * different way and each caught ONLY by sabotage, never by reading it:
   *
   *   naming `orgs`/`available`  -> matched nothing on most files, so the check
   *     silently skipped; an inverted UsageDashboard stayed GREEN.
   *   any `x === null ?`         -> matched the effect GUARD `if (orgId || orgs
   *     === null) return;` and called a correctly-ordered CmsPage inverted.
   *   any `!x ?`                 -> matched unrelated ternaries (`!query ?`).
   *   any loading affordance     -> matched `if (crm.loading) return <Skeleton/>`,
   *     the FEATURE-TOGGLE gate, which legitimately precedes everything.
   *
   * The last one is the instructive failure: identifying "the loading branch
   * belonging to THIS read" needs the render tree, not a regex over text. A
   * fifth guess would just be a fifth way to answer a different question — the
   * exact defect this file exists to catch.
   *
   * So ordering is proven BEHAVIOURALLY instead, by mounting: the per-feature
   * tests assert that a failed read shows the failure and NOT the skeleton
   * (`cms`, `sharing`, `service-desk`, `promotions`, `crm`, `chat-widget`,
   * `scheduled-chats`, `custom-domains`). The remaining migrated files rely on
   * the two static arms below plus review. NAMED AS A GAP rather than papered
   * over with a check that has been wrong four times.
   */
  /**
   * HG-4 — TWO accepted shapes now, because the branch moved.
   *
   * A page either still writes the branch itself (`orgsFailed ? …`) or HANDS THE
   * FLAG to `ui/OrgSelectionState`, which owns the order (failed → zero-orgs →
   * children) and the noun for all of them. Delegation is the stronger shape, not
   * an exemption: the component's own test drives the ambiguous inputs and pins
   * which branch wins, which is a property no per-page grep ever checked.
   *
   * The delegated form is matched as the component's tag PLUS an `orgsFailed=`
   * prop, never as a bare `/orgsFailed/`: every adopter destructures that name
   * from the hook, so a bare match would pass for a page that reads the flag and
   * does nothing with it — the exact silence this arm exists to catch.
   *
   * CORRECTION — tag-plus-prop was not enough either, and a reviewer proved it
   * rather than argued it: `<OrgSelectionState orgsFailed={orgsFailed}>{null}
   * </OrgSelectionState>` beside an unguarded table kept this green. `delegatesOrgStates`
   * above now checks the SHAPE (both props, no literals, actually wraps something).
   */
  it.each(ADOPTERS)('%s branches on orgsFailed (itself or via OrgSelectionState) and offers a retry', (rel) => {
    const src = code(rel);
    const branchesLocally = /orgsFailed \?|if \(orgsFailed\)/.test(src);
    const delegates = delegatesOrgStates(src);
    expect(branchesLocally || delegates, `${rel} never branches on orgsFailed`).toBe(true);
    // The hook's effect is the only place the read happens, so a retry that does
    // not re-trigger it would restore the permanent skeleton it exists to remove.
    expect(src, `${rel} has no retry wired to the org read`).toMatch(/retryOrgs/);
  });

  /**
   * HG-4 REGRESSION GUARD. Centralising this branch deleted twelve features'
   * `orgsFailedBody` and replaced all of them with one generic sentence, because
   * the shared component gave the EMPTY branch a feature slot and the FAILED
   * branch none. Nothing was red: every assertion in this file, and every
   * per-feature guard, was about the branch ORDER — none was about what the card
   * SAYS once it wins. So twelve screens quietly stopped naming the downstream
   * read that never happened, which is the one honest thing a failed read can
   * report (DESIGN.md §4.6 — "state the failure and its consequence").
   *
   * The slot exists now (`failedBody`), so this pins that adopters USE it. It is
   * static rather than behavioural on purpose: the property is "every delegating
   * page supplies its own clause", and that is a fact about the call site.
   */
  it.each(ADOPTERS.filter((rel) => /<OrgSelectionState\b/.test(code(rel))))(
    '%s passes its own failedBody clause, not just emptyBody',
    (rel) => {
      const src = code(rel);
      expect(src, `${rel} delegates the failed card but names no consequence`).toMatch(/failedBody=\{/);
    },
  );

  it('the failedBody scan covers the adopters it claims to (a broken filter would assert nothing)', () => {
    // Without this the `it.each` above degenerates to zero cases the moment the
    // component is renamed — passing by describing nothing, which is the exact
    // silence that let the clause disappear in the first place.
    const delegating = ADOPTERS.filter((rel) => /<OrgSelectionState\b/.test(code(rel)));
    // Raised 16 -> 24 as the last eight adopters migrated (funnels' DETAIL page,
    // plus the seven that had written the order inverted). Pinned at the REAL
    // count with no slack: slack in a floor is silent capacity for exactly the
    // regression the floor exists to catch.
    // 24 -> 31 with the SENTINEL_ORG_READS migration batch.
    expect(delegating.length).toBeGreaterThanOrEqual(31);
  });

  it('the shared renderer keeps the order the pages delegated to it', () => {
    // The delegated arm above is only as good as this: if `OrgSelectionState`
    // stopped testing `orgsFailed` above the empty branch, eleven pages would
    // regress at once and every per-page assertion here would still pass.
    // Behaviour is pinned in `ui/__tests__/OrgSelectionState.test.tsx`; this is
    // the structural half — the failure branch must come FIRST in the source.
    const src = code('ui/OrgSelectionState.tsx');
    const failedAt = src.search(/if \(orgsFailed\)/);
    const emptyAt = src.search(/orgs !== null && orgs\.length === 0/);
    expect(failedAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(-1);
    expect(failedAt, 'the empty branch moved above the failed branch').toBeLessThan(emptyAt);
  });

  it('the hook keeps orgs NULL on failure — the property every page depends on', () => {
    // If this regressed to `setOrgs([])` inside the hook, all four pages would
    // silently return to rendering "no workspaces" for a failed read, and the
    // per-page assertions above would all still pass.
    const src = code('ui/useOrgSelection.ts');
    expect(src).not.toMatch(/catch[\s\S]{0,120}setOrgs\(\[\]\)/);
    expect(src).toMatch(/setOrgsFailed\(true\)/);
    expect(src).toMatch(/setOrgsFailed\(false\)/); // and clears on success
  });

  it('the marketplace reviews read is failed-vs-empty too, not just orgs', () => {
    // Caught by probing: reverting this catch left the ratchet GREEN, because
    // every other assertion here is about the ORG read. A page can carry two
    // instances of the family and a seam-shaped check only sees its own seam.
    // "No reviews yet" on a marketplace listing is a claim about the PACK, not
    // about the request that failed.
    const src = code('features/marketplace/MarketplacePage.tsx');
    expect(src).toMatch(/const \[reviewsFailed, setReviewsFailed\]/);
    expect(src).toMatch(/setReviewsFailed\(false\)/);
    expect(src, 'the catch went back to setReviews([])').not.toMatch(/catch[\s\S]{0,80}setReviews\(\[\]\)/);
  });

  it('every listed file exists — the scan is not silently covering nothing', () => {
    for (const rel of [...MIGRATED, ...REMAINING]) {
      expect(existsSync(join(SRC, rel)), `${rel} moved or was deleted; update this list`).toBe(true);
    }
    expect(MIGRATED.length).toBeGreaterThan(0);
  });

  it('the derived adopter scan actually finds files (a broken walk would skip every assertion)', () => {
    // Without this, a regex or path change turns `it.each(ADOPTERS)` into zero
    // cases and the whole ratchet passes by describing nothing.
    //
    // Pinned at the REAL count with no slack (22 -> 24 when `webinars` and
    // `podcasts` migrated; 24 -> 25 when `funnels/FunnelDetailPage` finally
    // adopted the hook — it had been invisible to EVERY assertion in this file,
    // because the scan is derived from the IMPORT and that page never imported
    // it). It sat at 18 while the walk found 22, so four adopters could have
    // stopped adopting — or the walk could have lost four files — without a
    // word. Slack in a floor is silent capacity for exactly the regression the
    // floor exists to catch. Raise it when the set grows; never lower it to make
    // a red run green.
    // 25 -> 32 with the SENTINEL_ORG_READS migration batch (commerce, documents,
    // email, evals, forms, production, publishing).
    expect(ADOPTERS.length).toBeGreaterThanOrEqual(32);
  });

  /**
   * The DELEGATED arm is only as good as its shape check, and a shape check that
   * matched nothing would look like a codebase where nobody delegates — every
   * adopter would silently fall through to `branchesLocally` and the arm above
   * would still be green. So the classifier is asserted to classify.
   */
  it('the delegation check actually recognises the delegated form', () => {
    const delegating = ADOPTERS.filter((rel) => delegatesOrgStates(code(rel)));
    expect(delegating.length, 'no file reads as delegating — the shape check drifted').toBeGreaterThanOrEqual(31);
    // …and it is not just answering "true" to everything: a local-branch page
    // does not render the component at all, so it must NOT read as delegating.
    //
    // The control is SYNTHETIC, on purpose. It used to point at a real
    // non-delegating page — first `crm/CrmPage`, then
    // `byok/CompatEndpointsCard` — and each time that page migrated the control
    // went red: the control working, but also the control needing a new home.
    // There is now exactly ONE non-delegating adopter left, so the next
    // migration would break it with nothing to re-point at. A fixture cannot be
    // invalidated by a future migration, which is the whole point of a control.
    const LOCAL_BRANCH_PAGE = `
      export function Page() {
        const { orgs, orgsFailed, retry } = useOrgSelection(listOrgs);
        if (orgsFailed) return <StateCard title="failed" action={<Button onClick={retry}/>} />;
        if (orgs !== null && orgs.length === 0) return <StateCard title="empty" />;
        return <Real />;
      }`;
    expect(delegatesOrgStates(LOCAL_BRANCH_PAGE),
      'a hand-branched page must NOT read as delegating').toBe(false);
    // Kept alongside so the real-world case is still exercised while it exists.
    expect(delegatesOrgStates(code('byok/CompatEndpointsCard.tsx')),
      'the last hand-branched adopter — if this migrates, DELETE this line, not the synthetic one above').toBe(false);
  });

  it('the delegation check rejects a wrapper that wraps nothing', () => {
    // The reviewer's proof case, pinned as DATA so the hole cannot silently
    // reopen: each of these type-checks, renders, and leaves the page's real
    // content outside the guard.
    const props = 'orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs} emptyBody={t("x")}';
    const holes = [
      `<OrgSelectionState ${props}>{null}</OrgSelectionState>`,      // renders nothing
      `<OrgSelectionState ${props}></OrgSelectionState>`,            // empty body
      `<OrgSelectionState ${props} />`,                              // self-closing
      `<OrgSelectionState orgsFailed={orgsFailed}>x</OrgSelectionState>`,   // no orgs prop
      `<OrgSelectionState orgs={orgs} orgsFailed={false}>x</OrgSelectionState>`, // literal answer
      // The empty-child SPELLING class — `hasRealChild` (a JSX-element whitelist)
      // must reject all of these, incl. the comment case `code()` strips to `{}`.
      `<OrgSelectionState ${props}>{}</OrgSelectionState>`,          // stripped comment ⇒ empty braces
      `<OrgSelectionState ${props}><></></OrgSelectionState>`,       // empty fragment
      `<OrgSelectionState ${props}>{0}</OrgSelectionState>`,         // falsy literal, no braces-list
      `<OrgSelectionState ${props}>{void 0}</OrgSelectionState>`,    // renders nothing
      // GATE-1 residual — a PROPER first wrap does not license a degenerate SECOND
      // instance: the check inspected only the first `<OrgSelectionState>`, so this
      // empty-child sibling (real content ungated beside it) was invisible.
      `<OrgSelectionState ${props}><DataTable /></OrgSelectionState>\n<OrgSelectionState ${props}>{null}</OrgSelectionState>`,
      // …and the same with the degenerate instance FIRST, valid SECOND — order-independent.
      `<OrgSelectionState ${props}></OrgSelectionState>\n<OrgSelectionState ${props}><DataTable /></OrgSelectionState>`,
    ];
    for (const hole of holes) expect(delegatesOrgStates(hole), hole).toBe(false);
    // The positive control — without it the holes above would also pass if the
    // check simply returned false for everything.
    expect(delegatesOrgStates(`<OrgSelectionState ${props}><DataTable /></OrgSelectionState>`)).toBe(true);
    // …and TWO valid wraps in one file still delegate (the all-instances fix must
    // not over-reject a legitimate multi-instance page).
    expect(delegatesOrgStates(
      `<OrgSelectionState ${props}><DataTable /></OrgSelectionState>\n<OrgSelectionState ${props}><Chart /></OrgSelectionState>`,
    )).toBe(true);
  });

  it('the provenance list has not drifted from the real adopter set', () => {
    // MIGRATED is documentation now, but stale documentation about which pages
    // were audited is its own small lie — and the drift it hides (a page listed
    // that no longer adopts the hook) is exactly what let funnels go unpinned.
    const derived = new Set(ADOPTERS);
    const listedButNotAdopting = MIGRATED.filter((rel) => !derived.has(rel));
    expect(listedButNotAdopting).toEqual([]);
  });

  it('no NEW surface reads the org list by hand', () => {
    // THE ARM THAT MAKES THIS FILE COMPLETE. Everything above is scoped to
    // adopters, so a brand-new page that copies a neighbour and never imports
    // the hook is green by construction — which is how `FunnelDetailPage`
    // survived. This is the only assertion here that can see it.
    const derived = handRolledOrgReads();
    const listed = new Set(HAND_ROLLED);
    const unlisted = derived.filter((rel) => !listed.has(rel));
    expect(unlisted,
      'these read the org list without `ui/useOrgSelection`. Use the hook — it is the '
      + 'only thing that keeps `orgs` null on failure, so a hand-rolled read is free to '
      + 'collapse "could not read" into "has none" and hang the page on a dependent fetch.',
    ).toEqual([]);
  });

  it('the hand-rolled list only shrinks — a migrated file must leave it', () => {
    // The no-graveyard half. Without it the list rots into a record of what was
    // true once, and a page could migrate while still being carried as an
    // exemption — the same drift the MIGRATED provenance arm exists to catch.
    const derived = new Set(handRolledOrgReads());
    const staleExemptions = HAND_ROLLED.filter((rel) => !derived.has(rel));
    expect(staleExemptions,
      'no longer hand-rolls the org read — delete these entries from HAND_ROLLED',
    ).toEqual([]);
  });

  it('the hand-rolled scan actually finds files (a broken walk would assert nothing)', () => {
    // Same reasoning as the ADOPTERS floor: if the walk or either regex drifts,
    // `derived` goes empty, BOTH arms above pass vacuously, and the ratchet
    // reports a closed seam by describing nothing. Pinned at the real count with
    // no slack. This number should go DOWN. Never raise it to make a red run
    // green — a new entrant is the thing being detected.
    //
    // 44 -> 37 when the seven `SENTINEL_ORG_READS` surfaces migrated to the
    // hook; 37 -> 35 when the two adapter pass-throughs were excluded (they
    // never read orgs). It goes DOWN as the seam closes; a rise is a new entrant.
    // 33 -> 32 (2026-08-18): `features/kb/KnowledgeBasePage` migrated to
    // `useOrgSelection` in #3348 (`a78c543e6`) — the same KB round that closed
    // the chain-promise gap. The migration is the POINT of this ratchet, so the
    // red it produced is the gate working, not drift: the list only shrinks, and
    // a migrated file must leave it or the count stops describing the seam.
    // 34 -> 33 (FRGATE-5, 2026-08-18): `knowledge/SubjectKnowledgePanel` migrated.
    // A THIRD shape for this seam, worth recording next to the other two: not a
    // hung skeleton and not a false "no workspaces" instruction, but a DEAD
    // CONTROL — the select rendered with no options, `effectiveOrg` fell to '',
    // and Create sat disabled with nothing explaining it. The page neither hung
    // nor lied; it quietly stopped working. This gate forced the migration the
    // same way it forced ProjectsPage: my first attempt was a bespoke
    // `orgsFailed` flag, and the hook was the right answer.
    //
    // 35 -> 34 (UX_UPGRADE-projects R2, 2026-08-11): `ProjectsPage` migrated to
    // `useOrgSelection` + `OrgSelectionState`. This gate is what forced it: the
    // round's first attempt hand-rolled an `orgsFailed` flag and its own notice
    // — a 19th copy of the extracted idiom — and reproduced the ordering bug the
    // component exists to encode, rendering the disclosure BELOW a workspace
    // picker and a dead Create button rather than instead of them.
    expect(handRolledOrgReads().length).toBe(32);
  });

  it('the hand-rolled detector rejects the three measured false positives', () => {
    // Pinned as DATA so each hole cannot silently reopen. Every one of these was
    // a real file that a naive `grep -l listOrgs` flagged.
    const notCallers = [
      // Comment-only mention. `code()` strips comments; this proves it is applied
      // on THIS path too, not just the adopter path.
      "/** the page reads `listOrgs()` for its picker */\nexport const x = 1;",
      // The api layer declaring the function.
      'export async function listOrgs(): Promise<Org[]> { return get("/orgs"); }',
      // A pass-through re-export — declares no state, so it can collapse none.
      "export { listOrgs, type Org } from '../crm/crmOrgClient.js';",
      // An ADOPTER: passes the function by reference and never calls it.
      'const { orgs, orgsFailed } = useOrgSelection<Org>(listOrgs, access.enabled);',
    ];
    const isCaller = (src: string): boolean => {
      const c = stripComments(src);
      return /\blistOrgs\s*\(/.test(c)
        && !/export\s+(?:async\s+)?(?:function|const)\s+listOrgs/.test(c)
        && !/export\s*\{[^}]*\blistOrgs\b[^}]*\}\s*from/.test(c);
    };
    for (const src of notCallers) expect(isCaller(src), src).toBe(false);
    // A pass-through ADAPTER BINDING is not a read either — the shape that made
    // `ProfileKnowledgeTab`/`ProjectDetailPage` look like org readers.
    expect(isCaller(adapterBindingsStripped('const c = { listOrgs: () => listOrgs() };'))).toBe(false);
    // …but a binding beside a REAL call must still count, or the strip would be
    // a way to hide one.
    expect(isCaller(adapterBindingsStripped(
      'const c = { listOrgs: () => listOrgs() };\nvoid listOrgs().then(setOrgs);',
    ))).toBe(true);
    // The positive control — without it the four above would also pass if the
    // predicate simply returned false for everything.
    expect(isCaller('useEffect(() => { void listOrgs().then(setOrgs); }, []);')).toBe(true);
  });

  it.each(SENTINEL_ORG_READS)('%s still writes the sentinel in its org catch', (rel) => {
    // INVERTED on purpose, exactly like the REMAINING arm below: this asserts the
    // shape is STILL THERE. A green run means "known, recorded, unfixed"; a red
    // one means someone fixed it and must now delete the entry. The list can
    // therefore only shrink, and the fix shows up in review as a deletion rather
    // than as silence.
    expect(collapsesOrgRead(code(rel)),
      `${rel} no longer collapses the failed org read — remove it from SENTINEL_ORG_READS`,
    ).toBe(true);
    // …and it must still be outside the seam, so the two lists cannot disagree.
    expect(HAND_ROLLED).toContain(rel);
  });

  it('the sentinel list is DERIVED-complete — no eighth surface hides behind it', () => {
    // The list above is hand-written, so on its own it is a floor and not a
    // ceiling: a page could start collapsing its org read and simply not be
    // added. Deriving the same set closes that, and it is the check that would
    // have caught `priority-matrix` sitting on the list under the old regex.
    const derived = handRolledOrgReads().filter((rel) => collapsesOrgRead(code(rel)));
    expect(derived).toEqual([...SENTINEL_ORG_READS]);
  });

  it('the org-catch scanner reads THIS statement, not the next one', () => {
    // The #3032 defect, pinned as data. `priority-matrix` has a clean org catch
    // followed by a neighbouring chain that writes an empty list; the greedy
    // regex crossed the statement boundary and accused the wrong read.
    const neighbour = 'void listOrgs().then((o) => { setOrgs(o); }).catch(() => setOrgsFailed(true));\n'
      + 'void listProjects().then(setProjects).catch(() => {});\n'
      + 'void listPresets().then(setPresets).catch(() => setPresets([]));';
    expect(orgCatchBody(neighbour), 'the org catch is the one on the org read').toBe('() => setOrgsFailed(true)');
    expect(collapsesOrgRead(neighbour), 'a neighbouring chain must not be attributed to the org read').toBe(false);
    // The old regex is kept here as the PROOF it was wrong, so nobody
    // reintroduces it thinking the scanner is over-engineering.
    expect(/listOrgs\(\)[\s\S]{0,400}?\.catch\([\s\S]{0,80}?set[A-Za-z]*\(\[\]\)/.test(neighbour),
      'the greedy regex matched this — that is why it was replaced').toBe(true);

    // The positive case, in the real spelling from `commerce/CommercePage`
    // rather than a paraphrase of it — a braced body carrying BOTH halves,
    // which is what `RAW_IDIOM` was blind to.
    const bothHalves = 'void listOrgs().then((o) => { setOrgs(o); })'
      + '.catch(() => { setOrgs([]); setOrgsFailed(true); });';
    expect(RAW_IDIOM.test(bothHalves), 'the narrow idiom regex MISSES this — that was the other bug').toBe(false);
    expect(collapsesOrgRead(bothHalves)).toBe(true);

    // A catch that handles the failure without an empty list is not the family,
    // or every hand-rolled read would read as defective.
    expect(collapsesOrgRead('void listOrgs().then(setOrgs).catch((e) => setError(e.message));')).toBe(false);
    // No catch at all — distinct from a clean one, and must not read as a hit.
    expect(orgCatchBody('void listOrgs().then(setOrgs);')).toBeNull();
    expect(collapsesOrgRead('void listOrgs().then(setOrgs);')).toBe(false);
  });

  it('REMAINING is an honest to-do list, not a graveyard', () => {
    const overlap = REMAINING.filter((r) => (MIGRATED as readonly string[]).includes(r));
    expect(overlap).toEqual([]);
    // A file in REMAINING should still have the idiom — if it does not, someone
    // fixed it without moving it across, and the list has started lying.
    for (const rel of REMAINING) {
      expect(RAW_IDIOM.test(read(rel)), `${rel} no longer has the idiom — move it to MIGRATED or drop it`).toBe(true);
    }
  });
});
