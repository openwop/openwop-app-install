/**
 * System-site docs corpus (ADR 0392 open question 1 — the reference-content
 * effort). Seeds the product documentation as REAL published CMS pages in the
 * `docs` collection on the reserved system-site org — the exact
 * `featuresPage.ts` sibling pattern: deterministic page ids, a corpus
 * SEED_VERSION whose bump refreshes on redeploy, and the never-clobber rule
 * (a page a human has edited — `updatedBy !== SYSTEM_ACTOR` — is frozen
 * forever; only still-system-authored pages refresh).
 *
 * The pages serve at the public `/docs` tier once the `docs` toggle is ON for
 * the host tenant; publishing here fires the CMS lifecycle → docs→KB sync,
 * which no-ops while the toggle is off (run the docs backfill route after
 * enabling — README § Stripe payments has the sibling ops pattern).
 *
 * Content voice: brand-light ("this app", "your workspace") so a white-label
 * operator inherits accurate docs; every page is theirs to edit in the CMS
 * (which freezes it). Base locale only (the KB sync indexes base text; locale
 * overlays are a follow-on).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import {
  createPage, getPage, transitionPage, updatePage,
  type Section,
} from '../features/cms/cmsService.js';
import { ensureSystemSiteOrg, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from './systemSite.js';

const log = createLogger('host.systemSiteDocs');

const SYSTEM_ACTOR = 'system';
/** Bump when the corpus below changes — a redeploy refreshes every page that
 *  has never been human-edited. */
const SEED_VERSION = 1;

const pageIdFor = (slug: string): string => `page:host-site-docs-${slug}`;

/** richText section helper — heading feeds the /docs TOC + the KB chunker. */
const rt = (id: string, heading: string, text: string): Section =>
  ({ sectionId: id, type: 'richText', data: { heading, text } }) as Section;
const hero = (id: string, heading: string, subheading: string): Section =>
  ({ sectionId: id, type: 'hero', data: { heading, subheading } }) as Section;

interface DocSeed { slug: string; title: string; docsNav: string; sections: Section[] }

