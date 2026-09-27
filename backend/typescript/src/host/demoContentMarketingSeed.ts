/**
 * `demo-content-marketing` seeder (app-seeding-strategy.md §4 Phase 9, ADR 0031).
 *
 * The marketing surface over the Solstice narrative: a brand kit, a 6-page CMS
 * site (with a publish transition, an A/B experiment), forms + submissions, an
 * email program (templates + campaigns + engagement), the campaign brief→campaign
 * cluster (one confirmed brief with a filled messaging kernel), and a document
 * library. `dependsOn: ['demo-crm','demo-media','demo-commerce-depth']`.
 *
 * Each sub-step is toggle-gated (brand + CMS are always-on core; forms / email /
 * campaign-brief / campaign-orchestration / documents default off) and skips
 * honestly. Deterministic ids where the service allows them → idempotent seed +
 * surgical, marker-scoped clear. Engagement rows are written through the store
 * directly (the recorders stamp server-now — the only backdating path).
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { listContacts } from '../features/crm/contactsService.js';
import { ensureBrand, listBrands, deleteBrand } from '../features/brand/brandService.js';
import { createPage, listPages, deletePage, transitionPage, setScheduledPublish } from '../features/cms/cmsService.js';
import { updateEntityType } from '../features/entities/entitiesService.js';
import { createExperiment, listExperiments } from '../features/cms/pageExperimentsService.js';
import { createForm, listForms, deleteForm, setFormStatus, recordSubmission } from '../features/forms/formsService.js';
import { createTemplate, listTemplates, deleteTemplate, createCampaign, listCampaigns, deleteCampaign } from '../features/email/emailService.js';
import { createPersona, listPersonas, deletePersona } from '../features/campaign-brief/personaService.js';
import { createBrief, listBriefs, deleteBrief, setKernel, updateBrief } from '../features/campaign-brief/briefService.js';
import { finalizeFromBrief, listCampaigns as listOrchCampaigns, deleteCampaign as deleteOrchCampaign } from '../features/campaign-orchestration/campaignService.js';
import { createDocument, listDocuments, deleteDocument, addVersion } from '../features/documents/documentsService.js';
import { mediaServeTokenByKey } from './demoMediaSeed.js';
import { demoCrmSegmentId } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoContentMarketing');
const ACTOR = 'demo:content-marketing';
const BRAND_ID = 'brand-solstice';

// ADR 0655 D7 (EMWF-8) — the SAME key shape as `engagementService.ts` (`${tenantId}::${id}`):
// keyed bare `id`, the seeded rows were invisible to `listEngagement` and the eraser.
const engagementStore = new DurableCollection<{ id: string; tenantId: string; campaignId: string; contactId: string; kind: string; at: string }>('email:engagement', (e) => `${e.tenantId}::${e.id}`, undefined, (e) => e.tenantId);
const experimentStore = new DurableCollection<{ experimentId: string; tenantId: string; pageId: string }>('cms:pageexperiment', (e) => e.experimentId, undefined, (e) => e.tenantId);

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}
async function gate(id: string, tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne(id, { tenantId }))?.enabled);
}

export async function countDemoContentMarketing(tenantId: string): Promise<number> {
  const orgId = await orgIdFor(tenantId);
  return (await listPages(tenantId, orgId)).filter((p) => p.createdBy === ACTOR).length;
}

export async function seedDemoContentMarketing(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  const nowMs = Date.now();
  let created = 0;
  const skipped: string[] = [];
  const heroToken = await mediaServeTokenByKey(tenantId, orgId, 'house-blend');
  const productIds: string[] = []; // productGrid section references; resolved below if commerce present.

  // 1) Brand kit (always-on core; idempotent fixed id).
  if (!(await listBrands(tenantId, orgId)).some((b) => b.id === BRAND_ID)) {
    await ensureBrand(tenantId, orgId, BRAND_ID, ACTOR, {
      name: 'Solstice Roasters',
      description: 'Small-batch specialty coffee, roasted to order — DTC and B2B wholesale.',
      voiceProfile: { voice: 'Warm, unpretentious, expert', guidelines: 'Lead with the coffee, not the discount. Transparent sourcing.', formalityLevel: 2, samplePhrases: ['Roasted to order', 'From origin to your cup'], avoidPhrases: ['cheap', 'bargain'], toneRegisters: ['warm', 'confident'] },
      positioning: { tagline: 'Small-batch coffee, roasted to order.', elevatorPitch: 'Solstice sources transparently and roasts to order for kitchens and cafés alike.', differentiators: ['roast-to-order freshness', 'transparent sourcing'], competitiveFrame: 'specialty coffee' },
      keyPhrases: { approvedTaglines: ['Roasted to order'], valuePropositions: ['freshness', 'consistency'], productDescriptors: ['single origin', 'small batch'], bannedPhrases: ['instant'] },
    });
    created += 1;
  }

  // Resolve a few commerce products for the Shop productGrid (best-effort).
  try {
    const { listProducts } = await import('../features/commerce/commerceService.js');
    for (const p of (await listProducts(tenantId, orgId)).filter((x) => x.createdBy === 'demo:commerce-depth').slice(0, 8)) productIds.push(p.productId);
  } catch { /* commerce optional */ }

  // 2) CMS 6-page site (always-on). Deterministic page ids; publish transitions.
  const PAGES: { slug: string; title: string; status: 'published' | 'in_review' | 'scheduled'; sections: { type: string; data: Record<string, unknown> }[] }[] = [
    { slug: 'home', title: 'Home', status: 'published', sections: [
      { type: 'hero', data: { eyebrow: 'Solstice Roasters', heading: 'Small-batch coffee, roasted to order', subheading: 'Fresh beans for your kitchen and your café.', ...(heroToken ? { imageToken: heroToken } : {}), ctaLabel: 'Shop coffee', ctaUrl: '/shop' } },
      { type: 'columns', data: { heading: 'Why Solstice', columns: [{ title: 'Roasted to order', text: 'Every bag ships days after roast.' }, { title: 'Transparent sourcing', text: 'We name the farm, not just the country.' }, { title: 'DTC & wholesale', text: 'From your kitchen to your café.' }] } },
      { type: 'cta', data: { heading: 'Ready to brew?', label: 'Start a subscription', url: '/shop' } },
    ] },
    { slug: 'shop', title: 'Shop', status: 'published', sections: productIds.length ? [{ type: 'productGrid', data: { heading: 'Our coffee', productIds, storeOrgId: orgId } }] : [{ type: 'richText', data: { heading: 'Shop', text: 'Our storefront is brewing — check back soon.' } }] },
    // ADR 0407 — the About page carries an entityList section over the
    // demo-entities `team-member` type (published + publicRead by that seeder).
    // Reference-not-copy: if the entities toggle is off or the seeder hasn't
    // run, the section resolves nothing and renders its fallback — never an
    // error, never stale data.
    { slug: 'about', title: 'About', status: 'published', sections: [
      { type: 'richText', data: { heading: 'Our story', text: 'Founded in 2016, Solstice roasts small batches to order and sources transparently.' } },
      { type: 'entityList', data: { heading: 'Meet the team', tenantId, typeName: 'team-member', titleField: 'name', bodyField: 'role', limit: 6, sortKey: 'name', sortDir: 'asc' } },
    ] },
    { slug: 'wholesale', title: 'Wholesale', status: 'in_review', sections: [{ type: 'richText', data: { heading: 'Wholesale partners', text: 'Bring Solstice to your café, hotel, or grocery. Tell us about your program.' } }, { type: 'cta', data: { heading: 'Become a partner', label: 'Wholesale inquiry', url: '/contact' } }] },
    // ADR 0408 Phase D — the convergence dividend: the blog page carries an
    // entityList over the cms.page KERNEL type itself (kind=post, newest
    // first). Resolves only when the demo tenant opts cms.page into public
    // read (below, entities-toggle-gated) — scalar titles only, never blocks.
    { slug: 'blog', title: 'Blog', status: 'published', sections: [
      { type: 'richText', data: { heading: 'The Solstice Journal', text: 'Brewing guides, origin stories, and news from the roastery.' } },
      { type: 'entityList', data: { heading: 'Latest from the journal', tenantId, typeName: 'cms.page', titleField: 'title', filterKey: 'kind', filterValue: 'post', limit: 6, sortKey: 'createdAt', sortDir: 'desc' } },
    ] },
    { slug: 'contact', title: 'Contact', status: 'scheduled', sections: [{ type: 'richText', data: { heading: 'Get in touch', text: 'Questions about an order or a wholesale program? Reach out.' } }] },
  ];
  const existingPages = new Map((await listPages(tenantId, orgId)).filter((p) => p.createdBy === ACTOR).map((p) => [p.slug, p]));
  for (const pg of PAGES) {
    if (existingPages.has(pg.slug)) continue;
    const page = await createPage({ tenantId, orgId, title: pg.title, slug: pg.slug, createdBy: ACTOR, sections: pg.sections });
    if (pg.status === 'published') { await transitionPage(tenantId, orgId, page.pageId, 'publish', ACTOR); }
    else if (pg.status === 'in_review') { await transitionPage(tenantId, orgId, page.pageId, 'submit', ACTOR); }
    else if (pg.status === 'scheduled') { await setScheduledPublish(tenantId, orgId, page.pageId, new Date(nowMs + 7 * 86400_000).toISOString(), ACTOR); }
    created += 1;
  }
  // ADR 0408 Phase D — opt the demo tenant's cms.page kernel type into the
  // anonymous read so the Blog page's entityList-of-posts resolves (published
  // pages' SCALARS only — blocks never leave the kernel). The ONE mutable
  // system-type flag; entities-toggle-gated, best-effort (skips honestly).
  if (Boolean((await resolveOne('entities', { tenantId }))?.enabled)) {
    try {
      await updateEntityType({ tenantId, name: 'cms.page', patch: { publicRead: true }, actor: ACTOR });
    } catch { /* entities off mid-flight or type unminted — the section falls back */ }
  }
  // A/B experiment on Home (2 variants — treatment version + holdout).
  const homePage = (await listPages(tenantId, orgId)).find((p) => p.createdBy === ACTOR && p.slug === 'home');
  if (homePage && (await listExperiments(tenantId, orgId, homePage.pageId)).length === 0) {
    await createExperiment({ tenantId, orgId, pageId: homePage.pageId, name: 'Home hero A/B', createdBy: ACTOR, variants: [{ name: 'Control', versionId: homePage.publishedVersion ? `${homePage.pageId}:${homePage.publishedVersion}` : null, weight: 50 }, { name: 'Holdout', versionId: null, weight: 50 }] }).catch(() => undefined);
  }

  // 3) Forms + submissions (gated on forms).
  if (await gate('forms', tenantId)) {
    const FORMS: { title: string; createToContact: boolean; fields: { key: string; label: string; type: string; required: boolean; options?: string[] }[] }[] = [
      { title: 'Contact Us', createToContact: false, fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'email', label: 'Email', type: 'email', required: true }, { key: 'message', label: 'Message', type: 'textarea', required: true }] },
      { title: 'Wholesale Inquiry', createToContact: true, fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'email', label: 'Email', type: 'email', required: true }, { key: 'company', label: 'Company', type: 'text', required: true }] },
      { title: 'Newsletter Signup', createToContact: false, fields: [{ key: 'email', label: 'Email', type: 'email', required: true }] },
      { title: 'Support Request', createToContact: false, fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'email', label: 'Email', type: 'email', required: true }, { key: 'topic', label: 'Topic', type: 'select', required: true, options: ['Order', 'Subscription', 'Wholesale', 'Other'] }] },
    ];
    const existingForms = new Map((await listForms(tenantId, orgId)).filter((f) => f.createdBy === ACTOR).map((f) => [f.title, f]));
    const sources = ['google', 'newsletter', 'instagram', 'partner'];
    for (const [fi, f] of FORMS.entries()) {
      let form = existingForms.get(f.title);
      if (!form) {
        form = await createForm({ tenantId, orgId, title: f.title, fields: f.fields, createToContact: f.createToContact, createdBy: ACTOR });
        await setFormStatus(tenantId, orgId, form.formId, 'published');
        created += 1;
        // ~5 submissions per form with UTM tags. The Wholesale form has
        // `createToContact: true` — it demonstrates the OPTIONAL crm-contact
        // sink (ADR 0330): contacts appear only when the demo tenant's `crm`
        // toggle is on (demoProvision enables it), never as a forms-side write.
        for (let s = 0; s < 5; s += 1) {
          const values: Record<string, string> = { name: `Lead ${fi}-${s}`, email: `lead${fi}${s}@example.com`, message: 'Interested in your coffee.', company: `Café ${fi}-${s}`, topic: 'Order' };
          await recordSubmission(form, values, { utm: { source: sources[s % sources.length]!, medium: 'form', campaign: 'fy26-launch' } }).catch(() => undefined);
        }
      }
    }
  } else skipped.push('forms');

  // 4) Email — templates + campaigns targeting Phase-3 segments; engagement rows.
  if (await gate('email', tenantId)) {
    const TEMPLATES = [
      { slug: 'welcome', name: 'Welcome', subject: 'Welcome to Solstice, {{contact.name}}', body: 'Hi {{contact.name}}, welcome! Your first bag ships roasted to order.' },
      { slug: 'winback', name: 'Win-back', subject: 'We miss you, {{contact.name}}', body: 'It’s been a while — here’s 15% off your next order at {{contact.company}}.' },
      { slug: 'newsletter', name: 'Monthly Newsletter', subject: 'This month at Solstice', body: 'New single origins, brewing tips, and wholesale news.' },
      { slug: 'wholesale-followup', name: 'Wholesale Follow-up', subject: 'Your wholesale program, {{contact.company}}', body: 'Thanks for your interest — here’s our wholesale price list.' },
      { slug: 'subscription', name: 'Subscription Reminder', subject: 'Your next Solstice box', body: 'Your subscription ships soon, {{contact.name}}.' },
      { slug: 'holiday', name: 'Holiday Blend', subject: 'The Winter Solstice Blend is here', body: 'Seasonal and small-batch — 25% off this week.' },
      { slug: 'restock', name: 'Back in Stock', subject: 'Espresso Blend is back', body: 'Your favorite is restocked, {{contact.name}}.' },
      { slug: 'review', name: 'Review Request', subject: 'How’s your coffee?', body: 'Tell us what you think, {{contact.name}}.' },
    ];
    const existingTpls = new Map((await listTemplates(tenantId, orgId)).filter((t) => t.createdBy === ACTOR).map((t) => [t.name, t]));
    const tplIdBySlug = new Map<string, string>();
    for (const t of TEMPLATES) {
      const found = existingTpls.get(t.name);
      const tpl = found ?? await createTemplate({ tenantId, orgId, name: t.name, subject: t.subject, body: t.body, format: 'markdown', createdBy: ACTOR, templateId: `tpl:demo-cm-${t.slug}` });
      tplIdBySlug.set(t.slug, tpl.templateId);
      if (!found) created += 1;
    }
    const CAMPAIGNS: { slug: string; tpl: string; segment?: string; stage?: string; sent?: boolean }[] = [
      { slug: 'welcome', tpl: 'welcome', stage: 'lead' },
      { slug: 'winback', tpl: 'winback', segment: 'churn-risk', sent: true },
      { slug: 'newsletter', tpl: 'newsletter', segment: 'cafe-accounts', sent: true },
      { slug: 'wholesale', tpl: 'wholesale-followup', segment: 'high-value-wholesale' },
      { slug: 'holiday', tpl: 'holiday', segment: 'west-territory' },
      { slug: 'restock', tpl: 'restock', stage: 'customer' },
    ];
    const existingCampaigns = new Set((await listCampaigns(tenantId, orgId)).filter((c) => c.createdBy === ACTOR).map((c) => c.campaignId));
    const contacts = (await listContacts(tenantId)).filter((c) => c.contactId.startsWith('crm:demo-crm-')).map((c) => c.contactId);
    for (const c of CAMPAIGNS) {
      const campaignId = `cmp:demo-cm-${c.slug}`;
      if (existingCampaigns.has(campaignId)) continue;
      await createCampaign({ tenantId, orgId, templateId: tplIdBySlug.get(c.tpl)!, ...(c.segment ? { segmentId: demoCrmSegmentId(tenantId, c.segment) } : { stage: c.stage as 'lead' | 'customer' }), createdBy: ACTOR, campaignId });
      created += 1;
      // "Sent" campaigns get backdated engagement so open/click surfaces + CDP
      // trait windows are non-empty (recorders stamp now — direct store is the
      // only backdating path).
      if (c.sent && contacts.length) {
        for (let e = 0; e < 20; e += 1) {
          const kind = e % 3 === 0 ? 'clicked' : e % 5 === 0 ? 'unsubscribed' : 'opened';
          await engagementStore.put({ id: `demo-cm-${c.slug}-${e}`, tenantId, campaignId, contactId: contacts[e % contacts.length]!, kind, at: new Date(nowMs - (e % 30) * 86400_000).toISOString() });
        }
      }
    }
  } else skipped.push('email');

  // 5) Campaign cluster — personas + briefs (one confirmed with a kernel) + campaigns.
  if ((await gate('campaign-brief', tenantId))) {
    const existingPersonas = new Map((await listPersonas(tenantId, orgId)).filter((p) => p.createdBy === ACTOR).map((p) => [p.name, p.id]));
    const PERSONAS = [
      { name: 'DTC Home Brewer', role: 'Home coffee enthusiast', buyerStage: 'solution_aware' as const },
      { name: 'Café Owner', role: 'Independent café operator', buyerStage: 'product_aware' as const },
      { name: 'Hotel F&B Director', role: 'Hospitality beverage lead', buyerStage: 'problem_aware' as const },
      { name: 'Grocery Buyer', role: 'Retail category manager', buyerStage: 'product_aware' as const },
    ];
    const personaIds: string[] = [];
    for (const p of PERSONAS) {
      const id = existingPersonas.get(p.name) ?? (await createPersona(tenantId, orgId, ACTOR, { name: p.name, role: p.role, buyerStage: p.buyerStage, painPoints: ['freshness', 'consistency'], objections: ['price'], goals: ['reliable supply'], demographics: {}, brandId: BRAND_ID })).id;
      personaIds.push(id);
      if (!existingPersonas.has(p.name)) created += 1;
    }
    const existingBriefs = new Map((await listBriefs(tenantId, orgId)).filter((b) => b.createdBy === ACTOR).map((b) => [b.name, b]));
    const BRIEFS = [
      { name: 'FY26 Wholesale Launch', confirm: true },
      { name: 'Holiday DTC Push', confirm: false },
      { name: 'Subscription Growth', confirm: false },
    ];
    const orchestrateOn = await gate('campaign-orchestration', tenantId);
    for (const b of BRIEFS) {
      if (existingBriefs.has(b.name)) continue;
      const brief = await createBrief(tenantId, orgId, ACTOR, { name: b.name, objective: 'Grow wholesale and DTC revenue', brandId: BRAND_ID, personaIds, productName: 'Solstice House Blend', productDescription: 'Signature medium roast', channels: ['landing_page', 'email_sequence'], messaging: { primaryValueProp: 'Roasted to order', proofPoints: ['transparent sourcing'], ctaStrategy: 'Start a subscription' } });
      created += 1;
      if (b.confirm) {
        await setKernel(tenantId, brief.id, { headline: 'Small-batch coffee for your café', supportingStatement: 'Roasted to order, delivered fresh.', proofPoints: ['transparent sourcing', 'consistent quality'], primaryCta: 'Become a wholesale partner', secondaryCta: 'Request samples', tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: new Date(nowMs).toISOString() }, ACTOR);
        await updateBrief(tenantId, brief.id, { status: 'confirmed' }, ACTOR);
        if (orchestrateOn) {
          const confirmed = (await listBriefs(tenantId, orgId)).find((x) => x.id === brief.id);
          if (confirmed) { await finalizeFromBrief(tenantId, confirmed, ACTOR); created += 1; }
        }
      }
    }
  } else skipped.push('campaign-brief');

  // 6) Documents — 12 across kinds/formats/statuses with a version each.
  if (await gate('documents', tenantId)) {
    const DOCS: { slug: string; title: string; kind: string; format: string; status: 'draft' | 'in-review' | 'approved' | 'final' }[] = [
      { slug: 'sow-harborview', title: 'SOW — Harborview Hotels coffee program', kind: 'sow', format: 'markdown', status: 'final' },
      { slug: 'prd-subscription', title: 'PRD — Subscription box v2', kind: 'prd', format: 'markdown', status: 'in-review' },
      { slug: 'board-agenda-q3', title: 'Board agenda — Q3', kind: 'board-agenda', format: 'markdown', status: 'approved' },
      { slug: 'board-update-q3', title: 'Board update — Q3 growth', kind: 'board-update', format: 'markdown', status: 'draft' },
      { slug: 'wholesale-onepager', title: 'Wholesale one-pager', kind: 'doc', format: 'pdf', status: 'final' },
      { slug: 'brand-guidelines', title: 'Brand guidelines', kind: 'doc', format: 'pdf', status: 'approved' },
      { slug: 'sourcing-report', title: 'Green coffee sourcing report', kind: 'status-report', format: 'markdown', status: 'final' },
      { slug: 'q3-status', title: 'Q3 status report', kind: 'status-report', format: 'markdown', status: 'in-review' },
      { slug: 'rfp-grocery', title: 'RFP response — Greenleaf Markets', kind: 'rfp', format: 'doc', status: 'draft' },
      { slug: 'epic-storefront', title: 'Epic brief — storefront revamp', kind: 'epic-brief', format: 'markdown', status: 'draft' },
      { slug: 'sow-greenleaf', title: 'SOW — Greenleaf private label', kind: 'sow', format: 'markdown', status: 'approved' },
      { slug: 'onboarding-runbook', title: 'Wholesale onboarding runbook', kind: 'doc', format: 'markdown', status: 'final' },
    ];
    const existingDocs = new Set((await listDocuments(tenantId, orgId)).filter((d) => d.createdBy === ACTOR).map((d) => d.documentId));
    for (const d of DOCS) {
      const documentId = `doc:demo-cm-${d.slug}`;
      if (existingDocs.has(documentId)) continue;
      await createDocument({ tenantId, orgId, title: d.title, kind: d.kind, format: d.format, createdBy: ACTOR, documentId, provenance: { producedBy: { kind: 'user', id: ACTOR } } });
      await addVersion(tenantId, orgId, documentId, { content: `# ${d.title}\n\nDraft content for the ${d.kind}.`, producedBy: { kind: 'user', id: ACTOR } }).catch(() => undefined);
      created += 1;
    }
  } else skipped.push('documents');

  log.info('demo_content_marketing_seeded', { tenantId, created, skipped });
  return { created, details: { pages: PAGES.length, skipped } };
}

