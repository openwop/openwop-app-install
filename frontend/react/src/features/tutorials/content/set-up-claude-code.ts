import type { TutorialData } from '../tutorialTypes.js';

/**
 * Set Up Claude Code (ADR 0785) — pair your own Claude Code with a workspace and
 * use it from the chat. Deliberately UNBOUND: no walkthrough actions exist for the
 * `/claude-code` pages, and the binding-drift guard forbids a dangling Show-me.
 * The long-form guide is `docs/CLAUDE-CODE-SETUP.md`.
 */
export const setUpClaudeCode: TutorialData = {
  id: 'set-up-claude-code',
  category: 'build',
  title: 'Set Up Claude Code',
  description: 'Pair the Claude Code on your own machine with this workspace, then use it from a chat tab, let it work with your to-dos, and answer its permission prompts from your inbox.',
  hero: { title: 'Set Up Claude Code', subtitle: 'Your own Claude Code, one tab away from your workspace' },
  goal: 'Connect your own Claude Code to this workspace with the companion app, and learn what it can do here: a terminal tab, workspace tools, and inbox approvals.',
  learningObjectives: [
    'Pair your machine with a one-time code',
    'Run the companion in the folder you want Claude Code to work in',
    'Open Claude Code as a tab in the chat',
    'Let Claude Code read and add to-dos',
    'Answer Claude Code permission prompts from your inbox',
  ],
  prerequisites: [
    'Node.js 22 or newer',
    'Claude Code installed and signed in on your machine',
    'The Claude Code feature enabled for you by your admin',
  ],
  estimatedMinutes: 10,
  difficulty: 'intermediate',
  surfaces: ['/claude-code', '/claude-code/pair'],
  phases: [
    {
      number: 1,
      title: 'Pair your machine',
      goal: 'Give your machine a device key for this workspace.',
      outcome: 'Your machine is listed as an active device on the Claude Code page.',
      steps: [
        {
          id: '1.1',
          title: 'Check what you need',
          content: [
            { type: 'prose', text: 'Claude Code keeps running on your own machine, signed in the way you already sign it in. A small companion app connects your machine out to this workspace. It never opens a port, and your Claude credential never leaves your machine.' },
            { type: 'checklist', items: [
              { label: 'Node.js 22 or newer (node --version)' },
              { label: 'Claude Code installed and signed in (an Anthropic API key, Bedrock or Vertex is the supported sign-in)' },
              { label: 'On Linux only: a build toolchain (build-essential and python3)' },
            ] },
          ],
        },
        {
          id: '1.2',
          title: 'Start pairing',
          content: [
            { type: 'instructions', items: [
              { text: 'Open the Claude Code page and copy the pairing command. It is already filled in for this app.' },
              { text: 'Run it in a terminal on your machine. It prints an eight-character code and a link.' },
            ] },
            { type: 'code', language: 'bash', code: 'npx @openwop/agent-host pair --host https://your-app.example.com' },
            { type: 'callout', variant: 'tip', title: 'Use the command from the Claude Code page', body: 'The line above shows the shape of the command. The Claude Code page gives the exact one for this app, including any extra address it needs, so copy it from there.' },
          ],
        },
        {
          id: '1.3',
          title: 'Approve the device',
          content: [
            { type: 'instructions', items: [
              { text: 'Open the link while signed in, and type the code yourself.' },
              { text: 'Check the device name, where the request started, and which workspace it joins.' },
              { text: 'Read Before you approve, tick the box, and choose Approve device. Your terminal finishes on its own.' },
            ] },
            { type: 'callout', variant: 'warning', title: 'Never approve a code you did not start', body: 'A genuine pairing link never contains the code. If someone sends you a link with a code already filled in, deny it: they are trying to get into your workspace.' },
          ],
        },
      ],
    },
    {
      number: 2,
      title: 'Use Claude Code from the chat',
      goal: 'Run the companion and open Claude Code in a chat tab.',
      outcome: 'Claude Code answers in a tab inside the chat, working in the folder you chose.',
      steps: [
        {
          id: '2.1',
          title: 'Run the companion',
          content: [
            { type: 'prose', text: 'Start the companion in the folder you want Claude Code to work in, and keep it running. Sessions start in that folder and nowhere else, and the folder must already exist.' },
            { type: 'code', language: 'bash', code: 'npx @openwop/agent-host run --root ~/code/my-project' },
          ],
        },
        {
          id: '2.2',
          title: 'Open a Claude Code tab',
          content: [
            { type: 'instructions', items: [
              { text: 'Open the Chat, choose New tab, then Claude Code.' },
              { text: 'Pick your device and choose Start Claude Code.' },
              { text: 'Use it exactly as you would in your own terminal.' },
            ] },
            { type: 'callout', variant: 'tip', title: 'Leaving is harmless', body: 'Claude Code keeps running on your machine when you leave the chat or the tab disconnects. Come back, or choose Reconnect, and the tab catches up. Closing the tab with its X stops that session.' },
          ],
        },
      ],
    },
    {
      number: 3,
      title: 'Connect it to your work',
      goal: 'Let Claude Code use your workspace, and answer its prompts from anywhere.',
      outcome: 'Claude Code can see your to-dos, and its permission prompts reach your inbox.',
      steps: [
        {
          id: '3.1',
          title: 'Workspace tools',
          content: [
            { type: 'prose', text: 'Sessions started from the app are already connected to your workspace. Try asking Claude Code what is on your to-do list, or to add a to-do for later.' },
            { type: 'feature-grid', items: [
              { label: 'claude-code-my-todos', desc: 'Lists the to-dos on your board' },
              { label: 'claude-code-add-todo', desc: 'Adds a to-do to your board' },
              { label: 'claude-code-schema-lookup', desc: 'Looks up a workflow, node or envelope schema' },
            ] },
          ],
        },
        {
          id: '3.2',
          title: 'Approve prompts from your inbox',
          content: [
            { type: 'instructions', items: [
              { text: 'Before starting a session, tick Approve permission prompts from anywhere.' },
              { text: 'When Claude Code asks to use a tool, an Allow or Deny card appears in your Inbox. The first answer wins, the card or the terminal.' },
            ] },
            { type: 'callout', variant: 'tip', title: 'No card? Check the mode', body: 'A card only appears when Claude Code would ask you. In auto mode it does not ask, and it never asks before read-only commands such as ls. Press Shift+Tab until auto mode is off, then ask for something that changes a file.' },
            { type: 'callout', variant: 'info', title: 'Only you can answer', body: 'These cards are yours alone. Nobody else in the workspace can answer them, and a device key cannot approve its own prompts. If nobody answers within five minutes, the terminal asks you instead.' },
          ],
        },
        {
          id: '3.3',
          title: 'Manage your devices',
          content: [
            { type: 'instructions', items: [
              { text: 'The Claude Code page lists your devices, their status, and when each was last used.' },
              { text: 'Choose Revoke to cut a device off on its next request. Every pairing from the same machine has the same name, so check Paired and Last used to revoke the right one.' },
              { text: 'On the machine itself, run npx @openwop/agent-host unpair to forget the pairing there.' },
            ] },
          ],
        },
      ],
    },
  ],
};
