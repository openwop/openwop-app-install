/**
 * ADR 0768 follow-up D1 — the composer says what `@agent` will ACTUALLY do.
 * Pins the two behaviours the design's copy got wrong or hid: it is a HANDOFF
 * (routing switches, see chatSubmit.activateAgent), and with files attached the
 * mention does NOT switch agents (chatSubmit skips activation). Silent where `@`
 * means something else: channels, slash commands/workflows, `@@` boards, and
 * any `@token` that is not a known agent.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { name?: string }) => `${k}:${o?.name ?? ''}` }) }));
const ENTRIES = [{ agentId: 'a.kai', slug: 'kai', displayName: 'Kai', description: '' }] as never;

import { AgentHandoffHint } from '../AgentHandoffHint.js';

afterEach(cleanup);
const hint = (text: string, hasAttachments = false, inChannel = false) =>
  render(<AgentHandoffHint text={text} hasAttachments={hasAttachments} inChannel={inChannel} entries={ENTRIES} />).container;

describe('AgentHandoffHint (ADR 0768 D1)', () => {
  it('says it is a handoff, for a known agent anywhere in the text', () => {
    hint('draft this for @kai please');
    expect(screen.getByText('handoffHint:Kai')).toBeTruthy();
  });

  it('warns that the mention will NOT switch agents when files are attached', () => {
    hint('@kai check this', true);
    expect(screen.getByText('handoffIgnoredWithFiles:Kai')).toBeTruthy();
    expect(screen.queryByText('handoffHint:Kai')).toBeNull();
  });

  it('is silent for unknown @tokens, slash commands, @@ boards and channels', () => {
    expect(hint('email me @5pm').innerHTML).toBe('');
    expect(hint('/summarize @kai').innerHTML).toBe('');
    expect(hint('@devon /summarize this @kai').innerHTML).toBe('');
    expect(hint('@@growth-board @kai').innerHTML).toBe('');
    expect(hint('@kai hello', false, true).innerHTML).toBe('');
  });

  it('says nothing without the shell\'s entries (it never fetches its own)', () => {
    expect(render(<AgentHandoffHint text="@kai hi" hasAttachments={false} inChannel={false} entries={undefined} />).container.innerHTML).toBe('');
  });
});
