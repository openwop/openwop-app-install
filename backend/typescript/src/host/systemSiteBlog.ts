/**
 * System-site blog seed (ADR 0813). Seeds the deployment's launch post,
 * "10x Your Company = Your Team + AI Agents", as a DRAFT blog post (`kind:'post'`)
 * on the reserved system-site org, so it appears in the CMS for an operator to
 * finish (the `[TODO: …]` markers) and publish. It is never auto-published.
 *
 * The `systemSiteDocs.ts` sibling pattern: a deterministic page id, a
 * SEED_VERSION whose bump refreshes on redeploy, and the never-clobber rule. It
 * refreshes ONLY while the page is still system-authored AND unpublished. After
 * a human edit or a publish, a bump no longer writes the page: it offers the new
 * content as a `'seed'` version in the post's history, which the editor can
 * compare and Restore into the draft (ADR 0817).
 *
 * The two diagrams are PNG media rows on the system-site tenant (the system
 * site has no Media library UI, so its images are referenced by serve token,
 * like the front page's). The second diagram is also the post's social card.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { createPage, getPage, offerSeedVersion, updatePage, type Section } from '../features/cms/cmsService.js';
import { putSeo } from '../features/publishing/publishingService.js';
import { assertOrgCapacity, createAsset, listAssets } from '../features/media/mediaService.js';
import * as mediaStorage from '../features/media/mediaStorage.js';
import { ensureSystemSiteOrg, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from './systemSite.js';
import { ASSUMED_MODEL_PNG_BASE64, REAL_MODEL_PNG_BASE64 } from './seed-data/blog/launchPostDiagrams.js';

const log = createLogger('host.systemSiteBlog');

const SYSTEM_ACTOR = 'system';
/** Who the editor's history names for a seeded update it offers (ADR 0817). */
const SEED_ACTOR_LABEL = 'system (seeded update)';
/** Marks the media rows this seed owns (idempotency by name + this actor). */
const BLOG_MEDIA_ACTOR = 'system:blog-seed';
/** Bump when the post below changes — a redeploy refreshes it while it is still
 *  an untouched, unpublished system draft. */
const SEED_VERSION = 2;

export const LAUNCH_POST_SLUG = '10x-your-company-your-team-plus-ai-agents';
export const LAUNCH_POST_PAGE_ID = `page:host-site-blog-${LAUNCH_POST_SLUG}`;
const TITLE = '10x Your Company = Your Team + AI Agents';
const META_DESCRIPTION = 'Everyone told me AI agents would let one person run a company. After testing it on real work, I think that picture is wrong. The work happens at the handoffs.';

const DIAGRAMS = {
  assumed: { name: 'Blog: the assumed one-person agent model.png', base64: ASSUMED_MODEL_PNG_BASE64 },
  real: { name: 'Blog: the real multi-person, multi-agent model.png', base64: REAL_MODEL_PNG_BASE64 },
} as const;
type DiagramTokens = Record<keyof typeof DIAGRAMS, string>;

const rt = (id: string, heading: string, text: string): Section =>
  ({ sectionId: id, type: 'richText', data: heading ? { heading, text } : { text } }) as Section;

