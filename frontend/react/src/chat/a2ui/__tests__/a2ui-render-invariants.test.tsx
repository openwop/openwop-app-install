import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { A2uiSurfaceCard } from '../A2uiSurfaceCard.js';
import { A2UI_CATALOG_VERSION } from '../catalog.js';
import type { CardProps } from '../../registry/types.js';

afterEach(cleanup);

/**
 * Render-side SECURITY invariant probes for the A2UI surface renderer
 * (RFC 0102 §A; reference-impl-tier — the server suite can't observe these,
 * so each adopting host writes its own per `openwop-1`'s guidance). These are
 * the openwop-app rows for `invariants.yaml`:
 *   - `a2ui-surface-no-code-exec`        — declarative data only; no eval, no
 *     markup injection, out-of-catalog fails closed.
 *   - `a2ui-surface-no-network-egress`   — the renderer itself opens no network
 *     connection; the ONLY egress is the host's `onAction` (resume/exchange).
 */

const ctx: CardProps['context'] = { runId: 'run-1', nodeId: 'node-1', tenantId: 'demo' };

describe('a2ui-surface-no-code-exec', () => {
  it('renders agent-supplied text as inert text, never as markup/elements', () => {
    const injection = '<img src=x onerror="globalThis.__pwned=1"> <script>globalThis.__pwned=1</script>';
    render(<A2uiSurfaceCard
      payload={{ catalogVersion: A2UI_CATALOG_VERSION, surface: { components: [{ component: 'text', text: injection }] } }}
      cardType="ui.a2ui-surface" context={ctx} onAction={vi.fn()}
    />);
    // The string appears verbatim as text content…
    expect(screen.getByText(injection)).toBeTruthy();
    // …and produced NO injected elements and ran NO code.
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('fails closed on an out-of-catalog component — no interactive render', () => {
    render(<A2uiSurfaceCard
      payload={{ catalogVersion: A2UI_CATALOG_VERSION, surface: { components: [{ component: 'iframe', src: 'https://evil.example' }] } }}
      cardType="ui.a2ui-surface" context={ctx} onAction={vi.fn()}
    />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/could not be rendered safely/)).toBeTruthy();
  });
});

describe('a2ui-surface-no-network-egress', () => {
  it('opens no network connection when rendering or acting — egress is only via onAction', () => {
    const fetchSpy = vi.fn();
    const xhrOpen = vi.fn();
    const origFetch = globalThis.fetch;
    const origXHR = globalThis.XMLHttpRequest;
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = class { open = xhrOpen; send = vi.fn(); setRequestHeader = vi.fn(); } as unknown;
    try {
      const onAction = vi.fn().mockResolvedValue(undefined);
      render(<A2uiSurfaceCard
        payload={{ catalogVersion: A2UI_CATALOG_VERSION, surface: { components: [
          { component: 'field.text', id: 'msg', label: 'Message' },
          { component: 'action.button', id: 'send', label: 'Send', action: { target: 'resume' } },
        ] } }}
        cardType="ui.a2ui-surface" context={ctx} onAction={onAction}
      />);
      fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'hi' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      // The action routed through the host handler…
      expect(onAction).toHaveBeenCalledWith('resolve', expect.objectContaining({ action: 'send', msg: 'hi' }));
      // …and the renderer itself made ZERO network calls.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrOpen).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch?: unknown }).fetch = origFetch;
      (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = origXHR;
    }
  });
});
