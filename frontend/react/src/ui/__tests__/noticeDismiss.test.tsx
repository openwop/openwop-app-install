/**
 * `<Notice onDismiss>` — CC-UI-1.
 *
 * The defect this pins: callers that wanted a dismissible notice put a close
 * `<Button><XIcon/></Button>` as the FIRST child and re-added a status icon in
 * the children, while `Notice` already leads with the variant icon. Live on
 * app.openwop.dev (a1d1dccb7) the Campaign Brief validation read
 * "✓ ✕ ✓ Ready to generate…". `Notice` now owns the dismiss control: ONE status
 * icon, the message, then a trailing labelled button.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { Notice } from '../Notice.js';

afterEach(cleanup);

/** SVGs inside the notice that are NOT part of a button — i.e. status icons. */
function statusIcons(root: HTMLElement): number {
  return [...root.querySelectorAll('svg')].filter((s) => !s.closest('button')).length;
}

describe('Notice — dismiss control', () => {
  it('renders ONE status icon, the message, then a trailing labelled dismiss button', () => {
    const onDismiss = vi.fn();
    const { container } = render(<Notice variant="success" onDismiss={onDismiss} dismissLabel="Close">Ready to generate</Notice>);
    const box = container.querySelector('.alert') as HTMLElement;
    expect(statusIcons(box)).toBe(1);
    const button = screen.getByRole('button', { name: 'Close' });
    // Trailing: the message precedes the button in document order.
    const message = screen.getByText('Ready to generate');
    expect(message.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.lastElementChild).toBe(button);
    fireEvent.click(button);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps the live region on the message, and the button label out of it', () => {
    render(<Notice variant="warning" onDismiss={() => {}} dismissLabel="Close">Heads up</Notice>);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('Heads up');
  });

  it('control: without onDismiss there is no button and the shape is unchanged', () => {
    const { container } = render(<Notice variant="error">Failed</Notice>);
    expect(screen.queryByRole('button')).toBeNull();
    const region = screen.getByRole('alert');
    expect(region.classList.contains('alert')).toBe(true);
    expect(statusIcons(container as HTMLElement)).toBe(1);
  });
});