/** The post body. Prose uses the ADR 0813 block grammar (lists, `###`). */
function postSections(tokens: DiagramTokens): Section[] {
  return [
  rt("s01", "The story we were sold", "Everyone told me AI agents would let one person run a company. After building OpenWOP and testing it on real work, I think that picture is wrong.\n\nSam Altman has said tech CEOs keep a betting pool on the first year there will be a one-person billion-dollar company ([Fortune](https://fortune.com/2024/02/04/sam-altman-one-person-unicorn-silicon-valley-founder-myth/)).\n\nThe story goes like this. One person describes what they want. An orchestrator agent splits the work across a team of sub-agents. The campaign launches. The app ships.\n\nParts of it are true. Agents now write working code and draft campaigns in minutes.\n\nBut when we put real company work through it, it broke somewhere nobody was looking.\n\n**The tasks were fine. Everything between the tasks was not.**"),
  rt("s02", "How I got here", "`[TODO: when and why you started OpenWOP, one or two sentences of personal context.]`\n\nWhen I started building OpenWOP, I believed the same story: one operator, a fleet of agents. I thought the hard problems were inside the agent loop, like planning, tool use, and recovering from errors.\n\nThen we ran proofs of concept on real work: software features, marketing campaigns, `[TODO: other PoCs]`. Every one involved more than one person.\n\n- A product manager had an opinion about scope.\n- A designer spotted something the PRD missed.\n- An engineer knew why the obvious approach would break in production.\n- A marketer needed legal to approve a claim.\n\nThe agents did their part. Everything around them kept breaking. A question an agent raised sat unanswered for a day. A decision made in a side conversation never reached the agent building the feature. Two people approved two different versions of the same thing.\n\n`[TODO: one specific story from a PoC where a handoff failed. This is the most important anecdote in the post.]`\n\nThat's when I stopped thinking of agent orchestration as a one-person problem."),
  rt("s03", "1000 micro interactions", "I call what I saw \"1000 micro interactions.\" Any real piece of work, whether it's a feature, a campaign, or a quarterly close, moves through thousands of small exchanges:\n\n- **Human to human:** \"Is this in scope?\" \"Legal says we can't say that.\"\n- **Human to agent:** \"Use the new pricing.\" \"No, the other layout.\"\n- **Agent to human:** \"I found two ways to do this. Which one?\"\n- **Agent to agent:** a research agent passing findings to a writing agent, which passes a draft to a review agent.\n\nEach one is small. Each one changes the work a little. Added up, they *are* the work.\n\nThis changes what a feature is. We usually treat it as a fixed object moving through stages: spec, build, test, ship.\n\nIn practice, a feature is a shared understanding that gets rebuilt every time someone touches it. The spec on day one and the code on day ten describe two different things. The gap between them is made of micro interactions.\n\nToday's agent tools orchestrate the stages and the artifacts: tickets, specs, pull requests. They don't capture the interactions. So three things go wrong:\n\n1. **They lose the why.** The code says what was built. Nothing records why it changed from the plan.\n2. **Decisions happen where no one can see them.** An agent makes a judgment call on an edge case, and nobody who owns that call ever hears about it.\n3. **They can't tell intentional change from drift.** If the code doesn't match the spec, was that a decision or a mistake? Without a record of the interactions, there's no way to know."),
  rt("s04", "Two pictures of the same work", "The first picture is the one most agent platforms are built for. Work goes in one end and comes out the other, and only one person touches it."),
  { sectionId: "s05", type: 'image', data: { token: tokens.assumed, alt: "Diagram: one person sends a request to an orchestrator agent, which fans out to research, build, test and deploy agents; the shipped result goes back to the one person.", caption: "The assumed model: one person, one orchestrator, a fan of sub-agents." } },
  rt("s06", "", "The second picture is what I actually saw. Several people and several agents all shape the work, and they stay aligned through one shared channel and one shared record."),
  { sectionId: "s07", type: 'image', data: { token: tokens.real, alt: "Diagram: product, UX, engineering and marketing people and research, build, review and content agents all connect to a shared channel and an intent ledger, with handoffs between neighbors in both directions.", caption: "The real model: many people, many agents, one channel, one record." } },
  rt("s08", "", "The difference isn't the number of agents. It's that in the second picture, the connections between participants are part of the system instead of happening outside it."),
  rt("s09", "Where failure actually happens", "**Most failures happen between people and agents, at the handoffs. Not inside any single task.**\n\nThe research backs this up. UC Berkeley researchers studied 1,642 runs of seven popular multi-agent systems. Depending on the system, 41% to 87% of runs failed ([Cemri et al., 2025](https://arxiv.org/html/2503.13657v3)).\n\nMost of the failures weren't about skill. About 44% came from unclear specs and design. About 32% came from agents misaligned with each other: ignoring input, holding back information, drifting off task, or not asking for clarification.\n\nThey're the same failures human teams have. Just faster.\n\nThe journalist Evan Ratliff saw this first hand when he staffed a startup almost entirely with agents. The agents assigned tasks to a human intern and then forgot about them. A joke about an offsite turned into more than 150 messages before he stepped in ([R&D World](https://www.rdworldonline.com/a-journalist-created-a-startup-run-almost-entirely-by-ai-agents/)). Each agent did what it was told. Nobody was keeping the whole picture straight.\n\nMore automation can make this worse. Speed up the tasks without capturing the handoffs, and you go faster while understanding less of what you're building.\n\nThe industry numbers point the same way. Gartner expects over 40% of agentic AI projects to be cancelled by the end of 2027, citing cost, unclear value, and weak risk controls ([Outlook Business on Gartner](https://www.outlookbusiness.com/artificial-intelligence/over-40-of-agentic-ai-projects-will-be-scrapped-by-2027-says-gartner)). MIT researchers found 95% of companies got no return from their generative AI pilots, mostly because the tools didn't adapt to how people actually work ([Fortune](https://fortune.com/2025/08/18/mit-report-95-percent-generative-ai-pilots-at-companies-failing-cfo/))."),
  rt("s10", "From a pipeline to a loop", "If the work lives in the interactions, orchestration has to capture them. That means giving up the pipeline (spec, build, test, ship) for a continuous loop built around one shared record.\n\nI think of that record as an **intent ledger**: a living account of what the feature is right now, why it's that way, and what changed. It works by three rules:\n\n1. **Read before you act.** Every participant, human or agent, starts from the current ledger, not from a stale ticket.\n2. **Write back what changed.** Every decision, correction, and judgment call goes back into the ledger as a small update.\n3. **Hand off with structure.** When work passes to someone else, it carries five things: the intent, the decisions made, the open questions, what was tried, and how confident the sender is.\n\nAround that loop, the orchestrator does four jobs:\n\n- It listens to the places where decisions actually happen, like chat threads and meetings, and records them.\n- It flags drift when the work moves away from the recorded intent.\n- It sends an agent's judgment calls to the person who owns that decision.\n- It calls a re-sync checkpoint when enough change has piled up that people need to realign.\n\nThe shift fits in one line: **orchestration's job moves from routing tasks efficiently to keeping everyone's understanding of the work coherent as it changes.**\n\nNot all of this exists yet. Later in this post I separate what OpenWOP does today from what we're still building."),
  rt("s11", "Where it shows up", "The same pattern shows up wherever agents meet real teams. Here are three places we've seen it.\n\n### Software development: working code is the second artifact\n\n**The assumption:** describe an app, and agents plan, build, test, and deploy it.\n\n**What we found:** the biggest gains came from moving development to the very front of the process.\n\n**The first artifact is the PRD. The second is working code.** From there, we iterate on live software instead of documents.\n\nThat changes the meetings. Planning meetings are gone. In their place are working sessions where product, UX, and engineering sit with the running code and answer the questions the agents raise. Should this field be required? What happens when the payment fails? Is this the layout we meant?\n\nEach answer is a micro interaction, and each one reshapes the feature. When everyone answers quickly and in the same place, the cycle from question to new version takes minutes. When answers wait for the next meeting, you're back to the old speed with extra steps.\n\n`[TODO: one concrete example of a feature from a PoC, with rough timings before and after.]`\n\n**OpenWOP's part:** agents ask their questions in the team channel, and the right person answers there. Each question pauses the agent's work until someone answers, so the agent waits instead of guessing.\n\n### Marketing: the campaign changes after every review\n\n**The assumption:** give an agent a goal and a budget, and it researches the audience, writes the copy, makes the assets, and launches.\n\n**What actually happens:** a campaign passes through brand, product marketing, legal, sales, and whoever owns the budget. Legal strikes a claim. Sales wants a different offer. The product team changes a launch date. Each change has to reach every agent working on every asset, or you launch three versions of the same message.\n\n**OpenWOP's part:** an approval can require several reviewers, and the record shows who signed off on what. A change made in the channel reaches the agents producing the assets. `[TODO: an example from a marketing PoC.]`\n\n### IT and customer service: knowing when to hand off\n\nThese are the two most common places companies use agents today. IDC found 60% of enterprises investing in agents for IT, the most of any function ([IDC](https://www.idc.com/wp-content/uploads/2026/04/IDC-Directions-Agent-Economy-Perilli.pdf)). Customer service tops LangChain's survey of agent builders ([LangChain](https://langchain.com/state-of-agent-engineering)).\n\nBoth hit the same wall. Routine cases are easy. The hard ones touch access rights, a production system, a refund over the limit, or an angry customer. The agent has to recognize the decision isn't its to make, hand it to the right person with enough context to act, and pick up again after.\n\nWhen that handoff is clumsy, the customer feels it. They have to explain everything again.\n\n**OpenWOP's part:** when the coordinating agent isn't confident about a decision, the protocol requires it to stop and ask a person. Whoever picks up the case sees the full history of what the agent tried and why. In the app, those requests show up in Slack or the team channel, where people already work."),
  rt("s12", "The 10x condition", "**Any company can 10x its output with agents. But only if the humans in the loop stay heavily engaged.**\n\nThat's the opposite of the usual pitch, which says agents free people from the work.\n\nWhat I've seen is that agents speed up the work so much that people become the bottleneck. An agent can build a working prototype in an hour. If its first question waits two days for an answer, you've gained nothing.\n\nSpeed isn't automatic, either. In a 2025 study, experienced developers using AI were 19% slower, while believing they were 20% faster ([METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)). Newer tools have likely changed that result ([METR](https://metr.org/blog/2026-02-24-uplift-update/)), but the lesson holds: feeling fast and being fast are different things.\n\nThe biggest single change we made was putting everyone in one shared channel: product, design, engineering, marketing, and the agents. When an agent hits a decision it shouldn't make alone, the question shows up there, where the right person sees it in minutes. The answer goes back to the agent and into the record at the same time.\n\nThree things have to be true:\n\n1. **Decisions surface fast.** Agents raise questions where people already are, not in a queue nobody checks.\n2. **People answer fast.** The team treats agent questions like a teammate's question in standup, not like email.\n3. **Everyone sees the same thing.** One channel, one record, so nobody works from an old version.\n\nMiss any of the three and you get faster output that nobody understands. Get all three and the speed is real.\n\n`[TODO: any measured result from your PoCs, e.g. time from PRD to working code before and after. A real number here makes the 10x claim much stronger.]`"),
  rt("s13", "What we built: OpenWOP", "OpenWOP has two parts.\n\n**The protocol** is an open protocol for workflows where agents and people work together. It treats a human decision as a step in the workflow, not something that happens on the side. Because it's open, your agents, tools, and approval steps can come from different vendors and still share one record of who decided what.\n\n**The app**, at app.openwop.dev, is where teams use it day to day:\n\n- **Shared channels with agents in them.** @mention an agent to bring it in. Its questions come back to the same channel.\n- **Decisions where you already work.** Approval requests show up as cards in chat, and replies from Slack, Discord, or Telegram can answer them.\n- **Approvals with more than one person.** The record shows who signed off and when.\n- **A full history of every run.** See what each agent did, what it handed to whom, and where each output came from.\n- **A mission contract for each agent task.** Its goal, which tools it may use, and what success looks like, checked against what it actually did.\n- **Ready-made workflows** for marketing campaigns, approvals, finance, IT, people operations, and meetings, plus agents for code review, testing, and DevOps.\n\nAny company can build its own implementation of the protocol. Today all three certified implementations are ours. The next milestone is an independent one, and if you build agent infrastructure, we'd like it to be yours.\n\n### What's next\n\nSome of what I described isn't built yet. These items are on our public roadmap:\n\n- **Structured handoffs:** every handoff carries the intent, decisions, open questions, what was tried, and a confidence level.\n- **A shared intent ledger** for a whole feature or campaign, not just one agent task.\n- **Drift detection:** a flag when the work moves away from what the team agreed.\n- **Decisions captured from chat and meetings,** confirmed by a person before they're recorded."),
  rt("s14", "The work happens between us", "The one-person AI company was a useful picture for showing what agents can do. It was the wrong picture for how companies work.\n\nCompanies are groups of people trying to stay in agreement about what they're building while it keeps changing. Agents don't remove that problem. They make it faster and louder.\n\nThe teams that win won't be the ones with the most agents. They'll be the ones whose people and agents stay on the same page through a thousand small decisions.\n\n**That's the job of orchestration now. Not routing tasks. Keeping everyone's understanding of the work in sync as it changes.**"),
  { sectionId: "s15", type: 'cta', data: { heading: "Try it on one real workflow", subheading: "It's free to sign up, and team channels with agents are included. Pick something your team already does: a feature, a campaign, a weekly report. Put the people and the agents in one channel, and watch where the questions come from.", label: "Open app.openwop.dev", url: "/" } },
  rt("s16", "", "**Building agent infrastructure?** The protocol is open, and you can read it at [openwop.dev](https://openwop.dev). We're looking for the first independent implementation.\n\nI'd like to hear from you: where do handoffs break down on your team? Between people, between agents, or between the two?"),
  ] as Section[];
}