const DOCS: DocSeed[] = [
  // ── getting-started/ ────────────────────────────────────────────────────────
  {
    slug: 'welcome', title: 'Welcome', docsNav: 'getting-started/10',
    sections: [
      hero('h', 'Welcome', 'What this app is and how the pieces fit together.'),
      rt('s1', 'What this app does', 'This app is a workspace for AI-assisted work: one AI chat that can run real workflows, a visual workflow builder with repeatable runs, a knowledge base the AI answers from, and business features — CRM, commerce, campaigns, documents — that all share the same foundations.'),
      rt('s2', 'The one chat', 'There is a single AI chat surface. Every AI capability — agents, tools, document authoring, knowledge answers — rides through it. Features scope the chat to a specialist agent rather than adding separate chat boxes, so everything you can ask for lives in one place.'),
      rt('s3', 'Workflows and runs', 'Automations are workflows: graphs of typed nodes you compose on a canvas or install as ready-made chains. Every execution is a run — recorded, repeatable, and reviewable, with human-approval gates where you want sign-off.'),
      rt('s4', 'Your data, your keys', 'Provider credentials are yours (bring-your-own-key), stored encrypted and scoped to your workspace. Every feature is tenant-isolated, and most can be switched on or off per workspace from the admin area.'),
    ],
  },
  {
    slug: 'quickstart', title: 'Quickstart', docsNav: 'getting-started/20',
    sections: [
      hero('h', 'Quickstart', 'From sign-in to a first result in a few minutes.'),
      rt('s1', 'Sign in and look around', 'Sign in and you land on the dashboard. The left navigation lists the features enabled for your workspace; the chat is always one click away.'),
      rt('s2', 'Connect a model provider', 'Open the key settings and add an API key for at least one AI provider. Keys are stored encrypted, never shown again in full, and used only for your workspace. Without a key the app runs in an honest demo mode.'),
      rt('s3', 'Ask the chat to do something', 'Start in the chat: ask a question, or ask it to run a workflow. When a task needs your approval — sending an email, spending money — the chat pauses with an approval card instead of acting silently.'),
      rt('s4', 'Run your first workflow', 'Open Workflows and start from a template or the visual builder. Press run, watch the steps execute live, and open the run afterwards to see exactly what happened at every node.'),
    ],
  },
  {
    slug: 'workspaces-and-access', title: 'Workspaces & access', docsNav: 'getting-started/30',
    sections: [
      hero('h', 'Workspaces & access', 'Tenancy, organizations, members, and roles.'),
      rt('s1', 'Workspaces', 'Everything you create lives in a workspace (your tenant). Data never crosses workspaces: another tenant cannot see your runs, contacts, documents, or keys.'),
      rt('s2', 'Organizations and members', 'Inside a workspace, organizations group people and content. Members join with a role — viewer, editor, or admin — and each role maps to explicit scopes: read, write, run, approve, and management scopes for admins.'),
      rt('s3', 'Roles in practice', 'Viewers read. Editors create and change content and start runs. Admins additionally manage members, shared connections, webhooks, and approval policies. Sensitive operator actions — billing configuration, marketplace approvals — are reserved to the host operator.'),
      rt('s4', 'Anonymous and demo sessions', 'Without signing in you get an ephemeral demo workspace: real features, no persistence guarantees, and no access to anything another user made. Sign in to keep your work.'),
    ],
  },
  {
    slug: 'feature-toggles', title: 'Feature toggles', docsNav: 'getting-started/40',
    sections: [
      hero('h', 'Feature toggles', 'Every feature can be turned on or off per workspace.'),
      rt('s1', 'How gating works', 'Each feature has a toggle with a sensible default. The backend is the authority: when a toggle is off, the feature’s pages disappear from navigation and its API routes answer as if the feature does not exist.'),
      rt('s2', 'Managing toggles', 'Admins manage toggles from the admin area. Some features declare dependencies — a feature that needs another cannot strand it off — and a few support variants for A/B-style rollout.'),
      rt('s3', 'What toggles do not change', 'Toggling a feature off hides it; it does not delete data. Money-related records are always preserved regardless of toggle state.'),
    ],
  },

  // ── work/ ───────────────────────────────────────────────────────────────────
  {
    slug: 'ai-chat', title: 'AI chat', docsNav: 'work/10',
    sections: [
      hero('h', 'AI chat', 'One conversation surface for every AI capability.'),
      rt('s1', 'Conversations and agents', 'The chat keeps durable conversations. You can talk to the general assistant or scope a conversation to a specialist agent — a persona with its own instructions, tools, and knowledge bindings.'),
      rt('s2', 'Tools the chat can use', 'Agents call typed tools: reading app state, searching your knowledge base, looking up schemas, and running workflows. Tools respect your permissions — the chat can never read what you cannot.'),
      rt('s3', 'Approvals in the loop', 'Actions with consequences pause the conversation with an approval card. You see what the agent wants to do and approve or decline; nothing side-effectful happens silently.'),
      rt('s4', 'Bring your own key', 'Chat models run on the provider keys you configure. A workspace without keys gets a clearly-labeled demo experience rather than a fake one.'),
    ],
  },
  {
    slug: 'workflows-and-runs', title: 'Workflows & runs', docsNav: 'work/20',
    sections: [
      hero('h', 'Workflows & runs', 'Composable automation with a full memory.'),
      rt('s1', 'Composing workflows', 'Build workflows on the visual canvas from typed nodes — AI steps, data operations, integrations, approval gates — or install ready-made workflow chains and adapt them. Every node declares its inputs and outputs, so connections are checked, not guessed.'),
      rt('s2', 'Runs', 'Starting a workflow creates a run. Runs stream progress live, record every step’s inputs and outputs durably, and can be cancelled mid-flight. The run log is the audit trail: what ran, with what data, decided by whom.'),
      rt('s3', 'Replay and fork', 'A finished run can be replayed deterministically — recorded step outputs are reused, side effects are not re-fired. Forking branches a new run from any checkpoint, useful for retrying a failure with a fix.'),
      rt('s4', 'Human-in-the-loop', 'Approval nodes suspend a run until someone with the approval scope decides. Approvals arrive in the inbox and the chat, and the run resumes (or stops) with the decision recorded.'),
      rt('s5', 'Schedules and triggers', 'Workflows can run on a schedule, from a webhook, from an inbound event, or on demand from the chat. Scheduled work runs under the same recording and approval rules as manual runs.'),
    ],
  },
  {
    slug: 'agents', title: 'Agents', docsNav: 'work/30',
    sections: [
      hero('h', 'Agents', 'Specialist AI personas with tools, knowledge, and standing.'),
      rt('s1', 'What an agent is', 'An agent is a persona: instructions, an allowlist of tools, optional knowledge bindings, and configuration. Agent packs ship ready-made specialists; you can also configure your own.'),
      rt('s2', 'Standing agents', 'Some agents are standing coworkers with a roster identity — they keep memory across conversations, can be scheduled to work autonomously, and their autonomous activity is bounded by the capability policies you set.'),
      rt('s3', 'Capability policy', 'What agents may do on their own is governed centrally: allow, require approval, or deny — per capability, per workspace. Policy decisions are logged so you can see what was attempted, allowed, and blocked.'),
    ],
  },
  {
    slug: 'knowledge-base', title: 'Knowledge base', docsNav: 'work/40',
    sections: [
      hero('h', 'Knowledge base', 'The documents your AI answers from — with citations.'),
      rt('s1', 'Collections and documents', 'Knowledge lives in collections of documents: pasted text, uploaded files, or content synced from other features. Documents are chunked and embedded for retrieval.'),
      rt('s2', 'Grounded answers', 'When the chat answers from knowledge, it retrieves relevant passages and cites them by number. Coverage is honest: if retrieval finds little or nothing, the answer says so instead of inventing.'),
      rt('s3', 'Ingestion options', 'Text and common file formats ingest directly; heading-aware chunking keeps structure. Collections can pin a specific embedding model, and re-indexing runs in the background when settings change.'),
      rt('s4', 'Managed collections', 'Some features maintain their own managed collections automatically — published documentation, for example, is kept in lockstep with what is publicly live, so answers never cite unpublished content.'),
    ],
  },
  {
    slug: 'documents-and-canvases', title: 'Documents & canvases', docsNav: 'work/50',
    sections: [
      hero('h', 'Documents & canvases', 'Markdown documents, slides, drawings, CAD, and the app builder.'),
      rt('s1', 'Documents', 'Documents are markdown-first: write, split, and preview, with export to PDF, DOCX, EPUB, ODT, slides, and spreadsheets. The AI can draft and edit documents through the chat, with your review before anything is saved.'),
      rt('s2', 'Design canvases', 'Slides, drawings, and CAD each get a purpose-built editor on a shared canvas foundation. Everything is versioned; AI edits go through validation so a bad suggestion cannot corrupt a canvas.'),
      rt('s3', 'The app builder', 'The app builder turns a described application into a typed application model — screens, components, data — that you refine visually or through the chat, then export as real framework source code in several stacks.'),
      rt('s4', 'Sharing', 'Canvases and documents can be shared read-only by link, published as public pages, or exported. Share tokens are revocable and scoped to exactly one thing.'),
    ],
  },

  // ── business/ ───────────────────────────────────────────────────────────────
  {
    slug: 'crm', title: 'CRM', docsNav: 'business/10',
    sections: [
      hero('h', 'CRM', 'Contacts, companies, deals, and the activity timeline.'),
      rt('s1', 'Records', 'The CRM keeps contacts, companies, and deals with custom fields, tags, and relationships. Everything links: a deal knows its contacts, an activity knows its record, an email lands on the right timeline.'),
      rt('s2', 'Pipeline and activities', 'Deals move through configurable pipeline stages. Calls, notes, meetings, emails, bookings, and signatures accumulate on each record’s timeline, so the full history is one scroll.'),
      rt('s3', 'Booking links and e-signature', 'Public booking pages let outside contacts schedule time with you (time-zone aware, calendar-file invites); click-to-sign collects legally-attributable signatures on documents, with an audit certificate.'),
      rt('s4', 'Automation', 'CRM nodes let workflows read and write records — enrich a new lead, advance a deal after a signature, notify on stage changes — under the same permission rules as the UI.'),
    ],
  },
  {
    slug: 'commerce', title: 'Commerce', docsNav: 'business/20',
    sections: [
      hero('h', 'Commerce', 'Products, storefront checkout, orders, and subscriptions.'),
      rt('s1', 'Catalog and storefront', 'Maintain a product catalog and sell through a public storefront with hosted payment checkout. Inventory, quotes, discounts, and promotions are built in.'),
      rt('s2', 'Orders and fulfilment', 'Orders move through a money-safe lifecycle: payment is verified against the order before anything is marked paid, refunds are tracked, and every state change is auditable.'),
      rt('s3', 'Subscriptions', 'Products can be sold subscribe-and-save: the payment provider is the recurrence clock, and each paid period creates a normal order — no shadow billing system.'),
      rt('s4', 'Agent-reachable commerce', 'The catalog and checkout can be exposed to external AI shopping agents through a standard protocol surface, with your store remaining the merchant of record.'),
    ],
  },
  {
    slug: 'marketing', title: 'Marketing', docsNav: 'business/30',
    sections: [
      hero('h', 'Marketing', 'Briefs, creative, campaigns, journeys, and channels.'),
      rt('s1', 'From brief to creative', 'Campaign briefs capture strategy — audience, positioning, proof points — and feed everything downstream: persona-grounded ad angles, headlines, creative layouts with per-platform safe zones, and a research pipeline that mines real voice-of-customer evidence with citations.'),
      rt('s2', 'Campaigns and journeys', 'Email campaigns, customer journeys, and segment automations ride the workflow engine: sends are gated, spend has budgets, and every touch is recorded. Win-back and lifecycle journeys ship as installable chains.'),
      rt('s3', 'Channels', 'Email, SMS, web push, chat widgets, and business messaging connect through governed adapters with consent and opt-out enforced fail-closed — a contact who opted out cannot be messaged by any path, including workflows.'),
      rt('s4', 'Measurement', 'Engagement lands in the customer-data platform: events, segments, attribution, and pacing. Reporting reads the same records the automations write.'),
    ],
  },
  {
    slug: 'billing-and-plans', title: 'Billing & plans', docsNav: 'business/40',
    sections: [
      hero('h', 'Billing & plans', 'Subscriptions, AI-token balances, and the seller marketplace.'),
      rt('s1', 'Plans and entitlements', 'Workspaces subscribe to plans; one central resolver decides what a plan allows. Prepaid AI-token packs draw down before daily caps apply.'),
      rt('s2', 'Payments', 'Payment runs on the operator’s payment-provider account with hosted checkout and a verified webhook — fulfilment follows confirmed payment, never the redirect.'),
      rt('s3', 'The seller marketplace', 'Workspaces can onboard as sellers and offer paid packs to other workspaces. Payouts ride hosted seller accounts; buyers pay by destination charge with a platform fee; paid listings require operator approval before going live.'),
      rt('s4', 'Money rules', 'Money records are never lost to configuration: payments, payouts, refunds, and disputes are recorded even if a feature was toggled off in between, and every money mutation is idempotent under retries.'),
    ],
  },

  // ── reference/ ──────────────────────────────────────────────────────────────
  {
    slug: 'connections-and-keys', title: 'Connections & keys', docsNav: 'reference/10',
    sections: [
      hero('h', 'Connections & keys', 'Third-party integrations and credential handling.'),
      rt('s1', 'Bring your own key', 'AI-provider keys are configured per workspace, stored encrypted at rest, and resolved only at call time. Keys never appear in logs, run records, or API responses.'),
      rt('s2', 'Connections', 'Third-party apps connect through a brokered connection system: OAuth or token credentials are held host-side, calls are pinned to each provider’s real API hosts, and revoking a connection immediately disables everything that used it.'),
      rt('s3', 'Connection packs', 'New providers are described by connection packs — declarative manifests validated against a schema — so adding an integration does not mean adding trusted code.'),
      rt('s4', 'Egress governance', 'Outbound calls from workflows go through governed adapters. Vendor-write operations (posting, sending, paying) are marked adapter-only, so a workflow node can never smuggle a raw credential to an arbitrary host.'),
    ],
  },
  {
    slug: 'publishing-and-site', title: 'Publishing & site', docsNav: 'reference/20',
    sections: [
      hero('h', 'Publishing & site', 'The CMS, the public site, and this documentation.'),
      rt('s1', 'Pages and the editor', 'Public content is authored as CMS pages built from typed sections, with versions, localization overlays, scheduled publishing, and an editorial review flow (draft, in review, published).'),
      rt('s2', 'The public site', 'Published pages serve on the public site with search-engine metadata, sitemaps, and feeds. The home page, features page, blog, pricing, and legal pages are all CMS pages an operator can edit.'),
      rt('s3', 'This documentation', 'These docs are CMS pages in a dedicated docs collection: published pages appear in the public docs navigation, are indexed into a managed knowledge collection so the chat can answer from them with citations, and are reachable by external agents through documentation search tools.'),
      rt('s4', 'Forms and funnels', 'Public forms collect structured submissions with consent tracking; funnels compose landing pages, offers, and checkout into measured multi-step flows.'),
    ],
  },
  {
    slug: 'developer-surface', title: 'Developer surface', docsNav: 'reference/30',
    sections: [
      hero('h', 'Developer surface', 'APIs, packs, exports, and agent-facing tools.'),
      rt('s1', 'The API', 'The app speaks an open workflow protocol on the wire — runs, events, capabilities — plus host-extension REST routes for app features. Capability discovery tells clients exactly what this deployment supports; nothing is advertised that is not honored.'),
      rt('s2', 'Packs', 'Functionality ships as packs: node packs (workflow steps), agent packs (personas), artifact-type packs, workflow chains, and connection packs. Packs are versioned, signed, and installable from the marketplace.'),
      rt('s3', 'MCP and external agents', 'An inbound tool server lets external AI clients — IDEs, desktop assistants — call selected capabilities as typed tools with per-user authorization. Documentation search, notebooks, and app-builder controls are exposed this way.'),
      rt('s4', 'Exports and portability', 'What you build leaves with you: workflows export as portable definitions, the app builder emits real source code, documents export to standard formats, and data export covers your workspace’s records. Portability is a design rule, not an afterthought.'),
    ],
  },
];

