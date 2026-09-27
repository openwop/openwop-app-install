/**
 * Tutorial: Connect Your AI (ADR 0490) — getting-started walkthrough for the
 * BYOK provider setup + first conversation. Authored English content.
 */
import type { TutorialData } from '../tutorialTypes.js';

export const connectYourAi: TutorialData = {
  id: 'connect-your-ai',
  category: 'getting-started',
  title: 'Connect Your AI',
  description: 'Bring your own AI provider key, pick your models, and have your first grounded conversation with an agent.',
  hero: { title: 'Connect Your AI', subtitle: 'From a fresh workspace to your first agent conversation' },
  goal: 'Set up the AI layer everything else builds on: your own provider credential (BYOK), model selection, and the one chat that drives every AI feature in the product.',
  learningObjectives: [
    'Understand the managed free tier vs bring-your-own-key',
    'Add a provider API key on the Keys page',
    'Choose models on the Models page',
    'Start a conversation and talk to an agent',
  ],
  prerequisites: ['An API key from your AI provider (or use the managed tier to start)'],
  estimatedMinutes: 15,
  difficulty: 'beginner',
  surfaces: ['/keys', '/models'],
  phases: [
    {
      number: 1,
      title: 'Managed Tier vs Your Own Key',
      goal: 'Know which tier you are on and why BYOK matters.',
      outcome: 'You know where your AI calls run and who pays for them.',
      steps: [
        { id: '1.1', title: 'The two tiers', content: [
          { type: 'feature-grid', items: [
            { label: 'Managed tier', desc: 'Try-it-free calls through the host’s pooled key — capped, great for a first look' },
            { label: 'BYOK', desc: 'Your own provider credential — your models, your budgets, held host-side and never exposed to the browser' },
          ] },
          { type: 'callout', variant: 'info', title: 'Keys never leave the server', body: 'BYOK credentials are stored host-side and used server-to-provider. They never appear in page source, chat transcripts, or exports.' },
        ] },
      ],
    },
    {
      number: 2,
      chainId: 'tutorial.connect-your-ai.phase-2',
      title: 'Add Your Provider Key',
      goal: 'Register the credential.',
      outcome: 'The chat unlocks with your own provider.',
      steps: [
        { id: '2.1', title: 'The Keys page', content: [
          { type: 'instructions', items: [
            { text: 'Open the **Keys** page and add your provider’s API key (OpenAI, Anthropic, Google — whichever you use).' },
            { text: 'If a chat ever answers with **“this provider requires a BYOK credential”**, this page is where you fix it.' },
          ] },
        ] },
      ],
    },
    {
      number: 3,
      chainId: 'tutorial.connect-your-ai.phase-3',
      title: 'Pick Your Models',
      goal: 'Choose which model answers each turn.',
      outcome: 'Chat turns route to the model you chose.',
      steps: [
        { id: '3.1', title: 'The Models page', content: [
          { type: 'instructions', items: [
            { text: 'Open **Models** — choose which model answers chat turns, and see which models your team rates highest.' },
            { text: 'You can change the model per conversation later; this sets the default.' },
          ] },
        ] },
      ],
    },
    {
      number: 4,
      chainId: 'tutorial.connect-your-ai.phase-4',
      title: 'Your First Conversation',
      goal: 'Talk to the product.',
      outcome: 'A saved conversation with a real answer.',
      steps: [
        { id: '4.1', title: 'Say hello', content: [
          { type: 'instructions', items: [
            { text: 'Open the **Chat** tab and ask something real — conversations persist, stream live, and can run workflows.' },
            { text: 'Pick an **agent** to scope the conversation: agents bring their own tools and personas (the Funnel Architect, the Promotions Manager, your workspace’s own roster).' },
          ] },
          { type: 'callout', variant: 'tip', title: 'One chat, everywhere', body: 'Every “talk to AI” surface in the product is the SAME chat, scoped to an agent — skills you learn here apply everywhere.' },
        ] },
      ],
    },
    {
      number: 5,
      title: 'Where AI Shows Up Next',
      goal: 'See the surface area you just unlocked.',
      outcome: 'You know what to try next.',
      steps: [
        { id: '5.1', title: 'The map', content: [
          { type: 'feature-grid', items: [
            { label: 'Workflows', desc: 'AI nodes inside durable, replayable automations' },
            { label: 'Agents', desc: 'Personas with tools, schedules, and memory' },
            { label: 'Campaign Studio', desc: 'AI-generated briefs, channel content, and ads' },
            { label: 'Funnels', desc: 'The Funnel Architect proposes conversion experiments' },
          ] },
          { type: 'checklist', items: [
            { label: 'Provider key added' },
            { label: 'Default model chosen' },
            { label: 'First conversation saved' },
          ] },
        ] },
      ],
    },
  ],
};
