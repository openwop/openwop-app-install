/**
 * ADR 0147 — the unified composer mic gating matrix.
 * none / send-only / live-only / both, plus the two active hot states (a live
 * conversation and a recording clip). Breaks it: a mic offered to a model that
 * cannot take audio, a menu that stays clickable mid-turn, a hot state whose
 * stop button lost its label/pressed state, or a menu item that does nothing.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Control the recorder capability per-test.
const recorderState = { isSupported: true, isRecording: false };
vi.mock('../hooks/useAudioRecorder.js', () => ({
  useAudioRecorder: () => ({
    isSupported: recorderState.isSupported,
    isRecording: recorderState.isRecording,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  }),
  blobToBase64: vi.fn(),
}));
// i18n: echo the key so assertions don't depend on a locale being loaded.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// ChatInput's mount-time readers — the pickers' directories and the workflow
// mention cache — are not under test here; mock them so nothing fetches.
vi.mock('../AgentMentionAutocomplete.js', () => ({ AgentMentionAutocomplete: () => null }));
vi.mock('../SlashAutocomplete.js', () => ({ SlashAutocomplete: () => null }));
vi.mock('../BoardMentionAutocomplete.js', () => ({ BoardMentionAutocomplete: () => null }));
vi.mock('../lib/workflowMentions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
}));

import { ChatInput } from '../ChatInput.js';

const mic = (c: HTMLElement) => c.querySelector('.chatinput-mic-btn');
const baseProps = { onSend: vi.fn() };

beforeEach(() => { recorderState.isSupported = true; recorderState.isRecording = false; });
afterEach(cleanup);

describe('unified composer mic (ADR 0147)', () => {
  it('hides the mic when the model cannot take audio and there is no live mode', () => {
    const { container } = render(<ChatInput {...baseProps} supportsAudioInput={false} />);
    expect(mic(container)).toBeNull();
  });

  it('shows a record mic when only send-audio is available', () => {
    const { container } = render(<ChatInput {...baseProps} supportsAudioInput />);
    const btn = mic(container)!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('startVoiceRecording');
  });

  it('shows a live mic when only live conversation is available', () => {
    const { container } = render(
      <ChatInput {...baseProps} supportsAudioInput={false}
        liveVoice={{ available: true, active: false, phase: 'idle', onToggle: vi.fn() }} />,
    );
    const btn = mic(container)!;
    expect(btn.getAttribute('aria-label')).toBe('voiceLiveStartAria');
  });

  it('opens a menu with both options when both are available, and the live item starts live', () => {
    const onToggle = vi.fn();
    render(
      <ChatInput {...baseProps} supportsAudioInput
        liveVoice={{ available: true, active: false, phase: 'idle', onToggle }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'voiceMenuLabel' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByText('voiceMenuLive')).toBeTruthy();
    expect(screen.getByText('voiceMenuAudio')).toBeTruthy();
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: /voiceMenuLive/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('disables the voice menu while a turn is in flight (consistent with the direct buttons)', () => {
    const { container } = render(
      <ChatInput {...baseProps} disabled supportsAudioInput
        liveVoice={{ available: true, active: false, phase: 'idle', onToggle: vi.fn() }} />,
    );
    expect((mic(container) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the clay hot mic while a live conversation is active', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <ChatInput {...baseProps} supportsAudioInput
        liveVoice={{ available: true, active: true, phase: 'listening', onToggle }} />,
    );
    const btn = mic(container)!;
    expect(btn.className).toContain('is-live');
    expect(btn.getAttribute('aria-label')).toBe('voiceLiveStopAria');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it('renders the danger hot mic while a clip is recording', () => {
    recorderState.isRecording = true;
    const { container } = render(<ChatInput {...baseProps} supportsAudioInput />);
    const btn = mic(container)!;
    expect(btn.className).toContain('is-recording');
    expect(btn.getAttribute('aria-label')).toBe('stopVoiceRecording');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});