const seedMarker = new DurableCollection<{ id: string; version: number }>('systemsite:docs-seed', (r) => r.id);

async function doEnsure(): Promise<void> {
  await ensureSystemSiteOrg();
  const marker = await seedMarker.get('seed');
  if (marker?.version === SEED_VERSION) return; // corpus current — nothing to do

  for (const doc of DOCS) {
    const pageId = pageIdFor(doc.slug);
    const existing = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId);
    if (!existing) {
      const page = await createPage({
        tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId,
        title: doc.title, slug: doc.slug, collection: 'docs', docsNav: doc.docsNav,
        sections: doc.sections, createdBy: SYSTEM_ACTOR,
      });
      await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, page.pageId, 'publish', SYSTEM_ACTOR);
      log.info('system_site_doc_seeded', { pageId, slug: doc.slug });
    } else if (existing.updatedBy === SYSTEM_ACTOR) {
      // Never-clobber (the systemSite rule): refresh ONLY while the page has
      // never been human-edited; a real edit freezes it forever.
      await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, {
        title: doc.title, sections: doc.sections, docsNav: doc.docsNav,
      }, SYSTEM_ACTOR);
      if (existing.status !== 'published') {
        await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, 'publish', SYSTEM_ACTOR);
      }
      log.info('system_site_doc_refreshed', { pageId, slug: doc.slug });
    }
    // human-edited → frozen; skip silently.
  }
  await seedMarker.put({ id: 'seed', version: SEED_VERSION });
  log.info('system_site_docs_seeded', { pages: DOCS.length, seedVersion: SEED_VERSION });
}

let ensuring: Promise<void> | null = null;

/** Idempotent, concurrency-collapsed boot ensure (the ensureSystemSite shape). */
export function ensureSystemSiteDocs(): Promise<void> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/** Test-only: the seeded slugs, for coverage assertions. */
export const SEEDED_DOC_SLUGS: readonly string[] = DOCS.map((d) => d.slug);
