/**
 * Tutorial: Campaign Studio — Your First Brief (ADR 0374) — the reference
 * GUIDED tutorial: a step carries `walkthroughId`, so the renderer shows a "Show me"
 * that DRIVES the app via the guided-tour player (ADR 0368). The tutorial is
 * authored data; the tour is the active layer by reference.
 */
import type { TutorialData } from '../tutorialTypes.js';

export const campaignStudioFirstBrief: TutorialData = {
  id: 'campaign-studio-first-brief',
  category: 'marketing',
  title: 'Campaign Studio: Your First Brief',
  description: 'Create a campaign brief — the container for product, persona, and channels — then turn it into a running campaign. Watch it happen, or follow along.',
  hero: { title: 'Your First Campaign Brief', subtitle: 'Read the steps, or press “Show me” and let the app drive' },
  goal: 'Learn the brief → campaign flow in Campaign Studio, with the option to watch a guided walkthrough perform each step.',
  learningObjectives: [
    'Open a new campaign brief',
    'Name and create it',
    'Find where a brief becomes a running campaign',
  ],
  prerequisites: ['Campaign Studio enabled', 'Walkthroughs enabled (for “Show me”)'],
  estimatedMinutes: 5,
  difficulty: 'beginner',
  surfaces: ['/campaign-studio'],
  phases: [
    {
      number: 1,
      chainId: 'walkthrough.campaign-studio.first-brief',
      title: 'Brief → Campaign',
      goal: 'Create your first brief and see where it becomes a campaign.',
      outcome: 'You have a brief, and you know where campaigns come from.',
      steps: [
        {
          id: '1.1',
          title: 'Create a brief, guided',
          content: [
            { type: 'callout', variant: 'info', title: 'Press “Show me”', body: 'The guided walkthrough opens a new brief, pauses for you to name it, creates it, verifies it exists, and lands on the Campaigns tab — each step spotlighted and narrated. Prefer to do it yourself? The steps below are the same flow by hand.' },
            { type: 'instructions', items: [
              { text: 'Open Campaign Studio and press “New brief”.' },
              { text: 'Name the brief (tip: start it with “[Walkthrough]” so it’s easy to find later), then Create.' },
              { text: 'Open the Campaigns tab — that’s where a confirmed brief becomes a running campaign.' },
            ] },
          ],
        },
      ],
    },
  ],
};