/** Store each diagram once (idempotent by name + the seed's actor marker). */
async function ensureDiagramTokens(): Promise<DiagramTokens> {
  const existing = (await listAssets(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG))
    .filter((a) => a.uploadedBy === BLOG_MEDIA_ACTOR);
  const out: Partial<DiagramTokens> = {};
  for (const [key, d] of Object.entries(DIAGRAMS) as Array<[keyof typeof DIAGRAMS, (typeof DIAGRAMS)[keyof typeof DIAGRAMS]]>) {
    const hit = existing.find((a) => a.name === d.name);
    if (hit) { out[key] = hit.serveToken; continue; }
    const contentType = 'image/png';
    await assertOrgCapacity(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, Buffer.byteLength(d.base64, 'base64'));
    const stored = await mediaStorage.put(SYSTEM_SITE_TENANT, { contentBase64: d.base64, contentType });
    await createAsset({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG,
      name: d.name, contentType, sizeBytes: stored.sizeBytes,
      storageRef: stored.storageRef, serveToken: stored.serveToken,
      tags: [BLOG_MEDIA_ACTOR], uploadedBy: BLOG_MEDIA_ACTOR,
    });
    out[key] = stored.serveToken;
  }
  return out as DiagramTokens;
}

const seedMarker = new DurableCollection<{ id: string; version: number }>('systemsite:blog-seed', (r) => r.id);