export async function clearDemoContentMarketing(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  let cleared = 0;
  // Documents.
  for (const d of (await listDocuments(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { if (await deleteDocument(tenantId, orgId, d.documentId)) cleared += 1; }
  // Campaign cluster (orchestration → briefs → personas).
  for (const c of (await listOrchCampaigns(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { if (await deleteOrchCampaign(tenantId, c.id)) cleared += 1; }
  for (const b of (await listBriefs(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { if (await deleteBrief(tenantId, b.id)) cleared += 1; }
  for (const p of (await listPersonas(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { if (await deletePersona(tenantId, p.id)) cleared += 1; }
  // Email (campaigns + engagement + templates).
  const demoCampaignIds = new Set<string>();
  for (const c of (await listCampaigns(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { demoCampaignIds.add(c.campaignId); if (await deleteCampaign(tenantId, orgId, c.campaignId)) cleared += 1; }
  for (const e of (await engagementStore.listForTenantIndexed(tenantId)).filter((x) => x.id.startsWith('demo-cm-'))) { await engagementStore.delete(e.id); }
  for (const t of (await listTemplates(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { if (await deleteTemplate(tenantId, orgId, t.templateId)) cleared += 1; }
  // Forms.
  for (const f of (await listForms(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { if (await deleteForm(tenantId, orgId, f.formId)) cleared += 1; }
  // CMS experiments (no per-row delete API → direct store, scoped to demo pages)
  // then pages.
  const demoPageIds = new Set((await listPages(tenantId, orgId)).filter((x) => x.createdBy === ACTOR).map((p) => p.pageId));
  for (const e of (await experimentStore.listForTenantIndexed(tenantId)).filter((x) => demoPageIds.has(x.pageId))) { await experimentStore.delete(e.experimentId); }
  for (const p of (await listPages(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { if (await deletePage(tenantId, orgId, p.pageId)) cleared += 1; }
  // Brand.
  for (const b of (await listBrands(tenantId, orgId)).filter((x) => x.createdBy === ACTOR)) { if (await deleteBrand(tenantId, b.id)) cleared += 1; }

  log.info('demo_content_marketing_cleared', { tenantId, cleared });
  return { cleared };
}
