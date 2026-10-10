/**
 * ADR 0768 follow-up D2 — an attachment the answering model cannot read is said
 * in TEXT under the composer, not only in a hover title on a warning icon
 * (keyboard and screen-reader users never get a title).
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../AgentMentionAutocomplete.js', () => ({ AgentMentionAutocomplete: () => null }));
vi.mock('../SlashAutocomplete.js', () => ({ SlashAutocomplete: () => null }));
vi.mock('../BoardMentionAutocomplete.js', () => ({ BoardMentionAutocomplete: () => null }));
vi.mock('../lib/workflowMentions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
}));

import { ChatInput } from '../ChatInput.js';

beforeAll(() => { (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x'; (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined; });
afterEach(cleanup);

const attachImage = (container: HTMLElement) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
};

describe('unreadable attachment note (ADR 0768 D2)', () => {
  it('shows visible text when the answering model cannot read an attached image', async () => {
    const { container } = render(<ChatInput onSend={vi.fn()} supportsImageInput={false} />);
    attachImage(container);
    await waitFor(() => expect(screen.getByText('attachUnreadableNote')).toBeTruthy());
  });

  it('says nothing when the model can read it', async () => {
    const { container } = render(<ChatInput onSend={vi.fn()} supportsImageInput />);
    attachImage(container);
    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy());
    expect(screen.queryByText('attachUnreadableNote')).toBeNull();
  });
});