async function doEnsure(): Promise<void> {
  await ensureSystemSiteOrg();
  const marker = await seedMarker.get('seed');
  if (marker?.version === SEED_VERSION) return; // post current — nothing to do

  const existing = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID);
  const tokens = await ensureDiagramTokens();
  const sections = postSections(tokens);
  if (existing && (existing.updatedBy !== SYSTEM_ACTOR || existing.status === 'published')) {
    // Never-clobber: a human edit or a publish freezes the post. ADR 0817: the
    // newer seed is OFFERED instead, as a version in the post's history that
    // the editor can compare and Restore into the draft.
    await offerSeedVersion(existing, { title: TITLE, sections }, SEED_ACTOR_LABEL);
    log.info('system_site_blog_post_update_offered', { pageId: LAUNCH_POST_PAGE_ID, seedVersion: SEED_VERSION });
    await seedMarker.put({ id: 'seed', version: SEED_VERSION });
    return;
  }
  if (!existing) {
    await createPage({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId: LAUNCH_POST_PAGE_ID,
      title: TITLE, slug: LAUNCH_POST_SLUG, kind: 'post', category: 'orchestration',
      tags: ['ai-agents', 'multi-agent', 'workflow-orchestration', 'openwop'],
      sections, createdBy: SYSTEM_ACTOR,
    });
    log.info('system_site_blog_post_seeded', { pageId: LAUNCH_POST_PAGE_ID });
  } else {
    await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID, { title: TITLE, sections }, SYSTEM_ACTOR);
    log.info('system_site_blog_post_refreshed', { pageId: LAUNCH_POST_PAGE_ID });
  }
  await putSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID, SYSTEM_ACTOR, {
    metaDescription: META_DESCRIPTION, ogImageToken: tokens.real,
  });
  await seedMarker.put({ id: 'seed', version: SEED_VERSION });
}

let ensuring: Promise<void> | null = null;

/** Idempotent, concurrency-collapsed boot ensure (the ensureSystemSiteDocs shape). */
export function ensureSystemSiteBlog(): Promise<void> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/** Test-only: forget the in-process ensure so a test can re-run it. */
export function __resetSystemSiteBlogEnsure(): void { ensuring = null; }
